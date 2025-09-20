/**
 * Vault API Routes
 * Handles vault-related operations like withdraw
 */

import express from 'express';
import { PrismaClient } from '@prisma/client';
import type { ApiResponse } from '../../types/shared.js';
import { VaultInteractions } from '../../utils/vaultInteractions.js';
import { getVaultMapping } from '../../utils/vaultUtils.js';
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const router: express.Router = express.Router();
const prisma = new PrismaClient();

/**
 * Withdraw ALL user's vault shares from ALL vaults and transfer underlying tokens to user
 * POST /api/vault/withdraw/:userAddress
 */
router.post('/withdraw/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      const response: ApiResponse = {
        success: false,
        error: 'Invalid Address',
        message: 'Invalid Ethereum address format',
      };
      return res.status(400).json(response);
    }

    // Check executor setup
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      const response: ApiResponse = {
        success: false,
        error: 'Service Unavailable',
        message: 'Vault operations not available - executor not configured',
      };
      return res.status(503).json(response);
    }

    // Get ALL user's vault holdings
    const allUserHoldings = await prisma.userVaultHoldings.findMany({
      where: {
        userAddress: userAddress,
      },
    });

    if (!allUserHoldings || allUserHoldings.length === 0) {
      const response: ApiResponse = {
        success: false,
        error: 'No Holdings',
        message: 'No vault holdings found for this user',
      };
      return res.status(404).json(response);
    }

    console.log(`[VaultAPI] 🔍 User has ${allUserHoldings.length} vault holdings to withdraw`);

    // Setup executor account and vault interactions
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const rpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
    
    const vaultInteractions = new VaultInteractions(account, rpcUrl);
    
    const walletClient = createWalletClient({
      account: account,
      chain: arbitrum,
      transport: http(rpcUrl)
    });

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl)
    });

    // Process all vault holdings
    const withdrawalResults = [];
    let totalVaultsProcessed = 0;
    
    for (const holding of allUserHoldings) {
      try {
        console.log(`[VaultAPI] 🏦 Processing vault ${holding.vaultAddress} with ${holding.shareTokens} shares`);
        
        // Get vault mapping for token details
        const vaultMapping = getVaultMapping(holding.tokenSymbol);
        if (!vaultMapping) {
          console.error(`[VaultAPI] ❌ No vault mapping found for ${holding.tokenSymbol}`);
          continue;
        }

        const availableShares = parseFloat(holding.shareTokens.toString());
        if (availableShares <= 0) {
          console.log(`[VaultAPI] ⚠️ Skipping vault ${holding.vaultAddress} - no shares`);
          continue;
        }

        // Measure executor's token balance BEFORE withdrawal
        const balanceBefore = await publicClient.readContract({
          address: vaultMapping.tokenAddress as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
        }) as bigint;
        
        console.log(`[VaultAPI] 🔍 Executor's ${holding.tokenSymbol} balance BEFORE withdrawal: ${balanceBefore.toString()}`);

        // Execute withdrawal from this vault
        const withdrawResult = await vaultInteractions.withdrawFromVault(
          holding.vaultAddress as Address,
          holding.shareTokens.toString(),
          vaultMapping.decimals,
          userAddress as Address
        );

        if (!withdrawResult.success) {
          console.error(`[VaultAPI] ❌ Withdrawal failed for vault ${holding.vaultAddress}: ${withdrawResult.error}`);
          continue;
        }

        // Measure executor's token balance AFTER withdrawal
        const balanceAfter = await publicClient.readContract({
          address: vaultMapping.tokenAddress as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
        }) as bigint;
        
        console.log(`[VaultAPI] 🔍 Executor's ${holding.tokenSymbol} balance AFTER withdrawal: ${balanceAfter.toString()}`);
        
        // Calculate exact tokens received from withdrawal by difference
        const tokensReceivedWei = balanceAfter - balanceBefore;
        const actualTokensReceived = formatUnits(tokensReceivedWei, vaultMapping.decimals);
        
        console.log(`[VaultAPI] 🎯 Actual ${holding.tokenSymbol} received from withdrawal: ${actualTokensReceived} (diff: ${tokensReceivedWei.toString()} wei)`);

        // Only transfer if we actually received tokens from withdrawal
        let transferTxHash: string = '';
        if (tokensReceivedWei > 0) {
          console.log(`[VaultAPI] 💸 Transferring exact amount received: ${actualTokensReceived} ${holding.tokenSymbol} to user`);
          
          transferTxHash = await walletClient.writeContract({
            address: vaultMapping.tokenAddress as Address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [userAddress as Address, tokensReceivedWei], // Use exact wei amount received
            account: account,
          });

          await publicClient.waitForTransactionReceipt({ hash: transferTxHash as `0x${string}` });
          console.log(`[VaultAPI] ✅ Transfer confirmed: ${transferTxHash}`);
        } else {
          console.error(`[VaultAPI] ⚠️ No tokens received from withdrawal - skipping transfer`);
          continue;
        }

        // Remove the vault holding record
        await prisma.userVaultHoldings.delete({
          where: {
            user_vault_unique: {
              userAddress: userAddress,
              vaultAddress: holding.vaultAddress,
            },
          },
        });
        
        withdrawalResults.push({
          vaultAddress: holding.vaultAddress,
          tokenSymbol: holding.tokenSymbol,
          sharesWithdrawn: holding.shareTokens.toString(),
          assetsReceived: actualTokensReceived, // Use actual amount received, not estimated
          withdrawTxHash: withdrawResult.withdrawTxHash,
          transferTxHash: transferTxHash,
        });
        
        totalVaultsProcessed++;
        console.log(`[VaultAPI] ✅ Successfully processed vault ${holding.vaultAddress}`);
        
      } catch (error) {
        console.error(`[VaultAPI] ❌ Error processing vault ${holding.vaultAddress}:`, error);
        // Continue with next vault even if one fails
      }
    }

    if (totalVaultsProcessed === 0) {
      const response: ApiResponse = {
        success: false,
        error: 'No Withdrawals Processed',
        message: 'Unable to process any vault withdrawals',
      };
      return res.status(500).json(response);
    }

    const response: ApiResponse = {
      success: true,
      data: {
        vaultsProcessed: totalVaultsProcessed,
        totalVaults: allUserHoldings.length,
        withdrawals: withdrawalResults,
      },
      message: `Successfully processed ${totalVaultsProcessed}/${allUserHoldings.length} vault withdrawals`,
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Error processing vault withdrawal:', error);
    
    const response: ApiResponse = {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to process vault withdrawal',
    };
    res.status(500).json(response);
  }
});

/**
 * Get user's vault holdings
 * GET /api/vault/holdings/:userAddress
 */
router.get('/holdings/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      const response: ApiResponse = {
        success: false,
        error: 'Invalid Address',
        message: 'Invalid Ethereum address format',
      };
      return res.status(400).json(response);
    }
    
    // Get all vault holdings for user
    const holdings = await prisma.userVaultHoldings.findMany({
      where: { userAddress },
      orderBy: { createdAt: 'desc' },
    });
    
    const formattedHoldings = holdings.map(holding => ({
      id: holding.id,
      vaultAddress: holding.vaultAddress,
      shareTokens: holding.shareTokens.toString(),
      tokenSymbol: holding.tokenSymbol,
      createdAt: holding.createdAt.toISOString(),
      updatedAt: holding.updatedAt.toISOString(),
    }));
    
    const response: ApiResponse = {
      success: true,
      data: formattedHoldings,
      message: `Found ${formattedHoldings.length} vault holdings`,
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Error fetching vault holdings:', error);
    
    const response: ApiResponse = {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch vault holdings',
    };
    res.status(500).json(response);
  }
});

export default router;

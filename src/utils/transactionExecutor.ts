/**
 * Transaction Executor Utility for DCA Agent
 * 
 * Handles actual transaction execution using user's private key for DCA swaps
 * Based on the liquidation-prevention-agent pattern for real on-chain transactions
 */

import {
  type Address,
  type Hex,
  type TransactionReceipt,
  type LocalAccount,
  BaseError,
  ContractFunctionRevertedError,
  hexToString,
  isHex,
  createWalletClient,
  createPublicClient,
  http,
} from 'viem';
import { arbitrum } from 'viem/chains';
// Type definition for transaction plan (simplified version of ember-schemas)
interface TransactionPlan {
  chainId: string;
  to: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
}

interface ChainConfig {
  viemChain: typeof arbitrum;
  rpcUrl: string;
}

// Support for Arbitrum (can be extended later)
const chainIdMap: Record<string, ChainConfig> = {
  '42161': { 
    viemChain: arbitrum, 
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc'
  },
};

function getChainConfigById(chainId: string): ChainConfig {
  const config = chainIdMap[chainId];
  if (!config) {
    throw new Error(`Unsupported chainId: ${chainId}. Currently only Arbitrum (42161) is supported.`);
  }
  return config;
}

export class DCATransactionExecutor {
  private account: LocalAccount<string>;
  private userAddress: Address;

  constructor(
    account: LocalAccount<string>,
    userAddress: Address
  ) {
    this.account = account;
    this.userAddress = userAddress;
  }

  private log(...args: unknown[]) {
    console.log('[DCATransactionExecutor]', ...args);
  }

  private logError(...args: unknown[]) {
    console.error('[DCATransactionExecutor]', ...args);
  }

  /**
   * Execute DCA swap transaction
   * @param planId - DCA plan identifier for logging
   * @param transactions - Transaction plans from Ember MCP
   * @returns Transaction hash and execution summary
   */
  async executeDCASwap(planId: string, transactions: TransactionPlan[]): Promise<{
    txHash: string;
    fromAmount: string;
    toAmount: string;
    gasUsed: string;
  }> {
    if (!transactions || transactions.length === 0) {
      throw new Error('No transactions provided for DCA swap execution');
    }

    try {
      this.log(`Executing DCA swap for plan ${planId}...`);
      
      // For DCA, we typically expect a single swap transaction
      const transaction = transactions[0];
      if (!transaction) {
        throw new Error('No transaction provided for execution');
      }
      
      const { txHash, gasUsed } = await this.signAndSendTransaction(transaction);
      
      this.log(`DCA swap executed successfully: ${txHash}`);
      
      // Return execution details for database recording
      return {
        txHash,
        fromAmount: transaction.value || '0', // Will be filled from actual transaction data
        toAmount: '0', // Will be calculated from swap result
        gasUsed,
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logError(`Error executing DCA swap for plan ${planId}:`, err.message);
      throw new Error(`DCA swap execution failed: ${err.message}`);
    }
  }

  private async signAndSendTransaction(tx: TransactionPlan): Promise<{
    txHash: string;
    gasUsed: string;
  }> {
    if (!tx.chainId) {
      const errorMsg = `Transaction object missing required 'chainId' field`;
      this.logError(errorMsg, tx);
      throw new Error(errorMsg);
    }

    let chainConfig: ChainConfig;
    try {
      chainConfig = getChainConfigById(tx.chainId);
    } catch (error) {
      this.logError('Failed to get chain config:', error);
      throw error;
    }

    this.log(`Executing transaction on ${chainConfig.viemChain.name}...`);

    // Create wallet and public clients
    const walletClient = createWalletClient({
      account: this.account,
      chain: chainConfig.viemChain,
      transport: http(chainConfig.rpcUrl)
    });

    const publicClient = createPublicClient({
      chain: chainConfig.viemChain,
      transport: http(chainConfig.rpcUrl)
    });

    try {
      // Validate required transaction fields
      if (!tx.to || !isHex(tx.to)) {
        throw new Error(`Invalid 'to' address: ${tx.to}`);
      }

      // Send the transaction
      this.log(`Sending transaction to ${tx.to}...`);
      const txParams: any = {
        to: tx.to as Address,
        value: tx.value ? BigInt(tx.value) : 0n,
        data: tx.data as Hex | undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        nonce: tx.nonce ? Number(tx.nonce) : undefined,
      };

      // Add fee parameters (EIP-1559 or legacy)
      if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
        txParams.maxFeePerGas = BigInt(tx.maxFeePerGas);
        txParams.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
      } else if (tx.gasPrice) {
        txParams.gasPrice = BigInt(tx.gasPrice);
      }

      const txHash = await walletClient.sendTransaction(txParams);

      this.log(`Transaction sent: ${txHash}`);

      // Wait for transaction confirmation
      this.log('Waiting for transaction confirmation...');
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000, // 2 minutes timeout
      });

      if (receipt.status === 'reverted') {
        throw new Error(`Transaction reverted: ${txHash}`);
      }

      this.log(`Transaction confirmed: ${txHash}, Gas used: ${receipt.gasUsed.toString()}`);
      
      return {
        txHash,
        gasUsed: receipt.gasUsed.toString(),
      };

    } catch (error: unknown) {
      if (error instanceof BaseError) {
        let cause = error.cause;
        
        // Handle specific contract revert errors
        if (cause instanceof ContractFunctionRevertedError) {
          const revertReason = cause.data?.errorName || 'Unknown contract error';
          this.logError(`Contract revert: ${revertReason}`);
          throw new Error(`Transaction failed: ${revertReason}`);
        }
        
        // Try to extract a readable error message
        while (cause) {
          if ((cause as any).message) {
            this.logError(`Transaction error: ${(cause as any).message}`);
            throw new Error(`Transaction failed: ${(cause as any).message}`);
          }
          cause = (cause as any).cause;
        }
      }
      
      const err = error as Error;
      this.logError('Transaction failed:', err.message);
      throw new Error(`Transaction execution failed: ${err.message}`);
    }
  }
}

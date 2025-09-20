/**
 * Vault Interaction Utilities
 * Handles deposit and withdrawal operations with vault contracts
 */

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseUnits, 
  formatUnits, 
  type Address, 
  type LocalAccount,
  erc20Abi 
} from 'viem';
import { arbitrum } from 'viem/chains';

// Standard ERC4626 Vault ABI (commonly used interface)
const vaultAbi = [
  // Read functions
  {
    inputs: [{ name: 'assets', type: 'uint256' }],
    name: 'convertToShares',
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'shares', type: 'uint256' }],
    name: 'convertToAssets',
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Write functions
  {
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' }
    ],
    name: 'deposit',
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' }
    ],
    name: 'redeem',
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

interface VaultDepositResult {
  shareTokens: string;
  depositTxHash: string;
  success: boolean;
  error?: string;
}

interface VaultWithdrawResult {
  assetsReceived: string;
  withdrawTxHash: string;
  success: boolean;
  error?: string;
}

export class VaultInteractions {
  private publicClient: any;
  private walletClient: any;
  private account: LocalAccount;
  private rpcUrl: string;

  constructor(account: LocalAccount, rpcUrl: string) {
    this.account = account;
    this.rpcUrl = rpcUrl;
    
    this.publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl)
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: arbitrum,
      transport: http(rpcUrl)
    });
  }

  /**
   * Deposit tokens into vault and return share tokens received
   */
  async depositToVault(
    tokenAddress: Address,
    vaultAddress: Address,
    amount: string,
    decimals: number,
    userAddress: Address
  ): Promise<VaultDepositResult> {
    try {
      console.log(`[VaultInteractions] 🏦 Depositing ${amount} tokens to vault ${vaultAddress}`);
      
      const atomicAmount = parseUnits(amount, decimals);
      
      // Check token balance before deposit
      const tokenBalance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.account.address],
      });

      console.log(`[VaultInteractions] 💰 Current token balance: ${formatUnits(tokenBalance, decimals)}`);

      if (tokenBalance < atomicAmount) {
        throw new Error(`Insufficient token balance: need ${amount} but have ${formatUnits(tokenBalance, decimals)}`);
      }

      // Check if vault needs approval
      const allowance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [this.account.address, vaultAddress],
      });

      // Approve vault if needed
      if (allowance < atomicAmount) {
        console.log(`[VaultInteractions] 🔓 Approving vault ${vaultAddress} for token ${tokenAddress}`);
        
        const approveTxHash = await this.walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vaultAddress, atomicAmount],
          account: this.account,
        });

        await this.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        console.log(`[VaultInteractions] ✅ Approval confirmed: ${approveTxHash}`);
      }

      // Get user's share balance BEFORE deposit
      const sharesBefore = await this.publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as bigint;

      console.log(`[VaultInteractions] 📊 User's shares before deposit: ${formatUnits(sharesBefore, decimals)}`);

      // Execute deposit - shares go to user, not executor
      const depositTxHash = await this.walletClient.writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [atomicAmount, userAddress], // Shares go to user
        account: this.account,
      });

      await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });
      console.log(`[VaultInteractions] ✅ Deposit confirmed: ${depositTxHash}`);

      // Get user's share balance AFTER deposit
      const sharesAfter = await this.publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as bigint;

      // Calculate actual shares received by difference (both are bigint)
      const actualSharesReceived = sharesAfter - sharesBefore;
      const shareTokensHuman = formatUnits(actualSharesReceived, decimals);
      console.log(`[VaultInteractions] 🎯 Actual shares received: ${shareTokensHuman}`);

      return {
        shareTokens: shareTokensHuman,
        depositTxHash,
        success: true
      };

    } catch (error) {
      console.error('[VaultInteractions] ❌ Deposit failed:', error);
      return {
        shareTokens: '0',
        depositTxHash: '',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Withdraw tokens from vault using share tokens
   */
  async withdrawFromVault(
    vaultAddress: Address,
    shareAmount: string,
    decimals: number,
    userAddress: Address
  ): Promise<VaultWithdrawResult> {
    try {
      console.log(`[VaultInteractions] 🏦 Withdrawing ${shareAmount} shares from vault ${vaultAddress}`);
      
      const atomicShares = parseUnits(shareAmount, decimals);
      
      // Get expected assets
      const expectedAssets = await this.publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'convertToAssets',
        args: [atomicShares],
      });

      console.log(`[VaultInteractions] 📊 Expected assets: ${formatUnits(expectedAssets, decimals)}`);

      // Execute withdrawal - redeem shares for assets
      const withdrawTxHash = await this.walletClient.writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'redeem',
        args: [atomicShares, this.account.address, userAddress], // Assets to executor, shares from user
        account: this.account,
      });

      await this.publicClient.waitForTransactionReceipt({ hash: withdrawTxHash });
      console.log(`[VaultInteractions] ✅ Withdrawal confirmed: ${withdrawTxHash}`);

      const assetsReceivedHuman = formatUnits(expectedAssets, decimals);
      console.log(`[VaultInteractions] 🎯 Assets received: ${assetsReceivedHuman}`);

      return {
        assetsReceived: assetsReceivedHuman,
        withdrawTxHash,
        success: true
      };

    } catch (error) {
      console.error('[VaultInteractions] ❌ Withdrawal failed:', error);
      return {
        assetsReceived: '0',
        withdrawTxHash: '',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

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

// Simplified Vault ABI - deposit/withdraw with amounts only
const vaultAbi = [
  // Read functions
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Write functions - simplified signatures
  {
    inputs: [{ name: '_amount', type: 'uint256' }],
    name: 'deposit',
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '_shares', type: 'uint256' }],
    name: 'withdraw',
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

      // Get executor's share balance BEFORE deposit (shares will come to executor)
      const executorSharesBefore = await this.publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [this.account.address],
      }) as bigint;

      console.log(`[VaultInteractions] 📊 Executor's shares before deposit: ${formatUnits(executorSharesBefore, decimals)}`);

      // Execute deposit - shares go to transaction sender (executor account)
      const depositTxHash = await this.walletClient.writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [atomicAmount], // Only amount in wei required
        account: this.account,
      });

      await this.publicClient.waitForTransactionReceipt({ hash: depositTxHash });
      console.log(`[VaultInteractions] ✅ Deposit confirmed: ${depositTxHash}`);

      // Get executor's share balance AFTER deposit
      const executorSharesAfter = await this.publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [this.account.address],
      }) as bigint;

      // Calculate actual shares received by executor
      const actualSharesReceived = executorSharesAfter - executorSharesBefore;
      console.log(`[VaultInteractions] 🎯 Shares received by executor: ${formatUnits(actualSharesReceived, decimals)}`);

      // Note: Shares remain with executor, but we track them for the user in our database
      // This approach avoids complex share transfers and approvals
      const shareTokensHuman = formatUnits(actualSharesReceived, decimals);
      console.log(`[VaultInteractions] 🎯 Shares received by executor (tracked for user): ${shareTokensHuman}`);

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
      
      // Note: Executor already owns the shares (tracked in database for user)
      // No need to transfer shares since executor manages all vault positions
      console.log(`[VaultInteractions] 🏦 Using executor's vault shares for user withdrawal`);

      // Execute withdrawal - withdraw shares for assets (simplified function)
      const withdrawTxHash = await this.walletClient.writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [atomicShares], // Only shares amount in wei required
        account: this.account,
      });

      await this.publicClient.waitForTransactionReceipt({ hash: withdrawTxHash });
      console.log(`[VaultInteractions] ✅ Withdrawal confirmed: ${withdrawTxHash}`);

      // Note: Actual assets received will be measured by the calling code
      // using before/after balance checks for precision
      console.log(`[VaultInteractions] 🎯 Withdrawal completed for ${shareAmount} shares`);

      return {
        assetsReceived: shareAmount, // Placeholder - actual amount measured by caller
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

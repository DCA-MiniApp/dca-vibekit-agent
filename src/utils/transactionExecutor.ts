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

function formatWeiToEth(wei: bigint): string {
  const weiPerEth = 1_000_000_000_000_000_000n; // 1e18
  const whole = wei / weiPerEth;
  const fraction = wei % weiPerEth;
  // Return up to 6 decimal places for readability
  const fractionStr = (fraction.toString().padStart(18, '0')).slice(0, 6).replace(/0+$/, '');
  return fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
}

export class DCATransactionExecutor {
  private account: LocalAccount<string>;
  private userAddress: Address;
  private currentNonce: number | null = null;
  private nonceLastUpdated: number = 0;
  private readonly NONCE_CACHE_MS = 5000; // Cache nonce for 5 seconds

  constructor(
    account: LocalAccount<string>,
    userAddress: Address
  ) {
    this.account = account;
    this.userAddress = userAddress;
  }

  get executorAddress(): Address {
    return this.userAddress;
  }

  private log(...args: unknown[]) {
    console.log('[DCATransactionExecutor]', ...args);
  }

  private logError(...args: unknown[]) {
    console.error('[DCATransactionExecutor]', ...args);
  }

  /**
   * Get the next nonce for transactions, managing sequential nonce increments
   */
  private async getNextNonce(publicClient: any, forceRefresh: boolean = false): Promise<number> {
    const now = Date.now();
    
    // Force refresh or cache expired or first time
    if (forceRefresh || this.currentNonce === null || (now - this.nonceLastUpdated) > this.NONCE_CACHE_MS) {
      this.log('🔄 Fetching fresh nonce from network...');
      
      const networkNonce = await publicClient.getTransactionCount({
        address: this.userAddress,
        blockTag: 'pending' // Include pending transactions
      });
      
      this.currentNonce = networkNonce;
      this.nonceLastUpdated = now;
      this.log(`✅ Fresh nonce fetched: ${this.currentNonce}`);
    } else {
      // Use cached nonce and increment for next transaction  
      if (this.currentNonce !== null) {
        this.currentNonce = this.currentNonce + 1;
        this.log(`📈 Incremented cached nonce: ${this.currentNonce}`);
      } else {
        // This shouldn't happen but handle it as a safeguard
        throw new Error('Nonce cache is unexpectedly null');
      }
    }
    
    // TypeScript guard - this.currentNonce should never be null at this point
    if (this.currentNonce === null) {
      throw new Error('Failed to get valid nonce');
    }
    
    return this.currentNonce;
  }

  /**
   * Reset nonce cache to force fresh fetch on next transaction
   */
  private resetNonceCache(): void {
    this.currentNonce = null;
    this.nonceLastUpdated = 0;
    this.log('🔄 Nonce cache reset');
  }

  /**
   * Execute DCA swap transactions (can be multiple: approval + swap)
   * @param planId - DCA plan identifier for logging
   * @param transactions - Transaction plans from Ember MCP
   * @returns Transaction hashes and execution summary
   */
  async executeDCASwap(planId: string, transactions: TransactionPlan[]): Promise<{
    txHash: string;
    fromAmount: string;
    toAmount: string;
    gasUsed: string;
    gasCostEth: string;
  }> {
    if (!transactions || transactions.length === 0) {
      this.log(`DCA swap for plan ${planId}: No transactions required.`);
      throw new Error('No transactions provided for DCA swap execution');
    }

    try {
      this.log(`Executing ${transactions.length} transaction(s) for DCA swap plan ${planId}...`);
      
      // Reset nonce cache at the start of each execution batch
      this.resetNonceCache();

      const txHashes: string[] = [];
      let totalGasUsed = BigInt(0);
      let totalGasCostWei = BigInt(0);

      // Execute all transactions sequentially with proper nonce management
      for (let i = 0; i < transactions.length; i++) {
        const transaction = transactions[i];
        if (!transaction) {
          throw new Error(`Transaction ${i + 1} is undefined`);
        }

        this.log(`Executing transaction ${i + 1}/${transactions.length} for plan ${planId}...`);

        // Log transaction details for debugging
        this.log(`Transaction ${i + 1} details:`, {
          to: transaction.to,
          value: transaction.value || '0',
          valueInETH: transaction.value ? (BigInt(transaction.value) / BigInt(10 ** 18)).toString() + ' ETH' : '0 ETH',
          dataPrefix: transaction.data ? transaction.data.substring(0, 10) : 'no data',
          chainId: transaction.chainId,
          gas: transaction.gas || 'auto',
        });

        // Special check for ETH value requirements
        if (transaction.value && transaction.value !== '0') {
          this.log(`⚠️  Transaction requires ETH value: ${transaction.value} wei (${(BigInt(transaction.value) / BigInt(10 ** 18)).toString()} ETH)`);
        }

        // Execute with retry logic for nonce issues
        const { txHash, gasUsed, gasCostWei } = await this.signAndSendTransactionWithRetry(transaction, 3);
        txHashes.push(txHash);
        totalGasUsed += BigInt(gasUsed);
        totalGasCostWei += BigInt(gasCostWei);

        this.log(`Transaction ${i + 1}/${transactions.length} sent: ${txHash}`);
      }

      this.log(`DCA swap for plan ${planId} executed successfully! Transaction hash(es): ${txHashes.join(', ')}`);

      // Return execution details for database recording
      // For DCA, the last transaction is typically the swap
      const finalTxHash = txHashes[txHashes.length - 1];
      if (!finalTxHash) {
        throw new Error('No transaction hashes were recorded');
      }

      return {
        txHash: finalTxHash, // Use the last (swap) transaction hash
        fromAmount: '0', // Will be filled from actual swap result analysis
        toAmount: '0', // Will be calculated from swap result analysis
        gasUsed: totalGasUsed.toString(),
        gasCostEth: formatWeiToEth(totalGasCostWei),
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logError(`Error executing DCA swap for plan ${planId}:`, err.message);
      
      // Reset nonce cache on failure to ensure fresh start next time
      this.resetNonceCache();
      
      throw new Error(`DCA swap execution failed: ${err.message}`);
    }
  }

  /**
   * Wrapper for transaction execution with retry logic for nonce issues
   */
  private async signAndSendTransactionWithRetry(
    tx: TransactionPlan, 
    maxRetries: number = 3
  ): Promise<{
    txHash: string;
    gasUsed: string;
    gasCostWei: string;
  }> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.log(`🎯 Transaction attempt ${attempt}/${maxRetries}`);
        return await this.signAndSendTransaction(tx);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if it's a nonce-related error
        const isNonceError = lastError.message.toLowerCase().includes('nonce') ||
                           lastError.message.toLowerCase().includes('transaction underpriced') ||
                           lastError.message.toLowerCase().includes('already known');
        
        if (isNonceError && attempt < maxRetries) {
          this.logError(`❌ Attempt ${attempt} failed with nonce error: ${lastError.message}`);
          this.log(`🔄 Resetting nonce cache and retrying in 2 seconds...`);
          
          // Reset nonce cache to force fresh fetch
          this.resetNonceCache();
          
          // Wait before retry to avoid rapid-fire requests
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // Non-nonce error or max retries reached
          this.logError(`❌ Attempt ${attempt} failed: ${lastError.message}`);
          if (attempt === maxRetries) {
            throw lastError;
          }
        }
      }
    }
    
    // Should never reach here, but TypeScript requires it
    throw lastError || new Error('Unknown error in transaction retry');
  }

  private async signAndSendTransaction(tx: TransactionPlan): Promise<{
    txHash: string;
    gasUsed: string;
    gasCostWei: string;
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

    // Validate transaction fields (similar to liquidation prevention agent)
    if (!tx.to || !/^0x[a-fA-F0-9]{40}$/.test(tx.to)) {
      const errorMsg = `Transaction object invalid 'to' field: ${tx.to}`;
      this.logError(errorMsg, tx);
      throw new Error(errorMsg);
    }

    // For swap transactions, data is required. For simple transfers, it might be optional
    if (tx.data && !isHex(tx.data)) {
      const errorMsg = `Transaction object invalid 'data' field (not hex): ${tx.data}`;
      this.logError(errorMsg, tx);
      throw new Error(errorMsg);
    }

    const toAddress = tx.to as Address;
    const txData = tx.data ? (tx.data as Hex) : undefined;
    const txValue = tx.value ? BigInt(tx.value) : 0n;

    try {
      const dataPrefix = txData ? txData.substring(0, 10) : 'no data';
      this.log(
        `Preparing transaction to ${toAddress} on chain ${chainConfig.viemChain.id} from ${this.userAddress} with data ${dataPrefix}...`
      );

      // Check ETH balance if transaction requires value
      if (txValue > 0n) {
        const ethBalance = await publicClient.getBalance({ address: this.userAddress });
        this.log(`💰 ETH Balance: ${ethBalance.toString()} wei (${(ethBalance / BigInt(10 ** 18)).toString()} ETH)`);
        this.log(`💰 Required ETH: ${txValue.toString()} wei (${(txValue / BigInt(10 ** 18)).toString()} ETH)`);

        if (ethBalance < txValue) {
          throw new Error(`Insufficient ETH balance. Required: ${(txValue / BigInt(10 ** 18)).toString()} ETH, Available: ${(ethBalance / BigInt(10 ** 18)).toString()} ETH`);
        }
      }

      this.log(`Sending transaction...`);

      // Build transaction parameters

      // Estimate gas using the public client, then add a 20% buffer
      this.log("Estimating gas...")
      const gasEstimate = await publicClient.estimateGas({
        account: this.userAddress,
        to: toAddress,
        value: txValue,
        data: txData,
      }); 
      this.log("Gas estimated.....");
      
      this.log("gasEstimate", gasEstimate.toString());

      // Get proper nonce for this transaction
      const transactionNonce = await this.getNextNonce(publicClient);
      this.log(`🎯 Using nonce: ${transactionNonce} for transaction`);

      const txParams: any = {
        to: toAddress,
        value: txValue,
        data: txData,
        gas: gasEstimate * 12n / 10n, // add 20% buffer
        nonce: transactionNonce, // Use managed nonce
      };

      // Add gas parameters if provided (but don't override nonce)
      if (tx.gas) {
        txParams.gas = BigInt(tx.gas);
      }
      // Don't use tx.nonce as it may be stale - always use managed nonce

      // Add fee parameters (EIP-1559 or legacy)
      if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
        txParams.maxFeePerGas = BigInt(tx.maxFeePerGas);
        txParams.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
      } else if (tx.gasPrice) {
        txParams.gasPrice = BigInt(tx.gasPrice);
      }
      
      this.log("txParams", txParams);
      const txHash = await walletClient.sendTransaction(txParams);

      this.log(
        `Transaction submitted to chain ${chainConfig.viemChain.id}: ${txHash}. Waiting for confirmation...`
      );

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000, // 2 minutes timeout
      });

      this.log(
        `Transaction confirmed on chain ${chainConfig.viemChain.id} in block ${receipt.blockNumber} (Status: ${receipt.status}): ${txHash}`
      );

      if (receipt.status === 'reverted') {
        throw new Error(
          `Transaction ${txHash} failed (reverted). Check blockchain explorer for details.`
        );
      }

      // Compute gas cost in wei: gasUsed * effective gas price
      let gasCostWei = 0n;
      if (receipt.effectiveGasPrice) {
        gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
      } else if (tx.gasPrice) {
        gasCostWei = receipt.gasUsed * BigInt(tx.gasPrice);
      }

      return {
        txHash,
        gasUsed: receipt.gasUsed.toString(),
        gasCostWei: gasCostWei.toString(),
      };

    } catch (error: unknown) {
      // Improved error handling based on liquidation prevention agent
      let revertReason =
        error instanceof Error
          ? `Transaction failed: ${error.message}`
          : 'Transaction failed: Unknown error';

      if (error instanceof BaseError) {
        const cause = error.walk((e: unknown) => e instanceof ContractFunctionRevertedError);
        if (cause instanceof ContractFunctionRevertedError) {
          const errorName = cause.reason ?? cause.shortMessage;
          revertReason = `Transaction reverted: ${errorName}`;

          if (cause.data?.errorName === '_decodeRevertReason') {
            const hexReason = cause.data.args?.[0];
            if (hexReason && typeof hexReason === 'string' && isHex(hexReason as Hex)) {
              try {
                revertReason = `Transaction reverted: ${hexToString(hexReason as Hex)}`;
              } catch (decodeError) {
                this.logError('Failed to decode revert reason hex:', hexReason, decodeError);
              }
            }
          }
        } else {
          revertReason = `Transaction failed: ${error.shortMessage}`;
        }
        this.logError(`Send transaction failed: ${revertReason}`, error.details);
      } else if (error instanceof Error) {
        this.logError(`Send transaction failed: ${revertReason}`, error);
      } else {
        this.logError(`Send transaction failed with unknown error type: ${revertReason}`, error);
      }

      throw new Error(revertReason);
    }
  }
}

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
  }> {
    if (!transactions || transactions.length === 0) {
      this.log(`DCA swap for plan ${planId}: No transactions required.`);
      throw new Error('No transactions provided for DCA swap execution');
    }

    try {
      this.log(`Executing ${transactions.length} transaction(s) for DCA swap plan ${planId}...`);

      const txHashes: string[] = [];
      let totalGasUsed = BigInt(0);

      // Execute all transactions sequentially (like liquidation prevention agent)
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

        const { txHash, gasUsed } = await this.signAndSendTransaction(transaction);
        txHashes.push(txHash);
        totalGasUsed += BigInt(gasUsed);

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
      console.log("esitmating gas")
      const gasEstimate = await publicClient.estimateGas({
        account: this.userAddress,
        to: toAddress,
        value: txValue,
        data: txData,
      }); 
      console.log("gas estimated", gasEstimate);
      
      this.log("gasEstimate", gasEstimate);

      const txParams: any = {
        to: toAddress,
        value: txValue,
        data: txData,
        gas: gasEstimate * 12n / 10n, // add 20% buffer
      };

      // Add gas parameters if provided
      if (tx.gas) {
        txParams.gas = BigInt(tx.gas);
      }
      if (tx.nonce) {
        txParams.nonce = Number(tx.nonce);
      }

      // Add fee parameters (EIP-1559 or legacy)
      if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
        txParams.maxFeePerGas = BigInt(tx.maxFeePerGas);
        txParams.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
      } else if (tx.gasPrice) {
        txParams.gasPrice = BigInt(tx.gasPrice);
      }
      
      console.log("txParams before sending", txParams);
      this.log("txParams", txParams);
      this.log("walletClient", walletClient);
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

      return {
        txHash,
        gasUsed: receipt.gasUsed.toString(),
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

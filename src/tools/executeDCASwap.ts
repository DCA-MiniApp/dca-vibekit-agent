/**
 * Execute DCA Swap Tool
 * 
 * This tool handles the preparation of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Preparing transactions for execution via hooks
 * 3. Returning transaction data for secure signing
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { formatUnits, parseUnits, type Address, createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { arbitrum } from 'viem/chains';

import { withHooks, transactionSigningAfterHook, transactionValidationBeforeHook } from '../hooks/index.js';


// Response schema for Ember MCP - this is the structuredContent directly
const SwapTokensResponseSchema = z.object({
  fromToken: z.object({
    tokenUid: z.object({
      chainId: z.string(),
      address: z.string(),
    }).optional(),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    isNative: z.boolean(),
    iconUri: z.string(),
    isVetted: z.boolean(),
  }),
  toToken: z.object({
    tokenUid: z.object({
      chainId: z.string(),
      address: z.string(),
    }).optional(),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    isNative: z.boolean(),
    iconUri: z.string(),
    isVetted: z.boolean(),
  }),
  exactFromAmount: z.string(),
  displayFromAmount: z.string(),
  exactToAmount: z.string(),
  displayToAmount: z.string(),
  transactions: z.array(z.object({
    type: z.string(),
    to: z.string(),
    data: z.string(),
    value: z.string(),
    chainId: z.string(),
  })),
  estimation: z.object({
    effectivePrice: z.string(),
    timeEstimate: z.string(),
    expiration: z.string(),
  }),
  // We don't need providerTracking for our functionality, so we'll ignore it
});

type SwapTokensResponse = z.infer<typeof SwapTokensResponseSchema>;

/**
 * Find token details in the context's token map
 */
function findTokenDetail(
  tokenSymbol: string,
  tokenMap: Record<string, TokenInfo[]>,
  chainId: number = 42161
): TokenInfo | null {
  const upperSymbol = tokenSymbol.toUpperCase();
  const tokens = tokenMap[upperSymbol];
  if (!tokens || tokens.length === 0) return null;
  return tokens.find(token => token.chainId === chainId) || null;
}

/**
 * Safe conversion for decimal amounts to avoid BigInt errors
 */
function safeToHuman(value: string): string {
  return value.replace(/^\+/, '').trim();
}

/**
 * Retry wrapper for MCP client calls with exponential backoff
 */
async function retryMcpCall<T>(
  mcpClient: any,
  toolName: string,
  args: any,
  maxRetries: number = 3,
  baseDelay: number = 5000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[MCP Retry] 🎯 Attempt ${attempt}/${maxRetries} for ${toolName}`);
      
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: args,
      });
      
      console.log(`[MCP Retry] ✅ ${toolName} succeeded on attempt ${attempt}`);
      return result;
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[MCP Retry] ❌ Attempt ${attempt}/${maxRetries} failed for ${toolName}:`, lastError.message);
      
      // Check if it's a network-related error that should be retried
      const isNetworkError = lastError.message.toLowerCase().includes('fetch failed') ||
                           lastError.message.toLowerCase().includes('etimedout') ||
                           lastError.message.toLowerCase().includes('econnreset') ||
                           lastError.message.toLowerCase().includes('enotfound') ||
                           lastError.message.toLowerCase().includes('network') ||
                           lastError.message.toLowerCase().includes('timeout');
      
      if (isNetworkError && attempt < maxRetries) {
        const delay = baseDelay * attempt; // Progressive delay: 5s, 10s, 15s
        console.log(`[MCP Retry] 🔄 Network error detected, retrying in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Non-network error or max retries reached
        if (attempt === maxRetries) {
          console.error(`[MCP Retry] 💥 All ${maxRetries} attempts failed for ${toolName}`);
          throw lastError;
        } else {
          // Non-retryable error, fail immediately
          console.error(`[MCP Retry] 💥 Non-retryable error for ${toolName}, failing immediately`);
          throw lastError;
        }
      }
    }
  }
  
  // Should never reach here, but TypeScript requires it
  throw lastError || new Error(`Unknown error in MCP retry for ${toolName}`);
}

const ExecuteDCASwapParams = z.object({
  walletAddress: z.string().describe('The wallet address that will perform the token swap'),
  amount: z.string().describe('The amount of tokens to swap (input amount for exactIn, output amount for exactOut)'),
  amountType: z.string().describe('Whether the amount represents input tokens (exactIn) or desired output tokens (exactOut)'),
  toChain: z.string().describe('The destination blockchain network for the token swap'),
  fromChain: z.string().describe('The source blockchain network for the token swap'),
  fromToken: z.string().describe('The token to swap from (source token symbol or name)'),
  toToken: z.string().describe('The token to swap to (destination token symbol or name)'),
  slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
  planId: z.string().optional().describe('Optional DCA plan ID for tracking executions'),
});

const ROUTER_ADDRESS = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666' as Address;

/**
 * Retry wrapper for blockchain operations with exponential backoff
 */
async function retryBlockchainOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 3,
  baseDelay: number = 2000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Blockchain Retry] 🎯 Attempt ${attempt}/${maxRetries} for ${operationName}`);
      const result = await operation();
      console.log(`[Blockchain Retry] ✅ ${operationName} succeeded on attempt ${attempt}`);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Blockchain Retry] ❌ Attempt ${attempt}/${maxRetries} failed for ${operationName}:`, lastError.message);
      
      // Check if it's a retryable blockchain error
      const isRetryableError = lastError.message.toLowerCase().includes('network') ||
                              lastError.message.toLowerCase().includes('timeout') ||
                              lastError.message.toLowerCase().includes('connection') ||
                              lastError.message.toLowerCase().includes('rpc') ||
                              lastError.message.toLowerCase().includes('fetch failed');
      
      if (isRetryableError && attempt < maxRetries) {
        const delay = baseDelay * attempt; // Progressive delay: 2s, 4s, 6s
        console.log(`[Blockchain Retry] 🔄 Retryable error detected, retrying in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        if (attempt === maxRetries || !isRetryableError) {
          throw lastError;
        }
      }
    }
  }
  
  throw lastError || new Error(`Unknown error in blockchain retry for ${operationName}`);
}

/**
 * Handle token approvals and transfer from user to executor
 */
async function handleTokenApprovalsAndTransfer(
  context: any,
  fromTokenDetail: TokenInfo,
  amount: string,
  walletAddress: string
): Promise<void> {
  if (!context.custom.executeTransaction) {
    throw new Error('Transaction executor not available');
  }

  const executorAddress = context.custom.executeTransaction.executorAddress;
  
  console.log("From token details:", fromTokenDetail);
  console.log("user", walletAddress);
  console.log("executor", executorAddress);
  
  // Use token's actual decimals for all tokens
  let atomicAmount = parseUnits(amount, fromTokenDetail.decimals);
  if (fromTokenDetail.address == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831") {
    atomicAmount = parseUnits(amount, 6);
    console.log("atomic amount", atomicAmount);
  }

  // Create clients for token operations
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(context.custom.config.arbitrumRpcUrl)
  });

  const walletClient = createWalletClient({
    account: context.custom.executeTransaction.account,
    chain: arbitrum,
    transport: http(context.custom.config.arbitrumRpcUrl)
  });

  console.log(`[DCA Swap] 🔍 Checking approvals for ${fromTokenDetail.symbol} at ${fromTokenDetail.address}`);

  // Check if user and executor are the same (self-execution case)
  const isSelfExecution = walletAddress.toLowerCase() === executorAddress.toLowerCase();
  
  if (isSelfExecution) {
    console.log(`[DCA Swap] 🔄 Self-execution detected - user and executor are same address`);
    
    // Only need to check/approve router for direct execution
    const userApproval = await retryBlockchainOperation(
      () => publicClient.readContract({
        address: fromTokenDetail.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [walletAddress as Address, ROUTER_ADDRESS],
      }),
      'Check user approval to router'
    );

    console.log(`[DCA Swap] 📋 User approval to router: ${formatUnits(userApproval, fromTokenDetail.decimals)} ${fromTokenDetail.symbol}`);

    // If approval is insufficient, approve unlimited to router
    if (userApproval < atomicAmount) {
      console.log(`[DCA Swap] 🔓 Approving unlimited ${fromTokenDetail.symbol} to router ${ROUTER_ADDRESS}...`);

      const approveTxHash = await retryBlockchainOperation(
        () => walletClient.writeContract({
          address: fromTokenDetail.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ROUTER_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
          account: context.custom.executeTransaction.account,
        }),
        'Approve router'
      );

      await retryBlockchainOperation(
        () => publicClient.waitForTransactionReceipt({ hash: approveTxHash }),
        'Wait for approval confirmation'
      );
      console.log(`[DCA Swap] ✅ Router approval transaction confirmed: ${approveTxHash}`);
    } else {
      console.log(`[DCA Swap] ✅ User already has sufficient approval to router`);
    }
    
  } else {
    // Separate executor case - need to handle transfers between user and executor
    console.log(`[DCA Swap] 🔄 Separate executor detected - handling user to executor transfer`);
    
    // Check executor's approval to router with retry
    const executorApproval = await retryBlockchainOperation(
      () => publicClient.readContract({
        address: fromTokenDetail.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [executorAddress, ROUTER_ADDRESS],
      }),
      'Check executor approval'
    );

    console.log(`[DCA Swap] 📋 Executor approval to router: ${formatUnits(executorApproval, fromTokenDetail.decimals)} ${fromTokenDetail.symbol}`);

    // If approval is insufficient, approve unlimited to router
    if (executorApproval < atomicAmount) {
      console.log(`[DCA Swap] 🔓 Approving unlimited ${fromTokenDetail.symbol} to router ${ROUTER_ADDRESS}...`);

      const approveTxHash = await retryBlockchainOperation(
        () => walletClient.writeContract({
          address: fromTokenDetail.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ROUTER_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
          account: context.custom.executeTransaction.account,
        }),
        'Approve router'
      );

      await retryBlockchainOperation(
        () => publicClient.waitForTransactionReceipt({ hash: approveTxHash }),
        'Wait for approval confirmation'
      );
      console.log(`[DCA Swap] ✅ Router approval transaction confirmed: ${approveTxHash}`);
    } else {
      console.log(`[DCA Swap] ✅ Executor already has sufficient approval to router`);
    }

    // Transfer tokens from user to executor (assumes user has approved executor)
    console.log(`[DCA Swap] 💸 Transferring ${amount} ${fromTokenDetail.symbol} from user to executor...`);

    // Check user's approval to executor first with retry
    const userApproval = await retryBlockchainOperation(
      () => publicClient.readContract({
        address: fromTokenDetail.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [walletAddress as Address, executorAddress],
      }),
      'Check user approval'
    );

    console.log(`[DCA Swap] 📋 User approval to executor: ${formatUnits(userApproval, fromTokenDetail.decimals)} ${fromTokenDetail.symbol}`);

    if (userApproval < atomicAmount) {
      throw new Error(`Insufficient user approval: need ${amount} ${fromTokenDetail.symbol} but user only approved ${formatUnits(userApproval, fromTokenDetail.decimals)}`);
    }

    // Perform the transfer from user to executor with retry
    const transferTxHash = await retryBlockchainOperation(
      () => walletClient.writeContract({
        address: fromTokenDetail.address as Address,
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [walletAddress as Address, executorAddress, atomicAmount],
        account: context.custom.executeTransaction.account,
      }),
      'Transfer tokens from user to executor'
    );

    await retryBlockchainOperation(
      () => publicClient.waitForTransactionReceipt({ hash: transferTxHash }),
      'Wait for transfer confirmation'
    );
    console.log(`[DCA Swap] ✅ Transfer transaction confirmed: ${transferTxHash}`);
  }
}

// Base executeDCASwap tool implementation (transaction preparation only)
const baseExecuteDCASwapTool: VibkitToolDefinition<typeof ExecuteDCASwapParams, any, DCAContext, any> = {
  name: 'executeDCASwap',
  description: 'Prepare a token swap transaction using Ember MCP for secure execution via hooks',
  parameters: ExecuteDCASwapParams,
  execute: async (args, context) => {
    try {
      console.log(`[DCA Swap] 🔄 Preparing swap: ${args.amount} ${args.fromToken} → ${args.toToken} (${args.amountType})`);

      // Validate requirements
      if (!context.custom.executeTransaction) {
        throw new Error('Transaction execution not enabled - PRIVATE_KEY not configured');
      }
      if (!context.custom.mcpClient) {
        throw new Error('Ember MCP client not available');
      }

      // Resolve tokens
      const fromTokenDetail = findTokenDetail(args.fromToken, context.custom.tokenMap);
      console.log("fromtoken details", fromTokenDetail);
      const toTokenDetail = findTokenDetail(args.toToken, context.custom.tokenMap);

      if (!fromTokenDetail) throw new Error(`Could not resolve fromToken "${args.fromToken}"`);
      if (!toTokenDetail) throw new Error(`Could not resolve toToken "${args.toToken}"`);

      console.log(`[DCA Swap] ✅ From: ${fromTokenDetail.symbol} → To: ${toTokenDetail.symbol}`);

      // Check and handle token approvals and transfers
      await handleTokenApprovalsAndTransfer(
        context,
        fromTokenDetail,
        args.amount,
        args.walletAddress
      );
      let atomicAmount = parseUnits(args.amount, fromTokenDetail.decimals);
      if (fromTokenDetail.address == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831") {
        atomicAmount = parseUnits(args.amount, 6);
        console.log("atomic amount", atomicAmount);
      }

      // Get swap plan from Ember MCP with retry mechanism
      console.log("args.slippage", args.slippage);
      console.log("fromTokenDetail", fromTokenDetail);
      console.log("toTokenDetail", toTokenDetail);
      console.log("args.walletAddress", args.walletAddress);
      console.log("args.amountType", args.amountType);

      console.log(`[DCA Swap] 🔄 Requesting swap plan with retry mechanism...`);
      
      console.log("args.amount", args.amount);
      const swapArgs = {
        walletAddress: args.walletAddress,
        amount: args.amount,
        amountType: args.amountType,
        toChain: args.toChain,
        fromChain: args.fromChain,
        fromToken: args.fromToken,
        toToken: args.toToken,
        slippageTolerance: args.slippage,
      };

      // Use retry mechanism for network resilience
      const swapResult: any = await retryMcpCall(
        context.custom.mcpClient,
        'createSwap',
        swapArgs,
        3, // maxRetries
        5000 // baseDelay (5 seconds)
      );

      console.log(`[DCA Swap] 🔍 Swap result: ${JSON.stringify(swapResult)}`);
      if (swapResult.isError) {
        throw new Error(`Failed to get swap plan: ${swapResult.content}`);
      }

      // Parse and execute - the structuredContent is parsed directly
      const structuredContent: SwapTokensResponse = parseMcpToolResponsePayload(swapResult, SwapTokensResponseSchema);

      if (!structuredContent?.transactions || structuredContent.transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Prepared ${structuredContent.transactions.length} transaction(s) for secure execution via hooks`);

      // Calculate amounts from structured content
      const fromAmountHuman = structuredContent.displayFromAmount;
      const toAmountHuman = structuredContent.displayToAmount;
      const exchangeRate = structuredContent.estimation.effectivePrice;

      console.log(`[DCA Swap] 📈 Result: ${toAmountHuman} ${args.toToken} at rate ${exchangeRate}`);

      // Return transaction data for withHooks execution
      return {
        transactions: structuredContent.transactions,
        planId: args.planId, // Include planId if provided
        fromToken: args.fromToken,
        toToken: args.toToken,
        fromAmount: fromAmountHuman,
        toAmount: toAmountHuman,
        exchangeRate: exchangeRate,
        userAddress: args.walletAddress,
        operation: 'dca-swap',
        structuredContent: structuredContent
      };

    } catch (error) {
      console.error('[DCA Swap] ❌ Preparation failed:', error);
      throw error instanceof Error ? error : new Error(`DCA swap preparation failed: ${String(error)}`);
    }
  },
};


export const executeDCASwapTool = withHooks(baseExecuteDCASwapTool, {
  before: transactionValidationBeforeHook,
  after: transactionSigningAfterHook,
});

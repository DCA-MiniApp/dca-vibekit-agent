/**
 * Prepare DCA Swap Tool
 *
 * This tool handles the preparation of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Preparing transactions for TriggerX execution
 * 3. Returning transaction data for automated execution
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { parseUnits } from 'viem';


// Response schema for Ember MCP - matches the official ember-api schema
const SwapTokensResponseSchema = z.object({
  status: z.string(),
  orderType: z.string(),
  baseToken: z.object({
    chainId: z.string(),
    address: z.string(),
  }),
  quoteToken: z.object({
    chainId: z.string(),
    address: z.string(),
  }),
  transactions: z.array(z.object({
    type: z.string(),
    to: z.string(),
    data: z.string(),
    value: z.string(),
    chainId: z.string(),
    gas: z.string().optional(),
    gasPrice: z.string().optional(),
    maxFeePerGas: z.string().optional(),
    maxPriorityFeePerGas: z.string().optional(),
  })),
  estimation: z.object({
    baseTokenDelta: z.string(),
    quoteTokenDelta: z.string(),
    effectivePrice: z.string(),
    timeEstimate: z.string(),
    expiration: z.string(),
  }).optional(),
  chainId: z.string(),
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

const PrepareDCASwapParams = z.object({
  planId: z.string().describe('DCA plan ID for transaction preparation'),
  planDetails: z.object({
    fromToken: z.string().describe('Source token symbol (e.g., USDC)'),
    toToken: z.string().describe('Target token symbol (e.g., ETH)'),
    amount: z.string().describe('Amount to swap in source token units'),
    userAddress: z.string().describe('User wallet address for the swap'),
    slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
  }).describe('Plan details for swap preparation'),
});

// Removed ROUTER_ADDRESS and retryBlockchainOperation - blockchain operations moved to TriggerX

// Removed handleTokenApprovalsAndTransfer function - token handling moved to TriggerX and frontend

// Base prepareDCASwap tool implementation (returns only transactions)
const basePrepareDCASwapTool: VibkitToolDefinition<typeof PrepareDCASwapParams, any, DCAContext, any> = {
  name: 'prepareDCASwap',
  description: 'Prepare DCA swap transactions using Ember MCP for TriggerX execution',
  parameters: PrepareDCASwapParams,
  execute: async (args, context) => {
    try {
      const { planId, planDetails } = args;
      const { fromToken, toToken, amount, userAddress, slippage } = planDetails;

      console.log(`[DCA Swap] 🔄 Preparing swap for plan ${planId}: ${amount} ${fromToken} → ${toToken}`);

      // Validate MCP client availability
      if (!context.custom.mcpClient) {
        throw new Error('Ember MCP client not available');
      }

      // Resolve tokens
      const fromTokenDetail = findTokenDetail(fromToken, context.custom.tokenMap);
      console.log("fromtoken details", fromTokenDetail);
      const toTokenDetail = findTokenDetail(toToken, context.custom.tokenMap);

      if (!fromTokenDetail) throw new Error(`Could not resolve fromToken "${fromToken}"`);
      if (!toTokenDetail) throw new Error(`Could not resolve toToken "${toToken}"`);

      console.log(`[DCA Swap] ✅ From: ${fromTokenDetail.symbol} → To: ${toTokenDetail.symbol}`);

      // Calculate atomic amount for swap
      let atomicAmount = parseUnits(amount, fromTokenDetail.decimals);
      if (fromTokenDetail.address == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831") {
        atomicAmount = parseUnits(amount, 6);
        console.log("atomic amount", atomicAmount);
      }

      console.log(`[DCA Swap] 🔄 Requesting swap plan with retry mechanism...`);

      const swapArgs = {
        orderType: 'MARKET_SELL',
        baseToken: {
          chainId: fromTokenDetail.chainId.toString(),
          address: fromTokenDetail.address,
        },
        quoteToken: {
          chainId: toTokenDetail.chainId.toString(),
          address: toTokenDetail.address,
        },
        amount: atomicAmount.toString(),
        recipient: userAddress, // Send swapped tokens to user
        slippageTolerance: slippage,
      };

      // Use retry mechanism for network resilience
      const swapResult: any = await retryMcpCall(
        context.custom.mcpClient,
        'swapTokens',
        swapArgs,
        3, // maxRetries
        5000 // baseDelay (5 seconds)
      );

      console.log(`[DCA Swap] 🔍 Swap result: ${JSON.stringify(swapResult)}`);
      if (swapResult.isError) {
        throw new Error(`Failed to get swap plan: ${swapResult.content}`);
      }

      // Parse response
      const parsedResponse: SwapTokensResponse = parseMcpToolResponsePayload(swapResult, SwapTokensResponseSchema);
      const { transactions } = parsedResponse;

      if (!transactions || transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Prepared ${transactions.length} transaction(s) for TriggerX execution`);

      // Return only transactions for TriggerX
      return {
        planId,
        transactions,
        metadata: {
          fromToken,
          toToken,
          amount,
          userAddress,
          slippage
        }
      };

    } catch (error) {
      console.error('[DCA Swap] ❌ Preparation failed:', error);
      // Record failed preparation in database
      try {
        if (context?.custom?.prisma && args?.planId) {
          await context.custom.prisma.executionHistory.create({
            data: {
              planId: args.planId,
              fromAmount: args.planDetails.amount || '0',
              toAmount: '0',
              exchangeRate: '0',
              gasFee: null,
              txHash: null,
              status: 'FAILED',
              errorMessage: error instanceof Error ? error.message : String(error),
            },
          });
          console.log('[DCA Swap] 📝 Recorded FAILED preparation');
        }
      } catch (dbError) {
        console.error('[DCA Swap] ❌ Failed to record preparation error in DB:', dbError);
      }
      throw error instanceof Error ? error : new Error(`DCA swap preparation failed: ${String(error)}`);
    }
  },
};


// Export the tool for TriggerX execution
export const prepareDCASwapTool = basePrepareDCASwapTool;

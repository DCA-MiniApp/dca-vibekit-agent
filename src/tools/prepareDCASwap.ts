/**
 * Prepare DCA Swap Tool
 *
 * This tool handles the preparation of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Preparing transactions for TriggerX execution
 * 3. Returning transaction data for automated execution
 *
 * Examples:
 * - "Prepare a DCA plan to invest 10 USDC into WETH every week up to 1 month"
 * - "Create a DCA plan to invest 100 USDC into ETH every week for 6 months"
 * - "Set up automated DCA investment of 50 USDC to ARB weekly for 3 months"
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { parseUnits } from 'viem';
import { CreateSwapResponseSchema, type CreateSwapResponse } from '../types/shared.js';


// Schema is now imported from shared.ts

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
      console.log("args", args);
      // const tools = await mcpClient.listTools();
      // console.log("tools", tools);
      // const createSwapTool = tools.tools.find((t: any) => t.name === "createSwap");

      // console.log(
      //   "createSwap.inputSchema",
      //   JSON.stringify(createSwapTool.inputSchema, null, 2)
      // );

      // console.log(
      //   "createSwap.outputSchema",
      //   JSON.stringify(createSwapTool.outputSchema, null, 2)
      // );

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
        console.log(`[MCP Retry] 🔄 Network error detected, retrying in ${delay / 1000} seconds...`);
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
  planId: z.string().optional().describe('DCA plan ID for transaction preparation (optional - if not provided, will generate temporary ID)'),
  planDetails: z.object({
    fromToken: z.string().describe('Source token symbol (e.g., USDC)'),
    toToken: z.string().describe('Target token symbol (e.g., ETH)'),
    amount: z.string().describe('Amount to swap in source token units'),
    userAddress: z.string().describe('User wallet address for the swap'),
    slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
  }).describe('Plan details for swap preparation'),
}).or(z.object({
  fromToken: z.string().describe('Source token symbol (e.g., USDC)'),
  toToken: z.string().describe('Target token symbol (e.g., WETH, ETH)'),
  amount: z.string().describe('Amount to swap in source token units'),
  userAddress: z.string().describe('User wallet address for the swap'),
  slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
  planId: z.string().optional().describe('DCA plan ID (optional)'),
}));

// Removed ROUTER_ADDRESS and retryBlockchainOperation - blockchain operations moved to TriggerX

// Removed handleTokenApprovalsAndTransfer function - token handling moved to TriggerX and frontend

// Base prepareDCASwap tool implementation (returns only transactions)
const basePrepareDCASwapTool: VibkitToolDefinition<typeof PrepareDCASwapParams, any, DCAContext, any> = {
  name: 'prepareDCASwap',
  description: 'PREPARE swap transactions for TriggerX automation. Use this when users say "PREPARE", "SET UP", "AUTOMATE" a DCA plan and need transaction data. Creates swap transactions via Ember MCP - e.g., "Prepare a DCA plan to invest 10 USDC into WETH", "Set up automated investment", "Prepare transactions for DCA"',
  parameters: PrepareDCASwapParams,
  execute: async (args, context) => {
    try {
      // Handle both parameter formats
      let planId: string;
      let fromToken: string, toToken: string, amount: string, userAddress: string, slippage: string;
      
      if ('planDetails' in args) {
        // Format 1: { planId?, planDetails: {...} }
        planId = args.planId || `temp-${Date.now()}`;
        ({ fromToken, toToken, amount, userAddress, slippage } = args.planDetails);
      } else {
        // Format 2: { fromToken, toToken, amount, userAddress, slippage, planId? }
        planId = args.planId || `temp-${Date.now()}`;
        ({ fromToken, toToken, amount, userAddress, slippage } = args);
      }

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
        walletAddress: userAddress,              // string
        fromChain: fromTokenDetail.chainId.toString(), // string
        toChain: toTokenDetail.chainId.toString(),     // string
        fromToken: fromTokenDetail.symbol,      // string (token contract address)
        toToken: toTokenDetail.symbol,          // string (token contract address)
        amount: amount.toString(),         // string (amount in human readable format)
        amountType: "exactIn",                   // or "exactOut"
        // slippageTolerance: "0.5",           // string (percentage or bps depending on API)
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
        throw new Error(
          `Failed to get swap plan: ${JSON.stringify(swapResult.content, null, 2)}`
        );
      }

      // Parse response using the new schema
      const parsedResponse: CreateSwapResponse = parseMcpToolResponsePayload(swapResult, CreateSwapResponseSchema);

      // Extract data from the new response format
      const {
        transactions,
        exactFromAmount,
        exactToAmount,
        displayFromAmount,
        displayToAmount,
        feeBreakdown,
        estimation,
        providerTracking
      } = parsedResponse;

      if (!transactions || transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Prepared ${transactions.length} transaction(s) for TriggerX execution`);
      console.log(`[DCA Swap] 📊 Swap details: ${displayFromAmount} → ${displayToAmount}`);

      if (feeBreakdown) {
        console.log(`[DCA Swap] 💰 Fees: ${feeBreakdown.total} ${feeBreakdown.feeDenomination}`);
      }

      // Return success task with proper format for /sse endpoint
      const artifactData = {
        fromToken,
        toToken,
        amount,
        planId,
        transactions,
        userAddress,
        slippage,
        metadata: {
          exactFromAmount,
          exactToAmount,
          displayFromAmount,
          displayToAmount,
          feeBreakdown,
          estimation,
          providerTracking,
        }
      };

      const artifact = {
        artifactId: `prepare-swap-${planId}`,
        parts: [{
          kind: 'text' as const,
          text: JSON.stringify(artifactData, null, 2)
        }]
      };

      return createSuccessTask(
        'prepareDCASwap',
        [artifact],
        `✅ Prepared ${transactions.length} transaction(s) for ${amount} ${fromToken} → ${toToken}`
      );

    } catch (error) {
      console.error('[DCA Swap] ❌ Preparation failed:', error);
      if (error && typeof error === 'object' && 'response' in error) {
        const errorWithResponse = error as { response: { status: number; data: any } };
        console.error("Status:", errorWithResponse.response.status);
        console.error("Data:", JSON.stringify(errorWithResponse.response.data, null, 2));
      }

      // As a catch-all: stringify everything
      console.error("Full error JSON:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      // Record failed preparation in database (only if real plan ID)
      try {
        // Extract planId and amount for error logging
        let errorPlanId: string | undefined;
        let errorAmount = '0';
        
        if ('planDetails' in args) {
          errorPlanId = args.planId;
          errorAmount = args.planDetails?.amount || '0';
        } else {
          errorPlanId = args.planId;
          errorAmount = args.amount || '0';
        }
        
        if (context?.custom?.prisma && errorPlanId && !errorPlanId.startsWith('temp-')) {
          await context.custom.prisma.executionHistory.create({
            data: {
              planId: errorPlanId,
              fromAmount: errorAmount,
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
      return createErrorTask(
        'prepareDCASwap',
        error instanceof Error ? error : new Error(`DCA swap preparation failed: ${String(error)}`)
      );
    }
  },
};


// Export the tool for TriggerX execution
export const prepareDCASwapTool = basePrepareDCASwapTool;

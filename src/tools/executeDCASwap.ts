/**
 * Execute DCA Swap Tool
 * 
 * This tool handles the actual execution of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Executing the transaction using the private key
 * 3. Recording the execution in the database
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { formatUnits, parseUnits } from 'viem';

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

const ExecuteDCASwapParams = z.object({
  planId: z.string().describe('DCA plan ID to execute'),
  fromToken: z.string().describe('Source token symbol (e.g., USDC)'),
  toToken: z.string().describe('Target token symbol (e.g., ETH)'),
  amount: z.string().describe('Amount to swap in source token units'),
  userAddress: z.string().describe('User wallet address for the swap'),
  slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
});

export const executeDCASwapTool: VibkitToolDefinition<typeof ExecuteDCASwapParams, any, DCAContext, any> = {
  name: 'executeDCASwap',
  description: 'Execute a DCA swap transaction using Ember MCP and record the result in the database',
  parameters: ExecuteDCASwapParams,
  execute: async (args, context) => {
    try {
      console.log(`[DCA Swap] 🔄 Executing swap for plan ${args.planId}: ${args.amount} ${args.fromToken} → ${args.toToken}`);

      // Validate requirements
      if (!context.custom.executeTransaction) {
        throw new Error('Transaction execution not enabled - PRIVATE_KEY not configured');
      }
      if (!context.custom.mcpClient) {
        throw new Error('Ember MCP client not available');
      }

      // Resolve tokens
      const fromTokenDetail = findTokenDetail(args.fromToken, context.custom.tokenMap);
      const toTokenDetail = findTokenDetail(args.toToken, context.custom.tokenMap);
      
      if (!fromTokenDetail) throw new Error(`Could not resolve fromToken "${args.fromToken}"`);
      if (!toTokenDetail) throw new Error(`Could not resolve toToken "${args.toToken}"`);

      console.log(`[DCA Swap] ✅ From: ${fromTokenDetail.symbol} → To: ${toTokenDetail.symbol}`);

      // Get swap plan from Ember MCP
      const atomicAmount = parseUnits(args.amount, fromTokenDetail.decimals);
      const swapResult = await context.custom.mcpClient.callTool({
        name: 'swapTokens',
        arguments: {
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
          recipient: args.userAddress,
          slippageTolerance: args.slippage,
        },
      });

      if (swapResult.isError) {
        throw new Error(`Failed to get swap plan: ${swapResult.content}`);
      }

      // Parse and execute - NOW PROPERLY TYPED
      const parsedResponse: SwapTokensResponse = parseMcpToolResponsePayload(swapResult, SwapTokensResponseSchema);
      const { transactions, estimation } = parsedResponse;

      if (!transactions || transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Executing ${transactions.length} transaction(s)`);

      // Execute transactions
      const executionResult = await context.custom.executeTransaction.executeDCASwap(
        args.planId,
        transactions
      );

      console.log(`[DCA Swap] ✅ Transaction executed: ${executionResult.txHash}`);

      // Calculate amounts - NOW WITH PROPER TYPE SAFETY
      const fromAmountHuman = args.amount;
      let toAmountHuman = '0';
      let exchangeRate = '0';

      if (estimation) {
        toAmountHuman = safeToHuman(estimation.quoteTokenDelta);
        exchangeRate = safeToHuman(estimation.effectivePrice);
        console.log(`[DCA Swap] 📈 Result: ${toAmountHuman} ${args.toToken} at rate ${exchangeRate}`);
      }

      // Record in database
      const executionRecord = await context.custom.prisma.executionHistory.create({
        data: {
          planId: args.planId,
          fromAmount: fromAmountHuman,
          toAmount: toAmountHuman,
          exchangeRate: exchangeRate,
          gasFee: executionResult.gasUsed.toString(),
          txHash: executionResult.txHash,
          status: 'SUCCESS',
        },
      });

      console.log(`[DCA Swap] 📝 Success recorded in database: ${executionRecord.id}`);

      // Update plan
      const plan = await context.custom.prisma.dcaPlan.findUnique({
        where: { id: args.planId },
      });

      if (plan) {
        const newExecutionCount = plan.executionCount + 1;
        const nextExecution = new Date(Date.now() + plan.intervalMinutes * 60 * 1000);
        const isCompleted = newExecutionCount >= plan.totalExecutions;

        await context.custom.prisma.dcaPlan.update({
          where: { id: args.planId },
          data: {
            executionCount: newExecutionCount,
            nextExecution: isCompleted ? null : nextExecution,
            status: isCompleted ? 'COMPLETED' : 'ACTIVE',
            updatedAt: new Date(),
          },
        });

        console.log(`[DCA Swap] 📊 Plan updated: ${newExecutionCount}/${plan.totalExecutions} executions`);
      }

      return createSuccessTask(
        'executeDCASwap',
        [],
        `DCA swap executed: ${fromAmountHuman} ${args.fromToken} → ${toAmountHuman} ${args.toToken} (tx: ${executionResult.txHash})`
      );

    } catch (error) {
      console.error('[DCA Swap] ❌ Execution failed:', error);

      // Record failure
      try {
        await context.custom.prisma.executionHistory.create({
          data: {
            planId: args.planId,
            fromAmount: args.amount,
            toAmount: '0',
            exchangeRate: '0',
            gasFee: null,
            txHash: null,
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (dbError) {
        console.error('[DCA Swap] ❌ Database error:', dbError);
      }

      return createErrorTask(
        'executeDCASwap',
        error instanceof Error ? error : new Error(`DCA swap failed: ${String(error)}`)
      );
    }
  },
};

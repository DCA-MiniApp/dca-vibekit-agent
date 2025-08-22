/**
 * Execute DCA Swap Tool
 * 
 * This tool handles the actual execution of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Executing the transaction using the private key
 * 3. Recording the execution in the database
 * 
 * This tool will be used by the scheduler in Phase 5
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { formatUnits, parseUnits } from 'viem';

// Proper response schema based on real Ember MCP responses
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
  chainId: number = 42161 // Default to Arbitrum
): TokenInfo | null {
  const upperSymbol = tokenSymbol.toUpperCase();

  // Look for exact symbol match on the specified chain
  const tokens = tokenMap[upperSymbol];
  if (!tokens || tokens.length === 0) {
    return null;
  }

  // Find token on the correct chain
  const tokenOnChain = tokens.find(token => token.chainId === chainId);
  return tokenOnChain || null;
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

      // Check if transaction execution is enabled
      if (!context.custom.executeTransaction) {
        throw new Error('Transaction execution not enabled - PRIVATE_KEY not configured');
      }

      // Check if Ember MCP client is available

      console.log('context.custom.mcpClient', context.custom.mcpClient ? 'exists' : 'does not exist');
      if (!context.custom.mcpClient) {
        throw new Error('Ember MCP client not available');
      }

      // 🎯 STEP 1: Resolve token symbols to addresses and chain IDs
      console.log('[DCA Swap] 📍 Resolving token details...');
      const arbitrumChainId = 42161;

      const fromTokenDetail = findTokenDetail(args.fromToken, context.custom.tokenMap, arbitrumChainId);
      if (!fromTokenDetail) {
        throw new Error(`Could not resolve fromToken "${args.fromToken}" on Arbitrum (chainId: ${arbitrumChainId})`);
      }

      const toTokenDetail = findTokenDetail(args.toToken, context.custom.tokenMap, arbitrumChainId);
      if (!toTokenDetail) {
        throw new Error(`Could not resolve toToken "${args.toToken}" on Arbitrum (chainId: ${arbitrumChainId})`);
      }

      console.log(`[DCA Swap] ✅ From Token: ${fromTokenDetail.symbol} (${fromTokenDetail.address})`);
      console.log(`[DCA Swap] ✅ To Token: ${toTokenDetail.symbol} (${toTokenDetail.address})`);

      // 🎯 STEP 2: Convert human amount to atomic units
      const atomicAmount = parseUnits(args.amount, fromTokenDetail.decimals);
      console.log(`[DCA Swap] 💰 Amount: ${args.amount} ${args.fromToken} = ${atomicAmount.toString()} atomic units`);

      // 🎯 STEP 3: Call Ember MCP with CORRECT format
      console.log('[DCA Swap] 🤝 Getting swap plan from Ember MCP...');
      // console.log("context.custom.mcpClient.listTools()", await context.custom.mcpClient.listTools());
      // 🔥 CRITICAL: Check if we should use executor address instead of user address
      const executorAddress = context.custom.executeTransaction?.executorAddress;
      console.log("🔍 Address Analysis:");
      console.log("  - User Address (recipient):", args.userAddress);
      console.log("  - Executor Address (private key):", executorAddress);
      console.log("  - Using executor as source: tokens & ETH must be in executor wallet");
      
      console.log("📊 Swap Parameters:");
      console.log("  - Slippage:", args.slippage);
      console.log("  - From Token:", fromTokenDetail.chainId, fromTokenDetail.address);
      console.log("  - To Token:", toTokenDetail.chainId, toTokenDetail.address);
      console.log("  - Amount (atomic):", atomicAmount.toString());
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

      console.log("swapResult normally", swapResult.structuredContent);
      if (swapResult.isError) {
        console.error('[DCA Swap] ❌ Ember MCP swap error:', swapResult.content);
        throw new Error(`Failed to get swap plan: ${swapResult.content}`);
      }

      // 🎯 STEP 4: Parse response with proper schema validation
      console.log('[DCA Swap] 📊 Parsing Ember MCP response...');
      let parsedResponse: SwapTokensResponse;

      try {
        parsedResponse = parseMcpToolResponsePayload(swapResult, SwapTokensResponseSchema);
      } catch (parseError) {
        console.error('[DCA Swap] ❌ Failed to parse MCP response:', parseError);
        console.error('[DCA Swap] Raw response content:', JSON.stringify(swapResult.content, null, 2));
        console.error('[DCA Swap] Raw response structuredContent:', JSON.stringify(swapResult.structuredContent, null, 2));
        throw new Error(`Invalid response format from Ember MCP: ${parseError}`);
      }

      console.log("[DCA Swap] 📊 Parsed response:", JSON.stringify(parsedResponse, null, 2));
      const { transactions, estimation } = parsedResponse;

      if (!transactions || transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Received ${transactions.length} transaction(s) to execute`);
      
      // Log each transaction for debugging
      transactions.forEach((tx, index) => {
        console.log(`[DCA Swap] 📋 Transaction ${index + 1}:`, {
          to: tx.to,
          value: tx.value || '0',
          dataPrefix: tx.data ? tx.data.substring(0, 10) + '...' : 'no data',
          dataLength: tx.data ? tx.data.length : 0,
          chainId: tx.chainId,
          gas: tx.gas || 'not set',
          gasPrice: tx.gasPrice || 'not set',
          maxFeePerGas: tx.maxFeePerGas || 'not set',
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas || 'not set',
        });
      });

      // 🎯 STEP 5: Execute the swap transaction
      const executionResult = await context.custom.executeTransaction.executeDCASwap(
        args.planId,
        transactions
      );

      console.log(`[DCA Swap] ✅ Transaction executed successfully: ${executionResult.txHash}`);

      // 🎯 STEP 6: Calculate proper amounts and exchange rates
      const fromAmountHuman = args.amount; // Original human input
      const fromAmountAtomic = atomicAmount.toString();

      // Use estimation from Ember MCP if available, otherwise use execution result
      let toAmountAtomic = '0';
      let toAmountHuman = '0';
      let exchangeRate = '0';

      if (estimation) {
        // quoteTokenDelta is the amount we're receiving (in atomic units)
        toAmountAtomic = estimation.quoteTokenDelta;
        exchangeRate = estimation.effectivePrice;

        // Convert atomic amount to human-readable
        toAmountHuman = formatUnits(BigInt(toAmountAtomic), toTokenDetail.decimals);

        console.log(`[DCA Swap] 📈 Estimation: ${toAmountAtomic} atomic units = ${toAmountHuman} ${args.toToken}`);
        console.log(`[DCA Swap] 📈 Effective price: ${exchangeRate}`);
      } else {
        // Fallback: try to extract from execution result
        toAmountAtomic = executionResult.toAmount || '0';

        if (toAmountAtomic !== '0') {
          toAmountHuman = formatUnits(BigInt(toAmountAtomic), toTokenDetail.decimals);
        }

        // Calculate exchange rate manually if not provided
        if (toAmountAtomic !== '0' && fromAmountAtomic !== '0') {
          const fromAmountBigInt = BigInt(fromAmountAtomic);
          const toAmountBigInt = BigInt(toAmountAtomic);

          // Calculate price as toAmount/fromAmount (adjusted for decimals)
          const fromAmountFloat = parseFloat(formatUnits(fromAmountBigInt, fromTokenDetail.decimals));
          const toAmountFloat = parseFloat(formatUnits(toAmountBigInt, toTokenDetail.decimals));

          exchangeRate = toAmountFloat > 0 ? (toAmountFloat / fromAmountFloat).toString() : '0';
        }

        console.log(`[DCA Swap] 📈 Fallback calculation: ${toAmountAtomic} atomic units = ${toAmountHuman} ${args.toToken}`);
      }

      console.log(`[DCA Swap] 💹 Final amounts: ${fromAmountHuman} ${args.fromToken} → ${toAmountHuman} ${args.toToken}`);
      console.log(`[DCA Swap] 💹 Exchange rate: ${exchangeRate}`);

      // 🎯 STEP 7: Record execution in database
      console.log('[DCA Swap] 💾 Recording execution in database...');
      await context.custom.prisma.executionHistory.create({
        data: {
          planId: args.planId,
          fromAmount: fromAmountHuman, // Human-readable amount
          toAmount: toAmountHuman, // Human-readable amount  
          exchangeRate: exchangeRate,
          gasFee: executionResult.gasUsed.toString(), // Convert BigInt to string
          txHash: executionResult.txHash,
          status: 'SUCCESS',
        },
      });

      // 🎯 STEP 8: Update plan execution count and next execution time
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
            nextExecution: isCompleted ? undefined : nextExecution,
            status: isCompleted ? 'COMPLETED' : 'ACTIVE',
            updatedAt: new Date(),
          },
        });

        console.log(`[DCA Swap] 📊 Plan updated: ${newExecutionCount}/${plan.totalExecutions} executions`);

        if (isCompleted) {
          console.log(`[DCA Swap] 🎉 Plan ${args.planId} completed all executions!`);
        }
      }

      return createSuccessTask(
        'executeDCASwap',
        [],
        `DCA swap executed: ${fromAmountHuman} ${args.fromToken} → ${toAmountHuman} ${args.toToken} (tx: ${executionResult.txHash})`
      );

    } catch (error) {
      console.error('[DCA Swap] ❌ Execution failed:', error);

      // Record failed execution in database
      try {
        await context.custom.prisma.executionHistory.create({
          data: {
            planId: args.planId,
            fromAmount: args.amount, // Human-readable amount
            toAmount: '0',
            exchangeRate: '0',
            gasFee: null,
            txHash: null,
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });

        console.log('[DCA Swap] 📝 Failed execution recorded in database');
      } catch (dbError) {
        console.error('[DCA Swap] ❌ Failed to record error in database:', dbError);
      }

      return createErrorTask(
        'executeDCASwap',
        error instanceof Error ? error : new Error(`DCA swap failed: ${String(error)}`)
      );
    }
  },
};

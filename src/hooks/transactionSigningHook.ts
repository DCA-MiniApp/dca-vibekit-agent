import { createSuccessTask, createErrorTask } from 'arbitrum-vibekit-core';
import type { AfterHook } from './withHooks.js';
import type { DCAContext } from '../context/types.js';

/**
 * Transaction execution result interface
 */
interface TransactionResult {
  transactions: any[];
  [key: string]: any;
}

/**
 * After hook for secure transaction signing and execution using Vibekit's withHooks pattern.
 * This hook handles the transaction signing and execution for blockchain operations.
 *
 * @param result The result from the tool execution containing transactions to execute
 * @param context The agent context with transaction executor
 * @param args The original tool arguments
 * @returns Task with execution result or error
 */
export const transactionSigningAfterHook: AfterHook<TransactionResult, any, DCAContext> = async (
  result,
  context,
  args
) => {
  try {
    // Extract transactions and DCA-specific data from the result
    console.log("result in transactionSigningAfterHook", result);
    const { transactions, planId, fromToken, toToken, fromAmount, toAmount, exchangeRate, userAddress, ...otherData } = result;
    
    // Get user address from either the result or args (support both legacy and new parameter names)
    const finalUserAddress = userAddress || args.userAddress || args.walletAddress;
    
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      throw new Error('No transactions to execute');
    }

    console.log(`🔐 [withHooks] Executing ${transactions.length} transaction(s) with secure signing...`);
    
    // Use the transaction executor from context for secure signing
    if (!context.custom.executeTransaction) {
      throw new Error('Transaction executor not available');
    }
    
    const executionResult = await context.custom.executeTransaction.executeDCASwap(
      planId || `${finalUserAddress}-transaction`, 
      transactions
    );

    console.log(`✅ [withHooks] Transaction executed: ${executionResult.txHash}`);

    // Record in database only if we have a valid planId (for DCA plan executions)
    let executionRecord = null;
    if (planId) {
      executionRecord = await context.custom.prisma.executionHistory.create({
        data: {
          planId: planId,
          fromAmount: fromAmount || '0',
          toAmount: toAmount || '0',
          exchangeRate: exchangeRate || '0',
          // Store total gas cost in ETH as string (reusing existing gasFee column)
          gasFee: executionResult.gasCostEth,
          txHash: executionResult.txHash,
          status: 'SUCCESS',
        },
      });
      console.log(`📝 [withHooks] Success recorded in database: ${executionRecord.id}`);
    } else {
      console.log(`📝 [withHooks] No planId provided - skipping database recording (standalone swap)`);
    }

    // Update plan
    if (planId) {
      const plan = await context.custom.prisma.dcaPlan.findUnique({
        where: { id: planId },
      });

      if (plan) {
        const newExecutionCount = plan.executionCount + 1;
        // Set next execution based on interval from now
        const nextExecution = new Date(Date.now() + plan.intervalMinutes * 60 * 1000);
        const isCompleted = newExecutionCount >= plan.totalExecutions;

        await context.custom.prisma.dcaPlan.update({
          where: { id: planId },
          data: {
            executionCount: newExecutionCount,
            nextExecution: isCompleted ? null : nextExecution,
            status: isCompleted ? 'COMPLETED' : 'ACTIVE',
            updatedAt: new Date(),
          },
        });

        console.log(`📊 [withHooks] Plan updated: ${newExecutionCount}/${plan.totalExecutions} executions`);
        if (!isCompleted) {
          console.log(`⏰ [withHooks] Next execution scheduled for: ${nextExecution.toISOString()}`);
        }
      }
    }

    // Return success task with execution details
    return createSuccessTask(
      'executeDCASwap',
      [],
      `DCA swap executed: ${fromAmount} ${fromToken} → ${toAmount} ${toToken} (tx: ${executionResult.txHash})`
    );

  } catch (error) {
    console.error('❌ [withHooks] Transaction signing/execution failed:', error);
    
    // Record failure only if we have a valid planId
    try {
      if (result.planId && context.custom.prisma) {
        await context.custom.prisma.executionHistory.create({
          data: {
            planId: result.planId,
            fromAmount: args.amount || '0',
            toAmount: '0',
            exchangeRate: '0',
            gasFee: null,
            txHash: null,
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        console.log('[withHooks] 📝 Recorded FAILED execution in database');
      } else {
        console.log('[withHooks] 📝 No planId for failed execution - skipping database recording (standalone swap)');
      }
    } catch (dbError) {
      console.error('❌ [withHooks] Database error:', dbError);
    }
    
    return createErrorTask(
      'executeDCASwap',
      error instanceof Error ? error : new Error(`DCA swap failed: ${error}`)
    );
  }
};

/**
 * Before hook for transaction validation and security checks.
 * This can be used to validate inputs before transaction preparation.
 */
export const transactionValidationBeforeHook = async (args: any, context: any) => {
  // Validate required fields - check both userAddress (legacy) and walletAddress (new)
  const userAddress = args.userAddress || args.walletAddress;
  if (!userAddress) {
    throw new Error('User address is required for transaction execution');
  }

  if (args.amount && parseFloat(args.amount) <= 0) {
    throw new Error('Valid amount is required for transaction execution');
  }

  console.log(`🔍 [withHooks] Transaction validation passed for user: ${userAddress}`);
  
  // Return processed args (no changes in this case)
  return args;
};

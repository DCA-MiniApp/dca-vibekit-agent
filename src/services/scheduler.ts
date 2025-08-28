/**
 * DCA Scheduler Service
 * 
 * Multi-user DCA automation system with database-driven polling.
 * Supports unlimited concurrent users with individual DCA strategies.
 * 
 * Key Features:
 * - Database-driven polling every 60 seconds (configurable)
 * - Parallel execution with error isolation per user
 * - Comprehensive error handling and recovery
 * - Plan completion and status management
 * - Performance monitoring and logging
 */

import { PrismaClient, DcaPlan, DcaStatus } from '@prisma/client';
import { TaskState } from '@google-a2a/types';
import type { DCAContext } from '../context/types.js';
import { executeDCASwapTool } from '../tools/executeDCASwap.js';

export interface SchedulerConfig {
  intervalSeconds: number;
  maxConcurrentExecutions: number;
  retryAttempts: number;
  retryDelayMs: number;
  enableMetrics: boolean;
}

export interface SchedulerMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  lastExecutionTime: Date | null;
  averageExecutionTime: number;
  activePlansCount: number;
}

export class DCAScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private context: DCAContext;
  private config: SchedulerConfig;
  private metrics: SchedulerMetrics;

  constructor(context: DCAContext, config: Partial<SchedulerConfig> = {}) {
    this.context = context;
    this.config = {
      intervalSeconds: parseInt(process.env.SCHEDULER_INTERVAL_SECONDS || '600', 10),
      maxConcurrentExecutions: parseInt(process.env.MAX_CONCURRENT_EXECUTIONS || '50', 10),
      retryAttempts: 3,
      retryDelayMs: 5000,
      enableMetrics: process.env.ENABLE_METRICS === 'true',
      ...config,
    };

    this.metrics = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      lastExecutionTime: null,
      averageExecutionTime: 0,
      activePlansCount: 0,
    };
  }

  /**
   * Start the DCA scheduler
   */
  async startScheduler(): Promise<void> {
    if (this.isRunning) {
      console.warn('[Scheduler] DCA scheduler is already running');
      return;
    }

    // Check if transaction execution is enabled
    if (!this.context.executeTransaction) {
      console.error('[Scheduler] ❌ Cannot start scheduler - transaction execution not enabled');
      console.error('[Scheduler]    Please provide PRIVATE_KEY in environment variables');
      throw new Error('Transaction execution not enabled - PRIVATE_KEY required');
    }

    console.log(`[Scheduler] 🚀 Starting multi-user DCA scheduler...`);
    console.log(`[Scheduler]    - Interval: ${this.config.intervalSeconds} seconds`);
    console.log(`[Scheduler]    - Max concurrent executions: ${this.config.maxConcurrentExecutions}`);
    console.log(`[Scheduler]    - Retry attempts: ${this.config.retryAttempts}`);
    console.log(`[Scheduler]    - Metrics enabled: ${this.config.enableMetrics}`);
    console.log(`[Scheduler]    - Using executeDCASwapTool for consistency`);

    this.isRunning = true;

    // Initial execution
    await this.processDuePlans();

    // Set up recurring execution
    this.intervalId = setInterval(async () => {
      try {
        if (this.isRunning) {
          await this.processDuePlans();
        }
      } catch (error) {
        console.error('[Scheduler] ❌ Critical scheduler error:', error);
        // Continue running despite errors
      }
    }, this.config.intervalSeconds * 1000);

    console.log('[Scheduler] ✅ DCA scheduler started successfully');
  }

  /**
   * Stop the DCA scheduler
   */
  async stopScheduler(): Promise<void> {
    if (!this.isRunning) {
      console.warn('[Scheduler] DCA scheduler is not running');
      return;
    }

    console.log('[Scheduler] 🛑 Stopping DCA scheduler...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('[Scheduler] ✅ DCA scheduler stopped successfully');
  }

  /**
   * Get current scheduler status
   */
  getStatus(): { isRunning: boolean; metrics: SchedulerMetrics; config: SchedulerConfig } {
    return {
      isRunning: this.isRunning,
      metrics: { ...this.metrics },
      config: { ...this.config },
    };
  }

  /**
   * Process all plans due for execution
   */
  private async processDuePlans(): Promise<void> {
    const executionStart = Date.now();

    try {
      // Get all plans due for execution across ALL users
      const duePlans = await this.context.prisma.dcaPlan.findMany({
        where: {
          status: 'ACTIVE',
          nextExecution: {
            not: null,  // Only plans with scheduled execution (not completed)
            lte: new Date(),
          },
        },
        include: {
          executions: {
            orderBy: { executedAt: 'desc' },
            take: 1, // Get latest execution for context
          },
        },
        orderBy: {
          nextExecution: 'asc', // Process earliest due plans first
        },
      });

      this.metrics.activePlansCount = await this.context.prisma.dcaPlan.count({
        where: { status: 'ACTIVE' },
      });

      if (duePlans.length === 0) {
        console.log(`[Scheduler] 📋 No DCA plans due for execution (${this.metrics.activePlansCount} active plans)`);
        return;
      }

      console.log(`[Scheduler] 📋 Found ${duePlans.length} plans due for execution`);

      // Process plans in batches to control concurrency
      const batches = this.createExecutionBatches(duePlans);
      let totalProcessed = 0;
      let totalSuccessful = 0;
      let totalFailed = 0;

      for (const batch of batches) {
        console.log(`[Scheduler] ⚡ Processing batch of ${batch.length} plans...`);

        // Execute all plans in the batch in parallel
        const batchResults = await Promise.allSettled(
          batch.map(plan => this.executeDCAPlan(plan))
        );

        // Count results
        const batchSuccessful = batchResults.filter(r => r.status === 'fulfilled').length;
        const batchFailed = batchResults.filter(r => r.status === 'rejected').length;

        totalProcessed += batch.length;
        totalSuccessful += batchSuccessful;
        totalFailed += batchFailed;

        console.log(`[Scheduler] 📊 Batch complete: ${batchSuccessful} successful, ${batchFailed} failed`);

        // Small delay between batches to prevent overwhelming the system
        if (batches.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Update metrics
      this.metrics.totalExecutions += totalProcessed;
      this.metrics.successfulExecutions += totalSuccessful;
      this.metrics.failedExecutions += totalFailed;
      this.metrics.lastExecutionTime = new Date();

      const executionTime = Date.now() - executionStart;
      this.metrics.averageExecutionTime =
        (this.metrics.averageExecutionTime + executionTime) / 2;

      console.log(`[Scheduler] ✅ Execution complete: ${totalSuccessful}/${totalProcessed} successful (${executionTime}ms)`);

    } catch (error) {
      console.error('[Scheduler] ❌ Error processing due plans:', error);
      this.metrics.failedExecutions++;
    }
  }

  /**
   * Create execution batches to control concurrency
   */
  private createExecutionBatches(plans: DcaPlan[]): DcaPlan[][] {
    const batches: DcaPlan[][] = [];
    const batchSize = this.config.maxConcurrentExecutions;

    for (let i = 0; i < plans.length; i += batchSize) {
      batches.push(plans.slice(i, i + batchSize));
    }

    return batches;
  }

  /**
   * 🎯 FIXED: Execute DCA plan using the SAME TOOL with proper Task status checking
   */
  private async executeDCAPlan(plan: DcaPlan): Promise<void> {
    const planId = plan.id;
    const userAddress = plan.userAddress;

    console.log(`[Scheduler] 🔄 Executing DCA plan ${planId}: ${plan.amount} ${plan.fromToken} → ${plan.toToken} for ${userAddress}`);

    let lastError: Error | null = null;

    // Retry logic
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        // Check if plan is still active (might have been paused/cancelled during execution)
        const currentPlan = await this.context.prisma.dcaPlan.findUnique({
          where: { id: planId },
        });

        if (!currentPlan || currentPlan.status !== 'ACTIVE') {
          console.log(`[Scheduler] ⏭️  Plan ${planId} is no longer active, skipping`);
          return;
        }

        // 🎯 USE THE SAME TOOL - No code duplication!
        // Create a context wrapper for the tool (tools expect context.custom.*)
        const toolContext = {
          custom: this.context, // Wrap DCA context in custom property for tool compatibility
        };

        console.log(`[Scheduler] 🔧 Calling executeDCASwapTool for plan ${planId}...`);
        const toolResult = await executeDCASwapTool.execute(
          {
            planId: plan.id,
            fromToken: plan.fromToken,
            toToken: plan.toToken,
            amount: plan.amount.toString(),
            userAddress: plan.userAddress,
            slippage: plan.slippage.toString(),
          },
          toolContext as any
        );

        // 🔧 FIXED: Check Task status properly (was checking wrong property)
        console.log(`[Scheduler] 🔍 Tool result status: ${toolResult.status.state}`);

        if (toolResult.status.state === TaskState.Completed) {
          console.log(`[Scheduler] ✅ Plan ${planId} executed successfully via tool`);
          console.log(`[Scheduler]    Result: ${toolResult.status.message.parts[0]?.text || 'Swap completed'}`);
          return; // Success, exit retry loop
        } else {
          // Extract error message from failed task
          const errorMessage = toolResult.status.message.parts[0]?.text || 'Unknown error';
          throw new Error(`Tool execution failed: ${errorMessage}`);
        }

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[Scheduler] ❌ Attempt ${attempt}/${this.config.retryAttempts} failed for plan ${planId}:`, lastError.message);

        if (attempt < this.config.retryAttempts) {
          console.log(`[Scheduler] ⏳ Retrying in ${this.config.retryDelayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
        }
      }
    }

    // All retries failed
    console.error(`[Scheduler] 💥 Plan ${planId} failed after ${this.config.retryAttempts} attempts: ${lastError?.message}`);

    // Note: The tool already records failed executions in the database,
    // so we don't need to duplicate that logic here
    throw lastError || new Error('Execution failed');
  }
}

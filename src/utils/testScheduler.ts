/**
 * DCA Scheduler Testing Utility
 * 
 * This utility helps test the multi-user DCA scheduler by creating test plans
 * and monitoring their execution. Useful for Phase 5 validation.
 */

import { PrismaClient } from '@prisma/client';

export interface TestPlanConfig {
  userAddress: string;
  fromToken: string;
  toToken: string;
  amount: string;
  intervalMinutes: number;
  durationWeeks: number;
  slippage?: string;
}

export class DCASchedulerTester {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create test DCA plans for scheduler testing
   */
  async createTestPlans(plans: TestPlanConfig[]): Promise<string[]> {
    console.log(`[Tester] Creating ${plans.length} test DCA plans...`);
    
    const createdPlanIds: string[] = [];

    for (const plan of plans) {
      try {
        // Calculate execution parameters
        const totalMinutes = plan.durationWeeks * 7 * 24 * 60;
        const totalExecutions = Math.floor(totalMinutes / plan.intervalMinutes);
        const nextExecution = new Date(Date.now() + plan.intervalMinutes * 60 * 1000);
        const slippage = parseFloat(plan.slippage || '0.5') / 100;

        const dcaPlan = await this.prisma.dcaPlan.create({
          data: {
            userAddress: plan.userAddress,
            fromToken: plan.fromToken.toUpperCase(),
            toToken: plan.toToken.toUpperCase(),
            amount: plan.amount,
            intervalMinutes: plan.intervalMinutes,
            durationWeeks: plan.durationWeeks,
            nextExecution,
            totalExecutions,
            slippage: slippage.toString(),
            status: 'ACTIVE',
          },
        });

        createdPlanIds.push(dcaPlan.id);
        console.log(`[Tester] ✅ Created plan ${dcaPlan.id}: ${plan.amount} ${plan.fromToken} → ${plan.toToken} every ${plan.intervalMinutes}min`);
      } catch (error) {
        console.error(`[Tester] ❌ Failed to create plan for ${plan.userAddress}:`, error);
      }
    }

    console.log(`[Tester] Created ${createdPlanIds.length}/${plans.length} test plans successfully`);
    return createdPlanIds;
  }

  /**
   * Monitor scheduler execution for test plans
   */
  async monitorExecution(planIds: string[], durationMinutes: number = 10): Promise<void> {
    console.log(`[Tester] 👀 Monitoring ${planIds.length} plans for ${durationMinutes} minutes...`);
    
    const startTime = Date.now();
    const endTime = startTime + (durationMinutes * 60 * 1000);

    while (Date.now() < endTime) {
      try {
        // Get current status of all test plans
        const plans = await this.prisma.dcaPlan.findMany({
          where: {
            id: { in: planIds },
          },
          include: {
            executions: {
              orderBy: { executedAt: 'desc' },
              take: 1,
            },
          },
        });

        // Get execution history count
        const totalExecutions = await this.prisma.executionHistory.count({
          where: {
            planId: { in: planIds },
          },
        });

        const successfulExecutions = await this.prisma.executionHistory.count({
          where: {
            planId: { in: planIds },
            status: 'SUCCESS',
          },
        });

        const failedExecutions = await this.prisma.executionHistory.count({
          where: {
            planId: { in: planIds },
            status: 'FAILED',
          },
        });

        console.log(`[Tester] 📊 Status update:`);
        console.log(`  - Total executions: ${totalExecutions}`);
        console.log(`  - Successful: ${successfulExecutions}`);
        console.log(`  - Failed: ${failedExecutions}`);
        console.log(`  - Active plans: ${plans.filter(p => p.status === 'ACTIVE').length}`);
        console.log(`  - Completed plans: ${plans.filter(p => p.status === 'COMPLETED').length}`);

        // Show individual plan status
        for (const plan of plans) {
          const lastExecution = plan.executions[0];
          const nextExec = plan.nextExecution ? new Date(plan.nextExecution).toLocaleTimeString() : 'N/A';
          const progress = `${plan.executionCount}/${plan.totalExecutions}`;
          
          console.log(`  - Plan ${plan.id.slice(0, 8)}: ${plan.status} (${progress}) Next: ${nextExec}`);
          
          if (lastExecution) {
            const lastStatus = lastExecution.status === 'SUCCESS' ? '✅' : '❌';
            const lastTime = new Date(lastExecution.executedAt).toLocaleTimeString();
            console.log(`    Last execution: ${lastStatus} ${lastTime}`);
          }
        }

        console.log(''); // Empty line for readability

        // Wait 30 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 30000));

      } catch (error) {
        console.error('[Tester] ❌ Error during monitoring:', error);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    console.log('[Tester] 🏁 Monitoring completed');
  }

  /**
   * Clean up test plans
   */
  async cleanupTestPlans(planIds: string[]): Promise<void> {
    console.log(`[Tester] 🧹 Cleaning up ${planIds.length} test plans...`);
    
    try {
      // Delete execution history first (due to foreign key constraints)
      const deletedExecutions = await this.prisma.executionHistory.deleteMany({
        where: {
          planId: { in: planIds },
        },
      });

      // Delete the plans
      const deletedPlans = await this.prisma.dcaPlan.deleteMany({
        where: {
          id: { in: planIds },
        },
      });

      console.log(`[Tester] ✅ Cleanup complete: ${deletedPlans.count} plans, ${deletedExecutions.count} executions`);
    } catch (error) {
      console.error('[Tester] ❌ Cleanup failed:', error);
    }
  }

  /**
   * Run a complete test scenario
   */
  async runTestScenario(): Promise<void> {
    console.log('[Tester] 🚀 Starting DCA scheduler test scenario...');

    // Create test plans for multiple scenarios
    const testPlans: TestPlanConfig[] = [
      {
        userAddress: '0x742d35Cc6609C4532C9c2c28f7B2e1e8f8a3df5e',
        fromToken: 'USDC',
        toToken: 'ETH',
        amount: '100',
        intervalMinutes: 2, // 2 minutes for testing
        durationWeeks: 1,
        slippage: '0.5',
      },
      {
        userAddress: '0x8ba1f109551bD432803012645Hac136c22C135e',
        fromToken: 'DAI',
        toToken: 'ARB',
        amount: '50',
        intervalMinutes: 3, // 3 minutes for testing
        durationWeeks: 1,
        slippage: '1.0',
      },
      {
        userAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        fromToken: 'USDT',
        toToken: 'WETH',
        amount: '200',
        intervalMinutes: 5, // 5 minutes for testing
        durationWeeks: 1,
        slippage: '0.3',
      },
    ];

    let createdPlanIds: string[] = [];

    try {
      // Create test plans
      createdPlanIds = await this.createTestPlans(testPlans);

      if (createdPlanIds.length === 0) {
        console.log('[Tester] ❌ No test plans created, aborting test');
        return;
      }

      // Monitor execution for 10 minutes
      await this.monitorExecution(createdPlanIds, 10);

    } finally {
      // Always cleanup, even if test fails
      if (createdPlanIds.length > 0) {
        await this.cleanupTestPlans(createdPlanIds);
      }
    }

    console.log('[Tester] 🎉 Test scenario completed!');
  }

  /**
   * Get scheduler performance metrics
   */
  async getPerformanceMetrics(): Promise<{
    totalPlans: number;
    activePlans: number;
    totalExecutions: number;
    successRate: number;
    avgExecutionsPerHour: number;
  }> {
    const [totalPlans, activePlans, totalExecutions, successfulExecutions] = await Promise.all([
      this.prisma.dcaPlan.count(),
      this.prisma.dcaPlan.count({ where: { status: 'ACTIVE' } }),
      this.prisma.executionHistory.count(),
      this.prisma.executionHistory.count({ where: { status: 'SUCCESS' } }),
    ]);

    // Calculate executions in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentExecutions = await this.prisma.executionHistory.count({
      where: {
        executedAt: { gte: oneHourAgo },
      },
    });

    const successRate = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0;

    return {
      totalPlans,
      activePlans,
      totalExecutions,
      successRate,
      avgExecutionsPerHour: recentExecutions,
    };
  }
}

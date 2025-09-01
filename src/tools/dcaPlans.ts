import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext } from '../context/types.js';

/**
 * Tool to create a new DCA plan
 */
export const createDCAPlanTool: VibkitToolDefinition<any, any, DCAContext, any> = {
  name: 'createDCAPlan',
  description: 'Create a new Dollar Cost Averaging (DCA) plan for automated investment',
  parameters: z.object({
    userAddress: z.string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
      .describe('User wallet address'),
    fromToken: z.string()
      .min(1)
      .max(10)
      .describe('Source token symbol (e.g., USDC)'),
    toToken: z.string()
      .min(1)
      .max(10)
      .describe('Target token symbol (e.g., ETH)'),
    amount: z.string()
      .regex(/^\d+(\.\d+)?$/, 'Amount must be a valid number')
      .describe('Investment amount per execution'),
    intervalMinutes: z.number()
      .min(2)
      .max(43200) // Max 30 days
      .describe('Execution interval in minutes'),
    durationWeeks: z.number()
      // .min(1)
      // .max(260) // Max 5 years
      .describe('Total investment duration in weeks'),
    slippage: z.string()
      .regex(/^\d+(\.\d+)?$/, 'Slippage must be a valid number')
      .optional()
      .default('2')
      .describe('Slippage tolerance in percentage (default: 2%)'),
  }),
  execute: async ({ userAddress, fromToken, toToken, amount, intervalMinutes, durationWeeks, slippage }, context) => {

    console.log('🔥🔥🔥 [TOOL] createDCAPlan CALLED!');
    console.log('🔥🔥🔥 [TOOL] Args:', { userAddress, fromToken, toToken, amount, intervalMinutes, durationWeeks, slippage });

    try {
      const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
      const response = await fetch(`http://localhost:${API_PORT}/api/dca/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userAddress,
          fromToken,
          toToken,
          amount,
          intervalMinutes,
          durationWeeks,
          slippage: slippage || '2',
        }),
      });

      const result = await response.json() as any;
      
      if (!response.ok) {
        return createErrorTask(
          'createDCAPlan',
          new Error(result.message || 'Failed to create DCA plan')
        );
      }

      // After creating the plan, execute the first swap immediately
      console.log('🔥 [TOOL] Plan created successfully, executing first swap immediately...');
      
      // Import and call the execute tool directly
      const { executeDCASwapTool } = await import('./executeDCASwap.js');
      
      // Ensure minimum slippage of 0.3%
      let finalSlippage = slippage || '2';
      const slippageValue = parseFloat(finalSlippage);
      if (isNaN(slippageValue) || slippageValue < 0.3) {
        finalSlippage = '0.3';
      }
      
      // Create a minimal context for the execute tool (will be passed through)
      const executeResult = await executeDCASwapTool.execute(
        {
          planId: result.data.id,
          fromToken,
          toToken,
          amount,
          userAddress,
          slippage: finalSlippage, // Pass slippage as-is without division
        },
        // Pass through the context from the agent
        context
      );

             // Handle Task return type from hooks
       if ('kind' in executeResult && executeResult.kind === 'task') {
         // Check if the task indicates an error
         if (executeResult.status?.state === 'failed' || executeResult.status?.state === 'rejected' || executeResult.status?.state === 'canceled') {
           console.log('🔥 [TOOL] First execution failed, but plan was created:', executeResult.status.message);
           const errorMessage = executeResult.status.message?.parts?.[0] && executeResult.status.message.parts[0].kind === 'text' 
             ? executeResult.status.message.parts[0].text 
             : 'Unknown error';
           return createSuccessTask(
             'createDCAPlan',
             [],
             `DCA plan created: ${amount} ${fromToken} → ${toToken} every ${intervalMinutes} minutes for ${durationWeeks} weeks. First execution failed: ${errorMessage}`
           );
         } else {
           // Task completed successfully
           console.log('🔥 [TOOL] First execution completed successfully via hooks');
         }
       } else if ('kind' in executeResult && executeResult.kind === 'message') {
         // For Message type, we assume success
         console.log('🔥 [TOOL] First execution completed successfully');
       } else {
         console.warn('🔥 [TOOL] Unexpected executeResult type:', executeResult);
       }

      return createSuccessTask(
        'createDCAPlan',
        [],
        `🎉🎉 Successfully created DCA plan and executed first swap: ${amount} ${fromToken} → ${toToken} every ${intervalMinutes} minutes for ${durationWeeks} weeks`
      );
    } catch (error) {
      return createErrorTask(
        'createDCAPlan',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

/**
 * Tool to get user's DCA plans
 */
export const getUserDCAPlans: VibkitToolDefinition<any, any> = {
  name: 'getUserDCAPlans',
  description: 'Retrieve all DCA plans for a specific user address',
  parameters: z.object({
    userAddress: z.string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
      .describe('User wallet address to get plans for'),
  }),
  execute: async ({ userAddress }) => {
    try {
      const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
      const response = await fetch(`http://localhost:${API_PORT}/api/dca/plans/${userAddress}`);
      const result = await response.json() as any;
      
      if (!response.ok) {
        return createErrorTask(
          'getUserDCAPlans',
          new Error(result.message || 'Failed to fetch DCA plans')
        );
      }

      const plans = result.data || [];
      return createSuccessTask(
        'getUserDCAPlans',
        [],
        `Found ${plans.length} DCA plans for ${userAddress}`
      );
    } catch (error) {
      return createErrorTask(
        'getUserDCAPlans',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

/**
 * Tool to update DCA plan status
 */
export const updateDCAPlanStatus: VibkitToolDefinition<any, any> = {
  name: 'updateDCAPlanStatus',
  description: 'Update the status of a DCA plan (activate, pause, or cancel)',
  parameters: z.object({
    planId: z.string()
      .min(1)
      .describe('DCA plan ID to update'),
    status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
      .describe('New status for the DCA plan'),
  }),
  execute: async ({ planId, status }) => {
    try {
      const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
      const response = await fetch(`http://localhost:${API_PORT}/api/dca/plans/${planId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });

      const result = await response.json() as any;
      
      if (!response.ok) {
        return createErrorTask(
          'updateDCAPlanStatus',
          new Error(result.message || 'Failed to update DCA plan')
        );
      }

      return createSuccessTask(
        'updateDCAPlanStatus',
        [],
        `Successfully updated DCA plan status to ${status}`
      );
    } catch (error) {
      return createErrorTask(
        'updateDCAPlanStatus',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

/**
 * Tool to get execution history for a DCA plan
 */
export const getDCAExecutionHistory: VibkitToolDefinition<any, any> = {
  name: 'getDCAExecutionHistory',
  description: 'Get execution history for a specific DCA plan',
  parameters: z.object({
    planId: z.string()
      .min(1)
      .describe('DCA plan ID to get history for'),
    limit: z.number()
      .min(1)
      .max(100)
      .optional()
      .default(50)
      .describe('Maximum number of executions to return (default: 50)'),
    offset: z.number()
      .min(0)
      .optional()
      .default(0)
      .describe('Number of executions to skip for pagination (default: 0)'),
  }),
  execute: async ({ planId, limit = 50, offset = 0 }) => {
    try {
      const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
      const url = new URL(`http://localhost:${API_PORT}/api/dca/history/${planId}`);
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());

      const response = await fetch(url.toString());
      const result = await response.json() as any;
      
      if (!response.ok) {
        return createErrorTask(
          'getDCAExecutionHistory',
          new Error(result.message || 'Failed to fetch execution history')
        );
      }

      const executions = result.data || [];
      return createSuccessTask(
        'getDCAExecutionHistory',
        [],
        `Found ${executions.length} executions for plan ${planId}`
      );
    } catch (error) {
      return createErrorTask(
        'getDCAExecutionHistory',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

/**
 * Tool to get platform statistics
 */
export const getPlatformStats: VibkitToolDefinition<any, any> = {
  name: 'getPlatformStats',
  description: 'Get overall platform statistics including total plans, users, and executions',
  parameters: z.object({}),
  execute: async () => {
    try {
      const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
      const response = await fetch(`http://localhost:${API_PORT}/api/dca/stats`);
      const result = await response.json() as any;
      
      if (!response.ok) {
        return createErrorTask(
          'getPlatformStats',
          new Error(result.message || 'Failed to fetch platform statistics')
        );
      }

      return createSuccessTask(
        'getPlatformStats',
        [],
        'Platform statistics retrieved successfully'
      );
    } catch (error) {
      return createErrorTask(
        'getPlatformStats',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

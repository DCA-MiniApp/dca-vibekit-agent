import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask } from 'arbitrum-vibekit-core';
import type { DCAContext } from '../context/types.js';
import {
  CreateDCAPlanSchema,
  GetUserDCAPlansSchema,
  UpdateDCAPlanStatusSchema,
  GetDCAExecutionHistorySchema,
  GetPlatformStatsSchema,
  type CreateDCAPlanRequest,
  type GetUserDCAPlansRequest,
  type UpdateDCAPlanStatusRequest,
  type GetDCAExecutionHistoryRequest,
  type GetPlatformStatsRequest,
} from '../types/shared.js';

/**
 * Tool to create a new DCA plan
 */
export const createDCAPlanTool: VibkitToolDefinition<any, any, DCAContext, any> = {
  name: 'createDCAPlan',
  description: 'Create a new Dollar Cost Averaging (DCA) plan for automated investment',
  parameters: CreateDCAPlanSchema,
  execute: async (params: CreateDCAPlanRequest, context) => {
    const { userAddress, fromToken, toToken, amount, intervalMinutes, durationWeeks, slippage } = params;

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

      // Return plan details without executing first swap - TriggerX will handle execution
      console.log('🔥 [TOOL] Plan created successfully. Returning plan details for TriggerX integration...');

      // Calculate total executions for reference
      const totalExecutions = Math.floor((durationWeeks * 7 * 24 * 60) / intervalMinutes);

      return createSuccessTask(
        'createDCAPlan',
        [result],
        `🎉 DCA plan created successfully!`
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
  parameters: GetUserDCAPlansSchema,
  execute: async (params: GetUserDCAPlansRequest) => {
    const { userAddress } = params;
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
        [result],
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
  parameters: UpdateDCAPlanStatusSchema,
  execute: async (params: UpdateDCAPlanStatusRequest) => {
    const { planId, status } = params;
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
        [result],
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
  parameters: GetDCAExecutionHistorySchema,
  execute: async (params: GetDCAExecutionHistoryRequest) => {
    const { planId, limit = 50, offset = 0 } = params;
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
        [result],
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
  parameters: GetPlatformStatsSchema,
  execute: async (params: GetPlatformStatsRequest) => {
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

      console.log('🔥 [TOOL] Platform statistics retrieved successfully:', result);
      return createSuccessTask(
        'getPlatformStats',
        [result],
        'Platform statistics retrieved successfully '
      );
    } catch (error) {
      return createErrorTask(
        'getPlatformStats',
        error instanceof Error ? error : new Error(`Failed to connect to DCA API: ${String(error)}`)
      );
    }
  },
};

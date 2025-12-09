import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask } from 'arbitrum-vibekit-core';
import type { DCAContext } from '../context/types.js';
import {
  CreateDCAPlanSchema,
  GetUserDCAPlansSchema,
  UpdateDCAPlanStatusSchema,
  GetPlatformStatsSchema,
  type CreateDCAPlanRequest,
  type GetUserDCAPlansRequest,
  type UpdateDCAPlanStatusRequest,
  type GetPlatformStatsRequest,
} from '../types/shared.js';

/**
 * Tool to create a new DCA plan
 */
export const createDCAPlanTool: VibkitToolDefinition<any, any, DCAContext, any> = {
  name: 'createDCAPlan',
  description: 'Create a new DCA plan database record only (without transaction preparation). Use this for basic plan creation when you do NOT need transaction data - e.g., "Create a DCA plan record", "Set up a new investment plan", "Add a plan to database"',
  parameters: CreateDCAPlanSchema,
  execute: async (params: CreateDCAPlanRequest, context) => {
    const { userAddress, fromToken, toToken, amount, intervalSeconds, durationSeconds, slippage,fid } = params;

    console.log('🔥🔥🔥 [TOOL] createDCAPlan CALLED!');
    console.log('🔥🔥🔥 [TOOL] Args:', { userAddress, fromToken, toToken, amount, intervalSeconds, durationSeconds, slippage,fid });
    console.log('🔍 [TOOL createDCAPlan] userAddress from params:', userAddress);
    console.log('🔍 [TOOL createDCAPlan] Address length:', userAddress?.length);
    console.log('🔍 [TOOL createDCAPlan] Address regex test:', /^0x[a-fA-F0-9]{40}$/.test(userAddress || ''));

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
          intervalSeconds,
          durationSeconds,
          slippage: slippage || '2',
          fid,
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

// getDCAExecutionHistory tool removed - execution history now available via TriggerX API integration

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

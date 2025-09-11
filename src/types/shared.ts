import { z } from 'zod';

// DCA Plan Creation Schema
export const CreateDCAPlanSchema = z.object({
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
});

export type CreateDCAPlanRequest = z.infer<typeof CreateDCAPlanSchema>;

// DCA Plan Update Schema
export const UpdateDCAPlanSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
    .optional()
    .describe('Updated plan status'),
});

export type UpdateDCAPlanRequest = z.infer<typeof UpdateDCAPlanSchema>;

// DCA Plan Update Details Schema (for jobId and ipfsLink)
export const UpdateDCAPlanDetailsSchema = z.object({
  jobId: z.string().optional().describe('TriggerX job ID for the plan'),
  ipfsLink: z.string().optional().describe('IPFS link for plan metadata'),
});

export type UpdateDCAPlanDetailsRequest = z.infer<typeof UpdateDCAPlanDetailsSchema>;

// Get User DCA Plans Schema
export const GetUserDCAPlansSchema = z.object({
  userAddress: z.string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
    .describe('User wallet address to get plans for'),
});

export type GetUserDCAPlansRequest = z.infer<typeof GetUserDCAPlansSchema>;

// Update DCA Plan Status Schema
export const UpdateDCAPlanStatusSchema = z.object({
  planId: z.string()
    .min(1)
    .describe('DCA plan ID to update'),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED'])
    .describe('New status for the DCA plan'),
});

export type UpdateDCAPlanStatusRequest = z.infer<typeof UpdateDCAPlanStatusSchema>;

// Get DCA Execution History Schema
export const GetDCAExecutionHistorySchema = z.object({
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
});

export type GetDCAExecutionHistoryRequest = z.infer<typeof GetDCAExecutionHistorySchema>;

// Get Platform Stats Schema (empty schema for consistency)
export const GetPlatformStatsSchema = z.object({});

export type GetPlatformStatsRequest = z.infer<typeof GetPlatformStatsSchema>;


// Response Types
export interface DCAPlanResponse {
  id: string;
  userAddress: string;
  fromToken: string;
  toToken: string;
  amount: string;
  intervalMinutes: number;
  durationWeeks: number;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  nextExecution: string | null;
  executionCount: number;
  totalExecutions: number;
  slippage: string;
  jobId: string | null;
  ipfsLink: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionHistoryResponse {
  id: string;
  planId: string;
  executedAt: string;
  fromAmount: string;
  toAmount: string;
  exchangeRate: string;
  gasFee: string | null;
  txHash: string | null;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  errorMessage: string | null;
}

export interface PlatformStatsResponse {
  totalPlans: number;
  activePlans: number;
  totalUsers: number;
  totalExecutions: number;
  last24hExecutions: number;
  last7dExecutions: number;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Validation Helpers
export function validateEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function validateTokenSymbol(symbol: string): boolean {
  return /^[A-Z]{2,10}$/.test(symbol);
}

export function validateAmount(amount: string): boolean {
  return /^\d+(\.\d+)?$/.test(amount) && parseFloat(amount) > 0;
}

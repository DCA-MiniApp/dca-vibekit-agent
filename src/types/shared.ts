import { z } from "zod";

// DCA Plan Creation Schema
export const CreateDCAPlanSchema = z.object({
  userAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
    .describe("User wallet address"),
  fromToken: z
    .string()
    .min(1)
    .max(10)
    .describe("Source token symbol (e.g., USDC)"),
  toToken: z
    .string()
    .min(1)
    .max(10)
    .describe("Target token symbol (e.g., ETH)"),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Amount must be a valid number")
    .describe("Investment amount per execution"),
  intervalSeconds: z
    .number()
    .min(120) // Minimum 2 minutes (120 seconds)
    .max(2592000) // Max 30 days (30 * 24 * 60 * 60)
    .describe("Execution interval in seconds"),
  durationSeconds: z
    .number()
    .min(3600) // Minimum 1 hour (3600 seconds)
    .max(157680000) // Max 5 years (5 * 365 * 24 * 60 * 60)
    .describe("Total investment duration in seconds"),
  slippage: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Slippage must be a valid number")
    .optional()
    .default("2")
    .describe("Slippage tolerance in percentage (default: 2%)"),
  fid: z.string().optional().describe("Fid for the user"),
});

export type CreateDCAPlanRequest = z.infer<typeof CreateDCAPlanSchema>;

// DCA Plan Update Schema
export const UpdateDCAPlanSchema = z.object({
  status: z
    .enum(["ACTIVE", "PAUSED", "CANCELLED"])
    .optional()
    .describe("Updated plan status"),
});

export type UpdateDCAPlanRequest = z.infer<typeof UpdateDCAPlanSchema>;

// DCA Plan Update Details Schema (for jobId and ipfsLink)
export const UpdateDCAPlanDetailsSchema = z.object({
  jobId: z.string().optional().describe("TriggerX job ID for the plan"),
  ipfsLink: z.string().optional().describe("IPFS link for plan metadata"),
  fid: z.number().optional().describe("Fid of user"),
});

export type UpdateDCAPlanDetailsRequest = z.infer<
  typeof UpdateDCAPlanDetailsSchema
>;

// Get User DCA Plans Schema
export const GetUserDCAPlansSchema = z.object({
  userAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
    .describe("User wallet address to get plans for"),
});

export type GetUserDCAPlansRequest = z.infer<typeof GetUserDCAPlansSchema>;

// Update DCA Plan Status Schema
export const UpdateDCAPlanStatusSchema = z.object({
  planId: z.string().min(1).describe("DCA plan ID to update"),
  status: z
    .enum(["ACTIVE", "PAUSED", "CANCELLED"])
    .describe("New status for the DCA plan"),
});

export type UpdateDCAPlanStatusRequest = z.infer<
  typeof UpdateDCAPlanStatusSchema
>;

// GetDCAExecutionHistorySchema removed - execution history now comes from TriggerX API

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
  intervalSeconds: number;
  durationSeconds: number;
  totalExecutions: number;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  slippage: string;
  jobId: string | null;
  ipfsLink: string | null;
  createdAt: string;
  updatedAt: string;
}

// ExecutionHistoryResponse removed - execution history now comes from TriggerX API

export interface PlatformStatsResponse {
  totalPlans: number;
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

// CreateSwap Response Schema - matches the official createSwap output schema
export const CreateSwapResponseSchema = z.object({
  fromToken: z.object({
    tokenUid: z.object({
      chainId: z.string(),
      address: z.string(),
    }),
    name: z.string(),
    symbol: z.string(),
    isNative: z.boolean(),
    decimals: z.number(),
    iconUri: z.string().nullable().optional(),
    isVetted: z.boolean(),
  }),
  toToken: z.object({
    tokenUid: z.object({
      chainId: z.string(),
      address: z.string(),
    }),
    name: z.string(),
    symbol: z.string(),
    isNative: z.boolean(),
    decimals: z.number(),
    iconUri: z.string().nullable().optional(),
    isVetted: z.boolean(),
  }),
  exactFromAmount: z.string(),
  displayFromAmount: z.string(),
  exactToAmount: z.string(),
  displayToAmount: z.string(),
  transactions: z.array(
    z.object({
      type: z.enum(["TRANSACTION_TYPE_UNSPECIFIED", "EVM_TX", "SOLANA_TX"]),
      to: z.string(),
      data: z.string(),
      value: z.string(),
      chainId: z.string(),
    })
  ),
  feeBreakdown: z
    .object({
      serviceFee: z.string(),
      slippageCost: z.string(),
      total: z.string(),
      feeDenomination: z.string(),
    })
    .optional(),
  estimation: z
    .object({
      effectivePrice: z.string(),
      timeEstimate: z.string(),
      expiration: z.string(),
    })
    .optional(),
  providerTracking: z
    .object({
      requestId: z.string(),
      providerName: z.string(),
      explorerUrl: z.string(),
    })
    .optional(),
});

export type CreateSwapResponse = z.infer<typeof CreateSwapResponseSchema>;

// Additional types for better type safety
export type SwapTransaction = CreateSwapResponse["transactions"][0];
export type SwapFeeBreakdown = NonNullable<CreateSwapResponse["feeBreakdown"]>;
export type SwapEstimation = NonNullable<CreateSwapResponse["estimation"]>;
export type SwapProviderTracking = NonNullable<
  CreateSwapResponse["providerTracking"]
>;
export type SwapToken = CreateSwapResponse["fromToken"];

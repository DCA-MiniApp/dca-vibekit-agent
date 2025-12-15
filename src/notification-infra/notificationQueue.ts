import { Queue } from "bullmq";
import { connection } from "./redis.js";

export type NotificationType =
  | "failed-task"
  | "low-balance-warning"
  | "task-success";

export interface TxFailedPayload {
  idempotencyKey: string;   // e.g. `${jobId}:${taskId}:failed`, `${jobId}:low-balance`, `${jobId}:task-success:${taskId}`
  notificationType: NotificationType;
  jobId: string;
  taskId?: number;          // Required for failed-task / task-success, optional for low-balance
  planId?: string;
  userAddress: string;
  fid: number | null;       // Farcaster ID for notifications
  txHash?: string;
  chainId?: string;
  reason?: string;
  occurredAt?: string;
  txUrl?: string;
  // Fields specific to low-balance-warning
  jobCostPrediction?: number;
  totalTaskCost?: number;
  percentageUsed?: number;
  // Fields specific to task-success
  fromToken?: string;
  toToken?: string;
  amount?: string;
  username?: string | null;
}

export const notificationQueue = new Queue<TxFailedPayload>(
  "notifications",
  { connection }
);
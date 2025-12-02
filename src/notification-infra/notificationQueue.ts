import { Queue } from "bullmq";
import { connection } from "./redis.js";

export type NotificationType = "failed-task" | "low-balance-warning";

export interface TxFailedPayload {
  idempotencyKey: string;   // `${jobId}:${taskId}:failed` or `${jobId}:low-balance`
  notificationType: NotificationType;
  jobId: string;
  taskId?: number;          // Required for failed-task, optional for low-balance
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
}

export const notificationQueue = new Queue<TxFailedPayload>(
  "notifications",
  { connection }
);
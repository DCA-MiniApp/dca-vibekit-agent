import { Queue } from "bullmq";
import { connection } from "./redis.js";

export interface TxFailedPayload {
  idempotencyKey: string;   // `${jobId}:${taskId}:failed`
  jobId: string;
  taskId: number;
  planId?: string;
  userAddress: string;
  fid: number | null;       // Farcaster ID for notifications
  txHash?: string;
  chainId?: string;
  reason?: string;
  occurredAt?: string;
  txUrl?: string;
}

export const notificationQueue = new Queue<TxFailedPayload>(
  "notifications",
  { connection }
);
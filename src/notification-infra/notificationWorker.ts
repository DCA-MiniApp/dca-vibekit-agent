import { Worker, Job } from "bullmq";
import axios from "axios";
import { TxFailedPayload } from "./notificationQueue.js";
import { connection } from "./redis.js";

const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
const API_BASE = process.env.API_BASE_URL || "http://localhost:3031";

/**
 * Worker that processes notification jobs from the queue.
 * Fetches notification details and sends failed task notifications to the frontend.
 */
const worker = new Worker<TxFailedPayload>(
  "notifications",
  async (job: Job<TxFailedPayload>) => {
    const { 
      userAddress, 
      taskId, 
      jobId, 
      planId, 
      txHash, 
      chainId, 
      reason, 
      idempotencyKey,
      fid 
    } = job.data;

    console.log(`[Notification] Processing job ${job.id} (job ${jobId}, task ${taskId}, user ${userAddress})`);
    console.log(`[Notification] Idempotency key: ${idempotencyKey}`);

    // Validate fid - required for notifications
    if (!fid) {
      console.warn(
        `[Notification] Missing fid for user ${userAddress} (job: ${jobId}, task: ${taskId}). Skipping notification.`
      );
      return;
    }

    try {
      // Fetch notification details (token and URL) for the user
      console.log(`[Notification] Fetching notification details for fid ${fid}...`);
      
      // Use axios for better timeout support and error handling
      const notificationRes = await axios.get(
        `${API_BASE}/api/dca/toke-details/${fid}`,
        { timeout: 10000 }
      );

      const notificationDetails = notificationRes.data as { 
        success?: boolean;
        data?: { 
          notificationtoken?: string; 
          notification_url?: string;
        } 
      };

      const { notificationtoken, notification_url } = notificationDetails.data ?? {};

      // Send notification to frontend gateway (/api/tx-events -> Neynar)
      console.log(`[Notification] Sending notification to frontend for fid ${fid}...`);
      await axios.post(
        `${FRONTEND_BASE}/api/tx-events`,
        {
          fid,
          status: "failed",
          txHash,
          chainId,
          planId,
          reason: reason || "plan failed",
          notificationtoken,
          notification_url,
          userAddress,
          jobId,
          taskId,
        },
        { 
          timeout: 12000,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      console.log(
        `[Notification] ✅ Successfully sent notification (job ${jobId}, task ${taskId}, fid ${fid})`
      );
    } catch (error: any) {
      const errorMessage = error.response 
        ? `API error: ${error.response.status} - ${error.response.statusText}`
        : error.message || "Unknown error";
      
      console.error(
        `[Notification] ❌ Failed to send notification (job ${jobId}, task ${taskId}): ${errorMessage}`
      );
      
      // Re-throw to trigger BullMQ retry mechanism
      throw error;
    }
  },
  {
    connection,
    concurrency: 10,  // Process up to 10 notifications concurrently
    // Automatic retries handled by BullMQ via attempts config when adding jobs
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] ✅ Completed notification job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] ❌ Failed notification job ${job?.id}:`, err?.message || err);
});

worker.on("error", (err) => {
  console.error(`[Worker] ❌ Worker error:`, err);
});

console.log("[Worker] Notification worker started and ready to process jobs");

export default worker;
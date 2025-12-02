import { Worker, Job } from "bullmq";
import axios from "axios";
import { TxFailedPayload, notificationQueue } from "./notificationQueue.js";
import { connection } from "./redis.js";

const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
const API_BASE = process.env.API_BASE_URL || "http://localhost:3031";

/**
 * Worker that processes notification jobs from the queue.
 * Fetches notification details and sends failed task notifications to the frontend.
 */
// Queue monitoring - log stats periodically
async function logQueueStats() {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      notificationQueue.getWaitingCount(),
      notificationQueue.getActiveCount(),
      notificationQueue.getCompletedCount(),
      notificationQueue.getFailedCount(),
      notificationQueue.getDelayedCount(),
    ]);
    
    console.log(
      `[Queue Stats] Waiting: ${waiting}, Active: ${active}, Delayed: ${delayed}, ` +
      `Completed: ${completed}, Failed: ${failed}`
    );
    
    // Warn if queue is backing up
    if (waiting > 100) {
      console.warn(`[Queue] ⚠️ High queue depth: ${waiting} jobs waiting. Consider increasing worker concurrency.`);
    }
  } catch (err) {
    console.error("[Queue Stats] Error fetching stats:", err);
  }
}

// Log queue stats every minute
setInterval(logQueueStats, 60000);

const worker = new Worker<TxFailedPayload>(
  "notifications",
  async (job: Job<TxFailedPayload>) => {
    const { 
      notificationType,
      userAddress, 
      taskId, 
      jobId, 
      planId, 
      txHash, 
      chainId, 
      reason, 
      idempotencyKey,
      fid,
      jobCostPrediction,
      totalTaskCost,
      percentageUsed,
    } = job.data;

    const notificationTypeLabel = notificationType || "failed-task";
    console.log(`[Notification] Processing ${notificationTypeLabel} job ${job.id} (job ${jobId}, user ${userAddress})`);
    console.log(`[Notification] Idempotency key: ${idempotencyKey}`);

    // Validate fid - required for notifications
    if (!fid) {
      console.warn(
        `[Notification] Missing fid for user ${userAddress} (job: ${jobId}). Skipping notification.`
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

      // Prepare notification payload based on type
      let notificationPayload: any = {
        fid,
        notificationtoken,
        notification_url,
        userAddress,
        jobId,
        planId,
      };

      if (notificationType === "low-balance-warning") {
        // Low balance warning notification
        notificationPayload = {
          ...notificationPayload,
          status: "low-balance",
          reason: reason || "TG balance insufficient",
          jobCostPrediction,
          totalTaskCost,
          percentageUsed,
        };
      } else {
        // Failed task notification (existing logic)
        notificationPayload = {
          ...notificationPayload,
          status: "failed",
          txHash,
          chainId,
          reason: reason || "plan failed",
          taskId,
        };
      }

      // Send notification to frontend gateway
      console.log(`[Notification] Sending ${notificationTypeLabel} notification to frontend for fid ${fid}...`);
      await axios.post(
        `${FRONTEND_BASE}/api/tx-events`,
        notificationPayload,
        { 
          timeout: 12000,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      const taskInfo = taskId ? `task ${taskId}` : "";
      console.log(
        `[Notification] ✅ Successfully sent ${notificationTypeLabel} notification (job ${jobId}${taskInfo ? `, ${taskInfo}` : ""}, fid ${fid})`
      );
    } catch (error: any) {
      const status = error?.response?.status;
      console.log(`[Notification] Error status: ${status}`);
      const errorMessage = error.response 
        ? `API error: ${error.response.status} - ${error.response.statusText}`
        : error.message || "Unknown error";
      
      const taskInfo = taskId ? `task ${taskId}` : "";
      console.error(
        `[Notification] ❌ Failed to send ${notificationTypeLabel} notification (job ${jobId}${taskInfo ? `, ${taskInfo}` : ""}): ${errorMessage}`
      );
      
      // Re-throw to trigger BullMQ retry mechanism
      throw error;
    }
  },
  {
    connection,
    concurrency: 10,  // Process up to 10 notifications concurrently
    // Automatic retries handled by BullMQ via attempts config when adding jobs
    lockDuration: 30000,  // Job must complete in 30s or considered stalled
    maxStalledCount: 2,   // Max times a job can be stalled before failing
    stalledInterval: 30000, // Check for stalled jobs every 30s
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

worker.on("stalled", (jobId) => {
  console.warn(`[Worker] ⚠️ Job ${jobId} stalled - worker may have crashed or job took too long`);
});

// Log initial queue stats on startup
logQueueStats().catch(console.error);

console.log("[Worker] Notification worker started and ready to process jobs");

export default worker;
import axios from "axios";
import cron from "node-cron";
import { tryInsertDedup } from "./dedup.js";
import { notificationQueue } from "./notificationQueue.js";

const API_BASE_URL = 'https://dca-backend.udonswap.org';
const FAILED_TASKS_API = `${API_BASE_URL}/api/dca/users/failed-tasks`;

/**
 * Polls the API for failed tasks and queues notifications.
 * Runs every 3 minutes to check for any failed DCA plan tasks.
 */
export async function pollFailedTasksOnce() {
  try {
    console.log(`[Poller] Fetching failed tasks from ${FAILED_TASKS_API}...`);
    const { data } = await axios.get(FAILED_TASKS_API, {
      timeout: 30000, // 30 second timeout
    });

    if (!data?.success || !Array.isArray(data.data)) {
      console.warn("[Poller] Unexpected API response", data);
      return;
    }

    const failedTasksCount = data.data.length;
    console.log(`[Poller] Found ${failedTasksCount} failed task(s)`);

    if (failedTasksCount === 0) {
      return;
    }

    let queuedCount = 0;
    let skippedCount = 0;

    for (const task of data.data) {
      const { userAddress, jobId, taskId, txUrl, fid } = task;
      
      // Validate required fields
      if (!jobId || taskId === undefined) {
        console.warn(`[Poller] Skipping task with missing jobId or taskId:`, task);
        skippedCount++;
        continue;
      }

      const idempotencyKey = `${jobId}:${taskId}:failed`;

      // Check if notification already sent (deduplication)
      const ok = await tryInsertDedup(idempotencyKey);
      if (!ok) {
        console.log(`[Poller] Skipping duplicate notification (job ${jobId}, task ${taskId})`);
        skippedCount++;
        continue;
      }

      // Queue notification job
      await notificationQueue.add(
        "sendNotification",
        {
          idempotencyKey,
          jobId,
          taskId,
          userAddress,
          fid: fid || null,
          txUrl,
          reason: "Task failed",
          occurredAt: new Date().toISOString(),
        },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        }
      );

      queuedCount++;
      console.log(`[Poller] Queued notification for failed task (job ${jobId}, task ${taskId}, user ${userAddress})`);
    }

    console.log(`[Poller] Summary: ${queuedCount} queued, ${skippedCount} skipped`);
  } catch (e: any) {
    if (e.code === "ECONNREFUSED") {
      console.error(`[Poller] Cannot connect to API at ${FAILED_TASKS_API}. Is the server running?`);
    } else if (e.response) {
      console.error(`[Poller] API error: ${e.response.status} - ${e.response.statusText}`);
    } else {
      console.error("[Poller] Error fetching or processing failed tasks:", e.message || e);
    }
  }
}

/**
 * Starts the poller that runs every 3 minutes.
 * Also runs once immediately on startup to catch any existing failed tasks.
 */
// export function startPoller() {
//   // Schedule to run every 3 minutes
//   // Cron expression: "*/3 * * * *" means every 3 minutes
//   cron.schedule("*/3 * * * *", () => {
//     console.log("[Poller] Scheduled polling cycle started...");
//     pollFailedTasksOnce().catch((e) => console.error("[Poller] Scheduled run error", e));
//   });

//   console.log("[Poller] Started - will poll every 3 minutes");
  
//   // Run once immediately at startup
//   console.log("[Poller] Running initial check...");
//   pollFailedTasksOnce().catch((e) => console.error("[Poller] Initial run error", e));
// }

// // Auto-start poller when this module is imported
// if (process.env.DISABLE_AUTO_POLLER !== "true") {
//   startPoller();
// }
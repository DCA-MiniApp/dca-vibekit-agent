import axios from "axios";
import cron from "node-cron";
import { tryInsertDedup } from "./dedup.js";
import { notificationQueue } from "./notificationQueue.js";

const FAILED_TASKS_API = "http://localhost:3031/api/dca/users/failed-tasks";

export async function pollFailedTasksOnce() {
  try {
    const { data } = await axios.get(FAILED_TASKS_API);
    if (!data?.success || !Array.isArray(data.data)) {
      console.warn("[Poller] Unexpected API response", data);
      return;
    }

    console.log(`[Poller] Fetched ${data.data.length} failed tasks`);
    console.log("-------CHECKPOINT 1-------");

    for (const task of data.data) {
      const { userAddress, jobId, taskId, txUrl } = task;
      const idempotencyKey = `${jobId}:${taskId}:failed`;

      const ok = await tryInsertDedup(idempotencyKey);
      if (!ok) continue; // Already sent

      await notificationQueue.add(
        "sendNotification",
        {
          idempotencyKey,
          jobId,
          taskId,
          userAddress,
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

      console.log(`[Poller] queued failed tx (job ${jobId}, task ${taskId})`);
      console.log("-------CHECKPOINT 2-------");
    }
  } catch (e) {
    console.error("[Poller] error fetching or processing failed tasks", e);
  }
}

// Schedule every 5 minutes
export function startPoller() {
  cron.schedule("*/2 * * * *", () => {
    console.log("[Poller] Polling for failed tasks...");
    pollFailedTasksOnce().catch((e) => console.error("[Poller] run error", e));
  });

  // run once at boot
  pollFailedTasksOnce().catch((e) => console.error("[Poller] initial run error", e));
}

startPoller();
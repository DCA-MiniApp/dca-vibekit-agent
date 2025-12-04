import axios from "axios";
import cron from "node-cron";
import { tryInsertDedup } from "./dedup.js";
import { notificationQueue } from "./notificationQueue.js";

const API_BASE_URL =
  process.env.API_BASE_URL || "https://dca-backend.udonswap.org";
const LOW_BALANCE_WARNINGS_API = `${API_BASE_URL}/api/dca/users/low-balance-warnings`;

/**
 * Polls the API for low balance warnings and queues notifications.
 * Runs every 5 minutes to check for plans where user's ETH wallet balance
 * is only sufficient for 3, 2, or 1 more executions.
 */
export async function pollLowBalanceWarningsOnce() {
  try {
    console.log(
      `[Balance Poller] Fetching low balance warnings from ${LOW_BALANCE_WARNINGS_API}...`
    );
    const { data } = await axios.get(LOW_BALANCE_WARNINGS_API, {
      timeout: 120000, // 2 minutes timeout (longer due to batch processing)
    });

    if (!data?.success || !Array.isArray(data.data)) {
      console.warn("[Balance Poller] Unexpected API response", data);
      return;
    }

    const warnings = data.data;
    const warningsCount = warnings.length;

    console.log(`[Balance Poller] Found ${warningsCount} low balance warning(s)`);

    if (warningsCount === 0) {
      return;
    }

    let queuedCount = 0;
    let skippedCount = 0;

    for (const warning of warnings) {
      const {
        userAddress,
        jobId,
        planId,
        fid,
        jobCostPrediction,
        totalTaskCost,
        percentageUsed,
        remainingExecutions,
      } = warning;

      // Validate required fields
      if (!jobId || !userAddress) {
        console.warn(
          `[Balance Poller] Skipping warning with missing jobId or userAddress:`,
          warning
        );
        skippedCount++;
        continue;
      }

      // Only notify when remaining executions is 3, 2, or 1
      if (
        remainingExecutions !== 3 &&
        remainingExecutions !== 2 &&
        remainingExecutions !== 1
      ) {
        console.log(
          `[Balance Poller] Skipping job ${jobId} - remainingExecutions=${remainingExecutions}`
        );
        skippedCount++;
        continue;
      }

      // Create idempotency key per job and remaining-execution threshold
      // Format: `${jobId}:remaining:${remainingExecutions}`
      const idempotencyKey = `${jobId}:remaining:${remainingExecutions}`;

      // Check if notification already sent today (deduplication)
      const ok = await tryInsertDedup(idempotencyKey);
      if (!ok) {
        console.log(
          `[Balance Poller] Skipping duplicate notification (job ${jobId}, already notified today)`
        );
        skippedCount++;
        continue;
      }

      // Queue notification job with a clear countdown message
      let countdownMessage: string;
      if (remainingExecutions === 3) {
        countdownMessage =
          "Only 3 more transactions can be executed with your current ETH wallet balance. Please top up ETH to avoid interruptions.";
      } else if (remainingExecutions === 2) {
        countdownMessage =
          "Only 2 more transactions can be executed with your current ETH wallet balance. Please top up ETH to keep your plan running.";
      } else {
        countdownMessage =
          "Only 1 more transaction can be executed with your current ETH wallet balance. Your plan will likely stop after this unless you top up ETH.";
      }

      // Queue notification job
      await notificationQueue.add(
        "sendNotification",
        {
          idempotencyKey,
          notificationType: "low-balance-warning",
          jobId,
          planId,
          userAddress,
          fid: fid || null,
          jobCostPrediction,
          totalTaskCost,
          percentageUsed,
          reason: countdownMessage,
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
      console.log(
        `[Balance Poller] Queued countdown notification (job ${jobId}, user ${userAddress}, remainingExecutions=${remainingExecutions}, used ${percentageUsed.toFixed(
          2
        )}% of predicted cost)`
      );
    }

    console.log(
      `[Balance Poller] Summary: ${queuedCount} queued, ${skippedCount} skipped`
    );
  } catch (e: any) {
    if (e.code === "ECONNREFUSED") {
      console.error(
        `[Balance Poller] Cannot connect to API at ${LOW_BALANCE_WARNINGS_API}. Is the server running?`
      );
    } else if (e.response) {
      console.error(
        `[Balance Poller] API error: ${e.response.status} - ${e.response.statusText}`
      );
    } else {
      console.error(
        "[Balance Poller] Error fetching or processing low balance warnings:",
        e.message || e
      );
    }
  }
}

/**
 * Starts the balance warning poller that runs every 5 minutes.
 * Also runs once immediately on startup to catch any existing warnings.
 */
export function startBalancePoller() {
  // Schedule to run every 5 minutes
  // Cron expression: "*/5 * * * *" means every 5 minutes
  cron.schedule("*/5 * * * *", () => {
    console.log("[Balance Poller] Scheduled polling cycle started...");
    pollLowBalanceWarningsOnce().catch((e) =>
      console.error("[Balance Poller] Scheduled run error", e)
    );
  });

  console.log("[Balance Poller] Started - will poll every 5 minutes");

  // Run once immediately at startup
  console.log("[Balance Poller] Running initial check...");
  pollLowBalanceWarningsOnce().catch((e) =>
    console.error("[Balance Poller] Initial run error", e)
  );
}

// Auto-start poller when this module is imported
if (process.env.DISABLE_AUTO_BALANCE_POLLER !== "true") {
  startBalancePoller();
}


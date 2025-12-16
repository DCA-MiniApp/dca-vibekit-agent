import axios from "axios";
import cron from "node-cron";
import { tryInsertDedup } from "./dedup.js";
import { prisma } from "../services/prisma.js";
import { getJobDataById, TriggerXClient } from "sdk-triggerx";
import { notificationQueue } from "./notificationQueue.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

interface JobStatusData {
  planId: string;
  userAddress: string;
  fromToken: string;
  toToken: string;
  amount: string;
  jobId: string;
  ipfsLink: string | null;
  fid: number | null;
  username: string | null;
  jobStatus: string;
  intervalSeconds?: number;
  durationSeconds?: number;
  taskId?: number;
  taskStatus?: string;
  txUrl?: string;
}

/**
 * Convert seconds to human-readable format
 */
function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  }

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    if (remainingHours === 0) {
      return `${days} day${days !== 1 ? "s" : ""}`;
    }
    return `${days} day${days !== 1 ? "s" : ""} ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`;
  }

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? "s" : ""}`;
    }
    return `${hours} hour${hours !== 1 ? "s" : ""} ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}`;
  }

  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}

/**
 * Utility function to delay execution (for rate limiting)
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send notification to Slack webhook
 */
async function sendSlackNotification(data: JobStatusData) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn(
      "[Job Status Poller] SLACK_WEBHOOK_URL not configured. Skipping Slack notification."
    );
    return;
  }

  const {
    planId,
    userAddress,
    fromToken,
    toToken,
    amount,
    jobId,
    ipfsLink,
    fid,
    username,
    jobStatus,
    taskId,
    taskStatus,
    txUrl,
  } = data;

  // Format username with FID: username[fid] or just fid if no username
  const userDisplay =
    username && fid ? `${username}[${fid}]` : fid ? `FID: ${fid}` : "No FID";

  // Job status with badge/color indicator
  const jobStatusDisplay =
    jobStatus === "completed"
      ? `\`completed\` ✅`
      : jobStatus === "failed"
        ? `\`${jobStatus}\` ❌`
        : `\`${jobStatus}\``;

  // Task status with badge/color indicator
  const taskStatusDisplay =
    taskStatus === "completed"
      ? `\`completed\` ✅`
      : taskStatus === "failed"
        ? `\`${taskStatus}\` ❌`
        : taskStatus
          ? `\`${taskStatus}\``
          : "";

  // Build the Slack message with cleaner format
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔔 DCA Job Status Update",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Plan ID:* ${planId}\n*Job ID:* ${jobId}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*User Address:* ${userAddress}\n*Job Status:* ${jobStatusDisplay}`,
      },
    },
  ];

  // Add username section
  if (username || fid) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Username:* ${userDisplay}`,
      },
    });
  }

  // Add swap information
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Swap:* ${amount} ${fromToken} → ${toToken}`,
    },
  });

  // Add interval and duration information if available
  if (data.intervalSeconds || data.durationSeconds) {
    const intervalText = data.intervalSeconds
      ? `*Interval:* ${formatSeconds(data.intervalSeconds)}`
      : null;
    const durationText = data.durationSeconds
      ? `*Duration:* ${formatSeconds(data.durationSeconds)}`
      : null;

    const scheduleText = [intervalText, durationText]
      .filter(Boolean)
      .join("\n");

    if (scheduleText) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: scheduleText,
        },
      });
    }
  }

  // Add task information if available
  if (taskId !== undefined && taskStatus) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Task ID:* ${taskId}\n*Task Status:* ${taskStatusDisplay}`,
      },
    });
  }

  // Add IPFS link if available
  if (ipfsLink) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*IPFS Link:* <${ipfsLink}|View on IPFS>`,
      },
    });
  }

  // Add transaction URL if available
  if (txUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Transaction:* <${txUrl}|View on Explorer>`,
      },
    });
  }

  // Add timestamp footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_${new Date().toISOString()}_`,
      },
    ],
  });

  try {
    await axios.post(
      SLACK_WEBHOOK_URL,
      {
        blocks,
        text: `DCA Job Status Update - ${jobStatus}`,
      },
      {
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    console.log(
      `[Job Status Poller] ✅ Sent Slack notification for job ${jobId}`
    );
  } catch (error: any) {
    console.error(
      `[Job Status Poller] ❌ Failed to send Slack notification:`,
      error.message || error
    );
  }
}

/**
 * Send a summary notification with overall stats
 */
async function sendSummaryNotification(
  stats: {
    totalPlans: number;
    jobStatuses: any;
    taskStatuses: any;
    newUpdates: JobStatusData[];
  },
  notifiedCount: number,
  skippedCount: number
) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn(
      "[Job Status Poller] SLACK_WEBHOOK_URL not configured. Skipping summary notification."
    );
    return;
  }

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📊 DCA Job Status Summary",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Polling Cycle Complete*\nChecked ${stats.totalPlans} DCA plans`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Job Statuses:*\n✅ Completed: ${stats.jobStatuses.completed || 0}\n⏳ Processing: ${stats.jobStatuses.processing || 0}\n⏸️ Pending: ${stats.jobStatuses.pending || 0}\n❌ Failed: ${stats.jobStatuses.failed || 0}`,
        },
        {
          type: "mrkdwn",
          text: `*Task Statuses:*\n✅ Completed: ${stats.taskStatuses.completed || 0}\n⏳ Processing: ${stats.taskStatuses.processing || 0}\n⏸️ Pending: ${stats.taskStatuses.pending || 0}\n❌ Failed: ${stats.taskStatuses.failed || 0}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Notifications:*\n• Sent: ${notifiedCount}\n• Skipped (duplicates): ${skippedCount}\n• Total plans: ${stats.totalPlans}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${new Date().toISOString()}_`,
        },
      ],
    },
  ];

  try {
    await axios.post(
      SLACK_WEBHOOK_URL,
      {
        blocks,
        text: `DCA Job Status Summary - ${stats.totalPlans} plans checked`,
      },
      {
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    console.log(
      `[Job Status Poller] ✅ Sent summary notification (${stats.totalPlans} plans)`
    );
  } catch (error: any) {
    console.error(
      `[Job Status Poller] ❌ Failed to send summary notification:`,
      error.message || error
    );
  }
}

/**
 * Polls DCA plans with jobId and sends status updates to Slack.
 * Runs every 5 minutes to check for job status updates.
 */
export async function pollJobStatusOnce() {
  try {
    console.log("[Job Status Poller] Fetching DCA plans with jobId...");

    // Fetch all DCA plans that have a jobId
    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        jobId: { not: null },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    console.log(
      `[Job Status Poller] Found ${dcaPlans.length} DCA plan(s) with jobId`
    );

    if (dcaPlans.length === 0) {
      return;
    }

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    let notifiedCount = 0;
    let skippedCount = 0;

    // Track stats for summary
    const stats = {
      totalPlans: dcaPlans.length,
      jobStatuses: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      } as any,
      taskStatuses: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      } as any,
      newUpdates: [] as JobStatusData[],
    };

    // Max individual notifications to send (prevent spam)
    const MAX_INDIVIDUAL_NOTIFICATIONS = parseInt(
      process.env.MAX_SLACK_NOTIFICATIONS_PER_RUN || "10"
    );

    // Rate limiting: delay after every N notifications
    const RATE_LIMIT_BATCH_SIZE = 10;
    const RATE_LIMIT_DELAY_MS = 1000; // 1 second delay between batches

    for (const plan of dcaPlans) {
      try {
        const { jobId, userAddress, fid, ipfsLink } = plan;

        if (!jobId) {
          skippedCount++;
          continue;
        }

        console.log(
          `[Job Status Poller] Checking job ${jobId} for plan ${plan.id}...`
        );

        // Fetch job data from TriggerX SDK
        const jobDataResp = await getJobDataById(
          triggerxClient,
          jobId,
          userAddress
        );

        if (!jobDataResp || !jobDataResp.success || !jobDataResp.data) {
          console.warn(
            `[Job Status Poller] Failed to fetch job data for jobId ${jobId}`
          );
          skippedCount++;
          continue;
        }

        const { jobData, taskData } = jobDataResp.data;

        // Extract job status
        const jobStatus = jobData.status;

        // Track stats
        if (stats.jobStatuses[jobStatus] !== undefined) {
          stats.jobStatuses[jobStatus]++;
        }

        // Fetch username from user table if fid is available
        let username: string | null = null;
        if (fid) {
          try {
            const user = await prisma.user.findUnique({
              where: { fid: fid.toString() },
            });
            username = user?.username || null;
          } catch (err) {
            console.warn(
              `[Job Status Poller] Failed to fetch username for fid ${fid}:`,
              err
            );
          }
        }

        // Prepare base notification data
        const baseData: JobStatusData = {
          planId: plan.id,
          userAddress: plan.userAddress,
          fromToken: plan.fromToken,
          toToken: plan.toToken,
          amount: plan.amount.toString(),
          jobId: jobId,
          ipfsLink: plan.ipfsLink,
          fid: fid,
          username: username,
          jobStatus: jobStatus,
          intervalSeconds: plan.intervalSeconds,
          durationSeconds: plan.durationSeconds,
        };

        // Create idempotency key for job status
        const jobIdempotencyKey = `${jobId}:job-status:${jobStatus}`;

        // Check if we've already sent notification for this job status
        const jobStatusSent = await tryInsertDedup(jobIdempotencyKey);

        if (jobStatusSent) {
          // Only send individual notifications for important statuses or if under limit
          const isImportantStatus =
            jobStatus === "completed" || jobStatus === "failed";

          if (
            isImportantStatus ||
            stats.newUpdates.length < MAX_INDIVIDUAL_NOTIFICATIONS
          ) {
            stats.newUpdates.push(baseData);
            await sendSlackNotification(baseData);
            notifiedCount++;

            // Rate limiting: add delay after every batch
            if (notifiedCount % RATE_LIMIT_BATCH_SIZE === 0) {
              console.log(
                `[Job Status Poller] ⏳ Rate limit: waiting ${RATE_LIMIT_DELAY_MS}ms after ${RATE_LIMIT_BATCH_SIZE} notifications...`
              );
              await delay(RATE_LIMIT_DELAY_MS);
            }

            console.log(
              `[Job Status Poller] Sent job status notification (${jobStatus}) for job ${jobId}`
            );
          } else {
            console.log(
              `[Job Status Poller] Queued job status update (${jobStatus}) for summary (limit reached)`
            );
          }
        } else {
          console.log(
            `[Job Status Poller] Skipping duplicate job status notification (${jobStatus}) for job ${jobId}`
          );
        }

        // Process task data if available
        if (Array.isArray(taskData) && taskData.length > 0) {
          for (const task of taskData) {
            const taskId = task.task_id;
            const taskStatus = task.task_status;
            const txUrl = task.tx_url || "";

            // Track task stats
            if (stats.taskStatuses[taskStatus] !== undefined) {
              stats.taskStatuses[taskStatus]++;
            }

            // Create idempotency key for task status
            const taskIdempotencyKey = `${jobId}:task:${taskId}:${taskStatus}`;

            // Check if we've already sent notification for this task status
            const taskStatusSent = await tryInsertDedup(taskIdempotencyKey);

            if (taskStatusSent) {
              // Only send for important task statuses or if under limit
              const isImportantTaskStatus =
                taskStatus === "completed" || taskStatus === "failed";

              if (
                isImportantTaskStatus ||
                stats.newUpdates.length < MAX_INDIVIDUAL_NOTIFICATIONS
              ) {
                // Send task status notification (Slack)
                const taskNotificationData: JobStatusData = {
                  ...baseData,
                  taskId: taskId,
                  taskStatus: taskStatus,
                  txUrl: txUrl || undefined,
                };

                await sendSlackNotification(taskNotificationData);
                notifiedCount++;

                // Additionally, send in-app notification for task success
                if (taskStatus === "completed" && fid) {
                  const fcIdempotencyKey = `${jobId}:task-success:${taskId}:fid:${fid}`;
                  const fcOk = await tryInsertDedup(fcIdempotencyKey);
                  if (fcOk) {
                    await notificationQueue.add(
                      "sendNotification",
                      {
                        idempotencyKey: fcIdempotencyKey,
                        notificationType: "task-success",
                        jobId,
                        planId: plan.id,
                        userAddress,
                        fid,
                        taskId,
                        txHash: task.execution_tx_hash || undefined,
                        chainId: jobData.created_chain_id || undefined,
                        fromToken: plan.fromToken,
                        toToken: plan.toToken,
                        amount: plan.amount.toString(),
                        username,
                        reason: `Hey ${username ? `, ${username}` : ""}!  Your DCA plan ${plan.fromToken} → ${plan.toToken} with amount ${plan.amount.toString()} was executed successfully.\n With Task ID: ${taskId}\nYou can verify it in the History tab.`,
                      },
                      {
                        attempts: 5,
                        backoff: { type: "exponential", delay: 5000 },
                        removeOnComplete: 1000,
                        removeOnFail: 1000,
                      }
                    );
                  }
                }
                // Rate limiting: add delay after every batch
                if (notifiedCount % RATE_LIMIT_BATCH_SIZE === 0) {
                  console.log(
                    `[Job Status Poller] ⏳ Rate limit: waiting ${RATE_LIMIT_DELAY_MS}ms after ${RATE_LIMIT_BATCH_SIZE} notifications...`
                  );
                  await delay(RATE_LIMIT_DELAY_MS);
                }

                console.log(
                  `[Job Status Poller] Sent task status notification (${taskStatus}) for task ${taskId}, job ${jobId}`
                );
              } else {
                console.log(
                  `[Job Status Poller] Queued task status update (${taskStatus}) for summary (limit reached)`
                );
              }
            } else {
              console.log(
                `[Job Status Poller] Skipping duplicate task status notification (${taskStatus}) for task ${taskId}, job ${jobId}`
              );
              skippedCount++;
            }
          }
        }
      } catch (err) {
        console.error(
          `[Job Status Poller] Error processing plan ${plan.id}:`,
          err
        );
        skippedCount++;
      }
    }

    // Send summary if we have lots of updates or hit the limit
    if (notifiedCount >= MAX_INDIVIDUAL_NOTIFICATIONS || dcaPlans.length > 20) {
      await sendSummaryNotification(stats, notifiedCount, skippedCount);
    }

    console.log(
      `[Job Status Poller] Summary: ${notifiedCount} notifications sent, ${skippedCount} skipped`
    );
  } catch (e: any) {
    console.error(
      "[Job Status Poller] Error fetching or processing job statuses:",
      e.message || e
    );
  }
}

/**
 * Starts the job status poller that runs every 5 minutes.
 * Also runs once immediately on startup to catch any existing updates.
 */
export function startJobStatusPoller() {
  // Schedule to run every 10 minutes
  // Cron expression: "*/10 * * * *" means every 10 minutes
  cron.schedule("*/10 * * * *", () => {
    console.log("[Job Status Poller] Scheduled polling cycle started...");
    pollJobStatusOnce().catch((e) =>
      console.error("[Job Status Poller] Scheduled run error", e)
    );
  });

  console.log(
    "[Job Status Poller] Started - will poll every 5 minutes for job status updates"
  );

  // Run once immediately at startup
  console.log("[Job Status Poller] Running initial check...");
  pollJobStatusOnce().catch((e) =>
    console.error("[Job Status Poller] Initial run error", e)
  );
}

// Auto-start poller when this module is imported
if (process.env.DISABLE_AUTO_JOB_STATUS_POLLER !== "true") {
  startJobStatusPoller();
}

import axios from "axios";
import cron from "node-cron";
import { tryInsertDedup } from "./dedup.js";
import { prisma } from "../services/prisma.js";
import { getJobDataById, TriggerXClient } from "sdk-triggerx";

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
    taskId?: number;
    taskStatus?: string;
    txUrl?: string;
}

// Test data for testing without database or TriggerX API
const TEST_DCA_PLANS = [
    {
        id: "test-plan-001",
        userAddress: "0x40049FaB24B6115cD36D9Ce64EA35185f8bae810",
        fromToken: "USDC",
        toToken: "ETH",
        amount: "10",
        jobId: "1136658311433740703811181913266269765208135782441174104049747574954918004",
        ipfsLink: "https://ipfs.io/ipfs/QmTest123",
        fid: 727291,
        status: "ACTIVE",
    },
    {
        id: "test-plan-002",
        userAddress: "0x1234567890123456789012345678901234567890",
        fromToken: "USDC",
        toToken: "ARB",
        amount: "50",
        jobId: "1136658311433740703811181913266269765208135782441174104049747574954918005",
        ipfsLink: null,
        fid: null,
        status: "ACTIVE",
    },
];

const TEST_JOB_DATA_RESPONSE = {
    success: true,
    data: {
        jobData: {
            job_id: "1136658311433740703811181913266269765208135782441174104049747574954918004",
            job_title: "dca-automate",
            task_definition_id: 2,
            user_id: 46,
            link_job_id: null,
            chain_status: 0,
            custom: true,
            time_frame: 10800,
            recurring: false,
            status: "processing",
            job_cost_prediction: 0.000018512366947098,
            job_cost_actual: 0,
            task_ids: [31132, 31135],
            created_at: "2025-12-05T06:33:50.391Z",
            updated_at: "2025-12-05T06:33:50.391Z",
            last_executed_at: "0001-01-01T00:00:00Z",
            timezone: "Asia/Calcutta",
            is_imua: false,
            created_chain_id: "42161",
            safe_address: "",
        },
        taskData: [
            {
                task_id: 31132,
                task_number: 0,
                task_opx_cost: 0.00001,
                execution_timestamp: "2025-12-05T06:35:00.000Z",
                execution_tx_hash: "0xabc123def456",
                task_performer_id: 1,
                task_attester_ids: [1, 2],
                task_status: "completed",
                task_error: "",
                is_accepted: true,
                tx_url: "https://arbiscan.io/tx/0xabc123def456",
                converted_arguments: null,
            },
            {
                task_id: 31135,
                task_number: 1,
                task_opx_cost: 0,
                execution_timestamp: "0001-01-01T00:00:00Z",
                execution_tx_hash: "",
                task_performer_id: 0,
                task_attester_ids: null,
                task_status: "processing",
                task_error: "",
                is_accepted: false,
                tx_url: "",
                converted_arguments: null,
            },
        ],
    },
};

const TEST_USER_DATA = {
    fid: "727291",
    username: "alice.eth",
    userAddress: "0x40049FaB24B6115cD36D9Ce64EA35185f8bae810",
};

/**
 * Send notification to Slack webhook
 */
async function sendSlackNotification(data: JobStatusData) {
    if (!SLACK_WEBHOOK_URL) {
        console.warn("[Job Status Poller] SLACK_WEBHOOK_URL not configured. Skipping Slack notification.");
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
    const userDisplay = username && fid
        ? `${username}[${fid}]`
        : fid
            ? `FID: ${fid}`
            : "No FID";

    // Job status with badge/color indicator
    const jobStatusDisplay = jobStatus === "completed"
        ? `\`completed\` ✅`
        : jobStatus === "failed"
            ? `\`${jobStatus}\` ❌`
            : `\`${jobStatus}\``;

    // Task status with badge/color indicator
    const taskStatusDisplay = taskStatus === "completed"
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
                text: `*User Address:* ${userAddress}\n*FID:* ${fid || "N/A"}\n*Job Status:* ${jobStatusDisplay}`,
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
 * Polls DCA plans with jobId and sends status updates to Slack.
 * Runs every 5 minutes to check for job status updates.
 */
export async function pollJobStatusOnce() {
    try {
        let dcaPlans: any[] = [];
        const useTestData = process.env.JOB_STATUS_POLLER_TEST_DATA === "TRUE";

        if (useTestData) {
            console.log("[Job Status Poller] 🧪 Using TEST data (JOB_STATUS_POLLER_TEST_DATA=TRUE)");
            dcaPlans = TEST_DCA_PLANS;
        } else {
            console.log("[Job Status Poller] Fetching DCA plans with jobId...");

            // Fetch all DCA plans that have a jobId
            dcaPlans = await prisma.dcaPlan.findMany({
                where: {
                    jobId: { not: null },
                },
                orderBy: {
                    createdAt: "desc",
                },
            });
        }

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

                // Fetch job data from TriggerX SDK or use test data
                let jobDataResp: any;

                if (useTestData) {
                    console.log(`[Job Status Poller] 🧪 Using test job data for ${jobId}`);
                    jobDataResp = TEST_JOB_DATA_RESPONSE;
                } else {
                    jobDataResp = await getJobDataById(
                        triggerxClient,
                        jobId,
                        userAddress
                    );
                }

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

                // Fetch username from user table if fid is available or use test data
                let username: string | null = null;
                if (fid) {
                    if (useTestData) {
                        console.log(`[Job Status Poller] 🧪 Using test username for fid ${fid}`);
                        username = TEST_USER_DATA.username;
                    } else {
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
                }

                // Prepare base notification data
                const baseData: JobStatusData = {
                    planId: plan.id,
                    userAddress: plan.userAddress,
                    fromToken: plan.fromToken,
                    toToken: plan.toToken,
                    amount: typeof plan.amount === 'string' ? plan.amount : plan.amount.toString(),
                    jobId: jobId,
                    ipfsLink: ipfsLink || null,
                    fid: fid,
                    username: username,
                    jobStatus: jobStatus,
                };

                // Create idempotency key for job status
                const jobIdempotencyKey = `${jobId}:job-status:${jobStatus}`;

                // Check if we've already sent notification for this job status
                const jobStatusSent = await tryInsertDedup(jobIdempotencyKey);

                if (jobStatusSent) {
                    // Send job status notification
                    await sendSlackNotification(baseData);
                    notifiedCount++;
                    console.log(
                        `[Job Status Poller] Sent job status notification (${jobStatus}) for job ${jobId}`
                    );
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

                        // Create idempotency key for task status
                        const taskIdempotencyKey = `${jobId}:task:${taskId}:${taskStatus}`;

                        // Check if we've already sent notification for this task status
                        const taskStatusSent = await tryInsertDedup(taskIdempotencyKey);

                        if (taskStatusSent) {
                            // Send task status notification
                            const taskData: JobStatusData = {
                                ...baseData,
                                taskId: taskId,
                                taskStatus: taskStatus,
                                txUrl: txUrl || undefined,
                            };

                            await sendSlackNotification(taskData);
                            notifiedCount++;
                            console.log(
                                `[Job Status Poller] Sent task status notification (${taskStatus}) for task ${taskId}, job ${jobId}`
                            );
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
    // Schedule to run every 5 minutes
    // Cron expression: "*/5 * * * *" means every 5 minutes
    cron.schedule("*/5 * * * *", () => {
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

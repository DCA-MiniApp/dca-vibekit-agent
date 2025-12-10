import { getJobDataById, TriggerXClient, checkEthBalance } from "sdk-triggerx";
import { prisma } from "../services/prisma.js";
import { getTokenPrice } from "../utils/tokenPrice.js";

/**
 * Check if a job is completed
 */
export async function isJobCompleted(
    triggerxClient: TriggerXClient,
    jobId: string,
    userAddress: string
): Promise<boolean> {
    try {
        const jobData = await getJobDataById(triggerxClient, jobId, userAddress);
        return jobData?.data?.jobData?.status === "completed";
    } catch {
        return false;
    }
}

/**
 * Get failed tasks for all users
 */
export async function getFailedTasksForUsers(
    users: Array<{ userAddress: string; jobId: string | null; fid: number | null }>,
    triggerxClient: TriggerXClient
) {
    const failedTasks: {
        userAddress: string;
        jobId: string;
        taskId: number;
        txUrl: string;
        fid: number | null;
    }[] = [];

    await Promise.all(
        users.map(async (user) => {
            if (!user.jobId) return;
            try {
                const jobDataResp = await getJobDataById(
                    triggerxClient,
                    user.jobId,
                    user.userAddress
                );
                if (jobDataResp && Array.isArray(jobDataResp.data?.taskData)) {
                    jobDataResp.data?.taskData.forEach((task: any) => {
                        if (task.task_status === "failed") {
                            failedTasks.push({
                                userAddress: user.userAddress,
                                jobId: user.jobId ?? "",
                                taskId: task.task_id,
                                txUrl: task.tx_url || "",
                                fid: user.fid ?? null,
                            });
                        }
                    });
                }
            } catch (err) {
                console.warn(
                    `Failed to fetch job data for jobId ${user.jobId}:`,
                    err
                );
            }
        })
    );

    return failedTasks;
}

/**
 * Check low balance for a plan
 */
export async function checkLowBalanceForPlan(
    plan: { userAddress: string; jobId: string; fid: number | null; id: string },
    triggerxClient: TriggerXClient
) {
    if (!plan.jobId) return null;

    try {
        const jobDataResp = await getJobDataById(
            triggerxClient,
            plan.jobId,
            plan.userAddress
        );

        if (!jobDataResp || !jobDataResp.success) {
            return null;
        }

        const jobData = jobDataResp.data?.jobData;
        const taskData = jobDataResp.data?.taskData || [];

        if (!jobData) {
            return null;
        }

        // Skip if job is already completed, failed, or deleted
        const status = jobData.status?.toLowerCase();
        if (
            status === "completed" ||
            status === "failed" ||
            status === "deleted"
        ) {
            return null;
        }

        // Get user's actual ETH balance on Arbitrum (chainId: 42161)
        let userEthBalance: number;
        try {
            const balanceResponse = await checkEthBalance(plan.userAddress, 42161);

            if (!balanceResponse.success || !balanceResponse.data) {
                return null;
            }

            userEthBalance = parseFloat(balanceResponse.data.ethBalance || "0");

            if (userEthBalance === 0 || !Number.isFinite(userEthBalance)) {
                return null;
            }
        } catch (balanceErr) {
            console.warn(
                `[Balance Check] Failed to fetch ETH balance for ${plan.userAddress}:`,
                balanceErr
            );
            return null;
        }

        // Consider only tasks that have actually consumed TG (completed or processing)
        const tasksWithCost = taskData.filter((task: any) => {
            const tStatus = String(task.task_status).toLowerCase();
            return (
                (tStatus === "completed" || tStatus === "processing") &&
                task.task_opx_cost !== undefined &&
                task.task_opx_cost !== null
            );
        });

        // If no historical task data, we can't calculate average cost
        if (tasksWithCost.length === 0) {
            return null;
        }

        const taskOpxCosts = tasksWithCost.map((task: any) =>
            parseFloat(task.task_opx_cost?.toString() || "0")
        );

        const totalTaskCost = taskOpxCosts.reduce(
            (sum: number, cost: number) => sum + cost,
            0
        );

        // Average cost per execution for this job (in ETH)
        const avgTaskCost = totalTaskCost / tasksWithCost.length;
        if (!Number.isFinite(avgTaskCost) || avgTaskCost <= 0) {
            return null;
        }

        // Calculate how many more transactions the user can execute with current ETH balance
        const remainingExecutions = Math.floor(userEthBalance / avgTaskCost);

        // Only trigger countdown notifications when exactly 3, 2, or 1 executions remain
        if (
            remainingExecutions === 3 ||
            remainingExecutions === 2 ||
            remainingExecutions === 1
        ) {
            // Calculate percentage of balance that would be used
            const projectedCost = avgTaskCost * remainingExecutions;
            const percentageRemaining = (projectedCost / userEthBalance) * 100;

            return {
                userAddress: plan.userAddress,
                jobId: plan.jobId,
                planId: plan.id,
                fid: plan.fid ?? null,
                jobCostPrediction: userEthBalance,
                totalTaskCost: avgTaskCost,
                percentageUsed: Number((100 - percentageRemaining).toFixed(2)),
                remainingExecutions,
            };
        }
    } catch (err) {
        console.warn(
            `[Balance Check] Error processing plan ${plan.id} (jobId ${plan.jobId}):`,
            err
        );
    }

    return null;
}

/**
 * Format TG cost in decimal format with (eth) suffix
 */
export function formatTGCost(cost: number): string {
    if (cost === 0) {
        return "0(eth)";
    }

    const convertToDecimalString = (num: number): string => {
        const str = num.toString();
        if (str.includes("e") || str.includes("E")) {
            const match = str.match(/^([\d.]+)[eE]([+-]?\d+)$/);
            if (match && match[1] && match[2]) {
                const base = parseFloat(match[1]);
                const exponent = parseInt(match[2]);
                const result = base * Math.pow(10, exponent);
                const absExponent = Math.abs(exponent);
                const decimalPlaces = Math.max(absExponent + 4, 18);
                return result.toFixed(decimalPlaces);
            }
        }
        return str;
    };

    let decimalStr = convertToDecimalString(cost);
    if (decimalStr.includes(".")) {
        decimalStr = decimalStr.replace(/\.?0+$/, "");
        if (decimalStr.endsWith(".")) {
            decimalStr = decimalStr.slice(0, -1);
        }
    }

    return `${decimalStr}(eth)`;
}

/**
 * Process platform stats for a plan
 */
export async function processPlanForStats(
    plan: any,
    triggerxClient: TriggerXClient
) {
    if (!plan.jobId) return null;

    try {
        const jobDataResp = await getJobDataById(
            triggerxClient,
            plan.jobId,
            plan.userAddress
        );

        if (!jobDataResp || !jobDataResp.success) {
            return null;
        }

        const jobData = jobDataResp.data?.jobData;
        const taskData = jobDataResp.data?.taskData || [];

        if (!jobData) {
            return null;
        }

        const status = jobData.status || "unknown";
        const taskIds = jobData.task_ids || [];
        const taskOpxCosts = taskData.map((task: any) =>
            parseFloat(task.task_opx_cost || "0")
        );

        const totalTaskOpxCost = taskOpxCosts.reduce(
            (sum: number, cost: number) => sum + cost,
            0
        );
        const tgCostInEth = totalTaskOpxCost * Math.pow(10, -3);

        const successCount = taskData.filter(
            (task: any) => task.task_status === "completed"
        ).length;

        const tokenPrice = await getTokenPrice(plan.fromToken);
        const amount = parseFloat(plan.amount.toString());

        let totalValueSwap = 0;
        if (tokenPrice !== null) {
            totalValueSwap = amount * tokenPrice * successCount;
        }

        // Categorize job status
        let jobCategory: "live" | "failed" | "processing" = "live";
        if (status === "completed") {
            const hasFailedTasks = taskData.some(
                (task: any) => task.task_status === "failed"
            );
            jobCategory = hasFailedTasks ? "failed" : "live";
        } else if (
            status === "running" ||
            status === "pending" ||
            status === "processing"
        ) {
            jobCategory = "processing";
        } else if (status === "failed" || status === "cancelled") {
            jobCategory = "failed";
        }

        return {
            userAddress: plan.userAddress,
            fid: plan.fid,
            ipfsLink: plan.ipfsLink,
            jobId: plan.jobId,
            fromToken: plan.fromToken,
            toToken: plan.toToken,
            amount: plan.amount.toString(),
            taskIds,
            taskData,
            tgCostInEth,
            successCount,
            totalValueSwap,
            status,
            jobCategory,
        };
    } catch (err) {
        console.error(
            `Error processing plan for user ${plan.userAddress}, jobId ${plan.jobId}:`,
            err
        );
        return null;
    }
}

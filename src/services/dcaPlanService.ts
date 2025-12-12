import { getJobDataById, TriggerXClient } from "sdk-triggerx";
import type { DCAPlanResponse, JobData } from "../types/shared.js";
import { getTxFee, getConversionRate } from "../utils/blockchain.js";

/**
 * Format a single DCA plan with job data
 */
export async function formatDCAPlanWithJobData(
    plan: any,
    triggerxClient: TriggerXClient,
    userAddress: string
): Promise<DCAPlanResponse> {
    let jobData: JobData | null = null;
    if (plan.jobId) {
        try {
            // console.log(`Fetching job data for jobId ${plan.jobId}`);
            jobData = (await getJobDataById(
                triggerxClient,
                plan.jobId,
                userAddress
            )) as unknown as JobData;
        } catch (err) {
            console.warn(`Failed to fetch job data for jobId ${plan.jobId}:`, err);
        }
    }

    return {
        id: plan.id,
        userAddress: plan.userAddress,
        fromToken: plan.fromToken,
        toToken: plan.toToken,
        amount: plan.amount.toString(),
        intervalSeconds: plan.intervalSeconds,
        durationSeconds: plan.durationSeconds,
        totalExecutions: plan.totalExecutions,
        status: plan.status as any,
        slippage: plan.slippage.toString(),
        jobId: plan.jobId,
        ipfsLink: plan.ipfsLink,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
        jobData,
        successCount: calculateSuccessCount(jobData),
        jobDataStatus: getJobDataStatus(jobData),
    };
}

/**
 * Calculate success count from job data
 */
function calculateSuccessCount(jobData: JobData | null): number {
    const COMPLETED_STATUS = "completed";
    if (
        jobData &&
        jobData.success === true &&
        jobData.data &&
        Array.isArray(jobData.data.taskData)
    ) {
        return jobData.data.taskData.filter(
            (task: any) =>
                String(task.task_status).toLowerCase() === COMPLETED_STATUS
        ).length;
    }
    return 0;
}

/**
 * Get job data status
 */
function getJobDataStatus(jobData: any): string | null {
    if (jobData && jobData.success === true && jobData.data) {
        return jobData.data.jobData.status;
    }
    return null;
}

/**
 * Build history record from task and plan data
 */
export async function buildHistoryRecord(
    plan: any,
    task: any
): Promise<any> {
    let gasFee = null;
    if (task.execution_tx_hash) {
        try {
            gasFee = await getTxFee(task.execution_tx_hash);
        } catch (feeErr) {
            console.warn(
                `Failed to fetch gas fee for tx ${task.execution_tx_hash}:`,
                feeErr
            );
        }
    }

    let exchangeRate: string | null = null;
    let inputAmount: string | null = null;
    let outputAmount: string | null = null;
    if (task.execution_tx_hash) {
        try {
            const conv = await getConversionRate(
                plan.userAddress,
                task.execution_tx_hash
            );
            exchangeRate = conv.conversionRate;
            inputAmount = conv.inputAmount;
            outputAmount = conv.outputAmount;
        } catch (convErr) {
            console.warn(
                `Failed to fetch exchange rate for tx ${task.execution_tx_hash}:`,
                convErr
            );
        }
    }

    return {
        fromToken: plan.fromToken,
        toToken: plan.toToken,
        amount: plan.amount.toString(),
        slippage: plan.slippage ? plan.slippage.toString() : null,
        jobId: plan.jobId,
        taskId: task.task_id,
        executionTimestamp: task.execution_timestamp,
        executionTxHash: task.execution_tx_hash,
        taskStatus: task.task_status,
        gasFee: gasFee,
        exchangeRate: exchangeRate,
        inputAmount: inputAmount,
        outputAmount: outputAmount,
    };
}

/**
 * Convert DCA plan to response format
 */
export function planToResponse(plan: any): DCAPlanResponse {
    return {
        id: plan.id,
        userAddress: plan.userAddress,
        fromToken: plan.fromToken,
        toToken: plan.toToken,
        amount: plan.amount.toString(),
        intervalSeconds: plan.intervalSeconds,
        durationSeconds: plan.durationSeconds,
        totalExecutions: plan.totalExecutions,
        status: plan.status as any,
        slippage: plan.slippage.toString(),
        jobId: plan.jobId,
        ipfsLink: plan.ipfsLink,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
    };
}

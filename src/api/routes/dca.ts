import { Router } from "express";
import { prisma } from "../../services/prisma.js";
import {
  CreateDCAPlanSchema,
  UpdateDCAPlanSchema,
  UpdateDCAPlanDetailsSchema,
  type DCAPlanResponse,
  type PlatformStatsResponse,
  type ApiResponse,
} from "../../types/shared.js";
import { getJobDataById, TriggerXClient, checkEthBalance } from "sdk-triggerx";
import { getTokenPrice } from "../../utils/tokenPrice.js";
import { getCache, setCache, CacheKeys, invalidateUserCache } from "../../utils/cache.js";
const router: Router = Router();
import { ethers } from "ethers";

async function getTxFee(txHash: string) {
  const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);

  if (!tx || !receipt) {
    throw new Error("Transaction or receipt not found");
  }

  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice ?? 0n;
  const totalFee = gasUsed * effectiveGasPrice;

  return {
    // gasUsed: gasUsed.toString(),
    // gasPriceGwei: ethers.formatUnits(effectiveGasPrice, "gwei"),
    totalFeeETH: ethers.formatEther(totalFee),
    // totalFeeWei: totalFee.toString(),
  };
}

// --- On-chain conversion rate helper (Arbitrum) ---
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

interface ConversionResult {
  inputAmount: string;
  outputAmount: string;
  conversionRate: string;
}

/**
 * Get conversion rate from an Arbitrum transaction
 * @param userAddress - The user's wallet address
 * @param txHash - The transaction hash
 * @returns Object containing inputAmount, outputAmount, and conversionRate
 */
async function getConversionRate(
  userAddress: string,
  txHash: string
): Promise<ConversionResult> {
  const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

  const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) {
    throw new Error("Transaction not found");
  }

  // ERC20 Transfer event signature
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  let inputToken: { address: string; amount: string } | null = null;
  let outputToken: { address: string; amount: string } | null = null;

  for (const log of receipt.logs) {
    if (log.topics.length >= 3 && log.topics[0] === transferTopic) {
      const from = `0x${log.topics[1]!.slice(26)}`;
      const to = `0x${log.topics[2]!.slice(26)}`;
      const amount = log.data; // hex string

      // User receiving tokens (output)
      if (to.toLowerCase() === userAddress.toLowerCase()) {
        if (!outputToken) {
          outputToken = {
            address: log.address,
            amount,
          };
        }
      }

      // User sending tokens (input)
      if (from.toLowerCase() === userAddress.toLowerCase()) {
        if (!inputToken) {
          inputToken = {
            address: log.address,
            amount,
          };
        }
      }
    }
  }

  if (!inputToken || !outputToken) {
    throw new Error("Could not find token transfers for this address");
  }

  const inputContract = new ethers.Contract(
    inputToken.address,
    ERC20_ABI,
    provider
  );
  const outputContract = new ethers.Contract(
    outputToken.address,
    ERC20_ABI,
    provider
  );

  const [inputDecimals, outputDecimals] = await Promise.all([
    (inputContract as any).decimals(),
    (outputContract as any).decimals(),
  ]);

  const inputAmount = ethers.formatUnits(inputToken.amount, inputDecimals);
  const outputAmount = ethers.formatUnits(outputToken.amount, outputDecimals);

  const inputNum = parseFloat(inputAmount);
  const outputNum = parseFloat(outputAmount);
  const conversionRate =
    !Number.isFinite(inputNum) || inputNum === 0
      ? "0"
      : (outputNum / inputNum).toFixed(6);
  return {
    inputAmount: inputNum.toString(),
    outputAmount: outputNum.toString(),
    conversionRate,
  };
}

function calculateNextExecutionFromTasks(
  plan: any,
  jobData: any
): string | null {
  if (
    !jobData ||
    jobData.success !== true ||
    !jobData.data ||
    !jobData.data.jobData ||
    !Array.isArray(jobData.data.jobData.task_ids) ||
    jobData.data.jobData.task_ids.length <= 1
  ) {
    return null;
  }

  const taskIds: number[] = jobData.data.jobData.task_ids;
  const previousTaskId = taskIds[taskIds.length - 2];

  if (
    !previousTaskId ||
    !Array.isArray(jobData.data.taskData) ||
    jobData.data.taskData.length === 0
  ) {
    return null;
  }

  const previousTask = jobData.data.taskData.find(
    (task: any) => task.task_id === previousTaskId
  );

  const prevExecutionTimestamp = previousTask?.execution_timestamp;
  if (
    !prevExecutionTimestamp ||
    prevExecutionTimestamp === "0001-01-01T00:00:00Z"
  ) {
    return null;
  }

  const prevDate = new Date(prevExecutionTimestamp);
  if (Number.isNaN(prevDate.getTime())) {
    return null;
  }

  const intervalMs = (plan.intervalSeconds || 0) * 1000;
  if (!intervalMs) {
    return null;
  }

  return new Date(prevDate.getTime() + intervalMs).toISOString();
}

// Create DCA Plan
router.post("/create", async (req, res) => {
  try {
    console.log('🔍 [API /create] Raw request body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [API /create] req.body.userAddress:', req.body.userAddress);
    console.log('🔍 [API /create] Address length:', req.body.userAddress?.length);
    console.log('🔍 [API /create] Address regex test:', /^0x[a-fA-F0-9]{40}$/.test(req.body.userAddress || ''));

    // Validate request body
    const validatedData = CreateDCAPlanSchema.parse(req.body);

    console.log('🔍 [API /create] After validation - userAddress:', validatedData.userAddress);
    console.log('🔍 [API /create] After validation - Address length:', validatedData.userAddress?.length);
    console.log('🔍 [API /create] After validation - Address regex test:', /^0x[a-fA-F0-9]{40}$/.test(validatedData.userAddress || ''));

    // Calculate total executions based on duration and interval
    const totalExecutions = Math.floor(
      validatedData.durationSeconds / validatedData.intervalSeconds
    );

    // Convert amount and slippage to Decimal
    const amount = validatedData.amount;
    const slippage = parseFloat(validatedData.slippage || "2"); // Convert percentage to decimal

    console.log('🔍 [API /create] BEFORE Prisma create - userAddress:', validatedData.userAddress);

    // Create DCA plan in database
    const dcaPlan = await prisma.dcaPlan.create({
      data: {
        userAddress: validatedData.userAddress,
        fromToken: validatedData.fromToken.toUpperCase(),
        toToken: validatedData.toToken.toUpperCase(),
        amount: amount,
        intervalSeconds: validatedData.intervalSeconds,
        durationSeconds: validatedData.durationSeconds,
        totalExecutions,
        slippage: slippage,
        status: "ACTIVE",
        jobId: null, // Initially null, will be updated when job is created
        ipfsLink: null, // Initially null, will be updated when IPFS link is created
        fid: validatedData.fid ? parseInt(validatedData.fid) : null,
      },
    });

    console.log('🔍 [API /create] AFTER Prisma create - dcaPlan.userAddress:', dcaPlan.userAddress);
    console.log('🔍 [API /create] AFTER Prisma create - Address length:', dcaPlan.userAddress?.length);
    console.log('🔍 [API /create] AFTER Prisma create - Address regex test:', /^0x[a-fA-F0-9]{40}$/.test(dcaPlan.userAddress || ''));
    console.log('🔍 [API /create] Full dcaPlan object:', JSON.stringify(dcaPlan, null, 2));

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: {
        id: dcaPlan.id,
        userAddress: dcaPlan.userAddress,
        fromToken: dcaPlan.fromToken,
        toToken: dcaPlan.toToken,
        amount: dcaPlan.amount.toString(),
        intervalSeconds: dcaPlan.intervalSeconds,
        durationSeconds: dcaPlan.durationSeconds,
        totalExecutions: dcaPlan.totalExecutions,
        status: dcaPlan.status as any,
        slippage: dcaPlan.slippage.toString(),
        jobId: dcaPlan.jobId,
        ipfsLink: dcaPlan.ipfsLink,
        createdAt: dcaPlan.createdAt.toISOString(),
        updatedAt: dcaPlan.updatedAt.toISOString(),
      },
      message: "DCA plan created successfully",
    };

    console.log('🔍 [API /create] Response data userAddress:', response.data?.userAddress);
    console.log(
      `✅ Created DCA plan: ${validatedData.fromToken} → ${validatedData.toToken} for ${validatedData.userAddress}`
    );

    // Invalidate user cache
    if (dcaPlan.userAddress) {
      await invalidateUserCache(dcaPlan.userAddress);
    }

    res.status(201).json(response);
  } catch (error) {
    console.error("Error creating DCA plan:", error);

    if (error instanceof Error && error.name === "ZodError") {
      const response: ApiResponse = {
        success: false,
        error: "Validation Error",
        message: (error as any).errors
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
      return res.status(400).json(response);
    }

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to create DCA plan",
    };
    res.status(500).json(response);
  }
});

// Get user's DCA plans
router.get("/plans/:userAddress", async (req, res) => {
  const startTime = Date.now();
  try {
    const { userAddress } = req.params;

    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      const response: ApiResponse = {
        success: false,
        error: "Invalid Address",
        message: "Invalid Ethereum address format",
      };
      return res.status(400).json(response);
    }

    // Check cache first
    const cacheKey = CacheKeys.userPlans(userAddress);
    const cachedData = await getCache<ApiResponse<DCAPlanResponse[]>>(cacheKey);

    if (cachedData) {
      const duration = Date.now() - startTime;
      console.log(`[Cache HIT] Returning cached data for ${userAddress} in ${duration}ms`);
      return res.json(cachedData);
    }

    console.log(`[Cache MISS] Fetching fresh data for ${userAddress}`);

    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        userAddress: userAddress,
        status: "ACTIVE",
        jobId: { not: null },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // Fetch job data for each plan (in parallel)
    const formattedPlans: DCAPlanResponse[] = await Promise.all(
      dcaPlans.map(async (plan: any) => {
        let jobData = null;
        if (plan.jobId) {
          try {
            jobData = await getJobDataById(
              triggerxClient,
              plan.jobId,
              plan.userAddress
            );
          } catch (err) {
            console.warn(
              `Failed to fetch job data for jobId ${plan.jobId}:`,
              err
            );
          }
        }
        const computedNextExecution = calculateNextExecutionFromTasks(
          plan,
          jobData
        );
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
          jobData, // <-- Embed jobData here
          // Compute successCount based on jobData
          successCount: (() => {
            // The completed status we're checking for
            const COMPLETED_STATUS = "completed";
            // Check jobData exists and taskData array is present
            if (
              jobData &&
              jobData.success === true &&
              jobData.data &&
              Array.isArray(jobData.data.taskData)
            ) {
              // Count taskData entries with task_status === 'completed'
              return jobData.data.taskData.filter(
                (task: any) =>
                  String(task.task_status).toLowerCase() === COMPLETED_STATUS
              ).length;
            }
            return 0;
          })(),
          jobDataStatus: (() => {
            if (jobData && jobData.success === true && jobData.data) {
              return jobData.data.jobData.status;
            }
            return null;
          })(),
        };
      })
    );

    const response: ApiResponse<DCAPlanResponse[]> = {
      success: true,
      data: formattedPlans,
      message: `Found ${formattedPlans.length} DCA plans`,
    };

    // Store in cache (15 minutes TTL)
    await setCache(cacheKey, response, 900);

    const duration = Date.now() - startTime;
    console.log(`[Cache MISS] Processed fresh data for ${userAddress} in ${duration}ms`);

    res.json(response);
  } catch (error) {
    console.error("Error fetching DCA plans:", error);

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch DCA plans",
    };
    res.status(500).json(response);
  }
});

// Update DCA plan details (jobId and ipfsLink)
router.put("/plans/:planId/details", async (req, res) => {
  try {
    const { planId } = req.params;
    console.log('🔍 [API /plans/:planId/details] Updating plan:', planId);
    console.log('🔍 [API /plans/:planId/details] Request body:', JSON.stringify(req.body, null, 2));

    const validatedData = UpdateDCAPlanDetailsSchema.parse(req.body);

    // Check if plan exists
    const existingPlan = await prisma.dcaPlan.findUnique({
      where: { id: planId },
    });

    if (!existingPlan) {
      const response: ApiResponse = {
        success: false,
        error: "Plan Not Found",
        message: "DCA plan not found",
      };
      return res.status(404).json(response);
    }

    console.log('🔍 [API /plans/:planId/details] Existing plan userAddress:', existingPlan.userAddress);
    console.log('🔍 [API /plans/:planId/details] Existing plan address length:', existingPlan.userAddress?.length);
    console.log('🔍 [API /plans/:planId/details] Existing plan address regex test:', /^0x[a-fA-F0-9]{40}$/.test(existingPlan.userAddress || ''));

    // Prepare update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    // Only update fields that are provided
    if (validatedData.jobId !== undefined) {
      updateData.jobId = validatedData.jobId;
    }

    if (validatedData.ipfsLink !== undefined) {
      updateData.ipfsLink = validatedData.ipfsLink;
    }

    if (validatedData.fid !== undefined) {
      updateData.fid = validatedData.fid;
    }

    // Update plan details
    const updatedPlan = await prisma.dcaPlan.update({
      where: { id: planId },
      data: updateData,
    });

    console.log('🔍 [API /plans/:planId/details] AFTER update - updatedPlan.userAddress:', updatedPlan.userAddress);
    console.log('🔍 [API /plans/:planId/details] AFTER update - Address length:', updatedPlan.userAddress?.length);
    console.log('🔍 [API /plans/:planId/details] AFTER update - Address regex test:', /^0x[a-fA-F0-9]{40}$/.test(updatedPlan.userAddress || ''));

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: {
        id: updatedPlan.id,
        userAddress: updatedPlan.userAddress,
        fromToken: updatedPlan.fromToken,
        toToken: updatedPlan.toToken,
        amount: updatedPlan.amount.toString(),
        intervalSeconds: updatedPlan.intervalSeconds,
        durationSeconds: updatedPlan.durationSeconds,
        totalExecutions: updatedPlan.totalExecutions,
        status: updatedPlan.status as any,
        slippage: updatedPlan.slippage.toString(),
        jobId: updatedPlan.jobId,
        ipfsLink: updatedPlan.ipfsLink,
        createdAt: updatedPlan.createdAt.toISOString(),
        updatedAt: updatedPlan.updatedAt.toISOString(),
      },
      message: `DCA plan details updated successfully`,
    };

    console.log(
      `✅ Updated DCA plan ${planId} details: jobId=${validatedData.jobId}, ipfsLink=${validatedData.ipfsLink}`
    );

    // Invalidate user cache
    if (updatedPlan.userAddress) {
      await invalidateUserCache(updatedPlan.userAddress);
    }

    res.json(response);
  } catch (error) {
    console.error("Error updating DCA plan details:", error);

    if (error instanceof Error && error.name === "ZodError") {
      const response: ApiResponse = {
        success: false,
        error: "Validation Error",
        message: (error as any).errors
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
      return res.status(400).json(response);
    }

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to update DCA plan details",
    };
    res.status(500).json(response);
  }
});

// Update DCA plan status
router.put("/plans/:planId", async (req, res) => {
  try {
    const { planId } = req.params;
    const validatedData = UpdateDCAPlanSchema.parse(req.body);

    // Check if plan exists
    const existingPlan = await prisma.dcaPlan.findUnique({
      where: { id: planId },
    });

    if (!existingPlan) {
      const response: ApiResponse = {
        success: false,
        error: "Plan Not Found",
        message: "DCA plan not found",
      };
      return res.status(404).json(response);
    }

    // Update plan status
    const updatedPlan = await prisma.dcaPlan.update({
      where: { id: planId },
      data: {
        status: validatedData.status,
        updatedAt: new Date(),
      },
    });

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: {
        id: updatedPlan.id,
        userAddress: updatedPlan.userAddress,
        fromToken: updatedPlan.fromToken,
        toToken: updatedPlan.toToken,
        amount: updatedPlan.amount.toString(),
        intervalSeconds: updatedPlan.intervalSeconds,
        durationSeconds: updatedPlan.durationSeconds,
        totalExecutions: updatedPlan.totalExecutions,
        status: updatedPlan.status as any,
        slippage: updatedPlan.slippage.toString(),
        jobId: updatedPlan.jobId,
        ipfsLink: updatedPlan.ipfsLink,
        createdAt: updatedPlan.createdAt.toISOString(),
        updatedAt: updatedPlan.updatedAt.toISOString(),
      },
      message: `DCA plan status updated to ${validatedData.status}`,
    };

    console.log(
      `✅ Updated DCA plan ${planId} status to ${validatedData.status}`
    );

    // Invalidate user cache
    if (updatedPlan.userAddress) {
      await invalidateUserCache(updatedPlan.userAddress);
    }

    res.json(response);
  } catch (error) {
    console.error("Error updating DCA plan:", error);

    if (error instanceof Error && error.name === "ZodError") {
      const response: ApiResponse = {
        success: false,
        error: "Validation Error",
        message: (error as any).errors
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
      return res.status(400).json(response);
    }

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to update DCA plan",
    };
    res.status(500).json(response);
  }
});

// Get all execution history for a user (across all plans)
router.get("/user/:userAddress/history", async (req, res) => {
  const startTime = Date.now();
  try {
    const { userAddress } = req.params;
    console.log(`Fetching job/task history for user: ${userAddress}`);

    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Address",
        message: "Invalid Ethereum address format",
      });
    }

    // Check cache first
    const cacheKey = CacheKeys.userHistory(userAddress);
    const cachedData = await getCache<ApiResponse>(cacheKey);

    if (cachedData) {
      const duration = Date.now() - startTime;
      console.log(`[Cache HIT] Returning cached history for ${userAddress} in ${duration}ms`);
      return res.json(cachedData);
    }

    console.log(`[Cache MISS] Fetching fresh history for ${userAddress}`);

    // Get all DCA plans for the user
    const dcaPlans = await prisma.dcaPlan.findMany({
      where: { userAddress },
      orderBy: { createdAt: "desc" },
    });

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // For each plan, fetch job data and extract task info
    const history: any[] = [];

    await Promise.all(
      dcaPlans.map(async (plan: any) => {
        if (plan.jobId) {
          try {
            const jobDataResp = await getJobDataById(
              triggerxClient,
              plan.jobId,
              plan.userAddress
            );
            // Only process if there is job data and taskData is an array
            if (jobDataResp && Array.isArray(jobDataResp.data?.taskData)) {
              for (const task of jobDataResp.data.taskData) {
                // Include all tasks regardless of status
                const taskRecord: any = task;
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

                history.push({
                  fromToken: plan.fromToken,
                  toToken: plan.toToken,
                  amount: plan.amount.toString(),
                  slippage: plan.slippage ? plan.slippage.toString() : null,
                  jobId: plan.jobId,
                  taskId: task.task_id,
                  executionTimestamp: task.execution_timestamp,
                  executionTxHash: task.execution_tx_hash,
                  taskStatus: task.task_status,
                  txUrl: task.tx_url,
                  fromAmount: taskRecord?.fromAmount ?? null,
                  toAmount: taskRecord?.toAmount ?? null,
                  tgCostETH: taskRecord?.task_opx_cost ?? null,
                  gasFee: gasFee?.totalFeeETH,
                  exchangeRate: exchangeRate ?? null,
                  inputAmount: inputAmount ?? null,
                  outputAmount: outputAmount ?? null,
                });
              }
            }
          } catch (err) {
            console.warn(
              `Failed to fetch job data for jobId ${plan.jobId}:`,
              err
            );
          }
        }
      })
    );

    const response = {
      success: true,
      data: history,
      message: `Found ${history.length} completed/failed task executions for user ${userAddress}`,
    };

    // Store in cache (15 minutes TTL)
    await setCache(cacheKey, response, 900);

    const duration = Date.now() - startTime;
    console.log(`[Cache MISS] Processed fresh history for ${userAddress} in ${duration}ms`);

    res.json(response);
  } catch (error) {
    console.error("Error fetching user job/task history:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch user job/task history",
    });
  }
});
//

// Platform statistics (duplicate of /api/status/stats for convenience)
router.get("/stats", async (req, res) => {
  try {
    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // Get all DCA plans with jobId
    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        jobId: { not: null },
      },
      select: {
        jobId: true,
        userAddress: true,
        updatedAt: true,
      },
    });

    // Helper to check if job status is completed
    async function isJobCompleted(jobId: string, userAddress: string) {
      try {
        const jobData = await getJobDataById(
          triggerxClient,
          jobId,
          userAddress
        );
        return jobData?.data?.jobData?.status === "completed";
      } catch {
        return false;
      }
    }

    // Calculate totalExecutions
    let totalExecutions = 0;
    let last24hExecutions = 0;
    let last7dExecutions = 0;
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    await Promise.all(
      dcaPlans.map(async (plan) => {
        if (plan.jobId) {
          const completed = await isJobCompleted(plan.jobId, plan.userAddress);
          if (completed) {
            totalExecutions++;
            if (plan.updatedAt >= last24h) last24hExecutions++;
            if (plan.updatedAt >= last7d) last7dExecutions++;
          }
        }
      })
    );

    // Get current counts
    const totalPlans = await prisma.dcaPlan.count();

    // Get unique users count
    const uniqueUsers = await prisma.dcaPlan.groupBy({
      by: ["userAddress"],
      _count: true,
    });

    const stats: PlatformStatsResponse = {
      totalPlans,
      totalUsers: uniqueUsers.length,
      totalExecutions,
      last24hExecutions,
      last7dExecutions,
    };

    const response: ApiResponse<PlatformStatsResponse> = {
      success: true,
      data: stats,
      message: "Platform statistics retrieved successfully",
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching platform stats:", error);

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch platform statistics",
    };
    res.status(500).json(response);
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await prisma.dcaPlan.findMany({
      where: {
        jobId: {
          not: null,
        },
      },
      select: {
        userAddress: true,
        jobId: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const response: ApiResponse<
      { userAddress: string; jobId: string | null }[]
    > = {
      success: true,
      data: users,
      message: `Found ${users.length} user records`,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching user details:", error);

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch user details",
    };
    res.status(500).json(response);
  }
});

router.get("/users/failed-tasks", async (req, res) => {
  try {
    // 1. Get all users with jobId
    const users = await prisma.dcaPlan.findMany({
      where: {
        jobId: {
          not: null,
        },
      },
      select: {
        userAddress: true,
        jobId: true,
        fid: true,
      },
    });

    console.log("Fetched users with jobIds:", users.length);
    console.log("Sample users:", users);

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // 2. For each user/jobId, get jobData and extract failed tasks
    const failedTasks: {
      userAddress: string;
      jobId: string;
      taskId: number;
      txUrl: string;
      fid: number | null;
    }[] = [];

    await Promise.all(
      users.map(
        async (user: {
          userAddress: string;
          jobId: string | null;
          fid: number | null;
        }) => {
          if (!user.jobId) return; // Skip if jobId is null
          try {
            const jobDataResp = await getJobDataById(
              triggerxClient,
              user.jobId,
              user.userAddress
            );
            console.log(
              `Job data for user ${user.userAddress}, jobId ${user.jobId}:`,
              jobDataResp
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
        }
      )
    );

    res.json({
      success: true,
      data: failedTasks,
      message: `Found ${failedTasks.length} failed tasks`,
    });
  } catch (error) {
    console.error("Error fetching failed tasks:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch failed tasks",
    });
  }
});

// Get users with low ETH wallet balance countdown warnings (3, 2, 1 executions remaining)
router.get("/users/low-balance-warnings", async (req, res) => {
  try {
    // 1. Get all plans with jobId
    const plans = await prisma.dcaPlan.findMany({
      where: {
        jobId: {
          not: null,
        },
      },
      select: {
        userAddress: true,
        jobId: true,
        fid: true,
        id: true,
      },
    });

    console.log(
      `[Balance Check] Checking ${plans.length} active plans for low ETH wallet balance`
    );

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // 2. For each plan, get jobData and compute remaining executions
    const lowBalanceWarnings: {
      userAddress: string;
      jobId: string;
      planId: string;
      fid: number | null;
      jobCostPrediction: number;
      totalTaskCost: number;
      percentageUsed: number;
      remainingExecutions: number;
    }[] = [];

    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < plans.length; i += batchSize) {
      const batch = plans.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (plan) => {
          if (!plan.jobId) return;

          try {
            const jobDataResp = await getJobDataById(
              triggerxClient,
              plan.jobId,
              plan.userAddress
            );

            console.log("Jobdatatresp:", jobDataResp);

            if (!jobDataResp || !jobDataResp.success) {
              console.warn(
                `[Balance Check] Failed to fetch job data for jobId ${plan.jobId}`
              );
              return;
            }


            const jobData = jobDataResp.data?.jobData;
            const taskData = jobDataResp.data?.taskData || [];

            if (!jobData) {
              return;
            }

            // Skip if job is already completed, failed, pending, or deleted
            const status = jobData.status?.toLowerCase();
            if (status === "completed" || status === "failed" || status === "pending" || status === "deleted") {
              console.log(`[Balance Check] Skipping job ${plan.jobId} with status: ${status}`);
              return;
            }

            // Get user's actual ETH balance on Arbitrum (chainId: 42161)
            let userEthBalance: number;
            try {
              const balanceResponse = await checkEthBalance(plan.userAddress, 42161);

              // checkEthBalance returns { success, data: { ethBalanceWei, ethBalance }, error, errorCode }
              if (!balanceResponse.success || !balanceResponse.data) {
                console.log(`[Balance Check] Failed to fetch balance for ${plan.userAddress}: ${balanceResponse.error || 'Unknown error'}`);
                return;
              }

              userEthBalance = parseFloat(balanceResponse.data.ethBalance || "0");

              if (userEthBalance === 0 || !Number.isFinite(userEthBalance)) {
                console.log(`[Balance Check] User ${plan.userAddress} has zero or invalid ETH balance, skipping`);
                return;
              }

              console.log(`[Balance Check] User ${plan.userAddress} ETH balance: ${userEthBalance} ETH`);
            } catch (balanceErr) {
              console.warn(`[Balance Check] Failed to fetch ETH balance for ${plan.userAddress}:`, balanceErr);
              return;
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
              console.log(`[Balance Check] No historical task data for job ${plan.jobId}, skipping`);
              return;
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
              console.log(`[Balance Check] Invalid average task cost for job ${plan.jobId}, skipping`);
              return;
            }

            console.log(`[Balance Check] Job ${plan.jobId} - Avg task cost: ${avgTaskCost} ETH`);

            // Calculate how many more transactions the user can execute with current ETH balance
            const remainingExecutions = Math.floor(userEthBalance / avgTaskCost);

            console.log(`[Balance Check] Job ${plan.jobId} - Remaining executions: ${remainingExecutions}`);

            // Only trigger countdown notifications when exactly 3, 2, or 1 executions remain
            if (
              remainingExecutions === 3 ||
              remainingExecutions === 2 ||
              remainingExecutions === 1
            ) {
              // Calculate percentage of balance that would be used
              const projectedCost = avgTaskCost * remainingExecutions;
              const percentageRemaining = (projectedCost / userEthBalance) * 100;

              lowBalanceWarnings.push({
                userAddress: plan.userAddress,
                jobId: plan.jobId,
                planId: plan.id,
                fid: plan.fid ?? null,
                jobCostPrediction: userEthBalance, // Use actual ETH balance
                totalTaskCost: avgTaskCost, // Use average task cost
                percentageUsed: Number((100 - percentageRemaining).toFixed(2)),
                remainingExecutions,
              });

              console.log(
                `[Balance Check] ⚠️ LOW BALANCE WARNING: User ${plan.userAddress}, Job ${plan.jobId}, ` +
                `Only ${remainingExecutions} execution(s) remaining! ` +
                `(ETH balance: ${userEthBalance}, avg cost: ${avgTaskCost})`
              );
            }
          } catch (err) {
            console.warn(
              `[Balance Check] Error processing plan ${plan.id} (jobId ${plan.jobId}):`,
              err
            );
          }
        })
      );

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < plans.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(
      `[Balance Check] Found ${lowBalanceWarnings.length} plans with low balance`
    );

    res.json({
      success: true,
      data: lowBalanceWarnings,
      message: `Found ${lowBalanceWarnings.length} plans with low ETH wallet balance (only 3, 2, or 1 executions remaining)`,
    });
  } catch (error) {
    console.error(
      "[Balance Check] Error fetching low balance warnings:",
      error
    );
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch low balance warnings",
    });
  }
});

// Update jobId to null for a user
router.put("/jobupdate/:userAddress", async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { jobId } = req.body;
    console.log(`Updating jobId for user ${userAddress} to null`);

    if (!userAddress || !jobId) {
      return res.status(400).json({
        success: false,
        error: "Missing userAddress or jobId",
      });
    }

    // Update only the record where both userAddress and jobId match
    const result = await prisma.dcaPlan.updateMany({
      where: {
        userAddress,
        jobId,
      },
      data: {
        status: "CANCELLED",
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      message: `Updated ${result.count} DCA plan(s) for user ${userAddress} with jobId ${jobId}, set jobId to null.`,
    });
  } catch (error) {
    console.error("Error updating jobId for user:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to update jobId for user",
    });
  }
});

router.post("/user", async (req, res) => {
  try {
    const {
      fid,
      userAddress,
      username,
      pfpUrl,
      joinedAt,
      isWelcomed,
      notificationToken,
      isNotification,
    } = req.body;

    // Basic validation (expand as needed)
    if (!fid || !userAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: fid or userAddress",
      });
    }

    const user = await prisma.user.upsert({
      where: { fid },
      update: {
        userAddress,
        username,
        pfpUrl,
        joinedAt: joinedAt ? new Date(joinedAt) : undefined,
        isWelcomed,
        notificationToken,
        isNotification,
      },
      create: {
        fid,
        userAddress,
        username,
        pfpUrl,
        joinedAt: joinedAt ? new Date(joinedAt) : undefined,
        isWelcomed: isWelcomed ?? false,
        notificationToken,
        isNotification: isNotification ?? false,
      },
    });

    res.json({
      success: true,
      data: user,
      message: "User stored successfully",
    });
  } catch (error) {
    console.error("Error storing user:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to store user",
    });
  }
});

// Get token notification details by fid
router.get("/toke-details/:fid", async (req, res) => {
  try {
    const { fid } = req.params as { fid?: string };

    if (!fid) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: fid",
      });
    }

    const user = await prisma.user.findUnique({ where: { fid } });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    return res.json({
      success: true,
      data: {
        fid,
        notificationtoken: user?.notificationToken ?? null,
        notification_url: user?.notificationUrl ?? null,
      },
    });
  } catch (error) {
    console.error("Error fetching token details:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch token details",
    });
  }
});

// Update notification details for a user by fid
router.post("/token-notification", async (req, res) => {
  try {
    const {
      fid,
      notificationtoken,
      notificationurl,
      userAddress,
      username,
      pfpUrl,
      joinedAt,
      isWelcomed,
      isNotification,
    } = req.body;

    if (!fid) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: fid",
      });
    }

    // Find if user exists; if not, we will create with defaults
    const existing = await prisma.user.findUnique({ where: { fid } });

    const user = await prisma.user.upsert({
      where: { fid },
      update: {
        notificationToken: notificationtoken ?? undefined,
        notificationUrl: notificationurl ?? undefined,
        isNotification: isNotification ?? true,
      },
      create: {
        fid,
        // default to '0x' if no userAddress provided
        userAddress: userAddress ?? "0x",
        username,
        pfpUrl,
        joinedAt: joinedAt ? new Date(joinedAt) : undefined,
        isWelcomed: isWelcomed ?? false,
        notificationToken: notificationtoken,
        notificationUrl: notificationurl,
        isNotification: isNotification ?? true,
      },
    });

    return res.json({
      success: true,
      data: user,
      message: existing
        ? "Notification details updated"
        : "User created and notification details saved",
    });
  } catch (error) {
    console.error("Error updating token notification:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to upsert notification details",
    });
  }
});

// Get successful task count for a job
router.get(
  "/userAddress/:userAddress/job/:jobId/success-count",
  async (req, res) => {
    try {
      const { jobId, userAddress } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameter: jobId",
        });
      }

      const triggerxClient = new TriggerXClient(
        process.env.TRIGGERX_API_KEY || ""
      );

      // Fetch job data using SDK
      const jobData = await getJobDataById(triggerxClient, jobId, userAddress);

      if (!jobData || !Array.isArray(jobData.data?.taskData)) {
        return res.status(404).json({
          success: false,
          error: "Job not found or no task data available",
        });
      }

      // Count successful tasks
      const successCount = jobData.data?.taskData.filter(
        (task: any) => task.task_status === "completed"
      ).length;

      return res.json({
        success: true,
        data: {
          jobId,
          successCount,
          totalTasks: jobData.data?.taskData.length,
        },
        message: `Found ${successCount} successful tasks out of ${jobData.data?.taskData?.length} total tasks`,
      });
    } catch (err: any) {
      const status = err?.response?.status ?? 502;
      const data = err?.response?.data ?? err?.message ?? "Upstream error";
      console.error("TriggerX error:", { status, data });
      return res.status(status).json({
        success: false,
        error: "TriggerX request failed",
        details: data,
      });
    }
  }
);

// Get aggregated platform statistics with user details
router.get("/platform-stats", async (req, res) => {
  try {
    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    console.log("Request headers:", req.headers);

    // 1. Fetch all DCA plans with jobId
    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        jobId: {
          not: null,
        },
      },
      select: {
        userAddress: true,
        fromToken: true,
        toToken: true,
        amount: true,
        jobId: true,
        ipfsLink: true,
        fid: true,
      },
    });

    console.log(`Processing ${dcaPlans.length} DCA plans for platform stats`);
    // console.log("DCA plans:", JSON.stringify(dcaPlans, null, 2));

    // 2. Process each plan to gather data
    const userDataMap = new Map<
      string,
      {
        userAddress: string;
        fid: number | null;
        ipfs_url: string | null;
        jobid: string;
        fromToken: string;
        toToken: string;
        amount: string;
        tasks_id: number[];
        task_data: any[];
        successCount: number;
        Cost_of_TG: string; // Formatted as scientific notation with (eth) suffix
        total_swapped: number;
        status: string;
        username: string | null;
      }
    >();

    let totalValueSwapped = 0;
    let totalJobLiveCount = 0;
    let totalJobFailed = 0;
    let totalJobProcessing = 0;

    // Process plans in parallel batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < dcaPlans.length; i += batchSize) {
      const batch = dcaPlans.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (plan: any) => {
          if (!plan.jobId) return;

          try {
            // Get job data
            const jobDataResp = await getJobDataById(
              triggerxClient,
              plan.jobId,
              plan.userAddress
            );

            if (!jobDataResp || !jobDataResp.success) {
              console.warn(`Failed to fetch job data for jobId ${plan.jobId}`);
              return;
            }

            const jobData = jobDataResp.data?.jobData;
            const taskData = jobDataResp.data?.taskData || [];

            if (!jobData) {
              return;
            }

            // Extract required fields
            const status = jobData.status || "unknown";
            const taskIds = jobData.task_ids || [];
            const taskOpxCosts = taskData.map((task: any) =>
              parseFloat(task.task_opx_cost || "0")
            );

            // Calculate TG cost: sum of all task_opx_cost * 10^-3
            const totalTaskOpxCost = taskOpxCosts.reduce(
              (sum: number, cost: number) => sum + cost,
              0
            );
            const tgCostInEth = totalTaskOpxCost * Math.pow(10, -3);

            // Get success count
            const successCount = taskData.filter(
              (task: any) => task.task_status === "completed"
            ).length;

            // Get token price
            const tokenPrice = await getTokenPrice(plan.fromToken);
            const amount = parseFloat(plan.amount.toString());

            // Calculate total_value_swap: amount * price * successCount
            let totalValueSwap = 0;
            if (tokenPrice !== null) {
              totalValueSwap = amount * tokenPrice * successCount;
            }

            // Categorize job status
            if (status === "completed") {
              // Check if there are any failed tasks
              const hasFailedTasks = taskData.some(
                (task: any) => task.task_status === "failed"
              );
              if (hasFailedTasks) {
                totalJobFailed++;
              } else {
                totalJobLiveCount++;
              }
            } else if (
              status === "running" ||
              status === "pending" ||
              status === "processing"
            ) {
              totalJobProcessing++;
            } else if (status === "failed" || status === "cancelled") {
              totalJobFailed++;
            } else {
              totalJobLiveCount++;
            }

            // Store or update user data
            const userKey = `${plan.userAddress}_${plan.jobId}`;
            const existing = userDataMap.get(userKey);

            // Format TG cost in decimal format with (eth) suffix
            // Format: "0.0000000010001(eth)" - showing full decimal representation
            const formatTGCost = (cost: number): string => {
              if (cost === 0) {
                return "0(eth)";
              }

              // For very small numbers, we need to show enough decimal places
              // Use a helper to convert scientific notation to decimal string
              const convertToDecimalString = (num: number): string => {
                // Check if the number would be displayed in scientific notation
                const str = num.toString();
                if (str.includes("e") || str.includes("E")) {
                  // Parse scientific notation
                  const match = str.match(/^([\d.]+)[eE]([+-]?\d+)$/);
                  if (match && match[1] && match[2]) {
                    const base = parseFloat(match[1]);
                    const exponent = parseInt(match[2]);
                    const result = base * Math.pow(10, exponent);
                    // Calculate decimal places needed (at least 4 significant digits after decimal point)
                    const absExponent = Math.abs(exponent);
                    const decimalPlaces = Math.max(absExponent + 4, 18);
                    return result.toFixed(decimalPlaces);
                  }
                }
                return str;
              };

              let decimalStr = convertToDecimalString(cost);
              // Remove trailing zeros but keep at least one digit after decimal if it's a decimal number
              if (decimalStr.includes(".")) {
                decimalStr = decimalStr.replace(/\.?0+$/, "");
                // Ensure we don't remove the decimal point if there are no digits after
                if (decimalStr.endsWith(".")) {
                  decimalStr = decimalStr.slice(0, -1);
                }
              }

              return `${decimalStr}(eth)`;
            };

            if (existing) {
              // Merge task IDs and costs
              existing.tasks_id = [
                ...new Set([...existing.tasks_id, ...taskIds]),
              ];
              // Parse existing cost, add new cost, and reformat
              // Remove "(eth)" suffix and parse the decimal string
              const existingCostStr = existing.Cost_of_TG.replace("(eth)", "");
              const existingCost = parseFloat(existingCostStr);
              const newTotalCost = existingCost + tgCostInEth;
              existing.Cost_of_TG = formatTGCost(newTotalCost);
              existing.total_swapped += totalValueSwap;
              // Update successCount by adding new successful tasks
              existing.successCount += successCount;
              // Update fromToken, toToken and amount (keep the latest plan's values, or you could aggregate differently)
              existing.fromToken = plan.fromToken;
              existing.toToken = plan.toToken;
              existing.amount = plan.amount.toString();
              // Merge task_data arrays
              existing.task_data = [...existing.task_data, ...taskData];
            } else {
              userDataMap.set(userKey, {
                userAddress: plan.userAddress,
                fid: plan.fid,
                ipfs_url: plan.ipfsLink,
                jobid: plan.jobId,
                tasks_id: taskIds,
                Cost_of_TG: formatTGCost(tgCostInEth),
                total_swapped: totalValueSwap,
                status: status,
                task_data: taskData,
                successCount: successCount,
                fromToken: plan.fromToken,
                toToken: plan.toToken,
                amount: plan.amount.toString(),
                username: null,
              });
            }

            totalValueSwapped += totalValueSwap;
          } catch (err) {
            console.error(
              `Error processing plan for user ${plan.userAddress}, jobId ${plan.jobId}:`,
              err
            );
          }
        })
      );
    }

    // Convert map to array
    const users = Array.from(userDataMap.values());

    // Lookup usernames for available fids
    let usernameMap = new Map<string, string | null>();
    const fidsToLookup = Array.from(
      new Set(
        users
          .map((user) => user.fid ?? null)
          .filter((fid): fid is number => fid !== null)
      )
    );

    if (fidsToLookup.length > 0) {
      const userRecords = await prisma.user.findMany({
        where: {
          fid: {
            in: fidsToLookup.map((fid) => fid.toString()),
          },
        },
        select: {
          fid: true,
          username: true,
        },
      });

      usernameMap = new Map(
        userRecords.map((record: any) => [
          record.fid.toString(),
          record.username,
        ])
      );
    }

    const enrichedUsers = users.map((user) => {
      const username =
        user.fid !== null && user.fid !== undefined
          ? (usernameMap.get(user.fid.toString()) ?? null)
          : null;

      return {
        ...user,
        username: username,
      };
    });

    const total_successful_task = enrichedUsers.reduce(
      (sum, user) => sum + (user.successCount || 0),
      0
    );

    // Get unique users count
    const uniqueUserAddresses = new Set(
      enrichedUsers.map((u) => u.userAddress)
    );
    const totalUniqueUsers = uniqueUserAddresses.size;

    const isHomeRequest =
      typeof req.headers["ishome"] === "string" &&
      req.headers["ishome"]?.toLowerCase() === "true";

    // Build response
    const fullResponse = {
      total_unique_user: totalUniqueUsers,
      total_job_live_count: totalJobLiveCount,
      total_job_failed: totalJobFailed,
      total_job_processing: totalJobProcessing,
      total_value_swapped: totalValueSwapped,
      total_successful_task: total_successful_task,
      users: enrichedUsers.map((user) => ({
        Address: user.userAddress,
        fid: user.fid,
        fromToken: user.fromToken,
        toToken: user.toToken,
        amount: user.amount,
        successCount: user.successCount,
        ipfs_url: user.ipfs_url,
        jobid: user.jobid,
        tasks_id: user.tasks_id,
        task_data: user.task_data,
        Cost_of_TG: user.Cost_of_TG,
        total_swapped: user.total_swapped,
        status: user.status,
        username: user.username,
      })),
      last_update: new Date().toISOString(),
    };

    const response = isHomeRequest
      ? {
        total_job_live_count: fullResponse.total_job_live_count,
        total_value_swapped: fullResponse.total_value_swapped,
        last_update: fullResponse.last_update,
      }
      : fullResponse;

    return res.json({
      success: true,
      data: response,
      message: "Platform statistics retrieved successfully",
    });
  } catch (error) {
    console.error("Error fetching platform stats:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch platform statistics",
    });
  }
});

// Manual trigger for job status polling
router.post("/trigger-job-status-poll", async (req, res) => {
  try {
    console.log("[API] Manual job status poll triggered");

    // Import the poll function dynamically to avoid circular dependencies
    const { pollJobStatusOnce } = await import("../../notification-infra/pollJobStatus.js");

    // Trigger the poll asynchronously
    pollJobStatusOnce()
      .then(() => {
        console.log("[API] Job status poll completed successfully");
      })
      .catch((err) => {
        console.error("[API] Job status poll error:", err);
      });

    return res.json({
      success: true,
      message: "Job status poll triggered successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error triggering job status poll:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to trigger job status poll",
    });
  }
});

export { router as dcaRoutes };

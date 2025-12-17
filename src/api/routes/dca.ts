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
import { getJobDataById, TriggerXClient } from "sdk-triggerx";
import { getTokenPrice } from "../../utils/tokenPrice.js";
import {
  getCache,
  setCache,
  CacheKeys,
  invalidateUserCache,
} from "../../utils/cache.js";
import {
  isValidEthAddress,
  getTxFee,
  getConversionRate,
} from "../../utils/blockchain.js";
import {
  formatDCAPlanWithJobData,
  planToResponse,
  buildHistoryRecord,
} from "../../services/dcaPlanService.js";
import {
  isJobCompleted,
  getFailedTasksForUsers,
  checkLowBalanceForPlan,
  formatTGCost,
  processPlanForStats,
} from "../../services/statsService.js";
import {
  handleGenericError,
  sendInvalidAddressError,
  sendNotFoundError,
} from "../../utils/errorHandlers.js";

const router: Router = Router();

// Create DCA Plan
router.post("/create", async (req, res) => {
  try {
    console.log(
      "🔍 [API /create] Raw request body:",
      JSON.stringify(req.body, null, 2)
    );

    const incomingKey = req.headers["access-key"];
    // console.log("incomingKey:", incomingKey);
    const serverKey = process.env.API_ACCESS_KEY;
    // console.log("serverKey:", serverKey);

    if (!incomingKey || incomingKey !== serverKey) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid access key",
      });
    }

    const validatedData = CreateDCAPlanSchema.parse(req.body);

    // Calculate total executions based on duration and interval
    const totalExecutions = Math.floor(
      validatedData.durationSeconds / validatedData.intervalSeconds
    );

    const amount = validatedData.amount;
    const slippage = parseFloat(validatedData.slippage || "2");

    // Create DCA plan in database
    const dcaPlan = await prisma.dcaPlan.create({
      data: {
        userAddress: req.body.userAddress,
        fromToken: validatedData.fromToken.toUpperCase(),
        toToken: validatedData.toToken.toUpperCase(),
        amount: amount,
        intervalSeconds: validatedData.intervalSeconds,
        durationSeconds: validatedData.durationSeconds,
        totalExecutions,
        slippage: slippage,
        status: "ACTIVE",
        jobId: null,
        ipfsLink: null,
        fid: validatedData.fid ? parseInt(validatedData.fid) : null,
      },
    });

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: planToResponse(dcaPlan),
      message: "DCA plan created successfully",
    };

    console.log(
      `[Create Plan ] Created DCA plan: ${validatedData.fromToken} → ${validatedData.toToken} for ${validatedData.userAddress}`
    );

    // Invalidate user cache
    if (dcaPlan.userAddress) {
      await invalidateUserCache(req.body.userAddress.toLowerCase());
    }

    res.status(201).json(response);
  } catch (error) {
    handleGenericError(error, res, "Failed to create DCA plan");
  }
});

// Get user's DCA plans
router.get("/plans/:userAddress", async (req, res) => {
  const startTime = Date.now();

  // Validate Access Key
  const incomingKey = req.headers["access-key"];
  const serverKey = process.env.API_ACCESS_KEY;

  if (!incomingKey || incomingKey !== serverKey) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid access key",
    });
  }

  try {
    const { userAddress } = req.params;
    // console.log("getting all plans for user", userAddress);

    if (!isValidEthAddress(userAddress)) {
      return sendInvalidAddressError(res);
    }

    // Check cache first
    const Addresskey = userAddress.toLowerCase();
    const cacheKey = CacheKeys.userPlans(Addresskey);
    const cachedData = await getCache<ApiResponse<DCAPlanResponse[]>>(cacheKey);

    if (cachedData) {
      const duration = Date.now() - startTime;
      console.log(
        `[Cache HIT] Returning cached data for ${userAddress} in ${duration}ms`
      );
      return res.json(cachedData);
    }

    console.log(`[Cache MISS] Fetching fresh data for ${userAddress}`);

    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        userAddress,
        jobId: { not: null },
        status: { not: "CANCELLED" },
      },
      orderBy: { createdAt: "desc" },
    });

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    const formattedPlans: DCAPlanResponse[] = await Promise.all(
      dcaPlans.map((plan) =>
        formatDCAPlanWithJobData(plan, triggerxClient, userAddress)
      )
    );

    const response: ApiResponse<DCAPlanResponse[]> = {
      success: true,
      data: formattedPlans,
      message: `Found ${formattedPlans.length} DCA plans`,
    };

    await setCache(cacheKey, response, 300);

    const duration = Date.now() - startTime;
    console.log(
      `[Cache MISS] Processed fresh data for ${userAddress} in ${duration}ms`
    );

    res.json(response);
  } catch (error) {
    handleGenericError(error, res, "Failed to fetch DCA plans");
  }
});

// Update DCA plan details (jobId and ipfsLink)
router.put("/plans/:planId/details", async (req, res) => {
  try {
    const { planId } = req.params;
    // console.log("🔍 [API /plans/:planId/details] Updating plan:", planId);

    const validatedData = UpdateDCAPlanDetailsSchema.parse(req.body);

    // Check if plan exists
    const existingPlan = await prisma.dcaPlan.findUnique({
      where: { id: planId },
    });

    if (!existingPlan) {
      return sendNotFoundError(res, "DCA plan not found");
    }

    // Prepare update data
    const updateData: any = {
      updatedAt: new Date(),
    };

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

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: planToResponse(updatedPlan),
      message: `DCA plan details updated successfully`,
    };

    console.log(
      `[Update Plan] Updated DCA plan ${planId} details: jobId=${validatedData.jobId}, ipfsLink=${validatedData.ipfsLink}`
    );

    // Invalidate user cache
    if (updatedPlan.userAddress) {
      await invalidateUserCache(updatedPlan.userAddress.toLowerCase());
    }

    res.json(response);
  } catch (error) {
    handleGenericError(error, res, "Failed to update DCA plan details");
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
      return sendNotFoundError(res, "DCA plan not found");
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
      data: planToResponse(updatedPlan),
      message: `DCA plan status updated to ${validatedData.status}`,
    };

    console.log(
      `Updated DCA plan ${planId} status to ${validatedData.status}`
    );

    // Invalidate user cache
    if (updatedPlan.userAddress) {
      await invalidateUserCache(updatedPlan.userAddress.toLowerCase());
    }

    res.json(response);
  } catch (error) {
    handleGenericError(error, res, "Failed to update DCA plan");
  }
});

// Get all execution history for a user (across all plans)
router.get("/user/:userAddress/history", async (req, res) => {
  const startTime = Date.now();

  const incomingKey = req.headers["access-key"];
  const serverKey = process.env.API_ACCESS_KEY;

  if (!incomingKey || incomingKey !== serverKey) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid access key",
    });
  }

  try {
    const { userAddress } = req.params;
    // console.log(`Fetching job/task history for user: ${userAddress}`);

    if (!isValidEthAddress(userAddress)) {
      return sendInvalidAddressError(res);
    }

    // Check cache first
    const Addresskey = userAddress.toLowerCase();
    const cacheKey = CacheKeys.userHistory(Addresskey);
    const cachedData = await getCache<ApiResponse>(cacheKey);

    if (cachedData) {
      const duration = Date.now() - startTime;
      console.log(
        `[Cache HIT] Returning cached history for ${userAddress} in ${duration}ms`
      );
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
            if (jobDataResp && Array.isArray(jobDataResp.data?.taskData)) {
              for (const task of jobDataResp.data.taskData) {
                const historyRecord = await buildHistoryRecord(plan, task);
                history.push({
                  ...historyRecord,
                  txUrl: task.tx_url,
                  fromAmount: (task as any)?.fromAmount ?? null,
                  toAmount: (task as any)?.toAmount ?? null,
                  tgCostETH: task?.task_opx_cost ?? null,
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

    // Store in cache (5 minutes TTL) only if we have data
    if (history && history.length > 0) {
      await setCache(cacheKey, response, 300);
    }

    const duration = Date.now() - startTime;
    console.log(
      `[Cache MISS] Processed fresh history for ${userAddress} in ${duration}ms`
    );

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
          const completed = await isJobCompleted(
            triggerxClient,
            plan.jobId,
            plan.userAddress
          );
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
    handleGenericError(error, res, "Failed to fetch platform statistics");
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
    handleGenericError(error, res, "Failed to fetch user details");
  }
});

router.get("/users/failed-tasks", async (req, res) => {
  try {
    // Get all users with jobId
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

    // console.log("Fetched users with jobIds:", users.length);

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    const failedTasks = await getFailedTasksForUsers(users, triggerxClient);

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
    // Get all plans with jobId
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

    const lowBalanceWarnings: any[] = [];

    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < plans.length; i += batchSize) {
      const batch = plans.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map((plan) => {
          if (!plan.jobId) return Promise.resolve(null);
          return checkLowBalanceForPlan(
            { ...plan, jobId: plan.jobId },
            triggerxClient
          );
        })
      );

      results.forEach((result) => {
        if (result) {
          lowBalanceWarnings.push(result);
        }
      });

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
    console.log(`[Cancelled Plan] : Updating jobId for user ${userAddress} to null`);

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

    // Invalidate user cache
    if (userAddress) {
      await invalidateUserCache(userAddress.toLowerCase());
    }

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

    // Basic validation
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

    // Find if user exists
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

    // console.log("Request headers:", req.headers);

    const incomingKey = req.headers["access-key"];
    const serverKey = process.env.API_ACCESS_KEY;

    if (!incomingKey || incomingKey !== serverKey) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid access key",
      });
    }

    // Fetch all DCA plans with jobId
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

    // console.log(`Processing ${dcaPlans.length} DCA plans for platform stats`);

    // Process each plan to gather data
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
        Cost_of_TG: string;
        total_swapped: number;
        status: string;
        username: string | null;
      }
    >();

    let totalValueSwapped = 0;
    let totalJobLiveCount = 0;
    let totalJobFailed = 0;
    let totalJobProcessing = 0;

    // Process plans in parallel batches
    const batchSize = 10;
    for (let i = 0; i < dcaPlans.length; i += batchSize) {
      const batch = dcaPlans.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (plan: any) => {
          const result = await processPlanForStats(plan, triggerxClient);
          if (!result) return;

          // Update counters based on job category
          if (result.jobCategory === "live") {
            totalJobLiveCount++;
          } else if (result.jobCategory === "failed") {
            totalJobFailed++;
          } else if (result.jobCategory === "processing") {
            totalJobProcessing++;
          }

          // Store or update user data
          const userKey = `${result.userAddress}_${result.jobId}`;
          const existing = userDataMap.get(userKey);

          if (existing) {
            existing.tasks_id = [
              ...new Set([...existing.tasks_id, ...result.taskIds]),
            ];
            const existingCostStr = existing.Cost_of_TG.replace("(eth)", "");
            const existingCost = parseFloat(existingCostStr);
            const newTotalCost = existingCost + result.tgCostInEth;
            existing.Cost_of_TG = formatTGCost(newTotalCost);
            existing.total_swapped += result.totalValueSwap;
            existing.successCount += result.successCount;
            existing.fromToken = result.fromToken;
            existing.toToken = result.toToken;
            existing.amount = result.amount;
            existing.task_data = [...existing.task_data, ...result.taskData];
          } else {
            userDataMap.set(userKey, {
              userAddress: result.userAddress,
              fid: result.fid,
              ipfs_url: result.ipfsLink,
              jobid: result.jobId,
              tasks_id: result.taskIds,
              Cost_of_TG: formatTGCost(result.tgCostInEth),
              total_swapped: result.totalValueSwap,
              status: result.status,
              task_data: result.taskData,
              successCount: result.successCount,
              fromToken: result.fromToken,
              toToken: result.toToken,
              amount: result.amount,
              username: null,
            });
          }

          totalValueSwapped += result.totalValueSwap;
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
    const uniqueUsersList = await prisma.dcaPlan.groupBy({
      by: ["userAddress"],
      _count: true,
    });
    const totalUniqueUsers = uniqueUsersList.length;

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
    // console.log("[API] Manual job status poll triggered");

    // Import the poll function dynamically to avoid circular dependencies
    const { pollJobStatusOnce } =
      await import("../../notification-infra/pollJobStatus.js");

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

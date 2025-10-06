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
// import { getJobDataById } from "sdk-triggerx";
import { TriggerXClient } from "sdk-triggerx";
import { getJobDataById } from "sdk-triggerx/dist/api/getJobDataById.js";

const router: Router = Router();

// Create DCA Plan
router.post("/create", async (req, res) => {
  try {
    // Validate request body
    const validatedData = CreateDCAPlanSchema.parse(req.body);

    // Calculate total executions based on duration and interval
    const totalMinutes = validatedData.durationWeeks * 7 * 24 * 60;
    const totalExecutions = Math.floor(
      totalMinutes / validatedData.intervalMinutes
    );

    // Calculate next execution time (start immediately or after interval)
    const nextExecution = new Date(
      Date.now() + validatedData.intervalMinutes * 60 * 1000
    );

    // Convert amount and slippage to Decimal
    const amount = validatedData.amount;
    const slippage = parseFloat(validatedData.slippage || "2"); // Convert percentage to decimal

    // Create DCA plan in database
    const dcaPlan = await prisma.dcaPlan.create({
      data: {
        userAddress: validatedData.userAddress,
        fromToken: validatedData.fromToken.toUpperCase(),
        toToken: validatedData.toToken.toUpperCase(),
        amount: amount,
        intervalMinutes: validatedData.intervalMinutes,
        // Store as Decimal to support fractional weeks
        durationWeeks: validatedData.durationWeeks,
        nextExecution,
        totalExecutions,
        slippage: slippage,
        status: "ACTIVE",
        jobId: null, // Initially null, will be updated when job is created
        ipfsLink: null, // Initially null, will be updated when IPFS link is created
      },
    });

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: {
        id: dcaPlan.id,
        userAddress: dcaPlan.userAddress,
        fromToken: dcaPlan.fromToken,
        toToken: dcaPlan.toToken,
        amount: dcaPlan.amount.toString(),
        intervalMinutes: dcaPlan.intervalMinutes,
        durationWeeks: parseFloat(dcaPlan.durationWeeks.toString()),
        status: dcaPlan.status as any,
        nextExecution: dcaPlan.nextExecution?.toISOString() || null,
        executionCount: dcaPlan.executionCount,
        totalExecutions: dcaPlan.totalExecutions,
        slippage: dcaPlan.slippage.toString(),
        jobId: dcaPlan.jobId,
        ipfsLink: dcaPlan.ipfsLink,
        createdAt: dcaPlan.createdAt.toISOString(),
        updatedAt: dcaPlan.updatedAt.toISOString(),
      },
      message: "DCA plan created successfully",
    };

    console.log(
      `✅ Created DCA plan: ${validatedData.fromToken} → ${validatedData.toToken} for ${validatedData.userAddress}`
    );
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

    const dcaPlans = await prisma.dcaPlan.findMany({
      where: {
        userAddress: userAddress,
        status:"ACTIVE"
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        executions: {
          orderBy: { executedAt: "desc" },
          take: 1, // Get latest execution for each plan
        },
      },
    });

    const triggerxClient = new TriggerXClient(
      process.env.TRIGGERX_API_KEY || ""
    );

    // Fetch job data for each plan (in parallel)
    const formattedPlans: DCAPlanResponse[] = await Promise.all(
      dcaPlans.map(
        async (plan) => {
          let jobData = null;
          if (plan.jobId) {
            try {
              jobData = await getJobDataById(triggerxClient, plan.jobId);
            } catch (err) {
              console.warn(
                `Failed to fetch job data for jobId ${plan.jobId}:`,
                err
              );
            }
          }
          return {
            id: plan.id,
            userAddress: plan.userAddress,
            fromToken: plan.fromToken,
            toToken: plan.toToken,
            amount: plan.amount.toString(),
            intervalMinutes: plan.intervalMinutes,
            durationWeeks: parseFloat(plan.durationWeeks.toString()),
            status: plan.status as any,
            nextExecution: plan.nextExecution?.toISOString() || null,
            executionCount: plan.executionCount,
            totalExecutions: plan.totalExecutions,
            slippage: plan.slippage.toString(),
            jobId: plan.jobId,
            ipfsLink: plan.ipfsLink,
            createdAt: plan.createdAt.toISOString(),
            updatedAt: plan.updatedAt.toISOString(),
            jobData, // <-- Embed jobData here
          };
        }
      )
    );

    const response: ApiResponse<DCAPlanResponse[]> = {
      success: true,
      data: formattedPlans,
      message: `Found ${formattedPlans.length} DCA plans`,
    };

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

    // Update plan details
    const updatedPlan = await prisma.dcaPlan.update({
      where: { id: planId },
      data: updateData,
    });

    const response: ApiResponse<DCAPlanResponse> = {
      success: true,
      data: {
        id: updatedPlan.id,
        userAddress: updatedPlan.userAddress,
        fromToken: updatedPlan.fromToken,
        toToken: updatedPlan.toToken,
        amount: updatedPlan.amount.toString(),
        intervalMinutes: updatedPlan.intervalMinutes,
        durationWeeks: parseFloat(updatedPlan.durationWeeks.toString()),
        status: updatedPlan.status as any,
        nextExecution: updatedPlan.nextExecution?.toISOString() || null,
        executionCount: updatedPlan.executionCount,
        totalExecutions: updatedPlan.totalExecutions,
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
        intervalMinutes: updatedPlan.intervalMinutes,
        durationWeeks: parseFloat(updatedPlan.durationWeeks.toString()),
        status: updatedPlan.status as any,
        nextExecution: updatedPlan.nextExecution?.toISOString() || null,
        executionCount: updatedPlan.executionCount,
        totalExecutions: updatedPlan.totalExecutions,
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
  try {
    const { userAddress } = req.params;

    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Address",
        message: "Invalid Ethereum address format",
      });
    }

    // 1. Get all DCA plans for the user
    const dcaPlans = await prisma.dcaPlan.findMany({
      where: { userAddress },
      orderBy: { createdAt: "desc" },
    });

    const triggerxClient = new TriggerXClient(process.env.TRIGGERX_API_KEY || "");

    // 2. For each plan, fetch job data and extract task info
    const history: any[] = [];

    await Promise.all(
      dcaPlans.map(async (plan) => {
        if (plan.jobId) {
          try {
            const jobDataResp = await getJobDataById(triggerxClient, plan.jobId);
            console.log("Line 398:",jobDataResp);
            if (jobDataResp && Array.isArray(jobDataResp.taskData)) {
              jobDataResp.taskData.forEach((task: any) => {
                history.push({
                  fromToken: plan.fromToken,
                  toToken: plan.toToken,
                  amount: plan.amount.toString(),
                  jobId: plan.jobId,
                  taskId: task.task_id,
                  executionTimestamp: task.execution_timestamp,
                  executionTxHash: task.execution_tx_hash,
                  taskStatus: task.task_status,
                  txUrl: task.tx_url,
                });
              });
            }
          } catch (err) {
            console.warn(`Failed to fetch job data for jobId ${plan.jobId}:`, err);
          }
        }
      })
    );

    res.json({
      success: true,
      data: history,
      message: `Found ${history.length} task executions for user ${userAddress}`,
    });
  } catch (error) {
    console.error("Error fetching user job/task history:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch user job/task history",
    });
  }
});

// Get execution history for a plan
router.get("/history/:planId", async (req, res) => {
  try {
    const { planId } = req.params;
    const { limit = "50", offset = "0" } = req.query;

    // Validate plan exists
    const plan = await prisma.dcaPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      const response: ApiResponse = {
        success: false,
        error: "Plan Not Found",
        message: "DCA plan not found",
      };
      return res.status(404).json(response);
    }

    // Get execution history
    const executions = await prisma.executionHistory.findMany({
      where: { planId },
      orderBy: { executedAt: "desc" },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    const formattedExecutions = executions.map(
      (execution) => ({
        id: execution.id,
        planId: execution.planId,
        executedAt: execution.executedAt.toISOString(),
        fromAmount: execution.fromAmount.toString(),
        toAmount: execution.toAmount.toString(),
        exchangeRate: execution.exchangeRate.toString(),
        gasFee: execution.gasFee?.toString() || null,
        txHash: execution.txHash,
        status: execution.status,
        errorMessage: execution.errorMessage,
      })
    );

    const response: ApiResponse = {
      success: true,
      data: formattedExecutions,
      message: `Found ${formattedExecutions.length} executions`,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching execution history:", error);

    const response: ApiResponse = {
      success: false,
      error: "Internal Server Error",
      message: "Failed to fetch execution history",
    };
    res.status(500).json(response);
  }
});

// Platform statistics (duplicate of /api/status/stats for convenience)
router.get("/stats", async (req, res) => {
  try {
    // Get current counts
    const [totalPlans, activePlans, totalExecutions] = await Promise.all([
      prisma.dcaPlan.count(),
      prisma.dcaPlan.count({ where: { status: "ACTIVE" } }),
      prisma.executionHistory.count(),
    ]);

    // Get unique users count
    const uniqueUsers = await prisma.dcaPlan.groupBy({
      by: ["userAddress"],
      _count: true,
    });

    // Get recent executions (last 24 hours and 7 days)
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [last24hExecutions, last7dExecutions] = await Promise.all([
      prisma.executionHistory.count({
        where: {
          executedAt: { gte: last24h },
          status: "SUCCESS",
        },
      }),
      prisma.executionHistory.count({
        where: {
          executedAt: { gte: last7d },
          status: "SUCCESS",
        },
      }),
    ]);

    const stats: PlatformStatsResponse = {
      totalPlans,
      activePlans,
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
      },
    });

    console.log("Fetched users with jobIds:", users.length);
    console.log("Sample users:", users);

    const triggerxClient = new TriggerXClient(process.env.TRIGGERX_API_KEY || "");

    // 2. For each user/jobId, get jobData and extract failed tasks
    const failedTasks: { userAddress: string; jobId: string; taskId: number; txUrl: string }[] = [];

    await Promise.all(
      users.map(async (user: { userAddress: string; jobId: string | null }) => {
        if (!user.jobId) return; // Skip if jobId is null
        try {
          const jobDataResp = await getJobDataById(triggerxClient, user.jobId);
          console.log(`Job data for user ${user.userAddress}, jobId ${user.jobId}:`, jobDataResp);
          if (jobDataResp && Array.isArray(jobDataResp.taskData)) {
            jobDataResp.taskData.forEach((task: any) => {
              if (task.task_status === "failed") {
                failedTasks.push({
                  userAddress: user.userAddress,
                  jobId: user.jobId ?? "",
                  taskId: task.task_id,
                  txUrl: task.tx_url || "",
                });
              }
            });
          }
        } catch (err) {
          console.warn(`Failed to fetch job data for jobId ${user.jobId}:`, err);
        }
      })
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
        status:"CANCELLED",
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

export { router as dcaRoutes };

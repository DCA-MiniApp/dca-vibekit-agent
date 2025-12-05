import { Router } from 'express';
import { prisma, getDatabaseHealth } from '../../services/prisma.js';
import { type PlatformStatsResponse, type ApiResponse } from '../../types/shared.js';

const router: Router = Router();

// Platform statistics
router.get('/stats', async (req, res) => {
  try {
    // Get current counts
    const [totalPlans, activePlans] = await Promise.all([
      prisma.dcaPlan.count(),
      prisma.dcaPlan.count({ where: { status: 'ACTIVE' } }),
    ]);
    
    // totalExecutions now comes from TriggerX API data
    const totalExecutions = 0; // Placeholder - actual count comes from TriggerX
    
    // Get unique users count
    const uniqueUsers = await prisma.dcaPlan.groupBy({
      by: ['userAddress'],
      _count: true,
    });
    
    // Recent executions now come from TriggerX API data
    const last24hExecutions = 0; // Placeholder - actual count comes from TriggerX
    const last7dExecutions = 0; // Placeholder - actual count comes from TriggerX
    
    const stats: PlatformStatsResponse = {
      totalPlans,
      // activePlans,
      totalUsers: uniqueUsers.length,
      totalExecutions,
      last24hExecutions,
      last7dExecutions,
    };
    
    const response: ApiResponse<PlatformStatsResponse> = {
      success: true,
      data: stats,
      message: 'Platform statistics retrieved successfully',
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Error fetching platform stats:', error);
    
    const response: ApiResponse = {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch platform statistics',
    };
    res.status(500).json(response);
  }
});

// System health check
router.get('/health', async (req, res) => {
  try {
    const dbHealth = await getDatabaseHealth();
    
    const systemHealth = {
      api: 'healthy',
      database: dbHealth,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      env: process.env.NODE_ENV || 'development',
    };
    
    const response: ApiResponse = {
      success: true,
      data: systemHealth,
      message: 'System health check completed',
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Error in health check:', error);
    
    const response: ApiResponse = {
      success: false,
      error: 'Health Check Failed',
      message: 'System health check failed',
    };
    res.status(500).json(response);
  }
});

// Get scheduler status
router.get('/scheduler', (req, res) => {
  // Access scheduler instance from global scope (if available)
  const schedulerStatus = (global as any).dcaScheduler?.getStatus();
  
  if (!schedulerStatus) {
    const response: ApiResponse = {
      success: false,
      error: 'Scheduler Not Available',
      message: 'DCA scheduler is not running or not initialized',
    };
    return res.status(503).json(response);
  }
  
  const response: ApiResponse = {
    success: true,
    data: {
      ...schedulerStatus,
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    },
    message: 'Scheduler status retrieved successfully',
  };
  
  res.json(response);
});

export { router as statusRoutes };

import express from 'express';
import cors from 'cors';
import { prisma, getDatabaseHealth } from '../services/prisma.js';
import { dcaRoutes } from './routes/dca.js';
import { prepareSwapRouter } from './routes/dca.prepareSwap.js';
import { statusRoutes } from './routes/status.js';

// Initialize notification infrastructure
// This will auto-start the poller (checks for failed tasks every 20 minutes)
// import '../notification-infra/pollFailedTasks.js';
// This will auto-start the balance warning poller (checks for low balance every 5 minutes)
// import '../notification-infra/pollLowBalanceWarnings.js';
// This will auto-start the worker (processes notification jobs from queue)
// import '../notification-infra/notificationWorker.js';
// This will auto-start the job status poller (checks job status every 5 minutes and sends to Slack)
// import '../notification-infra/pollJobStatus.js';


const app: express.Application = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: corsOrigin,
  methods: ['POST', 'PUT', 'DELETE', 'OPTIONS', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ishome'],
  credentials: true,
}));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbHealth = await getDatabaseHealth();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'DCA Agent API',
      database: dbHealth,
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      service: 'DCA Agent API',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// API Routes
app.use('/api/dca', dcaRoutes);
app.use('/api/dca', prepareSwapRouter);
app.use('/api/status', statusRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'DCA Agent API',
    version: '1.0.0',
    description: 'Multi-user DCA automation platform',
    endpoints: {
      health: '/health',
      dca: '/api/dca/*',
      swap: '/api/swap/*',
      status: '/api/status/*',
    },
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message,
      details: err.details || null,
    });
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

export { app };

import express from 'express';
import cors from 'cors';
import { prisma, getDatabaseHealth } from '../services/prisma.js';
import { dcaRoutes } from './routes/dca.js';
import vaultRoutes from './routes/vault.js';
import { statusRoutes } from './routes/status.js';

const app: express.Application = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: corsOrigin,
  methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
app.use('/api/vault', vaultRoutes);
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
      vault: '/api/vault/*',
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

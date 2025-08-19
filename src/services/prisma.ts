import { PrismaClient } from '@prisma/client';

// Global Prisma instance to prevent multiple connections in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    errorFormat: 'pretty',
    // Optimized for NeonDB serverless
    datasourceUrl: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Database connection test
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$connect();
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

// Graceful shutdown
export async function closeDatabaseConnection(): Promise<void> {
  try {
    await prisma.$disconnect();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('❌ Error closing database connection:', error);
  }
}

// Database health check
export async function getDatabaseHealth() {
  try {
    // Test basic connectivity
    await prisma.$queryRaw`SELECT 1`;
    
    // Get basic stats
    const totalPlans = await prisma.dcaPlan.count();
    const activePlans = await prisma.dcaPlan.count({
      where: { status: 'ACTIVE' }
    });
    const totalExecutions = await prisma.executionHistory.count();
    
    return {
      status: 'healthy',
      totalPlans,
      activePlans,
      totalExecutions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    };
  }
}
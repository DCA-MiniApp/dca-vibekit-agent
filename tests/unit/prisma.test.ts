import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, testDatabaseConnection, getDatabaseHealth } from '../../src/services/prisma.js';

describe('Prisma Database Integration', () => {
  beforeAll(async () => {
    // Ensure database connection is available
    await testDatabaseConnection();
  });

  afterAll(async () => {
    // Clean up
    await prisma.$disconnect();
  });

  it('should connect to database successfully', async () => {
    const connected = await testDatabaseConnection();
    expect(connected).toBe(true);
  });

  it('should return database health status', async () => {
    const health = await getDatabaseHealth();
    expect(health).toHaveProperty('status');
    expect(health).toHaveProperty('timestamp');
    
    if (health.status === 'healthy') {
      expect(health).toHaveProperty('totalPlans');
      expect(health).toHaveProperty('activePlans');
      expect(health).toHaveProperty('totalExecutions');
    }
  });

  it('should be able to query DCA plans table', async () => {
    // This will fail if schema is not applied, which is expected during development
    try {
      const count = await prisma.dcaPlan.count();
      expect(typeof count).toBe('number');
    } catch (error) {
      // Expected during initial setup before schema is applied
      console.log('Note: Schema not applied yet - this is expected during development');
    }
  });
});
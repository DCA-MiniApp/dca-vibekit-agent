import 'dotenv/config';

// Test setup for Vitest
console.log('🧪 Setting up test environment...');

// Ensure test environment variables
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not set - database tests will fail');
  console.warn('   Set up a test database and add DATABASE_URL to .env');
}
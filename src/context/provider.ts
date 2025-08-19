import type { ContextProvider } from 'arbitrum-vibekit-core';
import type { ContextDependencies, DCAContext } from './types.js';
import { prisma, testDatabaseConnection } from '../services/prisma.js';

export const contextProvider: ContextProvider<DCAContext> = async (
  deps: ContextDependencies
) => {
  // Initialize Prisma client and test connection
  console.log('🔧 Testing database connection...');
  const dbConnected = await testDatabaseConnection();

  // Initialize blockchain configuration
  const arbitrumRpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.warn('⚠️  PRIVATE_KEY not configured - DCA execution will not work');
  }

  // Initialize MCP client for swap operations (will be implemented in Phase 5)
  const emberMcpUrl = process.env.EMBER_MCP_SERVER_URL || 'https://api.emberai.xyz/mcp';

  console.log('🔧 Initializing DCA Agent context...');
  console.log(`   - RPC URL: ${arbitrumRpcUrl}`);
  console.log(`   - Private Key: ${privateKey ? '✅ configured' : '❌ not configured'}`);
  console.log(`   - Ember MCP URL: ${emberMcpUrl}`);
  console.log(`   - Database: ${dbConnected ? '✅ connected' : '❌ connection failed'}`);

  if (!dbConnected) {
    console.warn('⚠️  Database connection failed - DCA operations will not work');
    console.warn('   Please check your DATABASE_URL in .env file');
  }

  return {
    // Prisma client for database operations
    prisma,
    
    // Blockchain configuration
    rpcUrl: arbitrumRpcUrl,
    privateKey,
    
    // MCP client for swap operations
    emberMcpUrl,
    
    // LLM model from dependencies
    llmModel: deps.llmModel,
    
    // Token mappings for supported tokens
    tokenMap: {
      'WETH': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      'USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      'USDT': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      'ARB': '0x912CE59144191C1204E64559FE8253a0e49E6548',
      'DAI': '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    },
  };
};
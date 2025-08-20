#!/usr/bin/env node
/**
 * DCA Agent - Multi-User Automated Investment Platform
 * Supports automated DCA strategies with PostgreSQL persistence and multi-user execution
 */

import 'dotenv/config';
import { Agent, createProviderSelector, getAvailableProviders } from 'arbitrum-vibekit-core';
import { contextProvider } from './context/provider.js';
import { agentConfig } from './config.js';
import { app as apiServer } from './api/server.js';
import { DCAScheduler } from './services/scheduler.js';

// Skills - implemented and planned
// import { dcaSwappingSkill } from './skills/dca-swapping.js';

// Provider selector initialization
const providers = createProviderSelector({
  openRouterApiKey: process.env.OPENROUTER_API_KEY
});

const available = getAvailableProviders(providers);
if (available.length === 0) {
  console.error('❌ No AI providers configured. Please set at least one provider API key.');
  console.error('   Supported providers: OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}

const preferred = process.env.AI_PROVIDER || available[0]!;
const selectedProvider = providers[preferred as keyof typeof providers];
if (!selectedProvider) {
  console.error(
    `❌ Preferred provider '${preferred}' not available. Available: ${available.join(', ')}`
  );
  process.exit(1);
}

const modelOverride = process.env.AI_MODEL;

// Export agent configuration for testing
export { agentConfig };

// Configure the agent
const agent = Agent.create(agentConfig, {
  // Runtime options
  cors: process.env.ENABLE_CORS !== 'false',
  basePath: process.env.BASE_PATH || undefined,
  llm: {
    model: modelOverride ? selectedProvider!(modelOverride) : selectedProvider!(),
  },
});

// Start the agent
const PORT = parseInt(process.env.PORT || '3001', 10);

// Health check endpoint for production deployments
export { agent };

async function startAgent() {
  try {
    // Start the REST API server on a different port
    const API_PORT = parseInt(process.env.API_PORT || '3002', 10);
    apiServerInstance = apiServer.listen(API_PORT, () => {
      console.log(`🚀 DCA API Server started on http://localhost:${API_PORT}`);
      console.log(`📊 API Endpoints: http://localhost:${API_PORT}/api/*`);
      console.log(`❤️  Health Check: http://localhost:${API_PORT}/health`);
    });

    // Start the MCP agent
    await agent.start(PORT, async deps => {
      // The context provider needs the LLM model from the agent configuration
      const llmModel = selectedProvider!(modelOverride);
      const context = await contextProvider({ ...deps, llmModel });
      
      // Start the DCA scheduler if transaction execution is enabled
      if (context.executeTransaction && process.env.ENABLE_SCHEDULER !== 'false') {
        console.log('🤖 Starting DCA scheduler...');
        dcaScheduler = new DCAScheduler(context);
        
        try {
          await dcaScheduler.startScheduler();
          console.log('✅ DCA scheduler started successfully');
          
          // Expose scheduler for API access
          (global as any).dcaScheduler = dcaScheduler;
        } catch (error) {
          console.error('❌ Failed to start DCA scheduler:', error);
          console.warn('   DCA automation will not be available');
        }
      } else if (!context.executeTransaction) {
        console.warn('⚠️  DCA scheduler disabled - transaction execution not enabled');
        console.warn('   Please provide PRIVATE_KEY to enable automated DCA execution');
      } else {
        console.log('ℹ️  DCA scheduler disabled via ENABLE_SCHEDULER=false');
      }
      
      return context;
    });

    console.log('🤖 DCA Agent successfully started!');
    console.log(`📍 MCP Base URL: http://localhost:${PORT}`);
    console.log(`🤖 Agent Card: http://localhost:${PORT}/.well-known/agent.json`);
    console.log(`🔌 MCP SSE: http://localhost:${PORT}/sse`);
    console.log(`💬 MCP Messages: http://localhost:${PORT}/messages`);
    console.log('\n🎯 Available Skills:');

    if (agentConfig.skills.length === 0) {
      console.log('   (No skills implemented yet - starting with Phase 1)');
    } else {
      agentConfig.skills.forEach(skill => {
        console.log(`   - ${skill.name}: ${skill.description}`);
      });
    }

    console.log('\n💡 Environment Configuration:');
    console.log(`   - AI Provider: ${preferred}`);
    console.log(`   - Model: ${modelOverride || 'default'}`);
    console.log(`   - MCP Port: ${PORT}`);
    console.log(`   - API Port: ${API_PORT}`);
    console.log(`   - CORS Enabled: ${process.env.ENABLE_CORS !== 'false'}`);
    console.log(
      `   - Arbitrum RPC: ${process.env.ARBITRUM_RPC_URL ? '✅ configured' : '⚠️  using default'}`
    );
    console.log(
      `   - Ember MCP Server: ${process.env.EMBER_MCP_SERVER_URL ? '✅ configured' : '⚠️  using default'}`
    );
    console.log(
      `   - Database: ${process.env.DATABASE_URL ? '✅ configured' : '⚠️  not configured'}`
    );
    console.log(
      `   - Private Key: ${process.env.PRIVATE_KEY ? '✅ configured' : '⚠️  not configured'}`
    );
    console.log(
      `   - DCA Scheduler: ${process.env.ENABLE_SCHEDULER !== 'false' ? '✅ enabled' : '❌ disabled'}`
    );
    console.log(
      `   - Scheduler Interval: ${process.env.SCHEDULER_INTERVAL_SECONDS || '60'} seconds`
    );
    console.log(
      `   - Max Concurrent Executions: ${process.env.MAX_CONCURRENT_EXECUTIONS || '50'}`
    );

    if (!process.env.ARBITRUM_RPC_URL || !process.env.EMBER_MCP_SERVER_URL || !process.env.DATABASE_URL) {
      console.log('\n⚠️  Warning: Some environment variables are not configured.');
      console.log('   For production use, please configure these in your .env file.');
    }

    if (!process.env.PRIVATE_KEY) {
      console.log('\n⚠️  DCA Automation: PRIVATE_KEY not configured.');
      console.log('   - DCA plans can be created but will not execute automatically');
      console.log('   - Provide PRIVATE_KEY to enable automated swap execution');
    }
  } catch (error) {
    console.error('❌ Failed to start DCA Agent:', error);
    process.exit(1);
  }
}

// Store API server instance and scheduler for graceful shutdown
let apiServerInstance: any = null;
let dcaScheduler: DCAScheduler | null = null;

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down DCA Agent gracefully...`);
  try {
    // Import prisma service dynamically to avoid circular dependencies
    const { closeDatabaseConnection } = await import('./services/prisma.js');
    
    // Stop DCA scheduler first
    if (dcaScheduler) {
      await dcaScheduler.stopScheduler();
      dcaScheduler = null;
    }
    
    // Close API server
    if (apiServerInstance) {
      await new Promise<void>((resolve) => {
        apiServerInstance.close(() => {
          console.log('✅ API server stopped');
          resolve();
        });
      });
    }
    
    // Close database connection
    await closeDatabaseConnection();
    
    // Stop the agent
    await agent.stop();
    console.log('✅ DCA Agent stopped successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

// Register shutdown handlers
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(signal => {
  process.on(signal, () => shutdown(signal));
});

// Handle uncaught exceptions and rejections
process.on('uncaughtException', error => {
  console.error('❌ Uncaught Exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the agent if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startAgent();
}

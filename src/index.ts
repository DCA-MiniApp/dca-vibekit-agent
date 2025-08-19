#!/usr/bin/env node
/**
 * DCA Agent - Multi-User Automated Investment Platform
 * Supports automated DCA strategies with PostgreSQL persistence and multi-user execution
 */

import 'dotenv/config';
import { Agent, createProviderSelector, getAvailableProviders } from 'arbitrum-vibekit-core';
import { contextProvider } from './context/provider.js';
import { agentConfig } from './config.js';

// Skills - implemented and planned
// import { dcaSwappingSkill } from './skills/dca-swapping.js';

// Provider selector initialization
const providers = createProviderSelector({
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  xaiApiKey: process.env.XAI_API_KEY,
  hyperbolicApiKey: process.env.HYPERBOLIC_API_KEY,
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
    await agent.start(PORT, async deps => {
      // The context provider needs the LLM model from the agent configuration
      const llmModel = selectedProvider!(modelOverride);
      return contextProvider({ ...deps, llmModel });
    });

    console.log('🤖 DCA Agent successfully started!');
    console.log(`📍 Base URL: http://localhost:${PORT}`);
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

    if (!process.env.ARBITRUM_RPC_URL || !process.env.EMBER_MCP_SERVER_URL || !process.env.DATABASE_URL) {
      console.log('\n⚠️  Warning: Some environment variables are not configured.');
      console.log('   For production use, please configure these in your .env file.');
    }
  } catch (error) {
    console.error('❌ Failed to start DCA Agent:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down DCA Agent gracefully...`);
  try {
    // Import prisma service dynamically to avoid circular dependencies
    const { closeDatabaseConnection } = await import('./services/prisma.js');
    
    // Close database connection first
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
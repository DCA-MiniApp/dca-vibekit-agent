#!/usr/bin/env node
/**
 * DCA Agent - Multi-User Automated Investment Platform
 * Supports automated DCA strategies with PostgreSQL persistence and multi-user execution
 */

import 'dotenv/config';
import { Agent, createProviderSelector, getAvailableProviders } from 'arbitrum-vibekit-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { contextProvider } from './context/provider.js';
import { agentConfig } from './config.js';
import { app as apiServer } from './api/server.js';
// Removed scheduler import since we don't need automated scheduling anymore

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

const modelOverride = process.env.LLM_MODEL;

// Export agent configuration for testing
export { agentConfig };

// Configure the agent
const agent = Agent.create(agentConfig, {
  // Runtime options
  cors: process.env.ENABLE_CORS !== 'false',
  basePath: process.env.BASE_PATH || undefined,
  llm: {
    model: modelOverride ? selectedProvider!(modelOverride) : selectedProvider!(process.env.LLM_MODEL || 'deepseek/deepseek-chat-v3-0324:free'),
  },
});

// Start the agent
const PORT = parseInt(process.env.PORT || '3030', 10);

// Health check endpoint for production deployments
export { agent };

async function startAgent() {
  try {
    // Start the REST API server on a different port
    const API_PORT = parseInt(process.env.API_PORT || '3031', 10);
    apiServerInstance = apiServer.listen(API_PORT, () => {
      console.log(`🚀 DCA API Server started on http://localhost:${API_PORT}`);
      console.log(`📊 API Endpoints: http://localhost:${API_PORT}/api/*`);
      console.log(`❤️  Health Check: http://localhost:${API_PORT}/health`);
    });

    // Start the MCP agent
    await agent.start(PORT, async deps => {

      console.log('🔥🔥🔥 [AGENT] Agent started - ready to receive messages');
      console.log('🔥🔥🔥 [AGENT] Available skills:', agentConfig.skills.map(s => s.name));
      console.log('🔥🔥🔥 [AGENT] Available tools:', agentConfig.skills.flatMap(s => s.tools.map(t => t.name)));

      let emberMcpClient: Client | null = null;

      const emberEndpoint = process.env.EMBER_MCP_SERVER_URL || 'https://api.emberai.xyz/mcp';

      try {
        console.log(`[DCA Agent] Connecting to MCP server at ${emberEndpoint}`);
        emberMcpClient = new Client(
          { name: 'DCAAgent', version: '1.0.0' },
          { capabilities: { tools: {}, resources: {}, prompts: {} } }
        );

        const transport = new StreamableHTTPClientTransport(new URL(emberEndpoint));
        // await emberMcpClient.connect(transport);
        // Add connection timeout similar to other agents
        const timeoutMs = parseInt(process.env.MCP_CONNECTION_TIMEOUT || '60000', 10);
        const connectionPromise = emberMcpClient.connect(transport);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`MCP connection timeout after ${timeoutMs}ms`)), timeoutMs)
        );
        await Promise.race([connectionPromise, timeoutPromise]);
        console.log('[DCA Agent] MCP client connected successfully.');
      } catch (error) {
        console.error('[DCA Agent] Failed to connect to MCP server:', error);
      }

      // Add the manual MCP client to the deps so tools can access it (only if connection succeeded)
      const updatedDeps = {
        ...deps,
        mcpClients: emberMcpClient ? {
          ...deps.mcpClients,
          'ember-mcp-tool-server': emberMcpClient
        } : deps.mcpClients
      };

      // The context provider needs the LLM model from the agent configuration
      const llmModel = selectedProvider!(modelOverride);
      const context = await contextProvider({ ...updatedDeps, llmModel });

      // Removed DCA scheduler - execution is now handled by TriggerX
      console.log('ℹ️  DCA scheduler removed - execution handled by TriggerX');

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
      `   - DCA Execution: Handled by TriggerX (not backend scheduler)`
    );

    if (!process.env.ARBITRUM_RPC_URL || !process.env.EMBER_MCP_SERVER_URL || !process.env.DATABASE_URL) {
      console.log('\n⚠️  Warning: Some environment variables are not configured.');
      console.log('   For production use, please configure these in your .env file.');
    }

    console.log('\nℹ️  DCA Execution: PRIVATE_KEY not required for backend.');
    console.log('   - DCA plans are created and TriggerX handles execution');
    console.log('   - Transaction approvals are handled in the frontend');
  } catch (error) {
    console.error('❌ Failed to start DCA Agent:', error);
    process.exit(1);
  }
}

// Store API server instance for graceful shutdown
let apiServerInstance: any = null;

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down DCA Agent gracefully...`);
  try {
    // Import prisma service dynamically to avoid circular dependencies
    const { closeDatabaseConnection } = await import('./services/prisma.js');

    // Removed DCA scheduler shutdown - no scheduler to stop

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

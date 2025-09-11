import type { PrismaClient } from '@prisma/client';
import type { LanguageModelV1 } from 'ai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Address } from 'viem';
// Removed transaction executor import since we don't need it anymore

export interface ContextDependencies {
  mcpClients: Record<string, Client>;
  llmModel?: LanguageModelV1;
}

export interface TokenInfo {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

export interface DCAContext {
  // Database client
  prisma: PrismaClient;
  
  // MCP client for Ember operations
  mcpClient: Client | null;
  
  // Token mappings from Ember MCP
  tokenMap: Record<string, TokenInfo[]>;
  
  // User configuration
  userAddress?: Address;
  
  // LLM model for AI operations
  llmModel?: LanguageModelV1;
  
  // Removed executeTransaction - transaction execution is handled by TriggerX now
  
  // Configuration
  config: {
    arbitrumRpcUrl: string;
    emberMcpServerUrl: string;
    defaultUserAddress?: Address;
    enableCaching: boolean;
    privateKey?: string;
  };
  
  // Metadata
  metadata: {
    loadedAt: Date;
    mcpConnected: boolean;
    tokenCount: number;
    availableSkills: string[];
    environment: string;
      // Removed transactionExecutionEnabled - execution handled by TriggerX
  };
}

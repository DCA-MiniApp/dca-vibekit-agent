import type { PrismaClient } from '@prisma/client';
import type { LanguageModelV1 } from 'ai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Address } from 'viem';
import type { DCATransactionExecutor } from '../utils/transactionExecutor.js';

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
  
  // Transaction executor for DCA swaps
  executeTransaction?: DCATransactionExecutor;
  
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
    transactionExecutionEnabled: boolean;
  };
}

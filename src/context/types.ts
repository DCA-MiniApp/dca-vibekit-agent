import type { CoreDependencies } from 'arbitrum-vibekit-core';
import type { PrismaClient } from '@prisma/client';

export interface ContextDependencies extends CoreDependencies {
  llmModel: any; // Will be typed properly when we have the actual model interface
}

export interface DCAContext {
  // Database client
  prisma: PrismaClient;
  
  // Blockchain configuration
  rpcUrl: string;
  privateKey?: string;
  
  // MCP client configuration
  emberMcpUrl: string;
  
  // LLM model for AI operations
  llmModel: any;
  
  // Token address mappings
  tokenMap: Record<string, string>;
}
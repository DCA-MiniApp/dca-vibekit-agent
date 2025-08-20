import type { ContextDependencies, DCAContext, TokenInfo } from './types.js';
import type { LanguageModelV1 } from 'ai';
import { prisma, testDatabaseConnection } from '../services/prisma.js';
import { Address, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DCATransactionExecutor } from '../utils/transactionExecutor.js';
import pRetry from 'p-retry';

/**
 * Load token map from Ember MCP server
 */
async function loadTokenMap(mcpClient: any): Promise<Record<string, TokenInfo[]>> {
  const MCP_TOOL_TIMEOUT_MS = parseInt(process.env.MCP_TOOL_TIMEOUT_MS || '120000', 10);

  const fetchTokens = async () => {
    console.log('[Context] Loading token map from Ember MCP server...');
    const response = await mcpClient.callTool(
      {
        name: 'getCapabilities',
        arguments: { type: 'SWAP' },
      },
      undefined,
      { timeout: MCP_TOOL_TIMEOUT_MS }
    );

    if (response && typeof response === 'object' && 'structuredContent' in response) {
      const data = (response as any).structuredContent;
      if (data && data.capabilities && Array.isArray(data.capabilities)) {
        const swapCapability = data.capabilities.find((cap: any) => cap.type === 'swap');
        if (swapCapability?.swapCapability?.supportedTokens) {
          const supportedTokens = swapCapability.swapCapability.supportedTokens;
          const tokenMap: Record<string, TokenInfo[]> = {};
          let loadedCount = 0;
          for (const token of supportedTokens) {
            if (token.symbol && token.tokenUid) {
              const symbol = token.symbol.toUpperCase();
              if (!tokenMap[symbol]) {
                tokenMap[symbol] = [];
              }
              tokenMap[symbol].push({
                chainId: parseInt(token.tokenUid.chainId, 10),
                address: token.tokenUid.address,
                decimals: token.decimals || 18,
                symbol: token.symbol,
                name: token.name || token.symbol,
              });
              loadedCount++;
            }
          }
          console.log(`[Context] Loaded ${loadedCount} tokens from Ember MCP`);
          return tokenMap;
        }
      }
    }
    throw new Error('No valid token data found in Ember MCP response');
  };

  try {
    return await pRetry(fetchTokens, {
      retries: 3,
      onFailedAttempt: error => {
        console.warn(`[Context] Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`);
      },
    });
  } catch (error) {
    console.error('[Context] Error loading token map from Ember MCP:', error);
    console.warn('[Context] Using fallback token map');
    // Fallback token map for Arbitrum
    return {
      'WETH': [{
        chainId: 42161,
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ether'
      }],
      'USDC': [{
        chainId: 42161,
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin'
      }],
      'USDT': [{
        chainId: 42161,
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        decimals: 6,
        symbol: 'USDT',
        name: 'Tether USD'
      }],
      'ARB': [{
        chainId: 42161,
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        decimals: 18,
        symbol: 'ARB',
        name: 'Arbitrum'
      }]
    };
  }
}

function parseUserAddress(addressString?: string): Address | undefined {
  if (!addressString) return undefined;
  if (isAddress(addressString)) {
    return addressString as Address;
  }
  console.warn(`[Context] Invalid default user address: ${addressString}`);
  return undefined;
}

export async function contextProvider(
  deps: ContextDependencies & { llmModel?: LanguageModelV1 }
): Promise<DCAContext> {
  console.log('[Context] Initializing DCA Agent context...');

  // Initialize Prisma client and test connection
  console.log('[Context] Testing database connection...');
  const dbConnected = await testDatabaseConnection();

  if (!dbConnected) {
    console.warn('⚠️  Database connection failed - DCA operations will not work');
    console.warn('   Please check your DATABASE_URL in .env file');
  }

  const { mcpClients, llmModel } = deps;

  // Find the Ember MCP client
  const emberMcpClient = Object.entries(mcpClients).find(
    ([name]) => name.includes('ember') || name.includes('mcp-tool-server')
  )?.[1] || null;

  console.log('emberMcpClient', emberMcpClient);

  let tokenMap: Record<string, TokenInfo[]> = {};
  let mcpConnected = false;

  if (emberMcpClient) {
    console.log('[Context] Found Ember MCP client, loading token map...');
    tokenMap = await loadTokenMap(emberMcpClient);
    mcpConnected = true;
  } else {
    console.warn('[Context] No Ember MCP client found - using fallback token map');
    tokenMap = await loadTokenMap(null); // Will use fallback
  }

  // Parse configuration
  const arbitrumRpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
  const emberMcpServerUrl = process.env.EMBER_MCP_SERVER_URL || 'https://api.emberai.xyz/mcp';
  const defaultUserAddress = parseUserAddress(process.env.DEFAULT_USER_ADDRESS);
  const enableCaching = process.env.AGENT_CACHE_TOKENS === 'true';
  const privateKey = process.env.PRIVATE_KEY;

  // Set up transaction execution if private key is provided
  let transactionExecutor: DCATransactionExecutor | undefined;
  let executionUserAddress: Address | undefined;
  let transactionExecutionEnabled = false;

  if (privateKey) {
    try {
      console.log('[Context] Setting up transaction execution...');
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      executionUserAddress = account.address;
      transactionExecutor = new DCATransactionExecutor(account, executionUserAddress);
      transactionExecutionEnabled = true;
      console.log(`[Context] Transaction execution enabled for address: ${executionUserAddress}`);
    } catch (error) {
      console.warn('[Context] Failed to set up transaction execution:', error);
      console.warn('   DCA swaps will not be executed automatically');
    }
  } else {
    console.warn('[Context] No PRIVATE_KEY provided - transaction execution disabled');
    console.warn('   DCA plans can be created but swaps will not execute automatically');
  }

  // Count available tokens
  const tokenCount = Object.values(tokenMap).reduce((count, tokens) => count + tokens.length, 0);

  const context: DCAContext = {
    prisma,
    mcpClient: emberMcpClient,
    tokenMap,
    userAddress: executionUserAddress || defaultUserAddress,
    llmModel,
    executeTransaction: transactionExecutor,
    config: {
      arbitrumRpcUrl,
      emberMcpServerUrl,
      defaultUserAddress,
      enableCaching,
      privateKey,
    },
    metadata: {
      loadedAt: new Date(),
      mcpConnected,
      tokenCount,
      availableSkills: ['dca-management'],
      environment: process.env.NODE_ENV || 'development',
      transactionExecutionEnabled,
    },
  };

  // Log context summary
  console.log('[Context] DCA Agent context loaded:');
  console.log(`  - Database: ${dbConnected ? '✅ connected' : '❌ connection failed'}`);
  console.log(`  - MCP Connected: ${mcpConnected ? '✅' : '❌'}`);
  console.log(`  - Token Map: ${Object.keys(tokenMap).length} symbols, ${tokenCount} tokens`);
  console.log(`  - RPC URL: ${arbitrumRpcUrl}`);
  console.log(`  - Transaction Execution: ${transactionExecutionEnabled ? '✅ enabled' : '❌ disabled'}`);

  return context;
}

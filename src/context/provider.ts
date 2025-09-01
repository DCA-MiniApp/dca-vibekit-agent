import type { ContextDependencies, DCAContext, TokenInfo } from './types.js';
import type { LanguageModelV1 } from 'ai';
import { prisma, testDatabaseConnection } from '../services/prisma.js';
import { Address, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DCATransactionExecutor } from '../utils/transactionExecutor.js';
import { parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import pRetry from 'p-retry';

// Local type definitions for MCP getTokens response (same as ember-api)
const TokenUidSchema = z.object({
  chainId: z.string(),
  address: z.string(),
});

const TokenSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  decimals: z.number(),
  tokenUid: TokenUidSchema,
});

const GetTokensResponseSchema = z.object({
  tokens: z.array(TokenSchema),
});

type Token = z.infer<typeof TokenSchema>;

/**
 * Convert ember-api Token to our internal TokenInfo structure
 */
function emberTokenToTokenInfo(token: Token): TokenInfo {
  return {
    chainId: parseInt(token.tokenUid.chainId, 10),
    address: token.tokenUid.address,
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.name || token.symbol,
  };
}

/**
 * Populate token map from ember-api tokens (similar to swapping agent)
 */
function populateTokenMap(tokens: Token[]): Record<string, TokenInfo[]> {
  const tokenMap: Record<string, TokenInfo[]> = {};
  let addedCount = 0;

  tokens.forEach(token => {
    const symbol = token.symbol.toUpperCase();

    if (!tokenMap[symbol]) {
      tokenMap[symbol] = [];
    }

    // Check if token already exists on this chain (avoid duplicates)
    const existsOnChain = tokenMap[symbol].some(
      t => t.chainId === parseInt(token.tokenUid.chainId, 10)
    );

    if (!existsOnChain) {
      tokenMap[symbol].push(emberTokenToTokenInfo(token));
      addedCount++;
    }
  });

  console.log(`[Context] Added ${addedCount} tokens to the token map`);
  return tokenMap;
}

/**
 * Fallback token map for Arbitrum when MCP client is unavailable
 */
function getFallbackTokenMap(): Record<string, TokenInfo[]> {
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

/**
 * Chain mappings for supported networks
 */
const CHAIN_MAPPINGS = [
  { id: '1', names: ['ethereum', 'mainnet', 'eth'] },
  { id: '42161', names: ['arbitrum', 'arbitrum one', 'arb'] },
  { id: '10', names: ['optimism', 'op'] },
  { id: '137', names: ['polygon', 'matic'] },
  { id: '8453', names: ['base'] },
];

/**
 * Load token map from Ember MCP server using getTokens (same as swapping agent)
 */
async function loadTokenMap(mcpClient: any): Promise<Record<string, TokenInfo[]>> {
  const fetchTokens = async () => {
    console.log('[Context] 🔄 Fetching supported tokens via MCP getTokens...');

    const chainIds = CHAIN_MAPPINGS.map(mapping => mapping.id);
    const getTokensArgs = chainIds.length > 0 ? { chainIds } : {};

    const tokensResult = await mcpClient.callTool({
      name: 'getTokens',
      arguments: getTokensArgs,
    });

    console.log('[Context] 📊 Parsing tokens response...');
    const tokensResponse = parseMcpToolResponsePayload(tokensResult, GetTokensResponseSchema) as z.infer<typeof GetTokensResponseSchema>;

    if (!tokensResponse.tokens || tokensResponse.tokens.length === 0) {
      throw new Error('No tokens received from Ember MCP getTokens');
    }

    console.log(`[Context] ✅ Received ${tokensResponse.tokens.length} tokens from Ember MCP`);
    const tokenMap = populateTokenMap(tokensResponse.tokens);

    // Debug: Log first 10 available Arbitrum tokens only
    const arbitrumSymbols = Object.entries(tokenMap)
      .filter(([_, tokens]) => tokens.some(token => token.chainId === 42161))
      .map(([symbol, _]) => symbol)
      .slice(0, 10);
    console.log('[Context] 📋 First 10 available Arbitrum tokens:', arbitrumSymbols.join(', '));

    return tokenMap;
  };

  try {
    return await pRetry(fetchTokens, {
      retries: 3,
      onFailedAttempt: error => {
        console.warn(`[Context] ⚠️  Token fetch attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`);
      },
    });
  } catch (error) {
    console.error('[Context] ❌ Error loading token map from Ember MCP:', error);
    throw error; // Let the caller handle fallback
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
  // console.log("MCP client details:",mcpClients);
  // console.log("LLM Model details:",llmModel);

  // Get the Ember MCP client (should be connected in index.ts)
  const emberMcpClient = mcpClients['ember-mcp-tool-server'] || null;
  console.log('[Context] Ember MCP client:', emberMcpClient ? '✅ connected' : '❌ not available'); 
  // console.log('emberMcpClient in provider', emberMcpClient);
  let tokenMap: Record<string, TokenInfo[]> = {};
  let mcpConnected = false;

  if (emberMcpClient) {
    console.log('[Context] Using connected Ember MCP client, loading token map...');
    try {
      tokenMap = await loadTokenMap(emberMcpClient);
      mcpConnected = true;
      console.log('mcpConnected in provider', mcpConnected);
      // Don't log the full tokenMap - it's too verbose
      // console.log('tokenMap in provider', tokenMap);

      // Filter and console only Arbitrum tokens
      const arbitrumTokens: Record<string, TokenInfo[]> = {};

      Object.entries(tokenMap).forEach(([symbol, tokens]) => {
        const arbitrumTokenList = tokens.filter(token => token.chainId === 42161);
        if (arbitrumTokenList.length > 0) {
          arbitrumTokens[symbol] = arbitrumTokenList;
        }
      });

      // console.log('🚀 Arbitrum tokens only:', arbitrumTokens);
      console.log(`📊 Total Arbitrum tokens: ${Object.keys(arbitrumTokens).length} symbols`);

      // Optional: Log first 10 Arbitrum tokens for quick reference
      const first10ArbitrumTokens = Object.entries(arbitrumTokens).slice(0, 10);
      console.log('🔍 First 10 Arbitrum tokens:');
      first10ArbitrumTokens.forEach(([symbol, tokens]) => {
        tokens.forEach(token => {
          console.log(`   ${symbol}: ${token.address} (${token.name})`);
        });
      });

    } catch (error) {
      console.error('[Context] Failed to load token map from MCP client:', error);
      console.warn('[Context] Using fallback token map');
      tokenMap = getFallbackTokenMap();
    }
  } else {
    console.warn('[Context] No Ember MCP client found - using fallback token map');
    tokenMap = getFallbackTokenMap();
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

  console.log('[Context] DCA Agent context initialized successfully');
  // console.log("Context details:", context);

  // Log context summary
  console.log('[Context] DCA Agent context loaded:');
  console.log(`  - Database: ${dbConnected ? '✅ connected' : '❌ connection failed'}`);
  console.log(`  - MCP Connected: ${mcpConnected ? '✅' : '❌'}`);
  // Count only Arbitrum tokens
  const arbitrumTokenCount = Object.values(tokenMap).reduce((count, tokens) =>
    count + tokens.filter(token => token.chainId === 42161).length, 0
  );
  const arbitrumSymbolCount = Object.entries(tokenMap)
    .filter(([_, tokens]) => tokens.some(token => token.chainId === 42161))
    .length;
  console.log(`  - Token Map: ${arbitrumSymbolCount} Arbitrum symbols, ${arbitrumTokenCount} Arbitrum tokens (total: ${Object.keys(tokenMap).length} symbols, ${tokenCount} tokens)`);
  console.log(`  - RPC URL: ${arbitrumRpcUrl}`);
  console.log(`  - Transaction Execution: ${transactionExecutionEnabled ? '✅ enabled' : '❌ disabled'}`);

  return context;
}

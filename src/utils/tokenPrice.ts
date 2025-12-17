/**
 * Utility function to get token price by symbol or contract address
 * Uses CoinGecko API to fetch token prices
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TokenInfo {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

interface TokenMap {
  metadata?: any;
  tokenMap: Record<string, TokenInfo[]>;
}

// Cache for token prices to avoid excessive API calls
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for token map to avoid reading file multiple times
let cachedTokenMap: TokenMap | null = null;

/**
 * Load token map from JSON file
 */
function loadTokenMap(): TokenMap | null {
  if (cachedTokenMap) {
    return cachedTokenMap;
  }

  try {
    const tokenMapPath = path.join(__dirname, "tokenMap_arbitrum.json");
    const tokenMapData = fs.readFileSync(tokenMapPath, "utf-8");
    cachedTokenMap = JSON.parse(tokenMapData) as TokenMap;
    return cachedTokenMap;
  } catch (error) {
    console.error("Error loading token map:", error);
    return null;
  }
}

/**
 * Get contract address from token symbol using token map
 */
function getContractAddressFromSymbol(symbol: string): string | null {
  const tokenMap = loadTokenMap();
  if (!tokenMap || !tokenMap.tokenMap) {
    return null;
  }

  const normalizedSymbol = symbol.toUpperCase().trim();
  const tokens = tokenMap.tokenMap[normalizedSymbol];

  if (tokens && tokens.length > 0 && tokens[0]) {
    // Return the first token's address for the symbol
    return tokens[0].address;
  }

  return null;
}

/**
 * Get token price by symbol or contract address
 * @param tokenIdentifier - Token symbol (e.g., "USDC", "ETH") or contract address
 * @param chainId - Chain ID (default: 42161 for Arbitrum)
 * @returns Token price in USD or null if not found
 */
export async function getTokenPrice(
  tokenIdentifier: string,
  chainId: string = "42161"
): Promise<number | null> {
  try {
    // Check cache first
    const cacheKey = `${tokenIdentifier.toLowerCase()}_${chainId}`;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.price;
    }

    let price: number | null = null;

    // If it's already a contract address, use it directly
    if (tokenIdentifier.startsWith("0x")) {
      price = await fetchPriceByContractAddress(tokenIdentifier, chainId);
    } else {
      // It's a symbol, so look it up in the token map
      const contractAddress = getContractAddressFromSymbol(tokenIdentifier);
      if (contractAddress) {
        // Use the contract address to fetch price
        price = await fetchPriceByContractAddress(contractAddress, chainId);
      } else {
        // Fallback: try direct symbol lookup via CoinGecko search
        price = await fetchPriceBySymbol(tokenIdentifier.toUpperCase().trim());
      }
    }

    // Cache the result
    if (price !== null) {
      priceCache.set(cacheKey, { price, timestamp: Date.now() });
    }

    return price;
  } catch (error) {
    console.error(`Error fetching price for ${tokenIdentifier}:`, error);
    return null;
  }
}

/**
 * Fetch price by CoinGecko ID
 */
async function fetchPriceByCoinGeckoId(coinId: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    return data[coinId]?.usd || null;
  } catch (error) {
    console.error(`Error fetching price for CoinGecko ID ${coinId}:`, error);
    return null;
  }
}

/**
 * Fetch price by contract address (for Arbitrum)
 */
async function fetchPriceByContractAddress(
  contractAddress: string,
  chainId: string
): Promise<number | null> {
  try {
    // CoinGecko uses "arbitrum-one" for Arbitrum chain
    const platformId = chainId === "42161" ? "arbitrum-one" : "ethereum";

    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/${platformId}?contract_addresses=${contractAddress}&vs_currencies=usd`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Record<string, { usd?: number }>;
    const lowerAddress = contractAddress.toLowerCase();
    // console.log(data?.[lowerAddress]?.usd);
    return data[lowerAddress]?.usd || null;
  } catch (error) {
    console.error(
      `Error fetching price for contract ${contractAddress}:`,
      error
    );
    return null;
  }
}

/**
 * Fetch price by symbol (fallback)
 */
async function fetchPriceBySymbol(symbol: string): Promise<number | null> {
  try {
    // Search for token by symbol
    const response = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${symbol}`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      coins?: Array<{ id: string }>;
    };
    if (data.coins && data.coins.length > 0 && data.coins[0]) {
      const coinId = data.coins[0].id;
      return await fetchPriceByCoinGeckoId(coinId);
    }

    return null;
  } catch (error) {
    console.error(`Error searching for token ${symbol}:`, error);
    return null;
  }
}


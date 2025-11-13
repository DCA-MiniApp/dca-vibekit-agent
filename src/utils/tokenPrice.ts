/**
 * Utility function to get token price by symbol or contract address
 * Uses CoinGecko API to fetch token prices
 */

interface TokenPriceResponse {
  price: number;
  symbol: string;
  name: string;
}

// Cache for token prices to avoid excessive API calls
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

    // Normalize token identifier
    const normalized = tokenIdentifier.toUpperCase().trim();

    // Map common token symbols to CoinGecko IDs
    const tokenIdMap: Record<string, string> = {
      ETH: "ethereum",
      WETH: "ethereum",
      USDC: "usd-coin",
      USDT: "tether",
      DAI: "dai",
      WBTC: "wrapped-bitcoin",
      ARB: "arbitrum",
      LINK: "chainlink",
      UNI: "uniswap",
      AAVE: "aave",
      CRV: "curve-dao-token",
    };

    let price: number | null = null;

    // Try by symbol first
    if (tokenIdMap[normalized]) {
      price = await fetchPriceByCoinGeckoId(tokenIdMap[normalized]);
    } else {
      // Try to fetch by contract address (for Arbitrum)
      if (chainId === "42161" && tokenIdentifier.startsWith("0x")) {
        price = await fetchPriceByContractAddress(tokenIdentifier, chainId);
      }
    }

    // If still no price, try direct symbol lookup
    if (!price) {
      price = await fetchPriceBySymbol(normalized);
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


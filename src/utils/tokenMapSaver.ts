/**
 * Token Map JSON Saver Utility
 * 
 * Temporary utility to save tokenMap to JSON file for analysis.
 * Controlled by SAVE_TOKEN_MAP_JSON environment variable.
 */

import fs from 'fs/promises';
import path from 'path';
import type { TokenInfo } from '../context/types.js';

/**
 * Save tokenMap to JSON file if enabled via environment variable
 * @param tokenMap - The token map to save
 * @param filename - Optional custom filename (default: tokenMap.json)
 */
export async function saveTokenMapToJson(
  tokenMap: Record<string, TokenInfo[]>,
  filename: string = 'tokenMap.json'
): Promise<void> {
  // Check if saving is enabled via environment variable
  const shouldSave = process.env.SAVE_TOKEN_MAP_JSON === 'true';
  
  if (!shouldSave) {
    return; // Exit silently if not enabled
  }

  try {
    // Prepare data for JSON with additional metadata
    const jsonData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        totalSymbols: Object.keys(tokenMap).length,
        totalTokens: Object.values(tokenMap).reduce((count, tokens) => count + tokens.length, 0),
        chainBreakdown: getChainBreakdown(tokenMap),
      },
      tokenMap: tokenMap,
    };

    // Save to project root
    const filePath = path.join(process.cwd(), filename);
    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
    
    console.log(`📁 [TokenMapSaver] ✅ Token map saved to: ${filePath}`);
    console.log(`📊 [TokenMapSaver] Stats: ${jsonData.metadata.totalSymbols} symbols, ${jsonData.metadata.totalTokens} tokens`);
    
    // Also save a simplified version with just Arbitrum tokens
    await saveArbitrumOnlyTokenMap(tokenMap, filename.replace('.json', '_arbitrum.json'));
    
  } catch (error) {
    console.error('❌ [TokenMapSaver] Failed to save token map:', error);
  }
}

/**
 * Get breakdown of tokens by chain ID
 */
function getChainBreakdown(tokenMap: Record<string, TokenInfo[]>): Record<string, number> {
  const chainBreakdown: Record<string, number> = {};
  
  Object.values(tokenMap).forEach(tokens => {
    tokens.forEach(token => {
      const chainId = token.chainId.toString();
      chainBreakdown[chainId] = (chainBreakdown[chainId] || 0) + 1;
    });
  });
  
  return chainBreakdown;
}

/**
 * Save a simplified version with only Arbitrum tokens (chainId: 42161)
 */
async function saveArbitrumOnlyTokenMap(
  tokenMap: Record<string, TokenInfo[]>,
  filename: string
): Promise<void> {
  try {
    // Filter for Arbitrum tokens only
    const arbitrumTokenMap: Record<string, TokenInfo[]> = {};
    
    Object.entries(tokenMap).forEach(([symbol, tokens]) => {
      const arbitrumTokens = tokens.filter(token => token.chainId === 42161);
      if (arbitrumTokens.length > 0) {
        arbitrumTokenMap[symbol] = arbitrumTokens;
      }
    });

    const jsonData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        description: 'Arbitrum tokens only (chainId: 42161)',
        totalSymbols: Object.keys(arbitrumTokenMap).length,
        totalTokens: Object.values(arbitrumTokenMap).reduce((count, tokens) => count + tokens.length, 0),
      },
      tokenMap: arbitrumTokenMap,
    };

    const filePath = path.join(process.cwd(), filename);
    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
    
    console.log(`📁 [TokenMapSaver] ✅ Arbitrum token map saved to: ${filePath}`);
    
  } catch (error) {
    console.error('❌ [TokenMapSaver] Failed to save Arbitrum token map:', error);
  }
}

/**
 * Save sample tokens for quick reference (first 10 tokens from each chain)
 */
export async function saveSampleTokenMap(
  tokenMap: Record<string, TokenInfo[]>,
  filename: string = 'tokenMap_sample.json'
): Promise<void> {
  const shouldSave = process.env.SAVE_TOKEN_MAP_JSON === 'true';
  
  if (!shouldSave) {
    return;
  }

  try {
    // Create sample with first 10 symbols for each major chain
    const sampleTokenMap: Record<string, TokenInfo[]> = {};
    const majorChains = [1, 42161, 10, 137, 8453]; // Ethereum, Arbitrum, Optimism, Polygon, Base
    
    let count = 0;
    for (const [symbol, tokens] of Object.entries(tokenMap)) {
      if (count >= 20) break; // Limit to 20 symbols for sample
      
      const relevantTokens = tokens.filter(token => majorChains.includes(token.chainId));
      if (relevantTokens.length > 0) {
        sampleTokenMap[symbol] = relevantTokens;
        count++;
      }
    }

    const jsonData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        description: 'Sample token map (first 20 symbols from major chains)',
        totalSymbols: Object.keys(sampleTokenMap).length,
        totalTokens: Object.values(sampleTokenMap).reduce((count, tokens) => count + tokens.length, 0),
      },
      tokenMap: sampleTokenMap,
    };

    const filePath = path.join(process.cwd(), filename);
    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
    
    console.log(`📁 [TokenMapSaver] ✅ Sample token map saved to: ${filePath}`);
    
  } catch (error) {
    console.error('❌ [TokenMapSaver] Failed to save sample token map:', error);
  }
}

/**
 * Vault Utilities for managing token-to-vault mappings and interactions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VaultMapping {
  tokenAddress: string;
  vaultAddress: string;
  symbol: string;
  decimals: number;
}

interface VaultMappings {
  [symbol: string]: VaultMapping;
}

let vaultMappings: VaultMappings | null = null;

/**
 * Load vault mappings from JSON file
 */
export function loadVaultMappings(): VaultMappings {
  if (vaultMappings) {
    return vaultMappings;
  }

  try {
    const mappingsPath = path.join(__dirname, '../config/vaultMappings.json');
    const mappingsData = fs.readFileSync(mappingsPath, 'utf8');
    vaultMappings = JSON.parse(mappingsData);
    console.log('[VaultUtils] Loaded vault mappings:', Object.keys(vaultMappings || {}));
    return vaultMappings || {};
  } catch (error) {
    console.error('[VaultUtils] Failed to load vault mappings:', error);
    return {};
  }
}

/**
 * Check if a token symbol has vault support
 */
export function hasVaultSupport(tokenSymbol: string): boolean {
  const mappings = loadVaultMappings();
  return tokenSymbol in mappings;
}

/**
 * Get vault address for a token symbol
 */
export function getVaultAddress(tokenSymbol: string): string | null {
  const mappings = loadVaultMappings();
  return mappings[tokenSymbol]?.vaultAddress || null;
}

/**
 * Get vault mapping for a token symbol
 */
export function getVaultMapping(tokenSymbol: string): VaultMapping | null {
  const mappings = loadVaultMappings();
  return mappings[tokenSymbol] || null;
}

/**
 * Get all supported vault tokens
 */
export function getSupportedVaultTokens(): string[] {
  const mappings = loadVaultMappings();
  return Object.keys(mappings);
}

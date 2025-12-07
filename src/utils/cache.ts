import { connection as redis } from "../notification-infra/redis.js";

/**
 * Cache utility for API endpoints
 * Provides methods to get, set, and invalidate cached data
 */

const DEFAULT_TTL = 600; // 10 minutes in seconds

export interface CacheOptions {
    ttl?: number; // Time to live in seconds
    key: string;  // Cache key
}

/**
 * Get data from cache
 */
export async function getCache<T>(key: string): Promise<T | null> {
    try {
        const cached = await redis.get(key);
        if (!cached) {
            return null;
        }
        return JSON.parse(cached) as T;
    } catch (error) {
        console.error(`[Cache] Error getting cache for key ${key}:`, error);
        return null;
    }
}

/**
 * Set data in cache with TTL
 */
export async function setCache<T>(
    key: string,
    data: T,
    ttl: number = DEFAULT_TTL
): Promise<void> {
    try {
        await redis.setex(key, ttl, JSON.stringify(data));
        console.log(`[Cache] Set cache for key ${key} with TTL ${ttl}s`);
    } catch (error) {
        console.error(`[Cache] Error setting cache for key ${key}:`, error);
    }
}

/**
 * Invalidate (delete) cache by key
 */
export async function invalidateCache(key: string): Promise<void> {
    try {
        await redis.del(key);
        console.log(`[Cache] Invalidated cache for key ${key}`);
    } catch (error) {
        console.error(`[Cache] Error invalidating cache for key ${key}:`, error);
    }
}

/**
 * Invalidate cache by pattern (e.g., "user:0x123*")
 */
export async function invalidateCachePattern(pattern: string): Promise<void> {
    try {
        const keys = await redis.keys(pattern);
        console.log(`[Cache] Found ${keys.length} keys to invalidate for pattern ${pattern}`);
        if (keys.length > 0) {
            await redis.del(...keys);
            console.log(`[Cache] Invalidated ${keys.length} keys matching pattern ${pattern}`);
        }
    } catch (error) {
        console.error(`[Cache] Error invalidating cache pattern ${pattern}:`, error);
    }
}

/**
 * Cache keys for DCA endpoints
 */
export const CacheKeys = {
    /**
     * Key for user's DCA plans
     * Format: dca:plans:{userAddress}
     */
    userPlans: (userAddress: string) => `dca:plans:${userAddress.toLowerCase()}`,

    /**
     * Key for user's execution history
     * Format: dca:history:{userAddress}
     */
    userHistory: (userAddress: string) => `dca:history:${userAddress.toLowerCase()}`,

    /**
     * Pattern to invalidate all caches for a user
     * Format: dca:*:{userAddress}
     */
    userPattern: (userAddress: string) => `dca:*:${userAddress.toLowerCase()}`,
};

/**
 * Invalidate all caches related to a user address
 */
export async function invalidateUserCache(userAddress: string): Promise<void> {
    await invalidateCachePattern(CacheKeys.userPattern(userAddress));
}

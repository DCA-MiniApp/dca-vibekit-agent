import { connection } from "./redis.js";


/**
 * Try to insert a dedup key with TTL; returns true if inserted (not seen before).
 */
export async function tryInsertDedup(key: string, ttlSeconds = 60 * 60 * 24 * 30): Promise<boolean> {
  // SET key 1 NX EX <ttl>
  const res = await connection.set(`notif:sent:${key}`, "1", "EX", ttlSeconds, "NX");
  return res === "OK";
}
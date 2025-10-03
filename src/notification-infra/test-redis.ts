import { connection } from "./redis.js";


async function testRedis() {
  try {
    await connection.set("test-key", "hello-redis");
    const value = await connection.get("test-key");
    console.log("Redis value:", value); // Should print: hello-redis
    await connection.quit();
  } catch (err) {
    console.error("Redis test failed:", err);
  }
}

testRedis();
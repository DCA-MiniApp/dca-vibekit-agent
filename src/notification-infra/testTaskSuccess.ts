// src/notification-infra/testTaskSuccess.js
import { notificationQueue } from "./notificationQueue.js";

async function main() {
  console.log("Enqueuing test task-success job");
  await notificationQueue.add("sendNotification", {
    idempotencyKey: "test-job-1:task-success:12345",
    notificationType: "task-success",
    jobId: "test-job-1",
    planId: "test-plan-1",
    userAddress: "0x40049FaB24B6115cD36D9Ce64EA35185f8bae810",
    fid: 0x123,
    taskId: 12345,
    txHash: "0xabc...",
    chainId: "42161",
    fromToken: "USDC",
    toToken: "WETH",
    amount: "100",
    username: "testuser",
  });
  console.log("Enqueued test task-success job");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
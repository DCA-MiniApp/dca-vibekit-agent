import { Worker, Job } from "bullmq";
import axios from "axios";
import { TxFailedPayload } from "./notificationQueue.js";
import { connection } from "./redis.js";


const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

const worker = new Worker<TxFailedPayload>(
  "notifications",
  async (job: Job<TxFailedPayload>) => {
    const { userAddress, taskId, jobId, planId, txHash, chainId, reason, idempotencyKey } = job.data;
    const fid=121;
    console.log(`[Notification] Processing job ${job.id} (job ${jobId} task ${taskId}) key=${idempotencyKey}`);
    console.log(`[Notification] Payload:`, job.data);

    // // Resolve fid
    // const fid = await getFidByAddress(userAddress);
    // if (!fid) {
    //   console.warn(`[Notification] Missing fid for user ${userAddress} (job: ${jobId} task: ${taskId}). Skipping.`);
    //   return;
    // }

    // Send to frontend gateway (/api/tx-events -> Neynar)
    // await axios.post(`${FRONTEND_BASE}/api/tx-events`, {
    //   fid,
    //   status: "failed",
    //   txHash,
    //   chainId,
    //   planId,
    //   reason,
    // }, { timeout: 12000 });

    console.log(`[Notification] Sent (job ${jobId} task ${taskId}) key=${idempotencyKey}`);
  },
  {
    connection,
    concurrency: 10,  // tune per throughput
    // automatic retries handled by BullMQ via attempts config when adding jobs, or here via settings
  }
);

worker.on("completed", (job) => console.log(`[Worker] completed: ${job.id}`));
worker.on("failed", (job, err) => console.error(`[Worker] failed: ${job?.id}`, err));

export default worker;
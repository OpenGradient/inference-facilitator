import { Worker } from "bullmq";
import { summarizeDataSettlementJob, summarizeError } from "./logging.js";
import { incrementMetric } from "./metrics.js";
import {
  createDataWorkerContext,
  createBullMqConnection,
  processDataSettlementJob,
} from "./all_networks_shared.js";
import {
  DATA_WORKER_EVM_PRIVATE_KEY_ENV,
  DATA_SETTLEMENT_QUEUE_NAME,
  SHUTDOWN_TIMEOUT_MS,
  type DataSettlementJobData,
} from "./all_networks_types_helpers.js";

const dataWorkerContext = createDataWorkerContext();

const worker = new Worker<DataSettlementJobData>(
  DATA_SETTLEMENT_QUEUE_NAME,
  async (job: { id?: string; data: DataSettlementJobData }) => {
    console.log("[data-worker] Processing data settlement job", {
      jobId: job.id,
      ...summarizeDataSettlementJob(job.data),
    });
    return processDataSettlementJob(job.data, dataWorkerContext);
  },
  {
    connection: createBullMqConnection(),
    concurrency: 1,
  },
);

worker.on("completed", (job: { id?: string }) => {
  incrementMetric("worker.job.completed.count", ["worker:data"]);
  console.log(`[data-worker] Completed job ${job.id}`);
});

worker.on("failed", (job: { id?: string } | undefined, err: unknown) => {
  incrementMetric("worker.job.failed.count", ["worker:data"]);
  console.error("[data-worker] Failed job", {
    jobId: job?.id ?? "unknown",
    ...summarizeError(err),
  });
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\\nReceived ${signal}. Shutting down data worker...`);

  const forcedExitTimer = setTimeout(() => {
    console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forcedExitTimer.unref();

  await worker.close();

  clearTimeout(forcedExitTimer);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

console.log(`[data-worker] Listening on queue: ${DATA_SETTLEMENT_QUEUE_NAME}`);
console.log(
  `[data-worker] Using ${DATA_WORKER_EVM_PRIVATE_KEY_ENV} for signer ${dataWorkerContext.signerAddress} on ${dataWorkerContext.chainName} (${dataWorkerContext.chainId})`,
);

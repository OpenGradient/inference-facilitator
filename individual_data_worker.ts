import { Worker } from "bullmq";
import { summarizeDataSettlementJob, summarizeError } from "./logging.js";
import { incrementMetric } from "./metrics.js";
import {
  createBullMqConnection,
  createDataWorkerContext,
  processPreSignedIndividualSettlement,
} from "./all_networks_shared.js";
import {
  DATA_INDIVIDUAL_WORKER_EVM_PRIVATE_KEY_ENV,
  DATA_SETTLEMENT_INDIVIDUAL_QUEUE_NAME,
  SHUTDOWN_TIMEOUT_MS,
  type IndividualDataSettlementJobData,
} from "./all_networks_types_helpers.js";

const dataWorkerContext = createDataWorkerContext(DATA_INDIVIDUAL_WORKER_EVM_PRIVATE_KEY_ENV);

const worker = new Worker<IndividualDataSettlementJobData>(
  DATA_SETTLEMENT_INDIVIDUAL_QUEUE_NAME,
  async (job: { id?: string; data: IndividualDataSettlementJobData }) => {
    console.log("[individual-data-worker] Processing individual data settlement job", {
      jobId: job.id,
      queueNonce: job.data.queueNonce,
      signerAddress: job.data.signerAddress,
      walrusBlobId: job.data.walrusBlobId,
      txHash: job.data.txHash,
      ...summarizeDataSettlementJob(job.data),
    });
    return processPreSignedIndividualSettlement(job.data, dataWorkerContext);
  },
  {
    connection: createBullMqConnection(),
    concurrency: 1,
  },
);

worker.on("completed", (job: { id?: string }) => {
  incrementMetric("worker.job.completed.count", ["worker:data-individual"]);
  console.log(`[individual-data-worker] Completed job ${job.id}`);
});

worker.on("failed", (job: { id?: string } | undefined, err: unknown) => {
  incrementMetric("worker.job.failed.count", ["worker:data-individual"]);
  console.error("[individual-data-worker] Failed job", {
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
  console.log(`\\nReceived ${signal}. Shutting down individual data worker...`);

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

console.log(
  `[individual-data-worker] Listening on queue: ${DATA_SETTLEMENT_INDIVIDUAL_QUEUE_NAME}`,
);
console.log(
  `[individual-data-worker] Broadcasting with ${DATA_INDIVIDUAL_WORKER_EVM_PRIVATE_KEY_ENV} for signer ${dataWorkerContext.signerAddress} on ${dataWorkerContext.chainName} (${dataWorkerContext.chainId})`,
);

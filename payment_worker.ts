import { Worker } from "bullmq";
import {
  createBullMqConnection,
  createFacilitator,
} from "./all_networks_shared.js";
import {
  PAYMENT_QUEUE_NAME,
  SHUTDOWN_TIMEOUT_MS,
  type PaymentSettlementJobData,
} from "./all_networks_types_helpers.js";

const facilitator = await createFacilitator();

const worker = new Worker<PaymentSettlementJobData>(
  PAYMENT_QUEUE_NAME,
  async (job: { data: PaymentSettlementJobData }) => {
    const { paymentPayload, paymentRequirements } = job.data;
    return facilitator.settle(paymentPayload, paymentRequirements);
  },
  {
    connection: createBullMqConnection(),
    concurrency: 1,
  },
);

worker.on("completed", (job: { id?: string }) => {
  console.log(`[payment-worker] Completed job ${job.id}`);
});

worker.on("failed", (job: { id?: string } | undefined, err: unknown) => {
  console.error(`[payment-worker] Failed job ${job?.id ?? "unknown"}:`, err);
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\\nReceived ${signal}. Shutting down payment worker...`);

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

console.log(`[payment-worker] Listening on queue: ${PAYMENT_QUEUE_NAME}`);

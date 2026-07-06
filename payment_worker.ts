import { Worker } from "bullmq";
import {
  summarizeError,
  summarizePaymentPayload,
  summarizePaymentRequirements,
} from "./logging.js";
import { incrementMetric } from "./metrics.js";
import { createBullMqConnection, createFacilitator } from "./all_networks_shared.js";
import { closeInferenceUsageTracker, recordInferenceUsage } from "./all_networks_usage.js";
import {
  PAYMENT_QUEUE_NAME,
  SHUTDOWN_TIMEOUT_MS,
  type PaymentSettlementJobData,
} from "./all_networks_types_helpers.js";

const facilitator = await createFacilitator();

function paymentAmountToMetricValue(amount: string): number | null {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : null;
}

const worker = new Worker<PaymentSettlementJobData>(
  PAYMENT_QUEUE_NAME,
  async (job: { id?: string; data: PaymentSettlementJobData }) => {
    const { paymentPayload, paymentRequirements } = job.data;
    console.log("[payment-worker] Processing payment settlement job", {
      jobId: job.id,
      ...summarizePaymentRequirements(paymentRequirements),
      ...summarizePaymentPayload(paymentPayload),
    });
    const result = await facilitator.settle(paymentPayload, paymentRequirements);

    if (result.success) {
      const tags = [
        "worker:payment",
        `network:${paymentRequirements.network}`,
        `asset:${paymentRequirements.asset}`,
        `scheme:${paymentRequirements.scheme}`,
      ];

      incrementMetric("payment.settled.count", tags);

      const amountValue = paymentAmountToMetricValue(paymentRequirements.amount);
      if (amountValue !== null) {
        incrementMetric("payment.settled.amount", tags, amountValue);
      }

      try {
        await recordInferenceUsage(
          job.data.usageMetadata
            ? {
                ...job.data.usageMetadata,
                sessionId:
                  job.data.usageMetadata.sessionId ?? (job.id ? String(job.id) : undefined),
              }
            : undefined,
          result.payer,
        );
      } catch (error) {
        console.error("[payment-worker] Failed to record inference usage", {
          jobId: job.id,
          ...summarizeError(error),
        });
      }
    }

    return result;
  },
  {
    connection: createBullMqConnection(),
    concurrency: 1,
  },
);

worker.on("completed", (job: { id?: string }) => {
  incrementMetric("worker.job.completed.count", ["worker:payment"]);
  console.log(`[payment-worker] Completed job ${job.id}`);
});

worker.on("failed", (job: { id?: string } | undefined, err: unknown) => {
  incrementMetric("worker.job.failed.count", ["worker:payment"]);
  console.error("[payment-worker] Failed job", {
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
  console.log(`\\nReceived ${signal}. Shutting down payment worker...`);

  const forcedExitTimer = setTimeout(() => {
    console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forcedExitTimer.unref();

  await worker.close();
  await closeInferenceUsageTracker();

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

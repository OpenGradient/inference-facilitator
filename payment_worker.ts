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
  isTerminalSettlementErrorReason,
  PAYMENT_QUEUE_NAME,
  PAYMENT_SETTLEMENT_MAX_ATTEMPTS,
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
  async (job: { id?: string; attemptsMade?: number; data: PaymentSettlementJobData }) => {
    const { paymentPayload, paymentRequirements } = job.data;
    console.log("[payment-worker] Processing payment settlement job", {
      jobId: job.id,
      attempt: (job.attemptsMade ?? 0) + 1,
      maxAttempts: PAYMENT_SETTLEMENT_MAX_ATTEMPTS,
      ...summarizePaymentRequirements(paymentRequirements),
      ...summarizePaymentPayload(paymentPayload),
    });
    const result = await facilitator.settle(paymentPayload, paymentRequirements);

    if (!result.success) {
      const errorReason = result.errorReason || "unknown_settlement_error";
      const terminal = isTerminalSettlementErrorReason(errorReason);
      const failureTags = [
        "worker:payment",
        `network:${paymentRequirements.network}`,
        `scheme:${paymentRequirements.scheme}`,
        `reason:${errorReason}`,
        `terminal:${terminal}`,
      ];
      incrementMetric("payment.settle.failure.count", failureTags);
      console.error("[payment-worker] Payment settlement attempt failed", {
        jobId: job.id,
        attempt: (job.attemptsMade ?? 0) + 1,
        maxAttempts: PAYMENT_SETTLEMENT_MAX_ATTEMPTS,
        errorReason,
        terminal,
        ...summarizePaymentRequirements(paymentRequirements),
        ...summarizePaymentPayload(paymentPayload),
      });

      if (!terminal) {
        // Throw so BullMQ retries the job with the queue's attempts/backoff
        // policy. Returning a success=false result here would silently
        // complete the job and drop the payment on a transient failure.
        throw new Error(`retryable_settlement_failure: ${errorReason}`);
      }

      // Terminal failure: retrying can never succeed (expired deadline,
      // consumed nonce, invalid signature). Complete the job with the failed
      // result so status pollers observe a terminal success=false outcome.
      incrementMetric("payment.settle.terminal_failure.count", failureTags);
      return result;
    }

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

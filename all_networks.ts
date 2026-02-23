import { Queue, type Job } from "bullmq";
import express from "express";
import { randomUUID } from "node:crypto";
import { type Server } from "node:http";
import { incrementMetric } from "./metrics.js";
import {
  createBullMqConnection,
  createFacilitator,
  processPrivateSettlement,
} from "./all_networks_shared.js";
import {
  DATA_SETTLEMENT_QUEUE_NAME,
  isSettlementError,
  normalizeHeaderValue,
  PAYMENT_QUEUE_NAME,
  parseSettlementJobDataFromHeaders,
  PORT,
  settlementStatusFromBullState,
  SHUTDOWN_TIMEOUT_MS,
  toSerializableResult,
  type DataSettlementJobData,
  type PaymentSettlementJobData,
  type SettlementApiJobResponse,
} from "./all_networks_types_helpers.js";
import { type PaymentPayload, type PaymentRequirements, type VerifyResponse } from "@x402/core/types";

const app = express();
app.use(express.json());

const facilitator = await createFacilitator();
const connection = createBullMqConnection();


const paymentQueue = new Queue<PaymentSettlementJobData>(PAYMENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});

const dataSettlementQueue = new Queue<DataSettlementJobData>(DATA_SETTLEMENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});

function queueNameFromJobId(jobId: string): "payment" | "settlement" | null {
  if (jobId.startsWith("payment-") || jobId.startsWith("payment:")) {
    return "payment";
  }
  if (jobId.startsWith("settlement-") || jobId.startsWith("settlement:")) {
    return "settlement";
  }
  return null;
}

async function toJobResponse(
  queueName: string,
  job: Job<unknown, unknown, string>,
): Promise<SettlementApiJobResponse> {
  const state = await job.getState();
  const status = settlementStatusFromBullState(state);
  const updatedAtMs = job.finishedOn ?? job.processedOn ?? job.timestamp;

  const response: SettlementApiJobResponse = {
    jobId: job.id || "unknown",
    queue: queueName,
    status,
    createdAt: new Date(job.timestamp).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    result: toSerializableResult(job.returnvalue),
    error: job.failedReason || undefined,
  };

  if (queueName === DATA_SETTLEMENT_QUEUE_NAME) {
    const payload = job.data as DataSettlementJobData;
    response.settlementType = payload.settlementType;
  }

  return response;
}

async function enqueuePaymentSettlementJob(args: {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}): Promise<SettlementApiJobResponse> {
  const paymentJobId = `payment-${randomUUID()}`;
  const paymentJob = await paymentQueue.add(
    "payment-settlement",
    {
      paymentPayload: args.paymentPayload,
      paymentRequirements: args.paymentRequirements,
    },
    {
      jobId: paymentJobId,
    },
  );

  return toJobResponse(PAYMENT_QUEUE_NAME, paymentJob);
}

async function enqueueDataSettlementJob(args: {
  settlementTypeHeader: string;
  settlementDataHeader?: string;
}): Promise<SettlementApiJobResponse | null> {
  const parsedSettlementHeader = parseSettlementJobDataFromHeaders(
    args.settlementTypeHeader,
    args.settlementDataHeader,
  );

  if (parsedSettlementHeader?.settlementType === "private") {
    await processPrivateSettlement();
    return null;
  }

  if (!parsedSettlementHeader) {
    throw new Error("Missing x-settlement-type header");
  }

  const settlementJobId = `settlement-${randomUUID()}`;
  const settlementJob = await dataSettlementQueue.add(
    "data-settlement",
    parsedSettlementHeader,
    {
      jobId: settlementJobId,
    },
  );

  return toJobResponse(DATA_SETTLEMENT_QUEUE_NAME, settlementJob);
}

app.post("/verify", async (req, res) => {
  incrementMetric("api.request.count", ["route:/verify", "method:POST"]);
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});


app.post("/settle", async (req, res) => {
  incrementMetric("api.request.count", ["route:/settle", "method:POST"]);
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const paymentJob = await enqueuePaymentSettlementJob({
      paymentPayload,
      paymentRequirements,
    });
    return res.status(202).json({ paymentJob });
  } catch (error) {
    console.error("Settle enqueue error:", error);
    if (isSettlementError(error)) {
      return res.status(400).json({
        error: error.message,
      });
    }

    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/settle_data", async (req, res) => {
  incrementMetric("api.request.count", ["route:/settle_data", "method:POST"]);
  try {
    const settlementTypeHeader = normalizeHeaderValue(req.get("x-settlement-type") || undefined);
    if (!settlementTypeHeader) {
      return res.status(400).json({
        error: "Missing x-settlement-type header",
      });
    }

    const settlementDataHeader = normalizeHeaderValue(req.get("x-settlement-data") || undefined);
    const settlementJob = await enqueueDataSettlementJob({
      settlementTypeHeader,
      settlementDataHeader,
    });

    if (!settlementJob) {
      return res.status(202).json({
        settlementJob: null,
        notes: "Private settlement ignored by facilitator.",
      });
    }

    return res.status(202).json({ settlementJob });
  } catch (error) {
    console.error("Settle data enqueue error:", error);
    if (isSettlementError(error)) {
      return res.status(400).json({
        error: error.message,
      });
    }

    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/settle/:jobId", async (req, res) => {
  incrementMetric("api.request.count", ["route:/settle/:jobId", "method:GET"]);
  try {
    const { jobId } = req.params;
    const hintedQueue = queueNameFromJobId(jobId);

    if (hintedQueue === "payment") {
      const job = await paymentQueue.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: `Settlement job not found: ${jobId}` });
      }
      return res.json(await toJobResponse(PAYMENT_QUEUE_NAME, job));
    }

    if (hintedQueue === "settlement") {
      const job = await dataSettlementQueue.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: `Settlement job not found: ${jobId}` });
      }
      return res.json(await toJobResponse(DATA_SETTLEMENT_QUEUE_NAME, job));
    }

    const [paymentJob, settlementJob] = await Promise.all([
      paymentQueue.getJob(jobId),
      dataSettlementQueue.getJob(jobId),
    ]);

    if (paymentJob) {
      return res.json(await toJobResponse(PAYMENT_QUEUE_NAME, paymentJob));
    }

    if (settlementJob) {
      return res.json(await toJobResponse(DATA_SETTLEMENT_QUEUE_NAME, settlementJob));
    }

    return res.status(404).json({ error: `Settlement job not found: ${jobId}` });
  } catch (error) {
    console.error("Settle status error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", async (_req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

let httpServer: Server | null = null;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\\nReceived ${signal}. Shutting down API gracefully...`);

  const forcedExitTimer = setTimeout(() => {
    console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forcedExitTimer.unref();

  if (httpServer) {
    await new Promise<void>(resolve => {
      httpServer!.close(() => resolve());
    });
  }

  await Promise.allSettled([paymentQueue.close(), dataSettlementQueue.close()]);

  clearTimeout(forcedExitTimer);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

httpServer = app.listen(parseInt(PORT, 10), () => {
  console.log(`🚀 All Networks API listening on http://localhost:${PORT}`);
  console.log(`   Supported networks: ${facilitator.getSupported().kinds.map(k => k.network).join(", ")}`);
  console.log(`   Payment queue: ${PAYMENT_QUEUE_NAME}`);
  console.log(`   Data settlement queue: ${DATA_SETTLEMENT_QUEUE_NAME}`);
  console.log();
});

/**
 * All Networks Facilitator Example
 *
 * Demonstrates how to create a facilitator that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana").
 */

import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { createWalletClient, http, publicActions, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { baseSepolia } from "viem/chains";

const ogEvm = defineChain({
  id: 10740,
  name: 'OG EVM',
  nativeCurrency: {
    decimals: 18,
    name: 'OG',
    symbol: 'OG',
  },
  rpcUrls: {
    default: { http: ['https://ogevmdevnet.opengradient.ai/'] },
  },
  blockExplorers: {
    default: {
      name: 'OG EVM Explorer',
      url: 'https://explorer.og.artela.io', // TODO: update
    },
  },
  contracts: {
    multicall3: {
      address: '0x4200000000000000000000000000000000000006',
      blockCreated: 1,
    },
  },
})

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const SETTLE_QUEUE_KEY = process.env.SETTLE_QUEUE_KEY || "x402:settle:queue";
const SETTLE_JOB_KEY_PREFIX = process.env.SETTLE_JOB_KEY_PREFIX || "x402:settle:job:";
const SETTLE_JOB_TTL_SECONDS = Number(process.env.SETTLE_JOB_TTL_SECONDS || 60 * 60 * 24);

type SettleJobStatus = "queued" | "processing" | "succeeded" | "failed";

type SettleJob = {
  id: string;
  status: SettleJobStatus;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  createdAt: string;
  updatedAt: string;
  result?: SettleResponse;
  error?: string;
};

type SettleJobResult = {
  jobId: string;
  status: SettleJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: SettleResponse;
  error?: string;
};

type SerializedBigInt = {
  __type: "bigint";
  value: string;
};

function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") {
      const wrapped: SerializedBigInt = {
        __type: "bigint",
        value: item.toString(),
      };
      return wrapped;
    }
    return item;
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value, (_key, item) => {
    if (
      item &&
      typeof item === "object" &&
      "__type" in item &&
      (item as SerializedBigInt).__type === "bigint"
    ) {
      return BigInt((item as SerializedBigInt).value);
    }
    return item;
  }) as T;
}

function settleJobKey(jobId: string): string {
  return `${SETTLE_JOB_KEY_PREFIX}${jobId}`;
}

function toSettleJobResult(job: SettleJob): SettleJobResult {
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  };
}

let isShuttingDown = false;

// Configuration - optional per network
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

// Validate at least one private key is provided
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Network configuration
const EVM_NETWORK = "eip155:10740"; // OG EVM
const BASE_TESTNET_NETWORK = "eip155:84532"; // Base Testnet
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet

// Initialize the x402 Facilitator
const facilitator = new x402Facilitator()
  .onBeforeVerify(async context => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async context => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async context => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async context => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async context => {
    console.log("After settle", context);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure", context);
  });

const redisClient = createClient({
  url: REDIS_URL,
});

const settleWorkerRedis = redisClient.duplicate();

redisClient.on("error", (error: unknown) => {
  console.error("Redis client error:", error);
});

settleWorkerRedis.on("error", (error: unknown) => {
  if (!isShuttingDown) {
    console.error("Redis settle worker error:", error);
  }
});

async function saveSettleJob(job: SettleJob): Promise<void> {
  console.log("Saving settle job", job);
  await redisClient.set(settleJobKey(job.id), serializeJson(job), {
    EX: SETTLE_JOB_TTL_SECONDS,
  });
}

async function getSettleJob(jobId: string): Promise<SettleJob | null> {

  const raw = await redisClient.get(settleJobKey(jobId));
  if (!raw) {
    return null;
  }
  return parseJson<SettleJob>(raw);
}

async function enqueueSettleJob(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleJobResult> {
  console.log("Enqueuing settle job", paymentPayload, paymentRequirements);
  const now = new Date().toISOString();
  const job: SettleJob = {
    id: randomUUID(),
    status: "queued",
    paymentPayload,
    paymentRequirements,
    createdAt: now,
    updatedAt: now,
  };

  await saveSettleJob(job);
  await redisClient.lPush(SETTLE_QUEUE_KEY, job.id);

  return toSettleJobResult(job);
}

async function settleQueuedJob(jobId: string): Promise<void> {
  const job = await getSettleJob(jobId);
  if (!job) {
    return;
  }

  console.log("Processing settle job", job);

  const processingJob: SettleJob = {
    ...job,
    status: "processing",
    updatedAt: new Date().toISOString(),
    error: undefined,
  };
  await saveSettleJob(processingJob);

  try {
    const result = await facilitator.settle(job.paymentPayload, job.paymentRequirements);
    const completedJob: SettleJob = {
      ...processingJob,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      result,
      error: undefined,
    };
    await saveSettleJob(completedJob);
  } catch (error) {
    const failedJob: SettleJob = {
      ...processingJob,
      status: "failed",
      updatedAt: new Date().toISOString(),
      result: undefined,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    await saveSettleJob(failedJob);
  }
}

async function settleWorkerLoop(workerClient: RedisClientType): Promise<void> {
  while (!isShuttingDown) {
    try {
      const popped = await workerClient.brPop(SETTLE_QUEUE_KEY, 0);
      if (!popped) {
        continue;
      }

      await settleQueuedJob(popped.element);
    } catch (error) {
      if (isShuttingDown) {
        return;
      }
      console.error("Settle worker loop error:", error);
    }
  }
}

// Register EVM scheme if private key is provided
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // Create a Viem client with both wallet and public capabilities
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: ogEvm,
    transport: http(),
  }).extend(publicActions);

  const baseViemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  const evmSigner = toFacilitatorEvmSigner({
    getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      viemClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => viemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      viemClient.writeContract({
        ...args,
        args: args.args || [],
        gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
        maxFeePerGas: parseGwei('0.002'), // Example: Set specific gas price if needed
        maxPriorityFeePerGas: parseGwei('0.001'),
      }),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      viemClient.sendTransaction({
        ...args,
         gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      viemClient.waitForTransactionReceipt(args),
  });

  const baseEvmSigner = toFacilitatorEvmSigner({
    getCode: (args: { address: `0x${string}` }) => baseViemClient.getCode(args),
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      baseViemClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => baseViemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      baseViemClient.writeContract({
        ...args,
        args: args.args || [],
        gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
        maxFeePerGas: parseGwei('0.002'), // Example: Set specific gas price if needed
        maxPriorityFeePerGas: parseGwei('0.001'),
      }),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      baseViemClient.sendTransaction({
        ...args,
         gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      baseViemClient.waitForTransactionReceipt(args),
  });


  facilitator.register(
    EVM_NETWORK,
    new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    EVM_NETWORK,
    new UptoEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    BASE_TESTNET_NETWORK,
    new ExactEvmScheme(baseEvmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    BASE_TESTNET_NETWORK,
    new UptoEvmScheme(baseEvmSigner, { deployERC4337WithEIP6492: true }),
  );
}

// Register SVM scheme if private key is provided
if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
}

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 */
app.post("/verify", async (req, res) => {
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

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Queue a settlement to process asynchronously
 */
app.post("/settle", async (req, res) => {
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

    const queuedJob = await enqueueSettleJob(paymentPayload, paymentRequirements);
    res.status(202).json(queuedJob);
  } catch (error) {
    console.error("Settle enqueue error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /settle/:jobId
 * Get queued settlement status or final result
 */
app.get("/settle/:jobId", async (req, res) => {
  try {
    const job = await getSettleJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        error: `Settlement job not found: ${req.params.jobId}`,
      });
    }

    res.json(toSettleJobResult(job));
  } catch (error) {
    console.error("Settle status error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start the server
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  await Promise.allSettled([settleWorkerRedis.quit(), redisClient.quit()]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await redisClient.connect();
await settleWorkerRedis.connect();
void settleWorkerLoop(settleWorkerRedis);

app.listen(parseInt(PORT, 10), () => {
  console.log(`🚀 All Networks Facilitator listening on http://localhost:${PORT}`);
  console.log(`   Supported networks: ${facilitator.getSupported().kinds.map(k => k.network).join(", ")}`);
  console.log(`   Redis settle queue: ${SETTLE_QUEUE_KEY}`);
  console.log();
});

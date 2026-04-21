import { x402Facilitator } from "@x402/core/facilitator";
import {
  EIP2612_GAS_SPONSORING,
  createErc20ApprovalGasSponsoringExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from "@x402/extensions";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { RedisOptions } from "ioredis";
import {
  createWalletClient,
  defineChain,
  http,
  parseGwei,
  parseTransaction,
  publicActions,
  recoverTransactionAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  debugLog,
  summarizeDataSettlementJob,
  summarizeError,
  summarizePaymentPayload,
  summarizePaymentRequirements,
  summarizeSettleResponse,
  summarizeVerifyResponse,
} from "./logging.js";
import { gaugeMetric, histogramMetric, incrementMetric } from "./metrics.js";
import {
  BASE_MAINNET_NETWORK,
  base64ToBytesCalldata,
  DATA_SETTLEMENT_BATCH_BUFFER_SIZE,
  DATA_SETTLEMENT_BATCH_IDLE_TIMEOUT_MS,
  DATA_SETTLEMENT_BATCH_MAX_AGE_MS,
  DATA_WORKER_EVM_PRIVATE_KEY_ENV,
  DATA_WORKER_SETTLEMENT_CONTRACT_ENV,
  HEARTBEAT_RELAY_EVM_PRIVATE_KEY_ENV,
  HEARTBEAT_RELAY_REGISTRY_CONTRACT_ENV,
  OG_EVM_NETWORK,
  REDIS_URL,
  toBytesCalldata,
  toStrictBytes32,
  type DataSettlementJobData,
  type DataWorkerContext,
  type HeartbeatRelayContext,
  type SettlementBatchData,
  type SettlementHandlerResult,
  type SettlementIndividualData,
} from "./all_networks_types_helpers.js";

const ogEvm = defineChain({
  id: 10740,
  name: "OG EVM",
  nativeCurrency: {
    decimals: 18,
    name: "OG",
    symbol: "OG",
  },
  rpcUrls: {
    default: { http: ["https://ogevmdevnet.opengradient.ai/"] },
  },
  blockExplorers: {
    default: {
      name: "OG EVM Explorer",
      url: "https://explorer.og.artela.io",
    },
  },
  contracts: {
    multicall3: {
      address: "0x4200000000000000000000000000000000000006",
      blockCreated: 1,
    },
  },
});

const DATA_WORKER_SETTLEMENT_GAS_LIMIT = BigInt(
  process.env.DATA_WORKER_SETTLEMENT_GAS_LIMIT || "9000000",
);
const DATA_WORKER_TX_RECEIPT_TIMEOUT_MS = Number(
  process.env.DATA_WORKER_TX_RECEIPT_TIMEOUT_MS || 120_000,
);
const BASE_MAINNET_RPC_URL = process.env.BASE_MAINNET_RPC_URL;
const HEARTBEAT_RELAY_GAS_LIMIT = BigInt(process.env.HEARTBEAT_RELAY_GAS_LIMIT || "500000");
const HEARTBEAT_RELAY_TX_RECEIPT_TIMEOUT_MS = Number(
  process.env.HEARTBEAT_RELAY_TX_RECEIPT_TIMEOUT_MS || 120_000,
);

type BatchFlushReason = "buffer-full" | "idle-timeout" | "max-age-timeout";

type BatchFlushResult = {
  merkleRoot: string;
  blobId: string;
  itemCount: number;
  reason: BatchFlushReason;
  settlementTxHash: `0x${string}`;
};

type WalrusUploadResponse = {
  newlyCreated?: {
    blobObject: {
      blobId: string;
    };
  };
  alreadyCertified?: {
    blobId: string;
  };
};

const DEFAULT_SPONSORED_RAW_TX_GAS = 70_000n;
const DEFAULT_SPONSORED_RAW_TX_MAX_FEE_PER_GAS = 1_000_000_000n;

type SponsoredGasWalletClient = {
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  sendTransaction(args: {
    to: `0x${string}`;
    data?: `0x${string}`;
    gas?: bigint;
    value?: bigint;
  }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string }>;
  sendRawTransaction(args: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function emitBatchOldestAgeMetric(): void {
  const oldestAgeMs =
    batchSettlementBuffer.length > 0 && batchSettlementFirstBufferedAtMs !== null
      ? Math.max(0, Date.now() - batchSettlementFirstBufferedAtMs)
      : 0;
  gaugeMetric("data.batch.oldest_age_ms", oldestAgeMs, ["worker:data"]);
}

let batchSettlementBuffer: SettlementBatchData[] = [];
let batchSettlementFlushTimer: ReturnType<typeof setTimeout> | null = null;
let batchSettlementMaxAgeTimer: ReturnType<typeof setTimeout> | null = null;
let batchSettlementFirstBufferedAtMs: number | null = null;
let batchFlushInFlight: Promise<BatchFlushResult | null> | null = null;

const settlementContractAbi = [
  {
    type: "function",
    name: "batchSettle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_merkleRoot",
        type: "bytes32",
      },
      {
        name: "_batchSize",
        type: "uint256",
      },
      {
        name: "_walrusBlobId",
        type: "bytes",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleIndividual",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_teeId",
        type: "bytes32",
      },
      {
        name: "_inputHash",
        type: "bytes32",
      },
      {
        name: "_outputHash",
        type: "bytes32",
      },
      {
        name: "_timestamp",
        type: "uint256",
      },
      {
        name: "_ethAddress",
        type: "address",
      },
      {
        name: "_walrusBlobId",
        type: "bytes",
      },
      {
        name: "_signature",
        type: "bytes",
      },
    ],
    outputs: [],
  },
] as const;

const teeRegistryHeartbeatAbi = [
  {
    type: "function",
    name: "heartbeat",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "teeId",
        type: "bytes32",
      },
      {
        name: "timestamp",
        type: "uint256",
      },
      {
        name: "signature",
        type: "bytes",
      },
    ],
    outputs: [],
  },
] as const;

function scheduleBatchFlush(context: DataWorkerContext): void {
  if (batchSettlementFlushTimer) {
    clearTimeout(batchSettlementFlushTimer);
  }

  batchSettlementFlushTimer = setTimeout(() => {
    void flushBatchSettlementBuffer(context, "idle-timeout").catch(error => {
      console.error("[settlement] Batch idle-timeout flush failed:", error);
    });
  }, DATA_SETTLEMENT_BATCH_IDLE_TIMEOUT_MS);

  batchSettlementFlushTimer.unref?.();

  if (batchSettlementFirstBufferedAtMs !== null && !batchSettlementMaxAgeTimer) {
    const elapsedMs = Date.now() - batchSettlementFirstBufferedAtMs;
    const remainingMs = Math.max(0, DATA_SETTLEMENT_BATCH_MAX_AGE_MS - elapsedMs);

    batchSettlementMaxAgeTimer = setTimeout(() => {
      void flushBatchSettlementBuffer(context, "max-age-timeout").catch(error => {
        console.error("[settlement] Batch max-age flush failed:", error);
      });
    }, remainingMs);

    batchSettlementMaxAgeTimer.unref?.();
  }
}

async function flushBatchSettlementBuffer(
  context: DataWorkerContext,
  reason: BatchFlushReason,
): Promise<BatchFlushResult | null> {
  if (batchFlushInFlight) {
    return batchFlushInFlight;
  }

  batchFlushInFlight = (async () => {
    if (batchSettlementBuffer.length === 0) {
      emitBatchOldestAgeMetric();
      return null;
    }

    const flushStartedAtMs = Date.now();
    const items = batchSettlementBuffer;
    const flushedBatchFirstBufferedAtMs = batchSettlementFirstBufferedAtMs;
    batchSettlementBuffer = [];
    batchSettlementFirstBufferedAtMs = null;

    if (batchSettlementFlushTimer) {
      clearTimeout(batchSettlementFlushTimer);
      batchSettlementFlushTimer = null;
    }
    if (batchSettlementMaxAgeTimer) {
      clearTimeout(batchSettlementMaxAgeTimer);
      batchSettlementMaxAgeTimer = null;
    }

    try {
      const values = items.map(item => [
        toStrictBytes32(item.teeId, "teeId"),
        toStrictBytes32(item.inputHash, "inputHash"),
        toStrictBytes32(item.outputHash, "outputHash"),
        base64ToBytesCalldata(item.teeSignature),
        item.timestamp,
      ]);

      const tree = StandardMerkleTree.of(values, [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes",
        "uint256",
      ]);
      const merkleRoot = tree.root;
      const treeData = JSON.stringify(tree.dump());
      const blobId = await uploadToWalrus(treeData, "batch-tree");
      const settlementTxHash = await context.submitBatchSettlement(
        merkleRoot as `0x${string}`,
        items.length,
        blobId,
      );

      console.log("[settlement] Batch settlement flushed:", {
        signerAddress: context.signerAddress,
        chainId: context.chainId,
        chainName: context.chainName,
        merkleRoot,
        walrusBlobId: blobId,
        itemCount: items.length,
        reason,
      });

      console.log("[settlement] Batch settlement transaction submitted:", {
        settlementContractAddress: context.settlementContractAddress,
        txHash: settlementTxHash,
        merkleRoot,
        batchSize: items.length,
        walrusBlobId: blobId,
      });

      incrementMetric("data.batch.settled.count", ["worker:data"]);
      histogramMetric("data.batch.size", items.length, ["worker:data"]);
      histogramMetric("data.batch.flush.duration_ms", Date.now() - flushStartedAtMs, [
        "worker:data",
        `reason:${reason}`,
        "outcome:success",
      ]);
      emitBatchOldestAgeMetric();

      return {
        merkleRoot,
        blobId,
        itemCount: items.length,
        reason,
        settlementTxHash,
      };
    } catch (error) {
      batchSettlementBuffer = [...items, ...batchSettlementBuffer];
      batchSettlementFirstBufferedAtMs =
        flushedBatchFirstBufferedAtMs ?? batchSettlementFirstBufferedAtMs ?? Date.now();
      scheduleBatchFlush(context);

      console.error("[settlement] Batch settlement flush failed; restored items to buffer:", {
        signerAddress: context.signerAddress,
        chainId: context.chainId,
        chainName: context.chainName,
        restoredItemCount: items.length,
        bufferedItems: batchSettlementBuffer.length,
        reason,
        error,
      });
      histogramMetric("data.batch.flush.duration_ms", Date.now() - flushStartedAtMs, [
        "worker:data",
        `reason:${reason}`,
        "outcome:failure",
      ]);
      emitBatchOldestAgeMetric();
      throw error;
    }
  })();

  try {
    return await batchFlushInFlight;
  } finally {
    batchFlushInFlight = null;
  }
}

export async function processPrivateSettlement(): Promise<SettlementHandlerResult> {
  console.warn(
    "[settlement] Received x-settlement-type=private in facilitator request. Ignoring as sanity check.",
  );
  return {
    acknowledged: true,
    settlementType: "private",
    processedAt: new Date().toISOString(),
    notes: "Private settlement ignored by facilitator.",
  };
}

export async function uploadToWalrus(
  data: string,
  uploadKind: "batch-tree" | "individual-payload" = "individual-payload",
): Promise<string> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL || "http://localhost:9002/v1/blobs";
  const url = `${publisherUrl}?epochs=10`;
  const walrusUploadTimeoutMs = Number(process.env.WALRUS_UPLOAD_TIMEOUT_MS || 30_000);
  console.log(`[settlement] Uploading ${uploadKind} to Walrus via ${publisherUrl}`);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), walrusUploadTimeoutMs);
  timeout.unref?.();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      body: data,
      headers: {
        "Content-Type": "application/json",
      },
      signal: abortController.signal,
    });
  } catch (error) {
    incrementMetric("data.walrus_upload.failure.count", ["worker:data", `kind:${uploadKind}`]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    incrementMetric("data.walrus_upload.failure.count", ["worker:data", `kind:${uploadKind}`]);
    const errorText = await response.text();
    throw new Error(`Walrus upload failed (${response.status}): ${errorText}`);
  }

  let result: WalrusUploadResponse;
  try {
    result = (await response.json()) as WalrusUploadResponse;
  } catch (error) {
    incrementMetric("data.walrus_upload.failure.count", ["worker:data", `kind:${uploadKind}`]);
    throw error;
  }

  if (result.newlyCreated?.blobObject?.blobId) {
    return result.newlyCreated.blobObject.blobId;
  }

  if (result.alreadyCertified?.blobId) {
    console.log(`[settlement] ${uploadKind} already exists on Walrus (deduplicated).`);
    return result.alreadyCertified.blobId;
  }

  incrementMetric("data.walrus_upload.failure.count", ["worker:data", `kind:${uploadKind}`]);
  throw new Error("Unexpected response format from Walrus Publisher");
}

export async function processBatchSettlement(
  data: SettlementBatchData,
  context: DataWorkerContext,
): Promise<SettlementHandlerResult> {
  batchSettlementBuffer.push(data);
  if (batchSettlementFirstBufferedAtMs === null) {
    batchSettlementFirstBufferedAtMs = Date.now();
  }
  emitBatchOldestAgeMetric();
  console.log("[settlement] Batch settlement item buffered:", {
    signerAddress: context.signerAddress,
    chainId: context.chainId,
    chainName: context.chainName,
    bufferedItems: batchSettlementBuffer.length,
    ...summarizeDataSettlementJob({ settlementType: "batch", data }),
  });
  debugLog("[settlement][debug] Raw batch settlement data", data);

  scheduleBatchFlush(context);

  const shouldFlushNow = batchSettlementBuffer.length >= DATA_SETTLEMENT_BATCH_BUFFER_SIZE;
  const flushResult = shouldFlushNow
    ? await flushBatchSettlementBuffer(context, "buffer-full")
    : null;

  return {
    acknowledged: true,
    settlementType: "batch",
    processedAt: new Date().toISOString(),
    notes: flushResult
      ? `Batch settlement flushed (root=${flushResult.merkleRoot}, walrusBlobId=${flushResult.blobId}, count=${flushResult.itemCount}, txHash=${flushResult.settlementTxHash}).`
      : `Batch settlement buffered (${batchSettlementBuffer.length}/${DATA_SETTLEMENT_BATCH_BUFFER_SIZE}).`,
  };
}

export async function processIndividualSettlement(
  data: SettlementIndividualData,
  context: DataWorkerContext,
): Promise<SettlementHandlerResult> {
  try {
    const walrusPayload = {
      input: data.input,
      output: data.output,
      teeSignature: data.teeSignature,
      teeId: data.teeId,
      timestamp: data.timestamp,
      ethAddress: data.ethAddress,
    };
    const walrusData = JSON.stringify(walrusPayload);
    const blobId = await uploadToWalrus(walrusData, "individual-payload");
    const decodedSignatureHex = base64ToBytesCalldata(data.teeSignature);

    const txHash = await context.submitIndividualSettlement({
      teeId: data.teeId,
      inputHash: toStrictBytes32(data.inputHash, "inputHash"),
      outputHash: toStrictBytes32(data.outputHash, "outputHash"),
      timestamp: data.timestamp,
      ethAddress: data.ethAddress,
      walrusBlobId: blobId,
      signature: decodedSignatureHex,
    });

    console.log("[settlement] Processing individual settlement:", {
      signerAddress: context.signerAddress,
      chainId: context.chainId,
      chainName: context.chainName,
      walrusBlobId: blobId,
      txHash,
      ...summarizeDataSettlementJob({ settlementType: "individual", data }),
    });
    debugLog("[settlement][debug] Raw individual settlement data", data);
    debugLog("[settlement][debug] Walrus payload", walrusPayload);

    console.log(
      `[settlement] Individual settlement uploaded to Walrus with blob id: ${blobId}, txHash: ${txHash}`,
    );
    incrementMetric("data.individual_settled.count", ["worker:data"]);

    return {
      acknowledged: true,
      settlementType: "individual",
      processedAt: new Date().toISOString(),
      notes: `Individual settlement processed (walrusBlobId=${blobId}, txHash=${txHash}).`,
    };
  } catch (error) {
    console.error("[settlement] Individual settlement failed:", {
      signerAddress: context.signerAddress,
      chainId: context.chainId,
      chainName: context.chainName,
      settlementContractAddress: context.settlementContractAddress,
      ...summarizeDataSettlementJob({ settlementType: "individual", data }),
      ...summarizeError(error),
    });
    throw error;
  }
}

export async function processDataSettlementJob(
  jobData: DataSettlementJobData,
  context: DataWorkerContext,
): Promise<SettlementHandlerResult> {
  if (jobData.settlementType === "batch") {
    return processBatchSettlement(jobData.data, context);
  }
  return processIndividualSettlement(jobData.data, context);
}

export function createDataWorkerContext(): DataWorkerContext {
  const privateKey = process.env[DATA_WORKER_EVM_PRIVATE_KEY_ENV] as `0x${string}` | undefined;
  if (!privateKey) {
    throw new Error(`${DATA_WORKER_EVM_PRIVATE_KEY_ENV} is required for data worker`);
  }

  const settlementContractAddress = (process.env[DATA_WORKER_SETTLEMENT_CONTRACT_ENV] ||
    process.env.X402_SETTLEMENT_CONTRACT) as `0x${string}` | undefined;
  if (!settlementContractAddress) {
    throw new Error(
      `${DATA_WORKER_SETTLEMENT_CONTRACT_ENV} (or X402_SETTLEMENT_CONTRACT) is required for data worker`,
    );
  }

  const account = privateKeyToAccount(privateKey);

  // OG EVM-only wallet context for data settlement worker.
  const ogEvmWalletClient = createWalletClient({
    account,
    chain: ogEvm,
    transport: http(),
  }).extend(publicActions);

  return {
    signerAddress: account.address,
    chainId: ogEvm.id,
    chainName: ogEvm.name,
    settlementContractAddress,
    submitBatchSettlement: async (
      merkleRoot: `0x${string}`,
      batchSize: number,
      walrusBlobId: string,
    ): Promise<`0x${string}`> => {
      let stage: "broadcast" | "receipt" = "broadcast";
      try {
        const txHash = await ogEvmWalletClient.writeContract({
          address: settlementContractAddress,
          abi: settlementContractAbi,
          functionName: "batchSettle",
          args: [merkleRoot, BigInt(batchSize), toHex(walrusBlobId)],
          gas: DATA_WORKER_SETTLEMENT_GAS_LIMIT,
          maxFeePerGas: parseGwei("0.002"),
          maxPriorityFeePerGas: parseGwei("0.001"),
        });
        stage = "receipt";
        const receipt = await withTimeout(
          ogEvmWalletClient.waitForTransactionReceipt({ hash: txHash }),
          DATA_WORKER_TX_RECEIPT_TIMEOUT_MS,
          "Batch settlement receipt wait",
        );
        if (receipt.status !== "success") {
          throw new Error(`Batch settlement transaction reverted: ${txHash}`);
        }
        return txHash;
      } catch (error) {
        incrementMetric("data.tx.failure.count", [
          "worker:data",
          "tx_type:batch",
          `stage:${stage}`,
        ]);
        throw error;
      }
    },
    submitIndividualSettlement: async ({
      teeId,
      inputHash,
      outputHash,
      timestamp,
      ethAddress,
      walrusBlobId,
      signature,
    }): Promise<`0x${string}`> => {
      let stage: "broadcast" | "receipt" = "broadcast";
      try {
        const txHash = await ogEvmWalletClient.writeContract({
          address: settlementContractAddress,
          abi: settlementContractAbi,
          functionName: "settleIndividual",
          args: [
            teeId,
            inputHash,
            outputHash,
            BigInt(timestamp),
            ethAddress,
            toHex(walrusBlobId),
            toBytesCalldata(signature),
          ],
          gas: DATA_WORKER_SETTLEMENT_GAS_LIMIT,
          maxFeePerGas: parseGwei("0.002"),
          maxPriorityFeePerGas: parseGwei("0.001"),
        });
        stage = "receipt";
        const receipt = await withTimeout(
          ogEvmWalletClient.waitForTransactionReceipt({ hash: txHash }),
          DATA_WORKER_TX_RECEIPT_TIMEOUT_MS,
          "Individual settlement receipt wait",
        );
        if (receipt.status !== "success") {
          throw new Error(`Individual settlement transaction reverted: ${txHash}`);
        }
        return txHash;
      } catch (error) {
        incrementMetric("data.tx.failure.count", [
          "worker:data",
          "tx_type:individual",
          `stage:${stage}`,
        ]);
        throw error;
      }
    },
  };
}

export function createHeartbeatRelayContext(): HeartbeatRelayContext {
  const privateKey = (process.env[HEARTBEAT_RELAY_EVM_PRIVATE_KEY_ENV] ||
    process.env[DATA_WORKER_EVM_PRIVATE_KEY_ENV] ||
    process.env.EVM_PRIVATE_KEY) as `0x${string}` | undefined;
  if (!privateKey) {
    throw new Error(
      `${HEARTBEAT_RELAY_EVM_PRIVATE_KEY_ENV} (or ${DATA_WORKER_EVM_PRIVATE_KEY_ENV}/EVM_PRIVATE_KEY) is required for heartbeat relay`,
    );
  }

  const registryContractAddress = (process.env[HEARTBEAT_RELAY_REGISTRY_CONTRACT_ENV] ||
    process.env.HEARTBEAT_CONTRACT_ADDRESS) as `0x${string}` | undefined;
  if (!registryContractAddress) {
    throw new Error(
      `${HEARTBEAT_RELAY_REGISTRY_CONTRACT_ENV} (or HEARTBEAT_CONTRACT_ADDRESS) is required for heartbeat relay`,
    );
  }

  const account = privateKeyToAccount(privateKey);
  const ogEvmWalletClient = createWalletClient({
    account,
    chain: ogEvm,
    transport: http(),
  }).extend(publicActions);

  return {
    signerAddress: account.address,
    chainId: ogEvm.id,
    chainName: ogEvm.name,
    registryContractAddress,
    submitHeartbeat: async ({ teeId, timestamp, signature }): Promise<`0x${string}`> => {
      let stage: "broadcast" | "receipt" = "broadcast";
      let txHash: `0x${string}` | undefined;
      try {
        txHash = await ogEvmWalletClient.writeContract({
          address: registryContractAddress,
          abi: teeRegistryHeartbeatAbi,
          functionName: "heartbeat",
          args: [teeId, BigInt(timestamp), signature],
          gas: HEARTBEAT_RELAY_GAS_LIMIT,
          maxFeePerGas: parseGwei("0.002"),
          maxPriorityFeePerGas: parseGwei("0.001"),
        });

        stage = "receipt";
        const receipt = await withTimeout(
          ogEvmWalletClient.waitForTransactionReceipt({ hash: txHash }),
          HEARTBEAT_RELAY_TX_RECEIPT_TIMEOUT_MS,
          "Heartbeat relay receipt wait",
        );
        if (receipt.status !== "success") {
          throw new Error(`Heartbeat relay transaction reverted: ${txHash}`);
        }

        return txHash;
      } catch (error) {
        incrementMetric("heartbeat.tx.failure.count", [`stage:${stage}`]);
        console.error("[heartbeat-relay] Heartbeat transaction failed:", {
          signerAddress: account.address,
          chainId: ogEvm.id,
          chainName: ogEvm.name,
          registryContractAddress,
          teeId,
          timestamp,
          stage,
          txHash,
          error,
        });
        throw error;
      }
    },
  };
}

export function createBullMqConnection(): RedisOptions {
  const parsed = new URL(REDIS_URL);
  const dbPath = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  const db = dbPath.length > 0 ? Number(dbPath) : 0;

  const options: RedisOptions = {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null,
  };

  if (parsed.protocol === "rediss:") {
    options.tls = {};
  }

  return options;
}

function createErc20ApprovalGasSponsorSigner(args: {
  signer: FacilitatorEvmSigner;
  walletClient: SponsoredGasWalletClient;
}): Erc20ApprovalGasSponsoringSigner {
  return {
    ...args.signer,
    sendTransactions: async transactions => {
      const hashes: `0x${string}`[] = [];

      for (const transaction of transactions) {
        let hash: `0x${string}`;

        if (typeof transaction === "string") {
          const parsed = parseTransaction(transaction);
          const payerAddress = await recoverTransactionAddress({
            serializedTransaction: transaction,
          });
          const gas = parsed.gas ?? DEFAULT_SPONSORED_RAW_TX_GAS;
          const maxFeePerGas =
            parsed.maxFeePerGas ?? parsed.gasPrice ?? DEFAULT_SPONSORED_RAW_TX_MAX_FEE_PER_GAS;
          const gasCost = gas * maxFeePerGas;
          const payerBalance = await args.walletClient.getBalance({ address: payerAddress });

          if (payerBalance < gasCost) {
            const deficit = gasCost - payerBalance;
            console.log(
              `[payment-worker] funding ${payerAddress} with ${deficit.toString()} wei for sponsored approval gas`,
            );

            const fundingHash = await args.walletClient.sendTransaction({
              to: payerAddress,
              value: deficit,
            });
            const fundingReceipt = await args.walletClient.waitForTransactionReceipt({
              hash: fundingHash,
            });

            if (fundingReceipt.status !== "success") {
              throw new Error(`gas_funding_failed: ${fundingHash}`);
            }
          }

          hash = await args.walletClient.sendRawTransaction({
            serializedTransaction: transaction,
          });
        } else {
          hash = await args.walletClient.sendTransaction({
            to: transaction.to,
            data: transaction.data,
            gas: transaction.gas,
          });
        }

        const receipt = await args.walletClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`transaction_failed: ${hash}`);
        }

        hashes.push(hash);
      }

      return hashes;
    },
  };
}

export async function createFacilitator(): Promise<x402Facilitator> {
  const evmPrivateKey = (process.env.PAYMENT_WORKER_EVM_PRIVATE_KEY ||
    process.env.EVM_PRIVATE_KEY) as `0x${string}` | undefined;

  if (!evmPrivateKey) {
    throw new Error("PAYMENT_WORKER_EVM_PRIVATE_KEY or EVM_PRIVATE_KEY is required");
  }

  const facilitator = new x402Facilitator()
    .onBeforeVerify(async context => {
      console.log("[verify] Starting payment verification", {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizePaymentPayload(context.paymentPayload),
      });
      debugLog("[verify][debug] Full verify context", context);
    })
    .onAfterVerify(async context => {
      console.log("[verify] Payment verification completed", {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizeVerifyResponse(context.result),
      });
      debugLog("[verify][debug] Verify result context", context);
    })
    .onVerifyFailure(async context => {
      console.warn("[verify] Payment verification failed", {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizePaymentPayload(context.paymentPayload),
        ...summarizeError(context.error),
      });
      debugLog("[verify][debug] Verify failure context", context);
    })
    .onBeforeSettle(async context => {
      console.log("[payment-settlement] Starting payment settlement", {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizePaymentPayload(context.paymentPayload),
      });
      debugLog("[payment-settlement][debug] Full settle context", context);
    })
    .onAfterSettle(async context => {
      const settlementSummary = {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizeSettleResponse(context.result),
        ...(context.result.success ? {} : summarizePaymentPayload(context.paymentPayload)),
      };

      console.log("[payment-settlement] Payment settlement completed", settlementSummary);
      debugLog("[payment-settlement][debug] Settle result context", context);
    })
    .onSettleFailure(async context => {
      console.error("[payment-settlement] Payment settlement failed", {
        ...summarizePaymentRequirements(context.requirements),
        ...summarizePaymentPayload(context.paymentPayload),
        ...summarizeError(context.error),
      });
      debugLog("[payment-settlement][debug] Settle failure context", context);
    });

  if (evmPrivateKey) {
    const evmAccount = privateKeyToAccount(evmPrivateKey);
    console.info(`EVM Facilitator account: ${evmAccount.address}`);

    const viemClient = createWalletClient({
      account: evmAccount,
      chain: ogEvm,
      transport: http(),
    }).extend(publicActions);

    const baseViemClient = createWalletClient({
      account: evmAccount,
      chain: base,
      transport: http(BASE_MAINNET_RPC_URL),
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
      }) => viemClient.verifyTypedData(args as never),
      writeContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
      }) =>
        viemClient.writeContract({
          ...args,
          args: args.args || [],
          gas: 9_000_000n,
          maxFeePerGas: parseGwei("0.002"),
          maxPriorityFeePerGas: parseGwei("0.001"),
        }),
      sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
        viemClient.sendTransaction({
          ...args,
          gas: 9_000_000n,
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
      }) => baseViemClient.verifyTypedData(args as never),
      writeContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
      }) =>
        baseViemClient.writeContract({
          ...args,
          args: args.args || [],
          gas: 5_000_000n,
          maxFeePerGas: parseGwei("0.006"),
          maxPriorityFeePerGas: parseGwei("0.005"),
        }),
      sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
        baseViemClient.sendTransaction({
          ...args,
          gas: 5_000_000n,
        }),
      waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
        baseViemClient.waitForTransactionReceipt(args),
    });

    const erc20ApprovalSigners = new Map<string, Erc20ApprovalGasSponsoringSigner>([
      [
        OG_EVM_NETWORK,
        createErc20ApprovalGasSponsorSigner({
          signer: evmSigner,
          walletClient: viemClient,
        }),
      ],
      [
        BASE_MAINNET_NETWORK,
        createErc20ApprovalGasSponsorSigner({
          signer: baseEvmSigner,
          walletClient: baseViemClient,
        }),
      ],
    ]);

    facilitator.register(
      OG_EVM_NETWORK,
      new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
    );
    facilitator.register(OG_EVM_NETWORK, new UptoEvmScheme(evmSigner));

    facilitator.register(
      BASE_MAINNET_NETWORK,
      new ExactEvmScheme(baseEvmSigner, { deployERC4337WithEIP6492: true }),
    );
    facilitator.register(BASE_MAINNET_NETWORK, new UptoEvmScheme(baseEvmSigner));

    facilitator
      .registerExtension(EIP2612_GAS_SPONSORING)
      .registerExtension(
        createErc20ApprovalGasSponsoringExtension(
          erc20ApprovalSigners.get(OG_EVM_NETWORK)!,
          network => erc20ApprovalSigners.get(network),
        ),
      );
  }

  return facilitator;
}

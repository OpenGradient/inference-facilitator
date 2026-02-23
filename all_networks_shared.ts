import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { RedisOptions } from "ioredis";
import { createWalletClient, defineChain, http, parseGwei, publicActions, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  base64ToBytesCalldata,
  DATA_SETTLEMENT_BATCH_BUFFER_SIZE,
  DATA_SETTLEMENT_BATCH_IDLE_TIMEOUT_MS,
  DATA_SETTLEMENT_BATCH_MAX_AGE_MS,
  DATA_WORKER_EVM_PRIVATE_KEY_ENV,
  DATA_WORKER_SETTLEMENT_CONTRACT_ENV,
  REDIS_URL,
  teeSignatureLeafValue,
  toBytesCalldata,
  toStrictBytes32,
  type DataSettlementJobData,
  type DataWorkerContext,
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
      return null;
    }

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
        toStrictBytes32(item.inputHash, "inputHash"),
        toStrictBytes32(item.outputHash, "outputHash"),
        teeSignatureLeafValue(item.teeSignature),
      ]);

      const tree = StandardMerkleTree.of(values, ["bytes32", "bytes32", "bytes32"]);
      const merkleRoot = tree.root;
      const treeData = JSON.stringify(tree.dump());
      const blobId = await uploadToWalrus(treeData);
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

export async function uploadToWalrus(data: string): Promise<string> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL || "http://localhost:9002/v1/blobs";
  const url = `${publisherUrl}?epochs=10`;
  const walrusUploadTimeoutMs = Number(process.env.WALRUS_UPLOAD_TIMEOUT_MS || 30_000);
  console.log(`Uploading individual settlement payload to Walrus: ${publisherUrl}`);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), walrusUploadTimeoutMs);
  timeout.unref?.();

  const response = await fetch(url, {
    method: "PUT",
    body: data,
    headers: {
      "Content-Type": "application/json",
    },
    signal: abortController.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Walrus upload failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as WalrusUploadResponse;

  if (result.newlyCreated?.blobObject?.blobId) {
    return result.newlyCreated.blobObject.blobId;
  }

  if (result.alreadyCertified?.blobId) {
    console.log("Blob already exists on Walrus (deduplicated).");
    return result.alreadyCertified.blobId;
  }

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
  console.log("[settlement] Batch settlement item buffered:", {
    signerAddress: context.signerAddress,
    chainId: context.chainId,
    chainName: context.chainName,
    bufferedItems: batchSettlementBuffer.length,
    data,
  });

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
    const blobId = await uploadToWalrus(walrusData);
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
      data,
    });

    console.log(
      `[settlement] Individual settlement uploaded to Walrus with blob id: ${blobId}, txHash: ${txHash}`,
    );

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
      data,
      error,
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
      const txHash = await ogEvmWalletClient.writeContract({
        address: settlementContractAddress,
        abi: settlementContractAbi,
        functionName: "batchSettle",
        args: [merkleRoot, BigInt(batchSize), toHex(walrusBlobId)],
        gas: DATA_WORKER_SETTLEMENT_GAS_LIMIT,
        maxFeePerGas: parseGwei("0.002"),
        maxPriorityFeePerGas: parseGwei("0.001"),
      });
      const receipt = await withTimeout(
        ogEvmWalletClient.waitForTransactionReceipt({ hash: txHash }),
        DATA_WORKER_TX_RECEIPT_TIMEOUT_MS,
        "Batch settlement receipt wait",
      );
      if (receipt.status !== "success") {
        throw new Error(`Batch settlement transaction reverted: ${txHash}`);
      }
      return txHash;
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
      const receipt = await withTimeout(
        ogEvmWalletClient.waitForTransactionReceipt({ hash: txHash }),
        DATA_WORKER_TX_RECEIPT_TIMEOUT_MS,
        "Individual settlement receipt wait",
      );
      if (receipt.status !== "success") {
        throw new Error(`Individual settlement transaction reverted: ${txHash}`);
      }
      return txHash;
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

export async function createFacilitator(): Promise<x402Facilitator> {
  const evmPrivateKey = (process.env.PAYMENT_WORKER_EVM_PRIVATE_KEY ||
    process.env.EVM_PRIVATE_KEY) as `0x${string}` | undefined;
  const svmPrivateKey = (process.env.PAYMENT_WORKER_SVM_PRIVATE_KEY ||
    process.env.SVM_PRIVATE_KEY) as string | undefined;

  if (!evmPrivateKey && !svmPrivateKey) {
    throw new Error(
      "At least one of PAYMENT_WORKER_EVM_PRIVATE_KEY/EVM_PRIVATE_KEY or PAYMENT_WORKER_SVM_PRIVATE_KEY/SVM_PRIVATE_KEY is required",
    );
  }

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

  const EVM_NETWORK = "eip155:10740";
  const BASE_TESTNET_NETWORK = "eip155:84532";
  const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

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

  if (svmPrivateKey) {
    const svmAccount = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    console.info(`SVM Facilitator account: ${svmAccount.address}`);
    const svmSigner = toFacilitatorSvmSigner(svmAccount);
    facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
  }

  return facilitator;
}

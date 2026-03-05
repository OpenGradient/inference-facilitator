import { type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import dotenv from "dotenv";
import { getAddress, isAddress, keccak256, toHex } from "viem";

dotenv.config();

function resolveQueueName(
  rawValue: string | undefined,
  fallbackValue: string,
  envVarName: string,
): string {
  const source = rawValue?.trim() || fallbackValue;
  const normalized = source.replaceAll(":", "-");

  if (source !== normalized) {
    console.warn(
      `[queue-config] ${envVarName} contained ':', normalized "${source}" -> "${normalized}" for BullMQ compatibility.`,
    );
  }

  return normalized;
}

export const PORT = process.env.PORT || "4022";
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const PAYMENT_QUEUE_NAME = resolveQueueName(
  process.env.PAYMENT_QUEUE_NAME,
  "x402-settle-payment-queue",
  "PAYMENT_QUEUE_NAME",
);
export const DATA_SETTLEMENT_QUEUE_NAME = resolveQueueName(
  process.env.DATA_SETTLEMENT_QUEUE_NAME,
  "x402-settle-data-queue",
  "DATA_SETTLEMENT_QUEUE_NAME",
);
export const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000);
export const DATA_WORKER_EVM_PRIVATE_KEY_ENV = "DATA_WORKER_EVM_PRIVATE_KEY";
export const DATA_WORKER_SETTLEMENT_CONTRACT_ENV = "DATA_WORKER_SETTLEMENT_CONTRACT";
export const DATA_SETTLEMENT_BATCH_BUFFER_SIZE = Number(
  process.env.DATA_SETTLEMENT_BATCH_BUFFER_SIZE || 20,
);
export const DATA_SETTLEMENT_BATCH_IDLE_TIMEOUT_MS = Number(
  process.env.DATA_SETTLEMENT_BATCH_IDLE_TIMEOUT_MS || 5 * 60 * 1000,
);
export const DATA_SETTLEMENT_BATCH_MAX_AGE_MS = Number(
  process.env.DATA_SETTLEMENT_BATCH_MAX_AGE_MS || 15 * 60 * 1000,
);

export type SettlementType = "private" | "batch" | "individual";

export type SettlementBatchData = {
  inputHash: string;
  outputHash: string;
  teeSignature: string;
};

export type SettlementIndividualData = SettlementBatchData & {
  input: unknown;
  output: unknown;
  teeId: `0x${string}`;
  timestamp: string;
  ethAddress: `0x${string}`;
};

export type DataSettlementJobData =
  | {
      settlementType: "batch";
      data: SettlementBatchData;
    }
  | {
      settlementType: "individual";
      data: SettlementIndividualData;
    };

export type ParsedSettlementHeader = DataSettlementJobData | { settlementType: "private" } | null;

export type SettlementHandlerResult = {
  acknowledged: true;
  settlementType: SettlementType;
  processedAt: string;
  notes: string;
};

export type PaymentSettlementJobData = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type DataWorkerContext = {
  signerAddress: `0x${string}`;
  chainId: number;
  chainName: string;
  settlementContractAddress: `0x${string}`;
  submitBatchSettlement: (
    merkleRoot: `0x${string}`,
    batchSize: number,
    walrusBlobId: string,
  ) => Promise<`0x${string}`>;
  submitIndividualSettlement: (args: {
    teeId: `0x${string}`;
    inputHash: `0x${string}`;
    outputHash: `0x${string}`;
    timestamp: string;
    ethAddress: `0x${string}`;
    walrusBlobId: string;
    signature: string;
  }) => Promise<`0x${string}`>;
};

export type SettlementApiJobResponse = {
  jobId: string;
  queue: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  settlementType?: SettlementType;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getRequiredStringField(record: Record<string, unknown>, fieldNames: string[]): string {
  for (const name of fieldNames) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  throw new Error(`Missing required settlement field. Expected one of: ${fieldNames.join(", ")}`);
}

export function getRequiredUnknownField(record: Record<string, unknown>, fieldNames: string[]): unknown {
  for (const name of fieldNames) {
    if (name in record) {
      return record[name];
    }
  }
  throw new Error(`Missing required settlement field. Expected one of: ${fieldNames.join(", ")}`);
}

export function parseUint256Field(record: Record<string, unknown>, fieldNames: string[]): string {
  const raw = getRequiredUnknownField(record, fieldNames);

  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new Error(`Invalid uint256 field. Expected non-negative integer for: ${fieldNames.join(", ")}`);
    }
    return raw.toString();
  }

  if (typeof raw !== "string") {
    throw new Error(`Invalid uint256 field. Expected string or number for: ${fieldNames.join(", ")}`);
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid uint256 field. Empty value for: ${fieldNames.join(", ")}`);
  }

  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      return BigInt(trimmed).toString();
    } catch {
      throw new Error(`Invalid uint256 hex value for: ${fieldNames.join(", ")}`);
    }
  }

  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`Invalid uint256 value for: ${fieldNames.join(", ")}`);
  }

  return trimmed;
}

function parseEvmAddressField(record: Record<string, unknown>, fieldNames: string[]): `0x${string}` {
  const value = getRequiredStringField(record, fieldNames);
  if (!isAddress(value)) {
    throw new Error(`Invalid EVM address for: ${fieldNames.join(", ")}`);
  }
  return getAddress(value);
}

function parseBatchSettlementData(decoded: unknown): SettlementBatchData {
  if (!isRecord(decoded)) {
    throw new Error("x-settlement-data must decode to a JSON object");
  }

  return {
    inputHash: getRequiredStringField(decoded, ["inputHash", "input_hash", "input hash", "input-hash"]),
    outputHash: getRequiredStringField(decoded, [
      "outputHash",
      "output_hash",
      "output hash",
      "output-hash",
    ]),
    teeSignature: getRequiredStringField(decoded, [
      "teeSignature",
      "tee_signature",
      "tee signature",
      "tee-signature",
      "tee singature",
    ]),
  };
}

function parseIndividualSettlementData(decoded: unknown): SettlementIndividualData {
  if (!isRecord(decoded)) {
    throw new Error("x-settlement-data must decode to a JSON object");
  }

  const batchData = parseBatchSettlementData(decoded);
  const teeId = toStrictBytes32(
    getRequiredStringField(decoded, ["teeId", "tee_id", "tee id", "tee-id"]),
    "teeId",
  );
  const timestamp = parseUint256Field(decoded, [
    "timestamp",
    "timeStamp",
    "time_stamp",
    "tee_timestamp",
  ]);
  const ethAddress = parseEvmAddressField(decoded, [
    "ethAddress",
    "eth_address",
    "eth address",
    "eth-address",
    "address",
  ]);

  return {
    ...batchData,
    input: getRequiredUnknownField(decoded, ["input"]),
    output: getRequiredUnknownField(decoded, ["output"]),
    teeId,
    timestamp,
    ethAddress,
  };
}

function decodeSettlementDataHeader(settlementDataHeader: string): unknown {
  const decodedBase64 = Buffer.from(settlementDataHeader, "base64").toString("utf8");

  try {
    return JSON.parse(decodedBase64) as unknown;
  } catch {
    throw new Error("x-settlement-data must be base64 encoded JSON");
  }
}

function parseSettlementType(rawType: string): SettlementType {
  const normalized = rawType.trim().toLowerCase();
  if (normalized === "private" || normalized === "pivate") {
    return "private";
  }
  if (normalized === "batch") {
    return "batch";
  }
  if (normalized === "individual" || normalized === "inidvidual") {
    return "individual";
  }
  throw new Error(`Unsupported x-settlement-type: ${rawType}`);
}

export function parseSettlementJobDataFromHeaders(
  settlementTypeHeader: string | undefined,
  settlementDataHeader: string | undefined,
): ParsedSettlementHeader {
  if (!settlementTypeHeader) {
    return null;
  }

  const settlementType = parseSettlementType(settlementTypeHeader);
  if (settlementType === "private") {
    return { settlementType: "private" };
  }

  if (!settlementDataHeader) {
    throw new Error("Missing x-settlement-data header for settlement type");
  }

  const decodedData = decodeSettlementDataHeader(settlementDataHeader);
  if (settlementType === "batch") {
    return {
      settlementType,
      data: parseBatchSettlementData(decodedData),
    };
  }

  return {
    settlementType,
    data: parseIndividualSettlementData(decodedData),
  };
}

function isHexLike(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

function normalizeHex(value: string): `0x${string}` {
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`;
  return withPrefix as `0x${string}`;
}

export function toStrictBytes32(value: string, fieldName: string): `0x${string}` {
  const normalized = normalizeHex(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName}: expected bytes32 hex value`);
  }
  return normalized;
}

export function teeSignatureLeafValue(value: string): `0x${string}` {
  const normalized = normalizeHex(value);
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return normalized;
  }
  if (isHexLike(normalized)) {
    return keccak256(normalized);
  }
  return keccak256(toHex(value));
}

export function toBytesCalldata(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x") && isHexLike(trimmed)) {
    return trimmed as `0x${string}`;
  }
  return toHex(trimmed);
}

export function base64ToBytesCalldata(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid teeSignature: empty base64 value");
  }

  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length === 0) {
    throw new Error("Invalid teeSignature: failed to decode base64");
  }

  return `0x${bytes.toString("hex")}` as `0x${string}`;
}

export function isSettlementError(error: unknown): error is Error {
  return error instanceof Error && error.message.toLowerCase().includes("settlement");
}

export function toSerializableResult(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

export function settlementStatusFromBullState(
  state: string,
): "queued" | "processing" | "succeeded" | "failed" {
  if (state === "completed") {
    return "succeeded";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "active") {
    return "processing";
  }
  return "queued";
}

export function normalizeHeaderValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

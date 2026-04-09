import { inspect } from "node:util";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  EIP2612_GAS_SPONSORING,
  ERC20_APPROVAL_GAS_SPONSORING,
  extractEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
  validateErc20ApprovalGasSponsoringInfo,
} from "@x402/extensions";
import type {
  DataSettlementJobData,
  SettlementBatchData,
  SettlementIndividualData,
} from "./all_networks_types_helpers.js";

type LogSummaryValue = boolean | number | string | undefined;
type LogSummary = Record<string, LogSummaryValue>;

export const DEBUG_LOGGING_ENABLED = process.env.FACILITATOR_DEBUG === "true";

function shortenValue(
  value: string | undefined,
  prefixLength = 10,
  suffixLength = 6,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.length <= prefixLength + suffixLength + 3) {
    return value;
  }

  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function summarizeObjectShape(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `object(${keys.slice(0, 5).join(",")})` : "object(empty)";
  }

  if (typeof value === "string") {
    return `string(${value.length})`;
  }

  return typeof value;
}

function summarizeSettlementBatchData(data: SettlementBatchData): LogSummary {
  return {
    teeId: shortenValue(data.teeId),
    inputHash: shortenValue(data.inputHash),
    outputHash: shortenValue(data.outputHash),
    timestamp: data.timestamp,
  };
}

function summarizeSettlementIndividualData(data: SettlementIndividualData): LogSummary {
  return {
    ...summarizeSettlementBatchData(data),
    ethAddress: shortenValue(data.ethAddress),
    inputShape: summarizeObjectShape(data.input),
    outputShape: summarizeObjectShape(data.output),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function summarizeExtensionInfoShape(extension: unknown): string | undefined {
  const extensionRecord = asRecord(extension);
  if (!extensionRecord) {
    return undefined;
  }

  const infoRecord = asRecord(extensionRecord.info);
  if (!infoRecord) {
    return undefined;
  }

  const keys = Object.keys(infoRecord);
  return keys.length > 0 ? keys.join(",") : undefined;
}

function diagnoseEip2612Extension(paymentPayload: PaymentPayload): LogSummary {
  const extension = paymentPayload.extensions?.[EIP2612_GAS_SPONSORING.key];
  if (!extension) {
    return {};
  }

  const infoShape = summarizeExtensionInfoShape(extension);
  const info = extractEip2612GasSponsoringInfo(paymentPayload);
  if (info) {
    return {
      eip2612State: validateEip2612GasSponsoringInfo(info) ? "client-signed" : "client-signed-invalid",
      eip2612InfoShape: infoShape,
    };
  }

  return {
    eip2612State: infoShape === "description,version" ? "server-declared-only" : "missing-required-fields",
    eip2612InfoShape: infoShape,
    probableIssue:
      "eip2612 declared by server but signed permit fields are missing from paymentPayload.extensions",
  };
}

function diagnoseErc20ApprovalExtension(paymentPayload: PaymentPayload): LogSummary {
  const extension = paymentPayload.extensions?.[ERC20_APPROVAL_GAS_SPONSORING.key];
  if (!extension) {
    return {};
  }

  const infoShape = summarizeExtensionInfoShape(extension);
  const info = extractErc20ApprovalGasSponsoringInfo(paymentPayload);
  if (info) {
    return {
      erc20ApprovalState: validateErc20ApprovalGasSponsoringInfo(info)
        ? "client-signed"
        : "client-signed-invalid",
      erc20ApprovalInfoShape: infoShape,
    };
  }

  return {
    erc20ApprovalState:
      infoShape === "description,version" ? "server-declared-only" : "missing-required-fields",
    erc20ApprovalInfoShape: infoShape,
  };
}

export function summarizePaymentRequirements(requirements: PaymentRequirements): LogSummary {
  return {
    scheme: requirements.scheme,
    network: requirements.network,
    asset: shortenValue(requirements.asset),
    amount: requirements.amount,
    payTo: shortenValue(requirements.payTo),
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
  };
}

export function summarizePaymentPayload(paymentPayload: PaymentPayload): LogSummary {
  return {
    x402Version: paymentPayload.x402Version,
    resourceUrl: paymentPayload.resource?.url,
    resourceMimeType: paymentPayload.resource?.mimeType,
    acceptedScheme: paymentPayload.accepted.scheme,
    acceptedNetwork: paymentPayload.accepted.network,
    acceptedAsset: shortenValue(paymentPayload.accepted.asset),
    acceptedAmount: paymentPayload.accepted.amount,
    acceptedPayTo: shortenValue(paymentPayload.accepted.payTo),
    payloadKeys: Object.keys(paymentPayload.payload).join(",") || undefined,
    extensionKeys: paymentPayload.extensions
      ? Object.keys(paymentPayload.extensions).join(",") || undefined
      : undefined,
    ...diagnoseEip2612Extension(paymentPayload),
    ...diagnoseErc20ApprovalExtension(paymentPayload),
  };
}

export function summarizeVerifyResponse(result: VerifyResponse): LogSummary {
  return {
    isValid: result.isValid,
    payer: shortenValue(result.payer),
    invalidReason: result.invalidReason,
    invalidMessage: result.invalidMessage,
    extensionKeys: result.extensions
      ? Object.keys(result.extensions).join(",") || undefined
      : undefined,
  };
}

export function summarizeSettleResponse(result: SettleResponse): LogSummary {
  return {
    success: result.success,
    payer: shortenValue(result.payer),
    transaction: shortenValue(result.transaction),
    network: result.network,
    settledAmount: result.amount,
    errorReason: result.errorReason,
    errorMessage: result.errorMessage,
    extensionKeys: result.extensions
      ? Object.keys(result.extensions).join(",") || undefined
      : undefined,
  };
}

export function summarizeError(error: unknown): LogSummary {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorMessage: String(error),
  };
}

export function summarizeDataSettlementJob(jobData: DataSettlementJobData): LogSummary {
  if (jobData.settlementType === "batch") {
    return {
      settlementType: jobData.settlementType,
      ...summarizeSettlementBatchData(jobData.data),
    };
  }

  return {
    settlementType: jobData.settlementType,
    ...summarizeSettlementIndividualData(jobData.data),
  };
}

export function debugLog(label: string, value: unknown): void {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }

  console.log(`${label}\n${inspect(value, { depth: null, colors: false, compact: false })}`);
}

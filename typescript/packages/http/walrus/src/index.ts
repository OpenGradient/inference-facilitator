import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { toHex, type Hex } from "viem";

export const DEFAULT_WALRUS_AGGREGATOR_URL = "https://aggregator.suicore.com";
export const DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS =
  "0xa06dAFA3D713b74e4e1E74B34bd1588C9FD6C290" as Hex;
export const DEFAULT_WALRUS_RPC_URL = "https://ogevmdevnet.opengradient.ai";

export const WALRUS_BATCH_LEAF_ENCODING = [
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes",
  "uint256",
] as const;

const verifierContractAbi = [
  {
    type: "function",
    name: "verifySignatureNoTimestamp",
    stateMutability: "view",
    inputs: [
      {
        name: "teeId",
        type: "bytes32",
      },
      {
        name: "inputHash",
        type: "bytes32",
      },
      {
        name: "outputHash",
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
    outputs: [
      {
        name: "",
        type: "bool",
      },
    ],
  },
] as const;

/**
 * Shared client options for Walrus blob requests.
 */
export interface WalrusClientOptions {
  /**
   * Base aggregator URL.
   *
   * @defaultValue "https://aggregator.suicore.com"
   */
  baseUrl?: string;

  /**
   * Fetch implementation to use. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Request options for blob fetches.
 */
export interface FetchWalrusBlobOptions
  extends Omit<RequestInit, "body" | "method">,
    WalrusClientOptions {}

export type WalrusBatchLeafTuple = [Hex, Hex, Hex, Hex, string];

export type WalrusBatchTreeDump = {
  format: "standard-v1";
  leafEncoding: string[];
  tree: Hex[];
  values: Array<{
    value: WalrusBatchLeafTuple;
    treeIndex: number;
    hash: Hex;
  }>;
};

export type WalrusBatchTreeItem = {
  index: number;
  tee_id: Hex;
  input_hash: Hex;
  output_hash: Hex;
  tee_signature: Hex;
  tee_timestamp: string;
  tuple: WalrusBatchLeafTuple;
};

export type LoadedWalrusBatchTree = {
  blobId: string;
  merkleRoot: Hex;
  tree: StandardMerkleTree<WalrusBatchLeafTuple>;
  dump: WalrusBatchTreeDump;
  items: WalrusBatchTreeItem[];
};

export type WalrusSignatureEncoding = "auto" | "hex" | "utf8" | "base64";

export type WalrusSignatureVerificationClient = {
  readContract(args: {
    address: Hex;
    abi: typeof verifierContractAbi;
    functionName: "verifySignatureNoTimestamp";
    args: readonly [Hex, Hex, Hex, bigint, Hex];
  }): Promise<boolean>;
};

export type VerifyWalrusBatchTreeItemSignatureArgs = {
  item: WalrusBatchTreeItem;
  verifierContractAddress?: Hex;
  publicClient: WalrusSignatureVerificationClient;
};

export type VerifyWalrusBatchTreeSignaturesArgs = {
  blobId?: string;
  tree?: LoadedWalrusBatchTree;
  verifierContractAddress?: Hex;
  publicClient: WalrusSignatureVerificationClient;
  aggregatorUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export type WalrusBatchTreeItemVerification = {
  item: WalrusBatchTreeItem;
  verified: boolean | null;
  error?: string;
};

export type WalrusBatchTreeVerificationResult = {
  blobId: string;
  merkleRoot: Hex;
  results: WalrusBatchTreeItemVerification[];
};

/**
 * Thrown when a Walrus blob request fails.
 */
export class WalrusBlobFetchError extends Error {
  public readonly blobId: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly url: string;

  /**
   * Creates a new Walrus blob fetch error.
   *
   * @param blobId - The blob ID that was requested.
   * @param response - The failed HTTP response.
   * @param url - The resolved blob URL.
   */
  public constructor(blobId: string, response: Response, url: string) {
    super(
      `Failed to fetch Walrus blob "${blobId}" from ${url}: ${response.status} ${response.statusText}`,
    );
    this.name = "WalrusBlobFetchError";
    this.blobId = blobId;
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = url;
  }
}

/**
 * Type guard for Walrus blob fetch errors.
 *
 * @param error - Unknown thrown value.
 * @returns Whether the value is a WalrusBlobFetchError.
 */
export function isWalrusBlobFetchError(error: unknown): error is WalrusBlobFetchError {
  return error instanceof WalrusBlobFetchError;
}

/**
 * Builds the Sui Core aggregator URL for a Walrus blob ID.
 *
 * @param blobId - Walrus blob ID.
 * @param options - Optional URL settings.
 * @returns The full blob URL.
 */
export function getWalrusBlobUrl(
  blobId: string,
  options: Pick<WalrusClientOptions, "baseUrl"> = {},
): string {
  const normalizedBlobId = normalizeBlobId(blobId);
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_WALRUS_AGGREGATOR_URL);
  return `${baseUrl}/v1/blobs/${encodeURIComponent(normalizedBlobId)}`;
}

/**
 * Fetches a Walrus blob and returns the raw HTTP response.
 *
 * @param blobId - Walrus blob ID.
 * @param options - Optional request configuration.
 * @returns The successful blob response.
 */
export async function fetchWalrusBlob(
  blobId: string,
  options: FetchWalrusBlobOptions = {},
): Promise<Response> {
  const { baseUrl, fetch: fetchImplementation, ...requestInit } = options;
  const resolvedFetch = resolveFetch(fetchImplementation);
  const normalizedBlobId = normalizeBlobId(blobId);
  const url = getWalrusBlobUrl(normalizedBlobId, { baseUrl });
  const response = await resolvedFetch(url, {
    ...requestInit,
    method: "GET",
  });

  if (!response.ok) {
    throw new WalrusBlobFetchError(normalizedBlobId, response, url);
  }

  return response;
}

/**
 * Fetches a Walrus blob and returns its bytes.
 *
 * @param blobId - Walrus blob ID.
 * @param options - Optional request configuration.
 * @returns The blob bytes.
 */
export async function fetchWalrusBlobBytes(
  blobId: string,
  options: FetchWalrusBlobOptions = {},
): Promise<ArrayBuffer> {
  const response = await fetchWalrusBlob(blobId, options);
  return response.arrayBuffer();
}

/**
 * Fetches a Walrus blob and returns its text content.
 *
 * @param blobId - Walrus blob ID.
 * @param options - Optional request configuration.
 * @returns The blob body as text.
 */
export async function fetchWalrusBlobText(
  blobId: string,
  options: FetchWalrusBlobOptions = {},
): Promise<string> {
  const response = await fetchWalrusBlob(blobId, options);
  return response.text();
}

/**
 * Fetches a Walrus blob and parses it as JSON.
 *
 * @param blobId - Walrus blob ID.
 * @param options - Optional request configuration.
 * @returns The parsed JSON payload.
 */
export async function fetchWalrusBlobJson<T>(
  blobId: string,
  options: FetchWalrusBlobOptions = {},
): Promise<T> {
  const response = await fetchWalrusBlob(blobId, options);
  return (await response.json()) as T;
}

/**
 * Fetches and parses a Walrus batch Merkle tree blob.
 *
 * @param blobId - Walrus batch blob ID.
 * @param options - Optional request configuration.
 * @returns The loaded tree plus decoded batch items.
 */
export async function fetchWalrusBatchTree(
  blobId: string,
  options: FetchWalrusBlobOptions = {},
): Promise<LoadedWalrusBatchTree> {
  const normalizedBlobId = normalizeBlobId(blobId);
  const dump = await fetchWalrusBlobJson<WalrusBatchTreeDump>(normalizedBlobId, options);
  return parseWalrusBatchTree(normalizedBlobId, dump);
}

/**
 * Parses a Walrus batch Merkle tree payload into strongly typed items.
 *
 * @param blobId - Walrus batch blob ID.
 * @param dump - Raw tree dump JSON.
 * @returns The loaded tree plus decoded batch items.
 */
export function parseWalrusBatchTree(
  blobId: string,
  dump: WalrusBatchTreeDump,
): LoadedWalrusBatchTree {
  validateWalrusBatchTreeDump(dump);

  const tree = StandardMerkleTree.load<WalrusBatchLeafTuple>(dump);
  const items = Array.from(tree.entries()).map(([index, value]) => {
    const tuple = normalizeWalrusBatchLeafTuple(value);
    return {
      index,
      tee_id: tuple[0],
      input_hash: tuple[1],
      output_hash: tuple[2],
      tee_signature: tuple[3],
      tee_timestamp: tuple[4],
      tuple,
    };
  });

  return {
    blobId,
    merkleRoot: tree.root as Hex,
    tree,
    dump,
    items,
  };
}

/**
 * Encodes a raw tee signature into bytes calldata for the onchain verifySignatureNoTimestamp call.
 *
 * @param signature - Raw signature value.
 * @param encoding - Signature encoding strategy.
 * @returns Encoded bytes calldata.
 */
export function encodeWalrusSignature(
  signature: string,
  encoding: WalrusSignatureEncoding = "auto",
): Hex {
  const normalizedSignature = normalizeRequiredString(signature, "teeSignature");

  if (encoding === "hex" || (encoding === "auto" && isHexLike(normalizedSignature))) {
    return normalizeHex(normalizedSignature);
  }

  if (encoding === "base64") {
    return base64ToHex(normalizedSignature);
  }

  return toHex(normalizedSignature);
}

/**
 * Calls verifySignatureNoTimestamp for a single Walrus batch item.
 *
 * @param args - Verification inputs for one batch item.
 * @returns Whether the onchain verifySignatureNoTimestamp call returned true.
 */
export async function verifyWalrusBatchTreeItemSignature(
  args: VerifyWalrusBatchTreeItemSignatureArgs,
): Promise<boolean> {
  return args.publicClient.readContract({
    address: resolveVerifierContractAddress(args),
    abi: verifierContractAbi,
    functionName: "verifySignatureNoTimestamp",
    args: [
      args.item.tee_id,
      args.item.input_hash,
      args.item.output_hash,
      BigInt(args.item.tee_timestamp),
      args.item.tee_signature,
    ],
  });
}

/**
 * Calls verifySignatureNoTimestamp for every item in a Walrus batch tree.
 *
 * @param args - Verification inputs for the whole Walrus batch tree.
 * @returns Per-item verification results.
 */
export async function verifyWalrusBatchTreeSignatures(
  args: VerifyWalrusBatchTreeSignaturesArgs,
): Promise<WalrusBatchTreeVerificationResult> {
  const loadedTree =
    args.tree ??
    (await fetchWalrusBatchTree(args.blobId ?? "", {
      baseUrl: args.aggregatorUrl,
      fetch: args.fetch,
    }));

  const results = await Promise.all(
    loadedTree.items.map(async item => {
      try {
        const verified = await args.publicClient.readContract({
          address: resolveVerifierContractAddress(args),
          abi: verifierContractAbi,
          functionName: "verifySignatureNoTimestamp",
          args: [
            item.tee_id,
            item.input_hash,
            item.output_hash,
            BigInt(item.tee_timestamp),
            item.tee_signature,
          ],
        });

        return {
          item,
          verified,
        } satisfies WalrusBatchTreeItemVerification;
      } catch (error) {
        return {
          item,
          verified: null,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WalrusBatchTreeItemVerification;
      }
    }),
  );

  return {
    blobId: loadedTree.blobId,
    merkleRoot: loadedTree.merkleRoot,
    results,
  };
}

/**
 * Creates a reusable Walrus client.
 *
 * @param options - Shared client options.
 * @returns Bound Walrus helper methods.
 */
export function createWalrusClient(options: WalrusClientOptions = {}) {
  return {
    getBlobUrl(blobId: string) {
      return getWalrusBlobUrl(blobId, options);
    },
    fetchBlob(blobId: string, requestInit: FetchWalrusBlobOptions = {}) {
      return fetchWalrusBlob(blobId, { ...options, ...requestInit });
    },
    fetchBlobBytes(blobId: string, requestInit: FetchWalrusBlobOptions = {}) {
      return fetchWalrusBlobBytes(blobId, { ...options, ...requestInit });
    },
    fetchBlobText(blobId: string, requestInit: FetchWalrusBlobOptions = {}) {
      return fetchWalrusBlobText(blobId, { ...options, ...requestInit });
    },
    fetchBlobJson<T>(blobId: string, requestInit: FetchWalrusBlobOptions = {}) {
      return fetchWalrusBlobJson<T>(blobId, { ...options, ...requestInit });
    },
    fetchBatchTree(blobId: string, requestInit: FetchWalrusBlobOptions = {}) {
      return fetchWalrusBatchTree(blobId, { ...options, ...requestInit });
    },
    verifyBatchTreeSignatures(args: Omit<VerifyWalrusBatchTreeSignaturesArgs, "blobId" | "fetch">) {
      return verifyWalrusBatchTreeSignatures({
        ...args,
        blobId: args.tree?.blobId,
        fetch: options.fetch,
        aggregatorUrl: args.aggregatorUrl ?? options.baseUrl,
      });
    },
  };
}

/**
 * Resolves the fetch implementation for the current runtime.
 *
 * @param fetchImplementation - Optional fetch implementation override.
 * @returns The fetch implementation to use.
 */
function resolveFetch(fetchImplementation?: typeof globalThis.fetch): typeof globalThis.fetch {
  const resolvedFetch = fetchImplementation ?? globalThis.fetch;

  if (!resolvedFetch) {
    throw new Error(
      "No fetch implementation available. Pass one in the options or use a runtime with globalThis.fetch.",
    );
  }

  return resolvedFetch;
}

/**
 * Validates and normalizes a blob ID.
 *
 * @param blobId - Candidate blob ID.
 * @returns A trimmed blob ID.
 */
function normalizeBlobId(blobId: string): string {
  const normalizedBlobId = blobId.trim();

  if (normalizedBlobId.length === 0) {
    throw new Error("Walrus blob ID is required.");
  }

  return decodeHexEncodedBlobId(normalizedBlobId);
}

/**
 * Removes trailing slashes from a base URL.
 *
 * @param baseUrl - Candidate base URL.
 * @returns The normalized base URL.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");

  if (normalizedBaseUrl.length === 0) {
    throw new Error("Walrus aggregator base URL is required.");
  }

  return normalizedBaseUrl;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalizedValue;
}

function normalizeHex(value: string): Hex {
  const normalizedValue = normalizeRequiredString(value, "hex");
  return (normalizedValue.startsWith("0x") ? normalizedValue : `0x${normalizedValue}`) as Hex;
}

function normalizeAddress(value: string, fieldName: string): Hex {
  const normalizedValue = normalizeHex(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalizedValue)) {
    throw new Error(`${fieldName} must be a valid EVM address.`);
  }
  return normalizedValue;
}

function resolveVerifierContractAddress(args: {
  verifierContractAddress?: string;
}): Hex {
  const verifierContractAddress =
    args.verifierContractAddress ?? DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS;

  return normalizeAddress(verifierContractAddress, "verifierContractAddress");
}

function normalizeBytes32(value: string, fieldName: string): Hex {
  const normalizedValue = normalizeHex(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedValue)) {
    throw new Error(`${fieldName} must be a bytes32 hex string.`);
  }
  return normalizedValue;
}

function normalizeUint256(value: unknown, fieldName: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${fieldName} must be a non-negative uint256.`);
    }
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative uint256.`);
    }
    return value.toString();
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string, number, or bigint.`);
  }

  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  if (!/^[0-9]+$/.test(normalizedValue)) {
    throw new Error(`${fieldName} must be a base-10 uint256 string.`);
  }

  return normalizedValue;
}

function validateWalrusBatchTreeDump(value: unknown): asserts value is WalrusBatchTreeDump {
  if (!isRecord(value)) {
    throw new Error("Walrus batch blob must be a JSON object.");
  }

  if (value.format !== "standard-v1") {
    throw new Error("Unsupported Walrus Merkle tree format.");
  }

  if (!Array.isArray(value.leafEncoding)) {
    throw new Error("Walrus batch tree is missing leafEncoding.");
  }

  const matchesExpectedEncoding =
    value.leafEncoding.length === WALRUS_BATCH_LEAF_ENCODING.length &&
    value.leafEncoding.every((item, index) => item === WALRUS_BATCH_LEAF_ENCODING[index]);
  if (!matchesExpectedEncoding) {
    throw new Error(
      `Unexpected Walrus batch leaf encoding. Expected ${WALRUS_BATCH_LEAF_ENCODING.join(", ")}`,
    );
  }

  if (!Array.isArray(value.tree) || !Array.isArray(value.values)) {
    throw new Error("Walrus batch tree is missing tree or values arrays.");
  }
}

function normalizeWalrusBatchLeafTuple(value: unknown): WalrusBatchLeafTuple {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error("Walrus batch tree item must be a 5-field tuple.");
  }

  return [
    normalizeBytes32(String(value[0]), "tee_id"),
    normalizeBytes32(String(value[1]), "input_hash"),
    normalizeBytes32(String(value[2]), "output_hash"),
    normalizeBytes(String(value[3]), "tee_signature"),
    normalizeUint256(value[4], "tee_timestamp"),
  ];
}

function isHexLike(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

function normalizeBytes(value: string, fieldName: string): Hex {
  const normalizedValue = normalizeHex(value);
  if (!isHexLike(normalizedValue) || (normalizedValue.length - 2) % 2 !== 0) {
    throw new Error(`${fieldName} must be valid bytes hex.`);
  }
  return normalizedValue;
}

function base64ToHex(value: string): Hex {
  const decodedValue = decodeBase64(value);
  let hex = "0x";
  for (let index = 0; index < decodedValue.length; index += 1) {
    hex += decodedValue.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex as Hex;
}

function decodeBase64(value: string): string {
  if (typeof globalThis.atob === "function") {
    return globalThis.atob(value);
  }

  throw new Error("Base64 signature decoding requires globalThis.atob in this runtime.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeHexEncodedBlobId(blobId: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(blobId)) {
    return blobId;
  }

  const hexValue = blobId.slice(2);
  if (hexValue.length === 0 || hexValue.length % 2 !== 0) {
    return blobId;
  }

  try {
    const bytes = new Uint8Array(hexValue.length / 2);
    for (let index = 0; index < hexValue.length; index += 2) {
      bytes[index / 2] = Number.parseInt(hexValue.slice(index, index + 2), 16);
    }

    const decodedBlobId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/^[\x21-\x7E]+$/.test(decodedBlobId)) {
      return blobId;
    }

    return decodedBlobId;
  } catch {
    return blobId;
  }
}

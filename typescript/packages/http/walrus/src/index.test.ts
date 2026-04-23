import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS,
  WalrusBlobFetchError,
  createWalrusClient,
  encodeWalrusSignature,
  fetchWalrusBlob,
  fetchWalrusBlobBytes,
  fetchWalrusBlobJson,
  fetchWalrusIndividualSettlement,
  fetchWalrusBlobText,
  getWalrusBlobUrl,
  isWalrusBlobFetchError,
  parseWalrusIndividualSettlement,
  verifyWalrusBatchTreeItemSignature,
  verifyWalrusIndividualSettlementSignature,
} from "./index";

describe("og-fe-tee-verification", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("builds blob URLs with the default aggregator", () => {
    expect(getWalrusBlobUrl("blob-123")).toBe(`${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/blob-123`);
  });

  it("trims and encodes blob IDs", () => {
    expect(getWalrusBlobUrl("  blob/with spaces  ")).toBe(
      `${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/blob%2Fwith%20spaces`,
    );
  });

  it("decodes hex-encoded walrus blob IDs before building URLs", () => {
    expect(
      getWalrusBlobUrl(
        "0x6f7247615875544e2d68784854566956414c716362464e3843763666786a6143334f557167315a6a765a59",
      ),
    ).toBe(`${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/orGaXuTN-hxHTViVALqcbFN8Cv6fxjaC3OUqg1ZjvZY`);
  });

  it("fetches a blob response with GET", async () => {
    const response = new Response("hello walrus", { status: 200 });
    mockFetch.mockResolvedValueOnce(response);

    const result = await fetchWalrusBlob("blob-123", { fetch: mockFetch });

    expect(result).toBe(response);
    expect(mockFetch).toHaveBeenCalledWith(
      `${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/blob-123`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches using the decoded walrus blob ID when a hex string is provided", async () => {
    const response = new Response("hello walrus", { status: 200 });
    mockFetch.mockResolvedValueOnce(response);

    await fetchWalrusBlob(
      "0x6f7247615875544e2d68784854566956414c716362464e3843763666786a6143334f557167315a6a765a59",
      { fetch: mockFetch },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      `${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/orGaXuTN-hxHTViVALqcbFN8Cv6fxjaC3OUqg1ZjvZY`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns bytes for binary content", async () => {
    const response = new Response("hello walrus", { status: 200 });
    mockFetch.mockResolvedValueOnce(response);

    const result = await fetchWalrusBlobBytes("blob-123", { fetch: mockFetch });

    expect(new TextDecoder().decode(result)).toBe("hello walrus");
  });

  it("returns text content", async () => {
    const response = new Response("hello walrus", { status: 200 });
    mockFetch.mockResolvedValueOnce(response);

    await expect(fetchWalrusBlobText("blob-123", { fetch: mockFetch })).resolves.toBe(
      "hello walrus",
    );
  });

  it("returns parsed JSON content", async () => {
    const payload = { ok: true };
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(response);

    await expect(
      fetchWalrusBlobJson<typeof payload>("blob-123", { fetch: mockFetch }),
    ).resolves.toEqual(payload);
  });

  it("fetches and parses an individual settlement blob", async () => {
    const payload = {
      input: { prompt: "hello" },
      output: {
        text: "world",
        tee_signature: "SGVsbG8=",
        tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
        tee_timestamp: "1741809483",
        tee_request_hash: "2222222222222222222222222222222222222222222222222222222222222222",
        tee_output_hash: "3333333333333333333333333333333333333333333333333333333333333333",
      },
      ethAddress: "0x4444444444444444444444444444444444444444",
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchWalrusIndividualSettlement("blob-123", { fetch: mockFetch })).resolves.toMatchObject({
      blobId: "blob-123",
      input: payload.input,
      output: payload.output,
      tee_id: payload.output.tee_id,
      tee_signature: payload.output.tee_signature,
      tee_signature_bytes: "0x48656c6c6f",
      tee_timestamp: payload.output.tee_timestamp,
      eth_address: payload.ethAddress,
      input_hash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      output_hash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
    });
  });

  it("throws a typed error on non-ok responses", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("missing", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchWalrusBlob("missing-blob", { fetch: mockFetch })).rejects.toMatchObject({
      name: "WalrusBlobFetchError",
      blobId: "missing-blob",
      status: 404,
      statusText: "Not Found",
    });
  });

  it("exposes a reusable client", async () => {
    const client = createWalrusClient({
      baseUrl: "https://example.com/",
      fetch: mockFetch,
    });
    mockFetch.mockResolvedValueOnce(new Response("hello from client", { status: 200 }));

    expect(client.getBlobUrl("blob-123")).toBe("https://example.com/v1/blobs/blob-123");
    await expect(client.fetchBlobText("blob-123")).resolves.toBe("hello from client");
  });

  it("identifies Walrus fetch errors", () => {
    const error = new WalrusBlobFetchError(
      "blob-123",
      new Response(null, { status: 500, statusText: "Server Error" }),
      `${DEFAULT_WALRUS_AGGREGATOR_URL}/v1/blobs/blob-123`,
    );

    expect(isWalrusBlobFetchError(error)).toBe(true);
    expect(isWalrusBlobFetchError(new Error("nope"))).toBe(false);
  });

  it("rejects empty blob IDs", () => {
    expect(() => getWalrusBlobUrl("   ")).toThrow("Walrus blob ID is required.");
  });

  it("encodes base64 tee signatures to hex", () => {
    expect(encodeWalrusSignature("SGVsbG8=", "base64")).toBe("0x48656c6c6f");
  });

  it("calls verifySignatureNoTimestamp with the decoded item fields", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(true),
    };
    const item = {
      index: 0,
      tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
      input_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      output_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      tee_signature: "0x1234",
      tee_timestamp: "1741809483",
      tuple: [
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333333333333333333333333333",
        "0x1234",
        "1741809483",
      ] as const,
    };

    await expect(
      verifyWalrusBatchTreeItemSignature({
        item,
        verifierContractAddress: "0x4444444444444444444444444444444444444444",
        publicClient,
      }),
    ).resolves.toBe(true);

    expect(publicClient.readContract).toHaveBeenCalledWith({
      address: "0x4444444444444444444444444444444444444444",
      abi: expect.any(Array),
      functionName: "verifySignatureNoTimestamp",
      args: [
        item.tee_id,
        item.input_hash,
        item.output_hash,
        1741809483n,
        item.tee_signature,
      ],
    });
  });

  it("uses the default verifier contract address when none is provided", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(true),
    };
    const item = {
      index: 0,
      tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
      input_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      output_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      tee_signature: "0x1234",
      tee_timestamp: "1741809483",
      tuple: [
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333333333333333333333333333",
        "0x1234",
        "1741809483",
      ] as const,
    };

    await expect(
      verifyWalrusBatchTreeItemSignature({
        item,
        publicClient,
      }),
    ).resolves.toBe(true);

    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS,
      }),
    );
  });

  it("parses individual settlement payload aliases", () => {
    expect(
      parseWalrusIndividualSettlement("blob-123", {
        input: { prompt: "hello" },
        output: {
          text: "world",
          tee_request_hash: "2222222222222222222222222222222222222222222222222222222222222222",
          tee_output_hash: "3333333333333333333333333333333333333333333333333333333333333333",
        },
        tee_signature: "SGVsbG8=",
        tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
        tee_timestamp: "1741809483",
        eth_address: "0x4444444444444444444444444444444444444444",
      }),
    ).toMatchObject({
      blobId: "blob-123",
      tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
      input_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      output_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      tee_signature: "SGVsbG8=",
      tee_signature_bytes: "0x48656c6c6f",
      tee_timestamp: "1741809483",
      eth_address: "0x4444444444444444444444444444444444444444",
    });
  });

  it("verifies individual settlements using blob-provided hashes", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(true),
    };
    const settlement = parseWalrusIndividualSettlement("blob-123", {
      input: { prompt: "hello" },
      output: {
        text: "world",
        tee_signature: "SGVsbG8=",
        tee_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
        tee_timestamp: "1741809483",
        tee_request_hash: "2222222222222222222222222222222222222222222222222222222222222222",
        tee_output_hash: "3333333333333333333333333333333333333333333333333333333333333333",
      },
      ethAddress: "0x4444444444444444444444444444444444444444",
    });

    await expect(
      verifyWalrusIndividualSettlementSignature({
        settlement,
        publicClient,
      }),
    ).resolves.toBe(true);

    expect(publicClient.readContract).toHaveBeenCalledWith({
      address: DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS,
      abi: expect.any(Array),
      functionName: "verifySignatureNoTimestamp",
      args: [
        settlement.tee_id,
        settlement.input_hash,
        settlement.output_hash,
        1741809483n,
        "0x48656c6c6f",
      ],
    });
  });

  it("requires explicit hashes for older individual blobs that do not include them", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(true),
    };
    const settlement = parseWalrusIndividualSettlement("blob-123", {
      input: { prompt: "hello" },
      output: { text: "world" },
      teeSignature: "SGVsbG8=",
      teeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      timestamp: "1741809483",
      ethAddress: "0x4444444444444444444444444444444444444444",
    });

    await expect(
      verifyWalrusIndividualSettlementSignature({
        settlement,
        publicClient,
      }),
    ).rejects.toThrow("inputHash is required for individual settlement verification.");

    await expect(
      verifyWalrusIndividualSettlementSignature({
        settlement,
        inputHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        outputHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        publicClient,
      }),
    ).resolves.toBe(true);
  });
});

# @x402/walrus

A small frontend-friendly client for fetching Walrus blobs from the Sui Core aggregator.

## Installation

```bash
pnpm install @x402/walrus
```

## Quick Start

```ts
import { fetchWalrusBlobText } from "@x402/walrus";

const blobText = await fetchWalrusBlobText("your-walrus-blob-id");
console.log(blobText);
```

## API

### `getWalrusBlobUrl(blobId, options?)`

Builds the aggregator URL for a blob ID.

### `fetchWalrusBlob(blobId, options?)`

Fetches the raw blob `Response`.

### `fetchWalrusBlobBytes(blobId, options?)`

Fetches the blob and returns an `ArrayBuffer`.

### `fetchWalrusBlobText(blobId, options?)`

Fetches the blob and returns a string.

### `fetchWalrusBlobJson<T>(blobId, options?)`

Fetches the blob and parses the body as JSON.

### `fetchWalrusBatchTree(blobId, options?)`

Fetches a batch Merkle tree blob and returns the decoded items for UI use.

### `DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS`

The default verifier contract address:
`0xa06dAFA3D713b74e4e1E74B34bd1588C9FD6C290`

### `DEFAULT_WALRUS_RPC_URL`

The default RPC URL:
`https://ogevmdevnet.opengradient.ai`

### `verifyWalrusBatchTreeItemSignature(args)`

Calls `verifySignatureNoTimestamp(teeId, inputHash, outputHash, timestamp, signature)` for a
single batch item. `args.verifierContractAddress` is optional and defaults to
`DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS`.

### `verifyWalrusBatchTreeSignatures(args)`

Runs `verifySignatureNoTimestamp(...)` for every item in a fetched Walrus batch tree.
`args.verifierContractAddress` is optional and defaults to
`DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS`.

### `createWalrusClient(options?)`

Creates a reusable client with a shared base URL and fetch implementation.

## Example

```ts
import { createWalrusClient } from "@x402/walrus";

const walrus = createWalrusClient({
  baseUrl: "https://aggregator.suicore.com",
});

const imageBytes = await walrus.fetchBlobBytes("your-walrus-blob-id");
```

## Batch Tree Notes

- The current facilitator batch tree stores raw `tee_signature` bytes in each leaf.
- That means the UI can call onchain `verifySignatureNoTimestamp(...)` directly for every item in
  the blob.
- The current batch leaf order is `tee_id, input_hash, output_hash, tee_signature, tee_timestamp`.

## Notes

- The default aggregator is `https://aggregator.suicore.com`.
- The default verifier contract is `0xa06dAFA3D713b74e4e1E74B34bd1588C9FD6C290`.
- The default RPC URL is `https://ogevmdevnet.opengradient.ai`.
- Walrus aggregators return the raw blob bytes from `GET /v1/blobs/<blob-id>`.
- Blob IDs are URL-encoded before the request is made.

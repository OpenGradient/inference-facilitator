# og-fe-tee-verification

A small frontend-friendly client for fetching Walrus blobs from the Sui Core aggregator.

## Installation

```bash
pnpm install og-fe-tee-verification
```

## Quick Start

```ts
import { fetchWalrusBlobText } from "og-fe-tee-verification";

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

### `fetchWalrusIndividualSettlement(blobId, options?)`

Fetches an individual settlement blob and returns the normalized payload, including `input`,
`output`, `tee_id`, `tee_signature`, `tee_signature_bytes`, `tee_timestamp`, `eth_address`, and
any stored `input_hash`/`output_hash` values.

### `DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS`

The default verifier contract address:
`0x626D71947f59E6574bDfAdA8eE48E4C96FF4203b`

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

### `verifyWalrusIndividualSettlementSignature(args)`

Runs `verifySignatureNoTimestamp(...)` for an individual settlement blob. If the blob does not
include `input_hash` and `output_hash`, pass them explicitly in `args`.

### `createWalrusClient(options?)`

Creates a reusable client with a shared base URL and fetch implementation.

## Example

```ts
import { createWalrusClient } from "og-fe-settlement-verify";

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

## Individual Settlement Notes

- Individual settlement blobs can derive `input_hash` from `tee_request_hash` and `output_hash`
  from `tee_output_hash` when those fields are present inside the stored `output` payload.
- The parsed individual payload also exposes `tee_signature_bytes`, which is the contract-ready
  bytes hex version of the stored TEE signature.
- If an individual settlement blob includes `inputHash` and `outputHash`, verification can run
  directly from the fetched Walrus payload.
- Older individual settlement blobs may only contain `input`, `output`, `teeSignature`, `teeId`,
  `timestamp`, and `ethAddress`. For those blobs, provide `inputHash` and `outputHash` manually
  when verifying.

## Notes

- The default aggregator is `https://aggregator.suicore.com`.
- The default verifier contract is `0x626D71947f59E6574bDfAdA8eE48E4C96FF4203b`.
- The default RPC URL is `https://ogevmdevnet.opengradient.ai`.
- Walrus aggregators return the raw blob bytes from `GET /v1/blobs/<blob-id>`.
- Blob IDs are URL-encoded before the request is made.

# OpenGradient Inference Facilitator

A fork of the x402 facilitator service customized for the OpenGradient network, with added support for LLM TEE (Trusted Execution Environment) inference settlement. This service handles payment verification and settlement for x402 payments, plus on-chain settlement of LLM inference input/output hashes for verifiable AI.

## Overview

The facilitator provides three main endpoints:

- `/verify`: Verifies x402 payment payloads
- `/settle`: Settles x402 payments and records LLM inference hashes on-chain
- `/supported`: Returns the payment kinds supported by the facilitator

### LLM TEE Settlement

In addition to standard x402 payment settlement, this service supports settling LLM inference results from TEE environments. When an LLM inference is performed in a TEE, the input and output hashes are recorded on-chain via the Settlement contract, providing cryptographic proof of the inference.

Settlement types:
- `settle`: Records input/output hash pair on-chain
- `settle-metadata`: Records hashes with additional model info
- `settle-batch`: Batches multiple settlements into a Merkle tree root (with tree data uploaded to Walrus)

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A valid Ethereum private key (for OpenGradient devnet) and/or Solana private key
- OpenGradient devnet tokens for transaction fees

## Setup

1. Install and build all packages:

```bash
pnpm install
pnpm build
```

2. Create a `.env` file with the following variables:

```env
# Required (at least one)
EVM_PRIVATE_KEY=0xYourPrivateKey
SVM_PRIVATE_KEY=base58EncodedSolanaPrivateKey

# Required for LLM TEE settlement
X402_SETTLEMENT_CONTRACT=0xYourSettlementContractAddress

# Optional
PORT=3000
SVM_RPC_URL=https://custom-solana-rpc.com

# Optional: Enable async queue processing
REDIS_HOST=localhost
REDIS_PORT=6379

# Optional: Batch settlement config
SETTLEMENT_BATCH_SIZE=20
SETTLEMENT_BATCH_TIMEOUT=60000
WALRUS_PUBLISHER_URL=http://localhost:9002/v1/blobs
```

3. Start the server:

```bash
pnpm dev
```

The server will start on http://localhost:3000

## API Endpoints

### GET /supported

Returns information the payment kinds that the facilitator supports.

Sample Response

```json5
{
  "kinds": [
    {
      "x402Version": 1,
      "scheme": "exact",
      "network": "og-devnet"
    },
    {
      "x402Version": 1,
      "scheme": "exact",
      "network": "solana-devnet",
      "extra": {
        "feePayer": "SolanaAddress"
      }
    }
  ]
}
```

### GET /verify

Returns information about the verify endpoint.

### POST /verify

Verifies an x402 payment payload.

Request body:

```typescript
{
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}
```

### GET /settle

Returns information about the settle endpoint.

### POST /settle

Settles an x402 payment by signing and broadcasting the transaction. For LLM TEE inference settlement, include additional headers.

Request body:

```typescript
{
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}
```

Optional headers for LLM TEE settlement:
- `x-input-hash`: Hash of the LLM inference input
- `x-output-hash`: Hash of the LLM inference output
- `x-settlement-type`: Settlement type (`settle`, `settle-metadata`, or `settle-batch`)

## Architecture

### Async Queue Processing

When Redis is configured, settlement requests are queued and processed asynchronously by a worker. This enables:
- Non-blocking API responses
- Batch settlement of multiple inference results into a single Merkle tree
- Automatic upload of batch data to Walrus for data availability

### Settlement Contract

The `SettlementRelay` contract (`contracts/settlement.sol`) emits events for:
- `Settlement(inputHash, outputHash)` - Single inference settlement
- `SettlementWithMetadata(inputHash, outputHash, modelInfo, inputData, outputData)` - Settlement with model metadata
- `BatchSettlement(merkleRoot, batchSize)` - Batched settlements via Merkle root

## Supported Networks

- **EVM**: `og-devnet` (OpenGradient devnet, chain ID: 10744)
- **SVM**: `solana-devnet`

## Resources

- [x402 Protocol Documentation](https://x402.org)
- [OpenGradient](https://opengradient.ai)

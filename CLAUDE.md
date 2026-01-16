# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a fork of the x402 facilitator service customized for the OpenGradient network, with added support for LLM TEE (Trusted Execution Environment) inference settlement. It handles payment verification/settlement plus on-chain recording of LLM inference input/output hashes for verifiable AI.

## Build & Development Commands

```bash
# Install dependencies and build everything
pnpm install
pnpm build

# Development server (hot reload)
pnpm dev

# Linting and formatting
pnpm lint          # Run eslint with auto-fix
pnpm lint:check    # Check without fixing
pnpm format        # Format with prettier
pnpm format:check  # Check formatting

# Testing (in x402 package)
cd typescript/packages/x402
pnpm test          # Run tests once
pnpm test:watch    # Run tests in watch mode

# Docker
make docker-build  # Build Docker image
make docker-run    # Run Docker container
```

## Architecture

### Monorepo Structure

```
/                           # Root: Facilitator Express server
├── index.ts               # Main server entry point
├── typescript/
│   └── packages/x402/     # Core x402 protocol library
```

### Core Components

**Facilitator Service** (`index.ts`):
- Express.js server with `/verify`, `/settle`, `/supported` endpoints
- Validates payment payloads using Zod schemas
- Routes requests to appropriate EVM or SVM handlers based on network
- Settles LLM inference hashes via `settlePayload()` when `x-input-hash`/`x-output-hash` headers present
- Optional Redis integration for async payment processing via worker queue

**x402 Package** (`typescript/packages/x402/`):
- `src/facilitator/` - Payment verification (`verify`), settlement (`settle`), and `settlePayload` for LLM hashes
- `src/facilitator/queue.ts` - Redis-based job queue for async settlement
- `src/facilitator/worker.ts` - Worker that processes queue, supports batch settlement with Merkle trees
- `src/schemes/exact/evm/` - EVM-specific payment implementation using viem
- `src/schemes/exact/svm/` - Solana-specific payment implementation using @solana/kit
- `src/types/` - TypeScript types and Zod validation schemas
- `src/client/` - Client-side payment header creation

**Settlement Contract** (`contracts/settlement.sol`):
- `SettlementRelay` contract for on-chain inference settlement
- Emits `Settlement`, `SettlementWithMetadata`, and `BatchSettlement` events

### Key Imports Pattern

```typescript
// From x402 package
import { verify, settle, startWorker } from "x402/facilitator";
import { PaymentRequirementsSchema, createSigner, type PaymentPayload } from "x402/types";
```

## Code Style Requirements

- **JSDoc required** on all functions, methods, and classes (enforced by eslint)
- Param descriptions must start with hyphen: `@param name - description`
- Use `@typescript-eslint/no-unused-vars` with pattern `^_$` for intentionally unused vars
- Member ordering enforced within classes

## Environment Variables

Required (at least one):
- `EVM_PRIVATE_KEY` - Ethereum private key (0x-prefixed)
- `SVM_PRIVATE_KEY` - Solana private key (base58 encoded)

Required for LLM settlement:
- `X402_SETTLEMENT_CONTRACT` - Settlement contract address on OpenGradient

Optional:
- `PORT` - Server port (default: 3000)
- `SVM_RPC_URL` - Custom Solana RPC URL
- `REDIS_HOST` / `REDIS_PORT` - Enable async payment processing
- `SETTLEMENT_BATCH_SIZE` - Batch size before flushing (default: 20)
- `SETTLEMENT_BATCH_TIMEOUT` - Batch timeout in ms (default: 60000)
- `WALRUS_PUBLISHER_URL` - Walrus publisher for batch data storage

## Supported Networks

- EVM: `og-devnet`
- SVM: `solana-devnet`

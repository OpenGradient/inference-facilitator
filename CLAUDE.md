# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an x402 Payment Protocol facilitator service that handles payment verification and settlement for blockchain-based payments. It supports both EVM (Ethereum-based) and SVM (Solana-based) networks.

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
- Optional Redis integration for async payment processing via worker queue

**x402 Package** (`typescript/packages/x402/`):
- `src/facilitator/` - Payment verification (`verify`) and settlement (`settle`) logic
- `src/schemes/exact/evm/` - EVM-specific payment implementation using viem
- `src/schemes/exact/svm/` - Solana-specific payment implementation using @solana/kit
- `src/types/` - TypeScript types and Zod validation schemas
- `src/client/` - Client-side payment header creation
- `src/paywall/` - UI components for wallet connection and payments

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

Optional:
- `PORT` - Server port (default: 3000)
- `SVM_RPC_URL` - Custom Solana RPC URL
- `REDIS_HOST` / `REDIS_PORT` - Enable async payment processing

## Supported Networks

- EVM: `og-devnet`
- SVM: `solana-devnet`

# Build stage
FROM node:20-alpine AS builder

ARG PNPM_VERSION=10.7.0
RUN npm install -g pnpm@${PNPM_VERSION} && \
    apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy all package.json files to optimize layer caching for pnpm install
COPY typescript/package.json ./typescript/
COPY typescript/packages/core/package.json ./typescript/packages/core/
COPY typescript/packages/extensions/package.json ./typescript/packages/extensions/
COPY typescript/packages/mcp/package.json ./typescript/packages/mcp/
COPY typescript/packages/mechanisms/evm/package.json ./typescript/packages/mechanisms/evm/
COPY typescript/packages/http/next/package.json ./typescript/packages/http/next/
COPY typescript/packages/http/express/package.json ./typescript/packages/http/express/
COPY typescript/packages/http/fetch/package.json ./typescript/packages/http/fetch/
COPY typescript/packages/http/hono/package.json ./typescript/packages/http/hono/
COPY typescript/packages/http/axios/package.json ./typescript/packages/http/axios/
COPY typescript/packages/http/paywall/package.json ./typescript/packages/http/paywall/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build all packages
# We assume 'pnpm build' at root builds all workspace packages
RUN pnpm --filter @x402/core build && \
    pnpm --filter @x402/evm build && \
    pnpm --filter @x402/extensions build && \
    pnpm build

# Remove development dependencies
RUN pnpm prune --prod

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built files and necessary node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Include workspace packages if needed at runtime
COPY --from=builder /app/typescript/packages ./typescript/packages

EXPOSE 3002

CMD ["node", "dist/all_networks.js"]

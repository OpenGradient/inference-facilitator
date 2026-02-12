FROM node:20-alpine AS builder

ARG PNPM_VERSION=10.7.0


RUN npm install -g pnpm@${PNPM_VERSION} && \
    apk add --no-cache python3 make g++

WORKDIR /app

ARG NODE_OPTIONS=--max-old-space-size=3048
ARG NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY typescript/package.json ./typescript/

RUN pnpm install --frozen-lockfile

COPY . .

WORKDIR /app/typescript/packages
RUN pnpm build

WORKDIR /app
RUN pnpm build

FROM node:20-alpine

ARG PNPM_VERSION=10.7.0

RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/typescript/package.json ./typescript/
COPY --from=builder /app/typescript/package.json ./typescript/

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

EXPOSE 3002

CMD ["pnpm", "start-prod"]

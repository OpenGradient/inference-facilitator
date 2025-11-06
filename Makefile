
.PHONY: all build test lint format clean docker-build docker-run

all: build

build:
	pnpm install
	pnpm build

test:
	pnpm test

lint:ß
	pnpm lint

format:
	pnpm format

clean:
	rm -rf node_modules dist

docker-build:
	docker build -t facilitator-x402 .

docker-run:
	docker run --rm -p 3002:3002 --env-file ./.env facilitator-x402



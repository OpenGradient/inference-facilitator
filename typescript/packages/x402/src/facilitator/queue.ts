import Redis from "ioredis";
import { PaymentPayload, PaymentRequirements } from "../types/verify";
import { RedisConfig } from "../types/config";
import { PaymentPayloadSchema, PaymentRequirementsSchema } from "../types/verify/x402Specs";
import { metrics } from "./metrics";


export interface BaseJob {
    id: string;
    timestamp: number;
}

export interface PaymentJob extends BaseJob {
    type: 'payment';
    payload: PaymentPayload;
    requirements: PaymentRequirements;
}

export interface SettlePayloadJob extends BaseJob {
    type: 'payload';
    network: string;
    inputHash: string;
    outputHash: string;
    modelType?: string;
    msg: string;
    settlement_type: string;
}

export type QueueJob = PaymentJob | SettlePayloadJob;


export class PaymentQueue {
    private redis: Redis;
    private key: string;

    private static instance: PaymentQueue | undefined;

    constructor(config: RedisConfig) {
        this.redis = new Redis({
            host: config.host,
            port: config.port,
            password: config.password,
            db: config.db,
            keyPrefix: config.keyPrefix,
        });
        this.key = "payment_queue";
    }

    public static getInstance(config: RedisConfig): PaymentQueue {
        if (!PaymentQueue.instance) {
            PaymentQueue.instance = new PaymentQueue(config);
        }
        return PaymentQueue.instance;
    }

    /**
     * Enqueues a payment request for settlement
     */
    async enqueue(payload: PaymentPayload, requirements: PaymentRequirements): Promise<string> {
        const id = Math.random().toString(36).substring(7);
        const job: PaymentJob = {
            id,
            type: 'payment',
            payload,
            requirements,
            timestamp: Date.now(),
        };

        // We store the full job data in the list
        await this.redis.rpush(this.key, JSON.stringify(job));

        metrics.increment("payment_requests_received", { type: "payment", network: requirements.network });

        return id;
    }

    /**
     * Enqueues a payload settlement request
     */
    async enqueuePayload(
        network: string,
        inputHash: string,
        outputHash: string,
        msg: string,
        settlement_type: string,
        model_type?: string,
    ): Promise<string> {
        const id = Math.random().toString(36).substring(7);
        const job: SettlePayloadJob = {
            id,
            type: 'payload',
            network,
            inputHash,
            outputHash,
            msg,
            settlement_type,
            modelType: model_type,
            timestamp: Date.now(),
        };

        // We store the full job data in the list
        await this.redis.rpush(this.key, JSON.stringify(job));

        metrics.increment("payment_requests_received", { type: "payload", network });

        return id;
    }

    /**
     * Process jobs from the queue
     * @param handler Function to handle the settlement logic
     */
    async process(handler: (job: QueueJob) => Promise<void>) {
        console.log("Starting queue processor...");
        while (true) {
            try {
                // Blocking pop, waits indefinitely for an item
                const result = await this.redis.blpop(this.key, 0);

                if (result && result[1]) {
                    const jobData = result[1];
                    try {
                        const jobStr = JSON.parse(jobData);
                        const job = jobStr as QueueJob;

                        await handler(job);
                    } catch (e) {
                        console.error("Error processing job:", e);
                    }
                }
            } catch (e) {
                console.error("Redis connection error:", e);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async pop(timeoutSeconds: number = 0): Promise<QueueJob | null> {
        try {
            const result = await this.redis.blpop(this.key, timeoutSeconds);
            if (result && result[1]) {
                const jobData = result[1];
                return JSON.parse(jobData) as QueueJob;
            }
        } catch (e) {
            console.error("Redis pop error:", e);
        }
        return null;
    }

    async close() {
        await this.redis.quit();
    }
}

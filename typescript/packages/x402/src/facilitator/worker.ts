import { Signer } from "../types/shared/wallet";
import { X402Config } from "../types/config";
import { PaymentQueue, QueueJob } from "./queue";
import { processSettlement, processSettlePayload } from "./facilitator";
import { generateMerkleRoot, getLeaf } from "../schemes/exact/evm/merkle";
import { Hex } from "viem";

export async function startWorker(
    getSigner: (network: string) => Promise<Signer>,
    startWorkerConfig: X402Config,
) {
    if (!startWorkerConfig.redis) {
        throw new Error("Redis configuration is required for worker");
    }

    const queue = new PaymentQueue(startWorkerConfig.redis);
    const batchBuffer: {
        network: string;
        inputHash: string;
        outputHash: string;
        msg: string;
    }[] = [];
    let lastFlushTime = Date.now();
    const BATCH_SIZE = Number(process.env.SETTLEMENT_BATCH_SIZE) || 20;
    const BATCH_TIMEOUT = Number(process.env.SETTLEMENT_BATCH_TIMEOUT) || 60000;

    console.log("Worker started, listening for jobs...");

    while (true) {
        try {
            if (batchBuffer.length > 0 && (Date.now() - lastFlushTime >= BATCH_TIMEOUT)) {
                await flushBuffer(batchBuffer, startWorkerConfig.redis, getSigner);
                batchBuffer.length = 0;
                lastFlushTime = Date.now();
            }

            const job = await queue.pop(1);

            if (job) {
                if (job.type === 'payment') {
                    const client = await getSigner(job.requirements.network);
                    console.log(`Processing payment job ${job.id} for network ${job.requirements.network}`);
                    const result = await processSettlement(
                        client,
                        job.payload,
                        job.requirements,
                        startWorkerConfig,
                    );
                    console.log(`Job ${job.id} settled: ${result.success} ${result.transaction}`);
                } else if (job.type === 'payload') {
                    // Check if this is a candidate for batching
                    if (job.settlement_type === 'settle-batch') {
                        console.log(`Buffering job ${job.id} for batching`);
                        batchBuffer.push({
                            network: job.network,
                            inputHash: job.inputHash,
                            outputHash: job.outputHash,
                            msg: job.msg
                        });

                        // check buffer
                        if (batchBuffer.length >= BATCH_SIZE) {
                            await flushBuffer(batchBuffer, startWorkerConfig.redis, getSigner);
                            batchBuffer.length = 0;
                            lastFlushTime = Date.now();
                        }
                    } else {
                        // Standard payload settlement
                        const client = await getSigner(job.network);
                        console.log(`Processing payload job ${job.id} for network ${job.network}`);
                        const result = await processSettlePayload(
                            client,
                            {
                                network: job.network,
                                inputHash: job.inputHash,
                                outputHash: job.outputHash,
                                msg: job.msg,
                                settlement_type: job.settlement_type,
                            });
                        console.log(`Job ${job.id} payload settled: ${result.success} ${result.transaction}`);
                    }
                }
            }
        } catch (e) {
            console.error("Error in worker loop:", e);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function flushBuffer(
    buffer: { network: string; inputHash: string; outputHash: string; msg: string }[],
    redisConfig: any,
    getSigner: (network: string) => Promise<Signer>
) {
    if (buffer.length === 0) return;

    console.log(`Flushing batch buffer with ${buffer.length} items`);
    const batchesByNetwork: { [network: string]: typeof buffer } = {};
    for (const item of buffer) {
        if (!batchesByNetwork[item.network]) {
            batchesByNetwork[item.network] = [];
        }
        batchesByNetwork[item.network].push(item);
    }

    for (const network of Object.keys(batchesByNetwork)) {
        const items = batchesByNetwork[network];
        try {
            const client = await getSigner(network);
            const leaves = items.map(item =>
                getLeaf(
                    item.inputHash.startsWith("0x") ? item.inputHash as Hex : `0x${item.inputHash}` as Hex,
                    item.outputHash.startsWith("0x") ? item.outputHash as Hex : `0x${item.outputHash}` as Hex
                )
            );
            const merkleRoot = generateMerkleRoot(leaves);

            console.log(`Settling buffered batch for ${network}, size: ${items.length}, root: ${merkleRoot}`);

            const result = await processSettlePayload(
                client,
                {
                    network: network,
                    inputHash: "0x",
                    outputHash: "0x",
                    msg: "",
                    settlement_type: "settle-batch",
                    root: merkleRoot,
                    size: BigInt(items.length)
                } as any
            );
            console.log(`Batch settled: ${result.success} ${result.transaction}`);
        } catch (e) {
            console.error(`Failed to settle batch for network ${network}:`, e);
        }
    }
}

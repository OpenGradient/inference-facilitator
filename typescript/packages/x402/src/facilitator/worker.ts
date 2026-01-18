import { Signer } from "../types/shared/wallet";
import { X402Config } from "../types/config";
import { PaymentQueue, QueueJob } from "./queue";
import { metrics } from "./metrics";
import { processSettlement, processSettlePayload } from "./facilitator";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

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

                    metrics.increment("settlements.processed", {
                        status: result.success ? "success" : "failure",
                        network: job.requirements.network,
                        kind: "single"
                    });

                    const tokenAmount = parseFloat(job.requirements.maxAmountRequired);
                    if (!isNaN(tokenAmount)) {
                        const assetTag = typeof job.requirements.asset === 'string' ? job.requirements.asset : (job.requirements.asset as any).address || 'unknown';
                        metrics.histogram("tokens.paid", tokenAmount, {
                            asset: assetTag,
                            network: job.requirements.network
                        });
                    }

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
                                modelType: job.modelType,
                                msg: job.msg,
                                settlement_type: job.settlement_type,
                            });

                        metrics.increment("settlements.processed", {
                            status: result.success ? "success" : "failure",
                            network: job.network,
                            kind: "single_with_metadata"
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
            const values = items.map(item => [
                item.inputHash.startsWith("0x") ? item.inputHash : `0x${item.inputHash}`,
                item.outputHash.startsWith("0x") ? item.outputHash : `0x${item.outputHash}`
            ]);
            const tree = StandardMerkleTree.of(values, ["bytes32", "bytes32"]);
            const merkleRoot = tree.root;

            console.log(`Settling buffered batch for ${network}, size: ${items.length}, root: ${merkleRoot}`);

            // walrus blob upload
            try {
                const treeData = JSON.stringify(tree.dump());
                const blobId = await uploadToWalrus(treeData);

                console.log(`Batch Data uploaded to Walrus. Blob ID: ${blobId}`);
                console.log(`Explorer: https://walruscan.com/mainnet/blob/${blobId}`);
                console.log(`Aggregator: https://aggregator.suicore.com/v1/blobs/${blobId}`);
            } catch (uploadError) {
                console.error("Failed to upload to Walrus (continuing with settlement):", uploadError);
            }

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

            metrics.increment("settlements.processed", {
                status: result.success ? "success" : "failure",
                network: network,
                kind: "batch"
            });
            metrics.gauge("batch.size", items.length, { network: network });

            if (result.success) {
                metrics.incrementBy("settlements.items_processed", items.length, {
                    network: network,
                    kind: "batch_item"
                });
            }

            console.log(`Batch settled: ${result.success} ${result.transaction}`);
        } catch (e) {
            console.error(`Failed to settle batch for network ${network}:`, e);
        }
    }
}

async function uploadToWalrus(data: string): Promise<string> {
    const PUBLISHER_URL = process.env.WALRUS_PUBLISHER_URL || "https://ogpublisher.opengradient.ai/v1/blobs";
    const url = `${PUBLISHER_URL}?epochs=10`;
    console.log(`Uploading batch to Walrus Mainnet: ${PUBLISHER_URL}`);

    const response = await fetch(url, {
        method: "PUT",
        body: data,
        headers: {
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Walrus Mainnet upload failed (${response.status}): ${errorText}`);
    }

    const result = await response.json()

    if (result.newlyCreated) {
        return result.newlyCreated.blobObject.blobId;
    } else if (result.alreadyCertified) {
        console.log("Blob already exists on Walrus (deduplicated).");
        return result.alreadyCertified.blobId;
    } else {
        throw new Error("Unexpected response format from Walrus Publisher");
    }
}
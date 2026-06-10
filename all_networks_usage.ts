import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { createBullMqConnection } from "./all_networks_shared.js";
import { incrementMetric } from "./metrics.js";
import { type InferenceUsageMetadata } from "./all_networks_types_helpers.js";

const USAGE_KEY_PREFIX = process.env.USAGE_REDIS_KEY_PREFIX || "x402:usage";
const USAGE_DEDUPE_TTL_SECONDS = Number(process.env.USAGE_DEDUPE_TTL_SECONDS || 90 * 24 * 60 * 60);
const USAGE_OPG_DECIMALS = Number(process.env.USAGE_OPG_DECIMALS || 18);
const USAGE_SUPABASE_ENABLED = process.env.USAGE_SUPABASE_ENABLED !== "false";
const USAGE_SUPABASE_URL = process.env.USAGE_SUPABASE_URL || process.env.SUPABASE_URL || "";
const USAGE_SUPABASE_SERVICE_ROLE_KEY =
  process.env.USAGE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USAGE_SUPABASE_RPC = process.env.USAGE_SUPABASE_RPC || "record_ohttp_usage";

let usageRedis: Redis | null = null;
let supabaseConfigWarningLogged = false;

function getUsageRedis(): Redis {
  if (!usageRedis) {
    usageRedis = new Redis(createBullMqConnection());
  }
  return usageRedis;
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function usageDedupeKey(usage: InferenceUsageMetadata): string {
  const source =
    usage.sessionId ||
    createHash("sha256")
      .update(
        JSON.stringify({
          requestCount: usage.requestCount,
          costOpg: usage.costOpg,
          costUsd: usage.costUsd,
          service: usage.service,
          method: usage.method,
          path: usage.path,
          model: usage.model,
          network: usage.network,
          asset: usage.asset,
        }),
      )
      .digest("hex");

  return `${USAGE_KEY_PREFIX}:session:${source}`;
}

function usageSinkDedupeKey(usage: InferenceUsageMetadata, sink: "redis" | "supabase"): string {
  return `${usageDedupeKey(usage)}:${sink}`;
}

function tagsForUsage(usage: InferenceUsageMetadata): string[] {
  return [
    usage.service ? `service:${usage.service}` : "service:unknown",
    usage.path ? `path:${usage.path}` : "path:unknown",
    usage.network ? `network:${usage.network}` : "network:unknown",
    usage.asset ? `asset:${usage.asset}` : "asset:unknown",
  ];
}

function opgAtomicToWholeUnits(costOpg: string): number {
  try {
    const atomic = BigInt(costOpg);
    const decimals = Math.max(0, Math.trunc(USAGE_OPG_DECIMALS));
    const scale = 10n ** BigInt(decimals);
    const parsed = Number(atomic / scale) + Number(atomic % scale) / Number(scale);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

async function claimUsageSink(
  redis: Redis,
  usage: InferenceUsageMetadata,
  sink: "redis" | "supabase",
): Promise<string | null> {
  const dedupeKey = usageSinkDedupeKey(usage, sink);
  const claimed = await redis.set(dedupeKey, "1", "EX", USAGE_DEDUPE_TTL_SECONDS, "NX");
  if (claimed !== "OK") {
    incrementMetric("inference_usage.duplicate.count", tagsForUsage(usage));
    return null;
  }
  return dedupeKey;
}

async function recordInferenceUsageInRedis(
  redis: Redis,
  usage: InferenceUsageMetadata,
  costOpg: number,
): Promise<boolean> {
  const dedupeKey = await claimUsageSink(redis, usage, "redis");
  if (!dedupeKey) {
    return false;
  }
  const day = utcDay();
  const dailyKey = `${USAGE_KEY_PREFIX}:daily:${day}`;
  const totalsKey = `${USAGE_KEY_PREFIX}:totals`;

  try {
    const multi = redis.multi();
    multi.hincrby(dailyKey, "request_count", usage.requestCount);
    multi.hincrbyfloat(dailyKey, "cost_opg", costOpg);
    multi.hincrbyfloat(dailyKey, "cost_usd", usage.costUsd);
    multi.hset(dailyKey, "day", day);
    multi.hincrby(totalsKey, "request_count", usage.requestCount);
    multi.hincrbyfloat(totalsKey, "cost_opg", costOpg);
    multi.hincrbyfloat(totalsKey, "cost_usd", usage.costUsd);
    await multi.exec();
  } catch (error) {
    await redis.del(dedupeKey);
    throw error;
  }

  return true;
}

function getSupabaseRpcUrl(): string | null {
  if (!USAGE_SUPABASE_ENABLED) {
    return null;
  }
  if (!USAGE_SUPABASE_URL || !USAGE_SUPABASE_SERVICE_ROLE_KEY) {
    if (!supabaseConfigWarningLogged) {
      supabaseConfigWarningLogged = true;
      console.warn(
        "[usage] Supabase usage sink disabled: set USAGE_SUPABASE_URL and USAGE_SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return null;
  }
  return `${USAGE_SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${USAGE_SUPABASE_RPC}`;
}

async function recordInferenceUsageInSupabase(
  redis: Redis,
  usage: InferenceUsageMetadata,
  costOpg: number,
): Promise<boolean> {
  const rpcUrl = getSupabaseRpcUrl();
  if (!rpcUrl) {
    return false;
  }

  const dedupeKey = await claimUsageSink(redis, usage, "supabase");
  if (!dedupeKey) {
    return false;
  }

  const body = {
    p_request_count: usage.requestCount,
    p_cost_usd: usage.costUsd,
    p_cost_opg: costOpg,
  };

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: USAGE_SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${USAGE_SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Supabase usage RPC failed (${response.status}): ${await response.text()}`);
    }
  } catch (error) {
    await redis.del(dedupeKey);
    throw error;
  }

  incrementMetric("inference_usage.supabase.recorded.count", tagsForUsage(usage));
  return true;
}

export async function recordInferenceUsage(
  usage: InferenceUsageMetadata | undefined,
): Promise<boolean> {
  if (!usage || (usage.requestCount === 0 && usage.costOpg === "0" && usage.costUsd === 0)) {
    return false;
  }

  const redis = getUsageRedis();
  const tags = tagsForUsage(usage);
  const costOpg = opgAtomicToWholeUnits(usage.costOpg);

  const [redisRecorded, supabaseRecorded] = await Promise.all([
    recordInferenceUsageInRedis(redis, usage, costOpg),
    recordInferenceUsageInSupabase(redis, usage, costOpg),
  ]);

  incrementMetric("inference_usage.request.count", tags, usage.requestCount);
  incrementMetric("inference_usage.cost_opg", tags, costOpg);
  incrementMetric("inference_usage.cost_usd", tags, usage.costUsd);

  console.log("[usage] Recorded inference session usage", {
    sessionId: usage.sessionId,
    requestCount: usage.requestCount,
    costOpg: usage.costOpg,
    costUsd: usage.costUsd,
    service: usage.service,
    path: usage.path,
    model: usage.model,
    network: usage.network,
    asset: usage.asset,
    redisRecorded,
    supabaseRecorded,
  });

  return redisRecorded || supabaseRecorded;
}

export async function getInferenceUsageStats(days = 30): Promise<{
  totalRequests: number;
  totalCostOpg: string;
  totalCostUsd: number;
  daily: Array<{ day: string; requestCount: number; costOpg: string; costUsd: number }>;
}> {
  const redis = getUsageRedis();
  const totalRaw = await redis.hgetall(`${USAGE_KEY_PREFIX}:totals`);
  const dailyKeys: Array<{ day: string; key: string }> = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    const day = utcDay(date);
    dailyKeys.push({ day, key: `${USAGE_KEY_PREFIX}:daily:${day}` });
  }

  const pipeline = redis.pipeline();
  for (const { key } of dailyKeys) {
    pipeline.hgetall(key);
  }
  const dailyResults = await pipeline.exec();
  if (!dailyResults) {
    throw new Error("Redis usage stats pipeline failed");
  }

  const daily = dailyResults.map(([error, raw], index) => {
    if (error) {
      throw error;
    }

    const day = dailyKeys[index]?.day ?? utcDay();
    const record = (raw ?? {}) as Record<string, string>;
    return {
      day,
      requestCount: Number(record.request_count || 0),
      costOpg: record.cost_opg || "0",
      costUsd: Number(record.cost_usd || 0),
    };
  });

  return {
    totalRequests: Number(totalRaw.request_count || 0),
    totalCostOpg: totalRaw.cost_opg || "0",
    totalCostUsd: Number(totalRaw.cost_usd || 0),
    daily,
  };
}

export async function closeInferenceUsageTracker(): Promise<void> {
  if (!usageRedis) {
    return;
  }
  await usageRedis.quit();
  usageRedis = null;
}

import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { getAddress, isAddress } from "viem";
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
const USAGE_SUPABASE_PER_APP_RPC =
  process.env.USAGE_SUPABASE_PER_APP_RPC || "record_ohttp_usage_per_app";
const USAGE_DEFAULT_APP_ID = process.env.USAGE_DEFAULT_APP_ID || "other";

let usageRedis: Redis | null = null;
let supabaseConfigWarningLogged = false;

function normalizeAddress(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAddress(trimmed)) {
    return null;
  }
  return getAddress(trimmed).toLowerCase();
}

function setPayerServiceMapping(
  map: Map<string, string>,
  address: string | undefined,
  appId: string,
): void {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    if (address?.trim()) {
      console.warn("[usage] Ignoring invalid payer wallet mapping", { appId });
    }
    return;
  }
  map.set(normalized, appId);
}

function loadPayerServiceMap(): Map<string, string> {
  const map = new Map<string, string>();

  setPayerServiceMapping(
    map,
    process.env.USAGE_CHAT_API_PAYER_WALLET || process.env.CHAT_API_PAYER_WALLET,
    "opengradient-chat",
  );
  setPayerServiceMapping(
    map,
    process.env.USAGE_BITQUANT_PAYER_WALLET || process.env.BITQUANT_PAYER_WALLET,
    "bitquant",
  );

  const rawMap = process.env.USAGE_PAYER_SERVICE_MAP;
  if (rawMap?.trim()) {
    try {
      const parsed = JSON.parse(rawMap) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected object mapping payer wallet to app id");
      }
      for (const [address, appId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof appId === "string" && appId.trim()) {
          setPayerServiceMapping(map, address, appId.trim());
        }
      }
    } catch (error) {
      console.warn("[usage] Ignoring invalid USAGE_PAYER_SERVICE_MAP", { error });
    }
  }

  return map;
}

const USAGE_PAYER_SERVICE_MAP = loadPayerServiceMap();

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
    usage.sessionId !== undefined
      ? `session:${usage.sessionId}`
      : `usage:${JSON.stringify({
          requestCount: usage.requestCount,
          costOpg: usage.costOpg,
          costUsd: usage.costUsd,
          service: usage.service,
          method: usage.method,
          path: usage.path,
          model: usage.model,
          network: usage.network,
          asset: usage.asset,
        })}`;
  const digest = createHash("sha256").update(source).digest("hex");

  return `${USAGE_KEY_PREFIX}:session:${digest}`;
}

type UsageSink = "redis" | "supabase" | "supabase_per_app";

function usageSinkDedupeKey(usage: InferenceUsageMetadata, sink: UsageSink): string {
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

function isZeroAtomicOpg(costOpg: string): boolean {
  try {
    return BigInt(costOpg) === 0n;
  } catch {
    return true;
  }
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
  sink: UsageSink,
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
    multi.expire(dailyKey, USAGE_DEDUPE_TTL_SECONDS);
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

function getSupabaseRpcUrl(rpcName: string): string | null {
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
  return `${USAGE_SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${rpcName}`;
}

async function recordInferenceUsageInSupabase(
  redis: Redis,
  usage: InferenceUsageMetadata,
  costOpg: number,
): Promise<boolean> {
  const rpcUrl = getSupabaseRpcUrl(USAGE_SUPABASE_RPC);
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

async function recordInferenceUsagePerAppInSupabase(
  redis: Redis,
  usage: InferenceUsageMetadata,
  costOpg: number,
): Promise<boolean> {
  const rpcUrl = getSupabaseRpcUrl(USAGE_SUPABASE_PER_APP_RPC);
  if (!rpcUrl) {
    return false;
  }

  const dedupeKey = await claimUsageSink(redis, usage, "supabase_per_app");
  if (!dedupeKey) {
    return false;
  }

  const body = {
    p_app_id: usage.service || USAGE_DEFAULT_APP_ID,
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
      throw new Error(
        `Supabase per-app usage RPC failed (${response.status}): ${await response.text()}`,
      );
    }
  } catch (error) {
    await redis.del(dedupeKey);
    throw error;
  }

  incrementMetric("inference_usage.supabase_per_app.recorded.count", tagsForUsage(usage));
  return true;
}

export async function recordInferenceUsage(
  rawUsage: InferenceUsageMetadata | undefined,
  payerAddress?: string,
): Promise<boolean> {
  const normalizedPayer = normalizeAddress(payerAddress);
  const appId = normalizedPayer
    ? (USAGE_PAYER_SERVICE_MAP.get(normalizedPayer) ?? USAGE_DEFAULT_APP_ID)
    : USAGE_DEFAULT_APP_ID;
  const usage = rawUsage
    ? {
        ...rawUsage,
        service: appId,
      }
    : rawUsage;

  if (
    !usage ||
    (usage.requestCount === 0 && isZeroAtomicOpg(usage.costOpg) && usage.costUsd === 0)
  ) {
    return false;
  }

  const redis = getUsageRedis();
  const tags = tagsForUsage(usage);
  const costOpg = opgAtomicToWholeUnits(usage.costOpg);

  const [redisResult, supabaseResult, perAppResult] = await Promise.allSettled([
    recordInferenceUsageInRedis(redis, usage, costOpg),
    recordInferenceUsageInSupabase(redis, usage, costOpg),
    recordInferenceUsagePerAppInSupabase(redis, usage, costOpg),
  ]);
  if (redisResult.status === "rejected") {
    console.error("[usage] Redis usage sink failed", { error: redisResult.reason });
    incrementMetric("inference_usage.redis.error.count", tags);
  }
  if (supabaseResult.status === "rejected") {
    console.error("[usage] Supabase usage sink failed", { error: supabaseResult.reason });
    incrementMetric("inference_usage.supabase.error.count", tags);
  }
  if (perAppResult.status === "rejected") {
    console.error("[usage] Supabase per-app usage sink failed", { error: perAppResult.reason });
    incrementMetric("inference_usage.supabase_per_app.error.count", tags);
  }
  const redisRecorded = redisResult.status === "fulfilled" && redisResult.value;
  const supabaseRecorded = supabaseResult.status === "fulfilled" && supabaseResult.value;
  const supabasePerAppRecorded = perAppResult.status === "fulfilled" && perAppResult.value;
  const recorded = redisRecorded || supabaseRecorded || supabasePerAppRecorded;

  if (!recorded) {
    return false;
  }

  incrementMetric("inference_usage.request.count", tags, usage.requestCount);
  incrementMetric("inference_usage.cost_opg", tags, costOpg);
  incrementMetric("inference_usage.cost_usd", tags, usage.costUsd);

  console.log("[usage] Recorded inference session usage", {
    hasSessionId: Boolean(usage.sessionId),
    sessionId: usage.sessionId,
    requestCount: usage.requestCount,
    costOpg: usage.costOpg,
    costUsd: usage.costUsd,
    payerAddress: normalizedPayer,
    appId,
    service: usage.service,
    path: usage.path,
    model: usage.model,
    network: usage.network,
    asset: usage.asset,
    redisRecorded,
    supabaseRecorded,
    supabasePerAppRecorded,
  });

  return true;
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

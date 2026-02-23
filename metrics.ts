import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DOGSTATSD_HOST = process.env.DD_AGENT_HOST || "127.0.0.1";
const DOGSTATSD_PORT = Number(process.env.DD_DOGSTATSD_PORT || 8125);
const METRIC_PREFIX = process.env.DD_METRICS_PREFIX || "x402-facilitator";
const METRICS_ENABLED = process.env.DD_METRICS_ENABLED !== "false";

const baseTags = [
  process.env.DD_SERVICE ? `service:${process.env.DD_SERVICE}` : null,
  process.env.DD_ENV ? `env:${process.env.DD_ENV}` : null,
  process.env.DD_VERSION ? `version:${process.env.DD_VERSION}` : null,
].filter((tag): tag is string => Boolean(tag));

type StatsDLike = {
  increment: (name: string, value?: number, sampleRate?: number, tags?: string[]) => void;
  gauge: (name: string, value: number, sampleRate?: number, tags?: string[]) => void;
  histogram: (name: string, value: number, sampleRate?: number, tags?: string[]) => void;
};

let client: StatsDLike | null = null;
let initErrorLogged = false;
let sendErrorLogged = false;

function formatMetricName(name: string): string {
  return `${METRIC_PREFIX}.${name}`;
}

function getClient(): StatsDLike | null {
  if (!METRICS_ENABLED) {
    return null;
  }

  if (client) {
    return client;
  }

  try {
    const hotShotsModule = require("hot-shots") as
      | (new (options?: Record<string, unknown>) => StatsDLike)
      | { default?: new (options?: Record<string, unknown>) => StatsDLike; StatsD?: new (options?: Record<string, unknown>) => StatsDLike };

    const StatsDClass =
      (typeof hotShotsModule === "function" ? hotShotsModule : hotShotsModule.StatsD || hotShotsModule.default);

    if (!StatsDClass) {
      throw new Error("hot-shots export not found");
    }

    client = new StatsDClass({
      host: DOGSTATSD_HOST,
      port: DOGSTATSD_PORT,
      globalTags: baseTags,
      errorHandler: (error: Error) => {
        if (!sendErrorLogged) {
          sendErrorLogged = true;
          console.error("[metrics] hot-shots send error:", error.message);
        }
      },
    });

    return client;
  } catch (error) {
    if (!initErrorLogged) {
      initErrorLogged = true;
      console.error("[metrics] Failed to initialize hot-shots client (metrics disabled):", error);
    }
    return null;
  }
}

function mergedTags(tags?: string[]): string[] | undefined {
  if (!tags || tags.length === 0) {
    return undefined;
  }
  return tags;
}

export function incrementMetric(name: string, tags?: string[], value = 1): void {
  if (!Number.isFinite(value)) {
    return;
  }

  const statsd = getClient();
  if (!statsd) {
    return;
  }

  statsd.increment(formatMetricName(name), value, 1, mergedTags(tags));
}

export function gaugeMetric(name: string, value: number, tags?: string[]): void {
  if (!Number.isFinite(value)) {
    return;
  }

  const statsd = getClient();
  if (!statsd) {
    return;
  }

  statsd.gauge(formatMetricName(name), value, 1, mergedTags(tags));
}

export function histogramMetric(name: string, value: number, tags?: string[]): void {
  if (!Number.isFinite(value)) {
    return;
  }

  const statsd = getClient();
  if (!statsd) {
    return;
  }

  statsd.histogram(formatMetricName(name), value, 1, mergedTags(tags));
}

export function timeAsync<T>(name: string, tags: string[], operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  return operation()
    .then(result => {
      histogramMetric(name, Date.now() - startedAt, [...tags, "outcome:success"]);
      return result;
    })
    .catch(error => {
      histogramMetric(name, Date.now() - startedAt, [...tags, "outcome:failure"]);
      throw error;
    });
}

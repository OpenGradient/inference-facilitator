import { StatsD } from "hot-shots";

class Metrics {
    private client: StatsD;

    private static instance: Metrics;

    private constructor() {
        this.client = new StatsD({
            host: process.env.DD_AGENT_HOST || "localhost",
            port: Number(process.env.DD_DOGSTATSD_PORT) || 8125,
            prefix: "x402.facilitator.",
            globalTags: {
                env: process.env.NODE_ENV || "development",
            },
            errorHandler: (error) => {
                console.error("Datadog stats error:", error);
            },
        });
    }

    public static getInstance(): Metrics {
        if (!Metrics.instance) {
            Metrics.instance = new Metrics();
        }
        return Metrics.instance;
    }

    public increment(name: string, tags?: Record<string, string>) {
        this.client.increment(name, 1, this.formatTags(tags));
    }

    public incrementBy(name: string, value: number, tags?: Record<string, string>) {
        this.client.increment(name, value, this.formatTags(tags));
    }

    public gauge(name: string, value: number, tags?: Record<string, string>) {
        this.client.gauge(name, value, this.formatTags(tags));
    }

    public histogram(name: string, value: number, tags?: Record<string, string>) {
        this.client.histogram(name, value, this.formatTags(tags));
    }

    private formatTags(tags?: Record<string, string>): string[] {
        if (!tags) return [];
        return Object.entries(tags).map(([key, value]) => `${key}:${value}`);
    }
}

export const metrics = Metrics.getInstance();

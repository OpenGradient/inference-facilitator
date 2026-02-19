import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:3003";
const SETTLE_DATA_URL = `${FACILITATOR_URL.replace(/\/$/, "")}/settle_data`;

function randomBytes32Hex(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

function randomAddressHex(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

function toBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function postJson(
  urlString: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(urlString);
  const isHttps = url.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callSettleData(args: {
  settlementType: "private" | "batch" | "individual";
  settlementData?: Record<string, unknown>;
}): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-settlement-type": args.settlementType,
  };

  if (args.settlementData) {
    headers["x-settlement-data"] = toBase64Json(args.settlementData);
  }

  const response = await postJson(SETTLE_DATA_URL, headers, JSON.stringify({}));
  const responseText = response.body;
  let parsed: unknown = responseText;

  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    // keep raw text fallback
  }

  console.log("--------------------------------------------------");
  console.log(`[settle_data] type=${args.settlementType} status=${response.status}`);
  console.log(parsed);
}

async function run(): Promise<void> {
  console.log(`[settle_data] Using facilitator: ${FACILITATOR_URL}`);
  console.log("[settle_data] Sending private settlement...");
  await callSettleData({
    settlementType: "private",
  });

  console.log("[settle_data] Sending 3 batch settlement entries...");
  for (let i = 1; i <= 3; i += 1) {
    await callSettleData({
      settlementType: "batch",
      settlementData: {
        inputHash: randomBytes32Hex(),
        outputHash: randomBytes32Hex(),
        teeSignature: `batch-tee-signature-${i}`,
      },
    });
  }

  console.log("[settle_data] Sending individual settlement...");
  const nowUnixSeconds = Math.floor(Date.now() / 1000).toString();
  await callSettleData({
    settlementType: "individual",
    settlementData: {
      inputHash: randomBytes32Hex(),
      outputHash: randomBytes32Hex(),
      teeSignature: "individual-tee-signature",
      input: {
        prompt: "hello world",
        requestId: `req-${Date.now()}`,
      },
      output: {
        text: "sample model output",
        score: 0.99,
      },
      teeId: randomBytes32Hex(),
      timestamp: nowUnixSeconds,
      ethAddress: randomAddressHex(),
    },
  });

  console.log("--------------------------------------------------");
  console.log("[settle_data] Done.");
  console.log(
    "[settle_data] Note: a batch flush happens when buffer is full or on idle timeout. Set DATA_SETTLEMENT_BATCH_BUFFER_SIZE=3 for immediate flush with this script.",
  );
}

await run();

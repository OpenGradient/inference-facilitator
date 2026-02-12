/**
 * All Networks Facilitator Example
 *
 * Demonstrates how to create a facilitator that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana").
 */

import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { f } from "./typescript/packages/extensions/dist/esm/index-DHE9jPAn.mjs";
import { baseSepolia } from "viem/chains";

const ogEvm = defineChain({
  id: 10740,
  name: 'OG EVM',
  nativeCurrency: {
    decimals: 18,
    name: 'OG',
    symbol: 'OG',
  },
  rpcUrls: {
    default: { http: ['https://ogevmdevnet.opengradient.ai/'] },
  },
  blockExplorers: {
    default: {
      name: 'OG EVM Explorer',
      url: 'https://explorer.og.artela.io', // TODO: update
    },
  },
  contracts: {
    multicall3: {
      address: '0x4200000000000000000000000000000000000006',
      blockCreated: 1,
    },
  },
})

dotenv.config();

// Configuration
const PORT = process.env.PORT || "4022";

// Configuration - optional per network
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

// Validate at least one private key is provided
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Network configuration
const EVM_NETWORK = "eip155:10740"; // OG EVM
const BASE_TESTNET_NETWORK = "eip155:84532"; // Base Testnet
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet

// Initialize the x402 Facilitator
const facilitator = new x402Facilitator()
  .onBeforeVerify(async context => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async context => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async context => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async context => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async context => {
    console.log("After settle", context);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure", context);
  });

// Register EVM scheme if private key is provided
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // Create a Viem client with both wallet and public capabilities
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: ogEvm,
    transport: http(),
  }).extend(publicActions);

  const baseViemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

  const evmSigner = toFacilitatorEvmSigner({
    getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      viemClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => viemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      viemClient.writeContract({
        ...args,
        args: args.args || [],
        gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
        maxFeePerGas: parseGwei('0.002'), // Example: Set specific gas price if needed
        maxPriorityFeePerGas: parseGwei('0.001'),
      }),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      viemClient.sendTransaction({
        ...args,
         gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      viemClient.waitForTransactionReceipt(args),
  });

  const baseEvmSigner = toFacilitatorEvmSigner({
    getCode: (args: { address: `0x${string}` }) => baseViemClient.getCode(args),
    address: evmAccount.address,
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) =>
      baseViemClient.readContract({
        ...args,
        args: args.args || [],
      }),
    verifyTypedData: (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => baseViemClient.verifyTypedData(args as any),
    writeContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }) =>
      baseViemClient.writeContract({
        ...args,
        args: args.args || [],
        gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
        maxFeePerGas: parseGwei('0.002'), // Example: Set specific gas price if needed
        maxPriorityFeePerGas: parseGwei('0.001'),
      }),
    sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
      baseViemClient.sendTransaction({
        ...args,
         gas: 5000000n, // Set a high gas limit (5M) to prevent OOG
      }),
    waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
      baseViemClient.waitForTransactionReceipt(args),
  });


  facilitator.register(
    EVM_NETWORK,
    new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    EVM_NETWORK,
    new UptoEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    BASE_TESTNET_NETWORK,
    new ExactEvmScheme(baseEvmSigner, { deployERC4337WithEIP6492: true }),
  );

  facilitator.register(
    BASE_TESTNET_NETWORK,
    new UptoEvmScheme(baseEvmSigner, { deployERC4337WithEIP6492: true }),
  );
}

// Register SVM scheme if private key is provided
if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
}

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 */
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Settle a payment on-chain
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(`🚀 All Networks Facilitator listening on http://localhost:${PORT}`);
  console.log(`   Supported networks: ${facilitator.getSupported().kinds.map(k => k.network).join(", ")}`);
  console.log();
});

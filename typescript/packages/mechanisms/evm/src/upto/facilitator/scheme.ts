import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactPermit2Payload } from "../../types";
import { verifyUptoPermit2, settleUptoPermit2 } from "./permit2";

export interface UptoEvmSchemeConfig {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492?: boolean;
}

/**
 * EVM facilitator implementation for the Upto payment scheme.
 * Uses Permit2 with x402UptoPermit2Proxy for variable-amount payments.
 *
 * The upto scheme allows a single signature to cover multiple requests
 * up to a spend cap. Each settlement uses the actual accumulated amount
 * rather than the full permitted amount.
 */
export class UptoEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "eip155:*";
  private readonly config: Required<UptoEvmSchemeConfig>;

  /**
   * Creates a new UptoEvmScheme instance.
   *
   * @param signer - The EVM signer for facilitator operations
   * @param config - Optional configuration for the facilitator
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    config?: UptoEvmSchemeConfig,
  ) {
    this.config = {
      deployERC4337WithEIP6492: config?.deployERC4337WithEIP6492 ?? false,
    };
  }

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For EVM upto, no extra data is needed.
   *
   * @param _ - The network identifier (unused for EVM)
   * @returns undefined (EVM has no extra data)
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Get signer addresses used by this facilitator.
   *
   * @param _ - The network identifier (unused for EVM, addresses are network-agnostic)
   * @returns Array of facilitator wallet addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies an upto payment payload.
   * All upto payloads use Permit2.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload as ExactPermit2Payload;
    return verifyUptoPermit2(this.signer, payload, requirements, rawPayload);
  }

  /**
   * Settles an upto payment by executing the transfer.
   * All upto payloads use Permit2 via x402UptoPermit2Proxy.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const rawPayload = payload.payload as ExactPermit2Payload;
    return settleUptoPermit2(this.signer, payload, requirements, rawPayload);
  }
}

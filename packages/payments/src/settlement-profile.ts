/**
 * Trusted settlement profiles. A profile is authority configuration, never
 * derived from a service response: it pins where payments may settle and
 * which challenge values are acceptable for a permit's `network`.
 *
 * IMPORTANT (Solana Payment Sandbox): the hosted Pay.sh / Surfpool sandbox
 * clones mainnet state including its genesis hash, so its x402 challenges
 * advertise the *mainnet* CAIP-2 network id and the mainnet USDC mint
 * address. The challenge alone therefore cannot cryptographically
 * distinguish the sandbox from production Solana. Virtual Haibin's sandbox
 * guarantee comes from this profile instead:
 *   - the authority settles and reconciles only through `rpcUrl`,
 *   - that RPC must identify as Surfnet (`surfnet-version`) and issue
 *     Surfnet-only blockhashes (`SURFNETxSAFEHASH...`),
 *   - every payment credential is bound to a blockhash the authority fetched
 *     from that RPC (service-supplied blockhashes are discarded), so the
 *     signed transfer cannot execute on any other chain,
 *   - the payment wallet is ephemeral and funded only via sandbox cheatcodes.
 */

export type SettlementProfileName = "solana-payment-sandbox" | "solana-devnet" | "solana-mainnet";

export type AllowedAsset = {
  mint: string;
  /** Human-readable label only; never used for authorization. */
  label: string;
};

export type SettlementProfile = {
  name: SettlementProfileName;
  /** The PurchasePermit `network` value this profile serves. */
  permitNetwork: string;
  environment: "sandbox";
  rpcUrl: string;
  /** Challenge `network` values accepted for this profile (exact string match). */
  acceptedChallengeNetworks: readonly string[];
  allowedAssets: readonly AllowedAsset[];
  protocol: "x402";
  x402Version: 2;
  scheme: "exact";
  /** Blockhashes from the pinned RPC must start with this (sandbox identity check). */
  requiredBlockhashPrefix: string;
};

export const SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL = "https://402.surfnet.dev:8899";

/** Mainnet USDC mint address, as cloned into the Surfpool sandbox (sandbox tokens have no value). */
export const SANDBOX_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** CAIP-2 id the Surfpool sandbox advertises (identical to mainnet's; see note above). */
export const SANDBOX_ADVERTISED_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export function solanaPaymentSandboxProfile(rpcUrl: string = SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL): SettlementProfile {
  const parsed = new URL(rpcUrl);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Sandbox RPC URL must be http(s).");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Sandbox RPC URL must not embed credentials.");
  }

  return Object.freeze({
    name: "solana-payment-sandbox",
    permitNetwork: "solana-payment-sandbox",
    environment: "sandbox",
    rpcUrl: parsed.toString().replace(/\/$/, ""),
    acceptedChallengeNetworks: Object.freeze([SANDBOX_ADVERTISED_NETWORK]),
    allowedAssets: Object.freeze([
      Object.freeze({
        mint: SANDBOX_USDC_MINT,
        label: "sandbox USDC (mainnet USDC mint address on the Surfpool sandbox; no real value)",
      }),
    ]),
    protocol: "x402",
    x402Version: 2,
    scheme: "exact",
    requiredBlockhashPrefix: "SURFNETxSAFEHASH",
  } satisfies SettlementProfile);
}

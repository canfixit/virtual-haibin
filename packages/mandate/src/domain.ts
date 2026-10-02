/**
 * Domain-separation constants for the Virtual Haibin PurchasePermit format.
 *
 * These are mixed into every canonical signing payload (see canonical.ts) so
 * a signature produced for this permit format/version can never be replayed
 * or reinterpreted as authorizing a different message format.
 */
export const PURCHASE_PERMIT_DOMAIN = "virtual-haibin/purchase-permit";
export const PURCHASE_PERMIT_VERSION = 1;
/**
 * v2 (Phase 4.5) adds a signed `operation` (see operation.ts): the exact
 * business operation and arguments the human approved. v1 semantics are
 * unchanged; a v1 signature never verifies as v2 (different domain prefix).
 */
export const PURCHASE_PERMIT_VERSION_2 = 2;

/**
 * Settlement environments a permit may authorize. These are Virtual Haibin
 * names, not chain identifiers: the authority maps each one to a trusted
 * settlement profile (RPC, accepted challenge networks, allowed assets).
 *
 * - "solana-payment-sandbox": the Pay.sh / Surfpool Solana Payment Sandbox
 *   (a hosted test validator; no real funds). Phase 4 settlement target.
 * - "devnet": Solana public devnet. Accepted by the schema; no authority
 *   settlement profile exists for it yet, so such permits cannot pay.
 *
 * mainnet is intentionally excluded until real-funds use is explicitly
 * approved (see CLAUDE.md security invariants).
 */
export const SUPPORTED_NETWORKS = ["solana-payment-sandbox", "devnet"] as const;

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

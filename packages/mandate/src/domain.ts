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
 * Solana clusters the permit may authorize. Restricted to devnet for the
 * hackathon MVP; mainnet-beta is intentionally excluded until real-funds use
 * is explicitly approved (see CLAUDE.md security invariants).
 */
export const SUPPORTED_NETWORKS = ["devnet"] as const;

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

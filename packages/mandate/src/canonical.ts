import canonicalize from "canonicalize";
import { PURCHASE_PERMIT_DOMAIN } from "./domain.js";
import type { UnsignedPurchasePermitV1 } from "./types.js";

/**
 * Produces the exact bytes that are signed and verified for a purchase
 * permit. Two properties matter for security here:
 *
 * 1. Deterministic output: RFC 8785 JSON Canonicalization (via the
 *    `canonicalize` package) fixes key order and number formatting so the
 *    same logical permit always canonicalizes to the same bytes, regardless
 *    of how the object was constructed.
 * 2. Domain separation: a `${domain}:v${version}\n` prefix is mixed in even
 *    though `domain`/`version` are already fields on the object, so a
 *    signature can never be reinterpreted as authorizing a different
 *    message format/version.
 *
 * The `signature` field must never be part of `permit` here -- the type
 * (UnsignedPurchasePermitV1) enforces that at compile time.
 */
export function canonicalizeUnsignedPurchasePermit(permit: UnsignedPurchasePermitV1): Uint8Array {
  const canonicalJson = canonicalize(permit);

  if (canonicalJson === undefined) {
    throw new Error("Purchase permit contains a value that cannot be canonicalized.");
  }

  const domainPrefix = `${PURCHASE_PERMIT_DOMAIN}:v${permit.version}\n`;
  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

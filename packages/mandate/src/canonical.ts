import canonicalize from "canonicalize";
import { PURCHASE_PERMIT_DOMAIN } from "./domain.js";
import type { UnsignedPurchasePermitV1, UnsignedPurchasePermitV2 } from "./types.js";

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
 *    message format/version (a v1 signature never verifies as v2).
 *
 * The `signature` field must never be part of `permit` here -- the types
 * (UnsignedPurchasePermitV1/V2) enforce that at compile time.
 */
export function canonicalizeUnsignedPurchasePermit(permit: UnsignedPurchasePermitV1 | UnsignedPurchasePermitV2): Uint8Array {
  const canonicalJson = canonicalize(permit);

  if (canonicalJson === undefined) {
    throw new Error("Purchase permit contains a value that cannot be canonicalized.");
  }

  const domainPrefix = `${PURCHASE_PERMIT_DOMAIN}:v${permit.version}\n`;
  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

/** Domain prefix + RFC 8785 canonical JSON of `value`, as UTF-8 bytes. */
export function canonicalBytes(domainPrefix: string, value: unknown): Uint8Array<ArrayBuffer> {
  const canonicalJson = canonicalize(value);

  if (canonicalJson === undefined) {
    throw new Error("Value cannot be canonicalized.");
  }

  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

import { readFileSync } from "node:fs";
import { isAddress } from "@solana/addresses";
import type { IssuerEntitlement } from "./authorize.js";

/**
 * Loads the authority's issuer trust root: the base58 Ed25519 public key of
 * the one human issuer whose PurchasePermits may spend from this authority's
 * payment wallet.
 *
 * Where the key comes from: in the Compose demo, the human-approval boundary
 * (apps/approver) generates the issuer key in its own private volume and
 * publishes only the *public* key to a trust volume that the authority mounts
 * read-only. In a real deployment an operator provisions this file. Either
 * way the trust decision is authority configuration -- it is never taken
 * from a permit, a request or the agent.
 *
 * The file must contain exactly one base58 public key (surrounding
 * whitespace allowed). Anything else fails startup closed.
 */
export function loadIssuerEntitlement(path: string, settlementProfiles: readonly string[]): IssuerEntitlement {
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Trusted issuer file ${path} could not be read (${error instanceof Error ? error.message : "unknown"}). ` +
        "The approver publishes it on first start; see docs/human-approval-and-semantic-authorization.md.",
    );
  }

  const issuer = contents.trim();

  if (issuer.length === 0 || !isAddress(issuer)) {
    throw new Error(`Trusted issuer file ${path} must contain exactly one base58 Ed25519 public key.`);
  }

  if (settlementProfiles.length === 0) {
    throw new Error("The trusted issuer must be entitled to at least one settlement profile.");
  }

  return Object.freeze({ issuer, settlementProfiles: Object.freeze([...settlementProfiles]) });
}

/**
 * Loads one pinned public key (e.g. a paid service's acknowledgement key)
 * from a read-only trust file. Same rules as the issuer trust file: exactly
 * one base58 public key, otherwise startup fails closed.
 */
export function loadPinnedPublicKey(path: string, label: string): string {
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label} trust file ${path} could not be read (${error instanceof Error ? error.message : "unknown"}).`);
  }

  const key = contents.trim();

  if (key.length === 0 || !isAddress(key)) {
    throw new Error(`${label} trust file ${path} must contain exactly one base58 Ed25519 public key.`);
  }

  return key;
}

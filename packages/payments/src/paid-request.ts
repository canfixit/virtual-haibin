import { createHash } from "node:crypto";

/**
 * The exact HTTP request sent to a paid service: method, URL, content type
 * and body bytes. The authority builds it from an operation it has already
 * verified against the human's permit (it never forwards agent-supplied
 * bytes), and the provider sends this object -- unchanged -- for both the
 * unpaid 402 probe and the paid retry.
 *
 * `sha256` identifies the request. A challenge records the digest of the
 * request that produced it, and `execute` refuses to pay unless the request
 * it is about to send has that same digest, so the operation paid for is
 * byte-for-byte the operation that was quoted.
 */
export type PaidRequest = {
  readonly url: string;
  readonly method: "POST";
  readonly contentType: "application/json";
  /** Exact body text, sent as UTF-8. */
  readonly body: string;
  /** Lowercase hex SHA-256 of the domain-separated request (see computePaidRequestDigest). */
  readonly sha256: string;
};

const PAID_REQUEST_DOMAIN = "virtual-haibin/paid-request:v1\n";

/** Recomputes the digest from the request's fields; never trusts a stored `sha256`. */
export function computePaidRequestDigest(request: Pick<PaidRequest, "url" | "method" | "contentType" | "body">): string {
  // JSON array of four strings: unambiguous and deterministic without a
  // canonicalization dependency.
  const encoded = JSON.stringify([request.method, request.url, request.contentType, request.body]);
  return createHash("sha256").update(PAID_REQUEST_DOMAIN + encoded, "utf8").digest("hex");
}

export function createPaidRequest(input: { url: string; method: "POST"; body: string }): PaidRequest {
  const fields = { url: input.url, method: input.method, contentType: "application/json" as const, body: input.body };
  return Object.freeze({ ...fields, sha256: computePaidRequestDigest(fields) });
}

/** True only if `request.sha256` matches its own fields and equals `expectedSha256`. */
export function paidRequestMatches(request: PaidRequest, expectedSha256: string): boolean {
  return computePaidRequestDigest(request) === request.sha256 && request.sha256 === expectedSha256;
}

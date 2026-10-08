import { createHash, randomBytes } from "node:crypto";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import type { SignedPurchasePermitV2 } from "@virtual-haibin/mandate";

/**
 * Demo sessions: the access-control boundary of the agent's HTTP API.
 *
 * A session is created by POST /session and returned ONCE as an unguessable
 * capability token (256 random bits). Everything a caller can do with the
 * agent -- install a permit, trigger a purchase, read its evidence, see its
 * audit trail -- is bound to that session:
 *
 * - each session has its own installed permit (no process-global permit);
 * - invocation IDs are claimed by the session that first uses them and are
 *   never handed to another session, even after the owner expires;
 * - evidence is readable only for invocations where THIS session's own
 *   signed request received a decision from the authority;
 * - creating a new session grants nothing that belongs to existing sessions.
 *
 * Tokens are held server-side only as SHA-256 digests, are never logged,
 * and are unrelated to the authority's bearer secret. State is in memory,
 * bounded and expiring: a demo-grade boundary for one agent process, not an
 * identity system.
 */

export type InstalledPermit = { permit: SignedPurchasePermitV2; digest: string };

export type Session = {
  readonly createdAt: number;
  readonly expiresAt: number;
  installed: InstalledPermit | null;
  /** IDs this session claimed (it may submit requests under them). */
  readonly invocations: Set<string>;
  /** IDs for which the authority decided THIS session's own request (evidence readable). */
  readonly decided: Set<string>;
  readonly audit: InMemoryAuditLog;
};

export type ClaimResult = "claimed" | "already-own" | "foreign" | "limit";

export type SessionStoreOptions = {
  ttlMs?: number;
  maxSessions?: number;
  maxInvocationsPerSession?: number;
  /** Bound on remembered invocation ownership (live + retired). */
  maxOwnedInvocations?: number;
  now?: () => number;
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RETIRED = "retired";

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export class SessionStore {
  readonly #sessions = new Map<string, Session>(); // key: SHA-256(token)
  readonly #keys = new WeakMap<Session, string>();
  /** invocationId -> owning session key, or RETIRED once its session ended. Insertion-ordered (FIFO bound). */
  readonly #owners = new Map<string, string>();
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #maxInvocations: number;
  readonly #maxOwned: number;
  readonly #now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.#maxSessions = options.maxSessions ?? 100;
    this.#maxInvocations = options.maxInvocationsPerSession ?? 200;
    this.#maxOwned = options.maxOwnedInvocations ?? 50_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    this.#prune();
    return this.#sessions.size;
  }

  /** Creates a session; the returned token is the only copy the server ever hands out. */
  create(): { token: string; session: Session } {
    this.#prune();

    // Bounded: evict the oldest session(s) rather than grow without limit.
    while (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#evict(oldest);
    }

    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    const session: Session = {
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      installed: null,
      invocations: new Set(),
      decided: new Set(),
      audit: new InMemoryAuditLog(),
    };
    const key = digest(token);
    this.#sessions.set(key, session);
    this.#keys.set(session, key);
    return { token, session };
  }

  /** Resolves `Authorization: Bearer <token>` to a live session, or null. */
  authenticate(authorization: string | undefined): Session | null {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return null;
    }

    const token = authorization.slice("Bearer ".length);

    if (!TOKEN_PATTERN.test(token)) {
      return null;
    }

    this.#prune();
    return this.#sessions.get(digest(token)) ?? null;
  }

  /**
   * Binds an invocation ID to `session` before anything is sent anywhere.
   * IDs owned by another session -- live or retired -- are refused.
   */
  claimInvocation(session: Session, invocationId: string): ClaimResult {
    const key = this.#keys.get(session);
    const owner = this.#owners.get(invocationId);

    if (key === undefined || (owner !== undefined && owner !== key)) {
      return "foreign";
    }

    if (owner === key) {
      return "already-own";
    }

    if (session.invocations.size >= this.#maxInvocations) {
      return "limit";
    }

    session.invocations.add(invocationId);
    this.#owners.set(invocationId, key);

    while (this.#owners.size > this.#maxOwned) {
      const oldest = this.#owners.keys().next().value;
      if (oldest === undefined) break;
      this.#owners.delete(oldest);
    }

    return "claimed";
  }

  /** Records that the authority decided this session's own request for `invocationId`. */
  markDecided(session: Session, invocationId: string): void {
    if (this.#owners.get(invocationId) === this.#keys.get(session)) {
      session.decided.add(invocationId);
    }
  }

  /** Evidence is readable only for an owned invocation the authority decided for this session. */
  canReadEvidence(session: Session, invocationId: string): boolean {
    const key = this.#keys.get(session);
    return key !== undefined && session.decided.has(invocationId) && this.#owners.get(invocationId) === key;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#evict(key);
    }
  }

  #evict(key: string): void {
    const session = this.#sessions.get(key);
    if (session === undefined) return;
    // Retire, never release: an ended session's invocations can't be claimed by anyone.
    for (const invocationId of session.invocations) {
      if (this.#owners.get(invocationId) === key) this.#owners.set(invocationId, RETIRED);
    }
    this.#sessions.delete(key);
  }
}

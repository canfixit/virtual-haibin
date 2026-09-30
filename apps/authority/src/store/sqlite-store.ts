import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { AuthorizationRequestV1 } from "@virtual-haibin/mandate";
import type { SignedAuthorizationReceiptV1 } from "../receipt.js";
import {
  InvalidStateTransitionError,
  type AuthorityStore,
  type BudgetEvaluator,
  type GrantRecord,
  type InvocationRecord,
  type InvocationState,
  type ReserveInput,
  type ReserveResult,
} from "./types.js";

/**
 * SQLite implementation of AuthorityStore using Node's built-in `node:sqlite`
 * (no native addon or extra dependency; stable in the pinned Node 24.21
 * runtime without flags or warnings).
 *
 * Concurrency model: every mutating method runs as a single
 * `BEGIN IMMEDIATE` transaction, which takes SQLite's write lock up front, so
 * the read-evaluate-write of a budget reservation is serialized against
 * every other writer -- in this process (the API is synchronous) and in any
 * other process sharing the file (they wait up to `busyTimeoutMs`).
 *
 * Amounts are stored as canonical decimal TEXT and computed with BigInt:
 * SQLite INTEGER is signed 64-bit and cannot hold the full u64 token range.
 */
export const SQLITE_SCHEMA_VERSION = 1;

export type SqliteAuthorityStoreOptions = {
  now?: () => number;
  /** How long a writer waits for another connection's lock before failing. Default 5000 ms. */
  busyTimeoutMs?: number;
};

/** SQL CHECK expression: canonical non-negative integer string of at most 20 digits (u64 range checked in code). */
function atomicCheck(column: string): string {
  return `CHECK (${column} <> '' AND ${column} NOT GLOB '*[^0-9]*' AND (${column} = '0' OR ${column} NOT GLOB '0*') AND length(${column}) <= 20)`;
}

const INVOCATION_STATES: readonly InvocationState[] = ["RESERVED", "DENIED", "CONFIRMED", "FAILED", "RECONCILIATION_REQUIRED"];

const SCHEMA_V1 = `
CREATE TABLE grants (
  issuer TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  permit_digest TEXT NOT NULL,
  max_total_atomic TEXT NOT NULL ${atomicCheck("max_total_atomic")},
  reserved_atomic TEXT NOT NULL ${atomicCheck("reserved_atomic")},
  consumed_atomic TEXT NOT NULL ${atomicCheck("consumed_atomic")},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, grant_id)
) STRICT;

CREATE TABLE invocations (
  invocation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  issuer TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  request_json TEXT NOT NULL,
  amount_atomic TEXT NOT NULL ${atomicCheck("amount_atomic")},
  state TEXT NOT NULL CHECK (state IN (${INVOCATION_STATES.map((state) => `'${state}'`).join(", ")})),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  payment_transaction_id TEXT,
  receipt_json TEXT,
  state_reason TEXT,
  decided_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (issuer, grant_id) REFERENCES grants (issuer, grant_id),
  CHECK (state <> 'CONFIRMED' OR payment_transaction_id IS NOT NULL)
) STRICT;

CREATE INDEX invocations_by_state ON invocations (state);

-- Append-only history of every invocation state change, for reconciliation
-- and later evidence export.
CREATE TABLE invocation_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES invocations (invocation_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
) STRICT;
`;

const MAX_U64 = 18446744073709551615n;

type InvocationRow = {
  invocation_id: string;
  fingerprint: string;
  issuer: string;
  grant_id: string;
  agent: string;
  request_json: string;
  amount_atomic: string;
  state: InvocationState;
  reason_codes_json: string;
  payment_transaction_id: string | null;
  receipt_json: string | null;
  state_reason: string | null;
  decided_at: number;
  created_at: number;
  updated_at: number;
};

type GrantRow = {
  issuer: string;
  grant_id: string;
  permit_digest: string;
  max_total_atomic: string;
  reserved_atomic: string;
  consumed_atomic: string;
  created_at: number;
  updated_at: number;
};

function toInvocation(row: InvocationRow): InvocationRecord {
  return {
    invocationId: row.invocation_id,
    fingerprint: row.fingerprint,
    issuer: row.issuer,
    grantId: row.grant_id,
    agent: row.agent,
    request: JSON.parse(row.request_json) as AuthorizationRequestV1,
    amountAtomic: row.amount_atomic,
    state: row.state,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[],
    paymentTransactionId: row.payment_transaction_id,
    receipt: row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as SignedAuthorizationReceiptV1),
    stateReason: row.state_reason,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGrant(row: GrantRow): GrantRecord {
  return {
    issuer: row.issuer,
    grantId: row.grant_id,
    permitDigest: row.permit_digest,
    maxTotalAtomic: row.max_total_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteAuthorityStore implements AuthorityStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #statements: Record<
    | "selectInvocation"
    | "insertInvocation"
    | "updateInvocationDecision"
    | "updateInvocationState"
    | "confirmInvocation"
    | "attachReceipt"
    | "selectGrant"
    | "insertGrant"
    | "updateGrantAmounts"
    | "insertTransition"
    | "selectReserved",
    StatementSync
  >;

  constructor(path: string, options: SqliteAuthorityStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? 5000 });

    if (path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
    }

    // FULL: a committed reservation/consumption must survive power loss, not
    // just a process crash; the write volume here is tiny.
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();

    const prepare = (sql: string) => this.#db.prepare(sql);
    this.#statements = {
      selectInvocation: prepare("SELECT * FROM invocations WHERE invocation_id = ?"),
      insertInvocation: prepare(
        `INSERT INTO invocations (invocation_id, fingerprint, issuer, grant_id, agent, request_json, amount_atomic,
           state, reason_codes_json, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateInvocationDecision: prepare(
        `UPDATE invocations SET state = ?, reason_codes_json = ?, request_json = ?, decided_at = ?, state_reason = NULL,
           updated_at = ? WHERE invocation_id = ? AND state = 'FAILED'`,
      ),
      updateInvocationState: prepare(
        "UPDATE invocations SET state = ?, state_reason = ?, updated_at = ? WHERE invocation_id = ? AND state = ?",
      ),
      confirmInvocation: prepare(
        `UPDATE invocations SET state = 'CONFIRMED', payment_transaction_id = ?, updated_at = ?
         WHERE invocation_id = ? AND state = 'RESERVED'`,
      ),
      attachReceipt: prepare(
        `UPDATE invocations SET receipt_json = ?, updated_at = ?
         WHERE invocation_id = ? AND receipt_json IS NULL AND state IN ('DENIED', 'CONFIRMED')`,
      ),
      selectGrant: prepare("SELECT * FROM grants WHERE issuer = ? AND grant_id = ?"),
      insertGrant: prepare(
        `INSERT INTO grants (issuer, grant_id, permit_digest, max_total_atomic, reserved_atomic, consumed_atomic,
           created_at, updated_at) VALUES (?, ?, ?, ?, '0', '0', ?, ?)`,
      ),
      updateGrantAmounts: prepare(
        "UPDATE grants SET reserved_atomic = ?, consumed_atomic = ?, updated_at = ? WHERE issuer = ? AND grant_id = ?",
      ),
      insertTransition: prepare(
        "INSERT INTO invocation_transitions (invocation_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)",
      ),
      selectReserved: prepare("SELECT invocation_id FROM invocations WHERE state = 'RESERVED' ORDER BY created_at"),
    };
  }

  async reserve(input: ReserveInput, evaluate: BudgetEvaluator): Promise<ReserveResult> {
    return this.#transaction(() => {
      const existing = this.#selectInvocation(input.invocationId);

      // A FAILED invocation was never submitted and released its budget, so
      // the *same* request may be attempted again. Anything else (including a
      // different request under a FAILED id) is returned for the caller to
      // treat as replay/conflict/reconciliation.
      const retryingFailed = existing !== null && existing.state === "FAILED" && existing.fingerprint === input.fingerprint;

      if (existing !== null && !retryingFailed) {
        return { kind: "existing", invocation: existing };
      }

      const now = this.#now();
      let grant = this.#selectGrant(input.grant.issuer, input.grant.grantId);

      if (grant === null) {
        this.#statements.insertGrant.run(
          input.grant.issuer,
          input.grant.grantId,
          input.grant.permitDigest,
          input.grant.maxTotalAtomic,
          now,
          now,
        );
        grant = this.#requireGrant(input.grant.issuer, input.grant.grantId);
      } else if (grant.permitDigest !== input.grant.permitDigest || grant.maxTotalAtomic !== input.grant.maxTotalAtomic) {
        return { kind: "grant_conflict", grant };
      }

      const reserved = BigInt(grant.reservedAtomic);
      const consumed = BigInt(grant.consumedAtomic);
      const decision = evaluate((reserved + consumed).toString());
      const requestJson = JSON.stringify(input.request);

      if (!decision.allowed) {
        this.#writeDecision(input, existing, "DENIED", decision.reasonCodes, requestJson, now);
        return { kind: "denied", invocation: this.#requireInvocation(input.invocationId) };
      }

      const amount = BigInt(input.amountAtomic);
      const newReserved = reserved + amount;

      // Defense in depth: never persist a reservation beyond the grant, even
      // if an evaluator were wrong.
      if (amount <= 0n || newReserved + consumed > BigInt(grant.maxTotalAtomic) || newReserved > MAX_U64) {
        throw new Error(`Refusing to reserve ${input.amountAtomic} beyond grant ${input.grant.grantId}'s total.`);
      }

      this.#statements.updateGrantAmounts.run(newReserved.toString(), grant.consumedAtomic, now, grant.issuer, grant.grantId);
      this.#writeDecision(input, existing, "RESERVED", [], requestJson, now);
      return { kind: "reserved", invocation: this.#requireInvocation(input.invocationId) };
    });
  }

  async confirm(invocationId: string, payment: { transactionId: string; settledAt: number }): Promise<InvocationRecord> {
    return this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RESERVED", "confirm");
      const grant = this.#requireGrant(invocation.issuer, invocation.grantId);
      const amount = BigInt(invocation.amountAtomic);
      const reserved = BigInt(grant.reservedAtomic);

      if (reserved < amount) {
        throw new Error(`Grant ${grant.grantId} reserved total is below invocation ${invocationId}'s reservation.`);
      }

      const now = this.#now();
      this.#statements.updateGrantAmounts.run(
        (reserved - amount).toString(),
        (BigInt(grant.consumedAtomic) + amount).toString(),
        now,
        grant.issuer,
        grant.grantId,
      );
      this.#expectOneChange(this.#statements.confirmInvocation.run(payment.transactionId, now, invocationId), invocationId, "confirm");
      this.#recordTransition(invocationId, "RESERVED", "CONFIRMED", `payment ${payment.transactionId}`, now);
      return this.#requireInvocation(invocationId);
    });
  }

  async fail(invocationId: string, reason: string): Promise<void> {
    this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RESERVED", "fail");
      const grant = this.#requireGrant(invocation.issuer, invocation.grantId);
      const amount = BigInt(invocation.amountAtomic);
      const reserved = BigInt(grant.reservedAtomic);

      if (reserved < amount) {
        throw new Error(`Grant ${grant.grantId} reserved total is below invocation ${invocationId}'s reservation.`);
      }

      const now = this.#now();
      this.#statements.updateGrantAmounts.run((reserved - amount).toString(), grant.consumedAtomic, now, grant.issuer, grant.grantId);
      this.#transitionState(invocationId, "RESERVED", "FAILED", reason, now);
    });
  }

  async markReconciliationRequired(invocationId: string, reason: string): Promise<void> {
    this.#transaction(() => {
      this.#requireState(invocationId, "RESERVED", "mark reconciliation required");
      this.#transitionState(invocationId, "RESERVED", "RECONCILIATION_REQUIRED", reason, this.#now());
    });
  }

  async attachReceipt(invocationId: string, receipt: SignedAuthorizationReceiptV1): Promise<SignedAuthorizationReceiptV1> {
    return this.#transaction(() => {
      this.#statements.attachReceipt.run(JSON.stringify(receipt), this.#now(), invocationId);
      const invocation = this.#requireInvocation(invocationId);

      if (invocation.receipt === null) {
        throw new InvalidStateTransitionError(invocationId, "CONFIRMED", "attach a receipt");
      }

      // If a receipt was already stored, that one is authoritative.
      return invocation.receipt;
    });
  }

  async getInvocation(invocationId: string): Promise<InvocationRecord | null> {
    return this.#selectInvocation(invocationId);
  }

  async getGrant(issuer: string, grantId: string): Promise<GrantRecord | null> {
    return this.#selectGrant(issuer, grantId);
  }

  async recoverInterruptedInvocations(reason: string): Promise<string[]> {
    return this.#transaction(() => {
      const ids = (this.#statements.selectReserved.all() as Array<{ invocation_id: string }>).map((row) => row.invocation_id);
      const now = this.#now();

      for (const invocationId of ids) {
        this.#transitionState(invocationId, "RESERVED", "RECONCILIATION_REQUIRED", reason, now);
      }

      return ids;
    });
  }

  async close(): Promise<void> {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  // -------------------------------------------------------------------------

  #migrate(): void {
    const { user_version: version } = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };

    if (version > SQLITE_SCHEMA_VERSION) {
      throw new Error(`Authority database schema v${version} is newer than this build supports (v${SQLITE_SCHEMA_VERSION}).`);
    }

    if (version === 0) {
      this.#transaction(() => {
        this.#db.exec(SCHEMA_V1);
        this.#db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      });
    }
  }

  /**
   * Runs `fn` in a BEGIN IMMEDIATE transaction. `fn` must be synchronous:
   * the write lock must not be held across an `await`, and awaiting inside
   * would let unrelated statements interleave into this transaction.
   */
  #transaction<T>(fn: () => T): T {
    if (this.#db.isTransaction) {
      throw new Error("Nested authority store transactions are not supported.");
    }

    this.#db.exec("BEGIN IMMEDIATE");

    try {
      const result = fn();

      if (result instanceof Promise) {
        throw new Error("Authority store transaction bodies must be synchronous.");
      }

      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK");
      }

      throw error;
    }
  }

  #writeDecision(
    input: ReserveInput,
    existing: InvocationRecord | null,
    state: "RESERVED" | "DENIED",
    reasonCodes: string[],
    requestJson: string,
    now: number,
  ): void {
    if (existing === null) {
      this.#statements.insertInvocation.run(
        input.invocationId,
        input.fingerprint,
        input.grant.issuer,
        input.grant.grantId,
        input.agent,
        requestJson,
        input.amountAtomic,
        state,
        JSON.stringify(reasonCodes),
        input.decidedAt,
        now,
        now,
      );
    } else {
      this.#expectOneChange(
        this.#statements.updateInvocationDecision.run(state, JSON.stringify(reasonCodes), requestJson, input.decidedAt, now, input.invocationId),
        input.invocationId,
        "retry",
      );
    }

    this.#recordTransition(input.invocationId, existing?.state ?? null, state, reasonCodes.join(",") || null, now);
  }

  #transitionState(invocationId: string, from: InvocationState, to: InvocationState, reason: string, now: number): void {
    this.#expectOneChange(this.#statements.updateInvocationState.run(to, reason, now, invocationId, from), invocationId, `move to ${to}`);
    this.#recordTransition(invocationId, from, to, reason, now);
  }

  #recordTransition(invocationId: string, from: InvocationState | null, to: InvocationState, reason: string | null, at: number): void {
    const params: SQLInputValue[] = [invocationId, from, to, reason, at];
    this.#statements.insertTransition.run(...params);
  }

  #expectOneChange(result: { changes: number | bigint }, invocationId: string, action: string): void {
    if (Number(result.changes) !== 1) {
      throw new Error(`Authority store could not ${action} invocation ${invocationId} (concurrent modification?).`);
    }
  }

  #selectInvocation(invocationId: string): InvocationRecord | null {
    const row = this.#statements.selectInvocation.get(invocationId) as InvocationRow | undefined;
    return row === undefined ? null : toInvocation(row);
  }

  #requireInvocation(invocationId: string): InvocationRecord {
    const invocation = this.#selectInvocation(invocationId);

    if (invocation === null) {
      throw new Error(`Invocation ${invocationId} does not exist.`);
    }

    return invocation;
  }

  #requireState(invocationId: string, expected: InvocationState, action: string): InvocationRecord {
    const invocation = this.#requireInvocation(invocationId);

    if (invocation.state !== expected) {
      throw new InvalidStateTransitionError(invocationId, expected, action);
    }

    return invocation;
  }

  #selectGrant(issuer: string, grantId: string): GrantRecord | null {
    const row = this.#statements.selectGrant.get(issuer, grantId) as GrantRow | undefined;
    return row === undefined ? null : toGrant(row);
  }

  #requireGrant(issuer: string, grantId: string): GrantRecord {
    const grant = this.#selectGrant(issuer, grantId);

    if (grant === null) {
      throw new Error(`Grant ${issuer}/${grantId} does not exist.`);
    }

    return grant;
  }
}

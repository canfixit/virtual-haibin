import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { ConfirmedSettlement, PaidResult, PaymentAttempt, PaymentRequirement } from "@virtual-haibin/payments";
import type { SignedServiceAuthorizationV1 } from "@virtual-haibin/evidence";
import type { SignedAuthorizationReceipt } from "../receipt.js";
import {
  InvalidStateTransitionError,
  type AuthorityStore,
  type BudgetEvaluator,
  type ConfirmPayment,
  type GrantRecord,
  type InvocationRecord,
  type InvocationState,
  type ReconciliationOutcome,
  type RecoveryResult,
  type ReserveInput,
  type ReserveResult,
  type StoredAuthorizationEvidence,
  type StoredAuthorizationRequest,
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
export const SQLITE_SCHEMA_VERSION = 4;

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

/**
 * v2 (Phase 4): durable payment evidence per invocation -- the validated
 * challenge requirement, the pre-transmission payment attempt (needed for
 * reconciliation), the confirmed settlement and a bounded paid result.
 */
const SCHEMA_V2 = `
ALTER TABLE invocations ADD COLUMN payment_requirement_json TEXT;
ALTER TABLE invocations ADD COLUMN payment_attempt_json TEXT;
ALTER TABLE invocations ADD COLUMN settlement_json TEXT;
ALTER TABLE invocations ADD COLUMN result_json TEXT;
`;

/**
 * v3 (Phase 5): the signed artifacts needed for portable evidence -- the
 * exact signed PurchasePermit and the agent's request signature -- stored
 * with each invocation. Rows from earlier versions keep NULL and cannot be
 * exported as evidence.
 */
const SCHEMA_V3 = `
ALTER TABLE invocations ADD COLUMN authorization_json TEXT;
`;

/**
 * v4 (Phase 5C): the authority-signed service authorization sent with the
 * paid retry, recorded together with the payment attempt (before transmission).
 */
const SCHEMA_V4 = `
ALTER TABLE invocations ADD COLUMN service_authorization_json TEXT;
`;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
];

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
  payment_requirement_json: string | null;
  payment_attempt_json: string | null;
  settlement_json: string | null;
  result_json: string | null;
  authorization_json: string | null;
  service_authorization_json: string | null;
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

function parseOrNull<T>(json: string | null): T | null {
  return json === null ? null : (JSON.parse(json) as T);
}

function toInvocation(row: InvocationRow): InvocationRecord {
  return {
    invocationId: row.invocation_id,
    fingerprint: row.fingerprint,
    issuer: row.issuer,
    grantId: row.grant_id,
    agent: row.agent,
    request: JSON.parse(row.request_json) as StoredAuthorizationRequest,
    amountAtomic: row.amount_atomic,
    state: row.state,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[],
    paymentTransactionId: row.payment_transaction_id,
    paymentRequirement: parseOrNull<PaymentRequirement>(row.payment_requirement_json),
    paymentAttempt: parseOrNull<PaymentAttempt>(row.payment_attempt_json),
    settlement: parseOrNull<ConfirmedSettlement>(row.settlement_json),
    result: parseOrNull<PaidResult>(row.result_json),
    receipt: parseOrNull<SignedAuthorizationReceipt>(row.receipt_json),
    authorization: parseOrNull<StoredAuthorizationEvidence>(row.authorization_json),
    serviceAuthorization: parseOrNull<SignedServiceAuthorizationV1>(row.service_authorization_json),
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
    | "recordAttempt"
    | "resolveConfirmed"
    | "selectByState"
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
           state, reason_codes_json, payment_requirement_json, authorization_json, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      // Retrying a FAILED invocation starts a fresh attempt: all previous
      // payment evidence is cleared (it never settled).
      updateInvocationDecision: prepare(
        `UPDATE invocations SET state = ?, reason_codes_json = ?, request_json = ?, amount_atomic = ?,
           payment_requirement_json = ?, authorization_json = ?, payment_attempt_json = NULL, service_authorization_json = NULL,
           settlement_json = NULL, result_json = NULL,
           payment_transaction_id = NULL, decided_at = ?, state_reason = NULL, updated_at = ?
         WHERE invocation_id = ? AND state = 'FAILED'`,
      ),
      updateInvocationState: prepare(
        "UPDATE invocations SET state = ?, state_reason = ?, updated_at = ? WHERE invocation_id = ? AND state = ?",
      ),
      confirmInvocation: prepare(
        `UPDATE invocations SET state = 'CONFIRMED', payment_transaction_id = ?, settlement_json = ?, result_json = ?,
           updated_at = ? WHERE invocation_id = ? AND state = 'RESERVED'`,
      ),
      recordAttempt: prepare(
        `UPDATE invocations SET payment_attempt_json = ?, service_authorization_json = ?, updated_at = ?
         WHERE invocation_id = ? AND state = 'RESERVED' AND payment_attempt_json IS NULL`,
      ),
      resolveConfirmed: prepare(
        `UPDATE invocations SET state = 'CONFIRMED', payment_transaction_id = ?, settlement_json = ?, state_reason = ?,
           updated_at = ? WHERE invocation_id = ? AND state = 'RECONCILIATION_REQUIRED'`,
      ),
      selectByState: prepare("SELECT * FROM invocations WHERE state = ? ORDER BY created_at"),
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
      selectReserved: prepare(
        "SELECT invocation_id, payment_attempt_json IS NOT NULL AS has_attempt FROM invocations WHERE state = 'RESERVED' ORDER BY created_at",
      ),
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

  async recordPaymentAttempt(invocationId: string, attempt: PaymentAttempt, serviceAuthorization?: SignedServiceAuthorizationV1): Promise<void> {
    this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RESERVED", "record a payment attempt");

      if (invocation.paymentAttempt !== null) {
        throw new InvalidStateTransitionError(invocationId, "RESERVED without a recorded attempt", "record a second payment attempt");
      }

      const now = this.#now();
      const authorizationJson = serviceAuthorization === undefined ? null : JSON.stringify(serviceAuthorization);
      this.#expectOneChange(this.#statements.recordAttempt.run(JSON.stringify(attempt), authorizationJson, now, invocationId), invocationId, "record attempt");
      this.#recordTransition(invocationId, "RESERVED", "RESERVED", `payment attempt ${attempt.payerSignature}`, now);
    });
  }

  async confirm(invocationId: string, payment: ConfirmPayment): Promise<InvocationRecord> {
    return this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RESERVED", "confirm");
      const now = this.#now();
      this.#consumeReservation(invocation, now);
      this.#expectOneChange(
        this.#statements.confirmInvocation.run(
          payment.transactionId,
          payment.settlement === undefined ? null : JSON.stringify(payment.settlement),
          payment.result === undefined || payment.result === null ? null : JSON.stringify(payment.result),
          now,
          invocationId,
        ),
        invocationId,
        "confirm",
      );
      this.#recordTransition(invocationId, "RESERVED", "CONFIRMED", `payment ${payment.transactionId}`, now);
      return this.#requireInvocation(invocationId);
    });
  }

  async resolveReconciliation(invocationId: string, outcome: ReconciliationOutcome): Promise<InvocationRecord> {
    return this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RECONCILIATION_REQUIRED", "resolve reconciliation");
      const now = this.#now();

      if (outcome.kind === "confirmed") {
        this.#consumeReservation(invocation, now);
        const reason = `reconciled: settled in ${outcome.settlement.transactionId}`;
        this.#expectOneChange(
          this.#statements.resolveConfirmed.run(outcome.settlement.transactionId, JSON.stringify(outcome.settlement), reason, now, invocationId),
          invocationId,
          "resolve as confirmed",
        );
        this.#recordTransition(invocationId, "RECONCILIATION_REQUIRED", "CONFIRMED", reason, now);
      } else {
        this.#releaseReservation(invocation, now);
        this.#transitionState(invocationId, "RECONCILIATION_REQUIRED", "FAILED", `reconciled: ${outcome.reason}`, now);
      }

      return this.#requireInvocation(invocationId);
    });
  }

  async listReconciliationRequired(): Promise<InvocationRecord[]> {
    return (this.#statements.selectByState.all("RECONCILIATION_REQUIRED") as InvocationRow[]).map(toInvocation);
  }

  async fail(invocationId: string, reason: string): Promise<void> {
    this.#transaction(() => {
      const invocation = this.#requireState(invocationId, "RESERVED", "fail");
      const now = this.#now();
      this.#releaseReservation(invocation, now);
      this.#transitionState(invocationId, "RESERVED", "FAILED", reason, now);
    });
  }

  async markReconciliationRequired(invocationId: string, reason: string): Promise<void> {
    this.#transaction(() => {
      this.#requireState(invocationId, "RESERVED", "mark reconciliation required");
      this.#transitionState(invocationId, "RESERVED", "RECONCILIATION_REQUIRED", reason, this.#now());
    });
  }

  async attachReceipt(invocationId: string, receipt: SignedAuthorizationReceipt): Promise<SignedAuthorizationReceipt> {
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

  async recoverInterruptedInvocations(reason: string): Promise<RecoveryResult> {
    return this.#transaction(() => {
      const rows = this.#statements.selectReserved.all() as Array<{ invocation_id: string; has_attempt: number }>;
      const now = this.#now();
      const result: RecoveryResult = { reconciliationRequired: [], releasedNeverSubmitted: [] };

      for (const row of rows) {
        if (row.has_attempt) {
          this.#transitionState(row.invocation_id, "RESERVED", "RECONCILIATION_REQUIRED", reason, now);
          result.reconciliationRequired.push(row.invocation_id);
        } else {
          this.#releaseReservation(this.#requireInvocation(row.invocation_id), now);
          this.#transitionState(row.invocation_id, "RESERVED", "FAILED", `${reason}; no payment attempt recorded, credential never transmitted`, now);
          result.releasedNeverSubmitted.push(row.invocation_id);
        }
      }

      return result;
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

    const pending = MIGRATIONS.filter((migration) => migration.version > version);

    if (pending.length === 0) {
      return;
    }

    // All pending migrations apply atomically; a failure leaves the database
    // exactly as it was (never partially migrated or reset).
    this.#transaction(() => {
      for (const migration of pending) {
        this.#db.exec(migration.sql);
      }

      this.#db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    });
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
    const authorizationJson = input.authorization === undefined ? null : JSON.stringify(input.authorization);

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
        input.paymentRequirement === null ? null : JSON.stringify(input.paymentRequirement),
        authorizationJson,
        input.decidedAt,
        now,
        now,
      );
    } else {
      this.#expectOneChange(
        this.#statements.updateInvocationDecision.run(
          state,
          JSON.stringify(reasonCodes),
          requestJson,
          input.amountAtomic,
          input.paymentRequirement === null ? null : JSON.stringify(input.paymentRequirement),
          authorizationJson,
          input.decidedAt,
          now,
          input.invocationId,
        ),
        input.invocationId,
        "retry",
      );
    }

    this.#recordTransition(input.invocationId, existing?.state ?? null, state, reasonCodes.join(",") || null, now);
  }

  /** reserved -= amount; consumed += amount (exactly once, inside the caller's transaction). */
  #consumeReservation(invocation: InvocationRecord, now: number): void {
    const grant = this.#requireGrant(invocation.issuer, invocation.grantId);
    const amount = BigInt(invocation.amountAtomic);
    const reserved = BigInt(grant.reservedAtomic);

    if (reserved < amount) {
      throw new Error(`Grant ${grant.grantId} reserved total is below invocation ${invocation.invocationId}'s reservation.`);
    }

    this.#statements.updateGrantAmounts.run(
      (reserved - amount).toString(),
      (BigInt(grant.consumedAtomic) + amount).toString(),
      now,
      grant.issuer,
      grant.grantId,
    );
  }

  /** reserved -= amount (the payment is known not to have settled). */
  #releaseReservation(invocation: InvocationRecord, now: number): void {
    const grant = this.#requireGrant(invocation.issuer, invocation.grantId);
    const amount = BigInt(invocation.amountAtomic);
    const reserved = BigInt(grant.reservedAtomic);

    if (reserved < amount) {
      throw new Error(`Grant ${grant.grantId} reserved total is below invocation ${invocation.invocationId}'s reservation.`);
    }

    this.#statements.updateGrantAmounts.run((reserved - amount).toString(), grant.consumedAtomic, now, grant.issuer, grant.grantId);
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

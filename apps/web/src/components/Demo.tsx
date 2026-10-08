import { useState, type FormEvent } from "react";
import type { ApprovalTerms } from "../api";
import { formatToken, formatUnits, opLabel, shorten, type DemoResponse, type Permit, type TimelineStep } from "../model";
import { ErrorNote, Field } from "./Layout";

export const APPROVED = { operation: "summarize", datasetId: "dataset-a" } as const;
export const VIOLATION = { operation: "export", datasetId: "dataset-a" } as const;

// ---------------------------------------------------------------------------
// 01 Human approval (BLUE)
// ---------------------------------------------------------------------------

export function ApprovalCard(props: {
  agent: string | null;
  terms: ApprovalTerms | null;
  permit: Permit | null;
  busy: boolean;
  error: string | null;
  onApprove: (approvalCode: string) => Promise<boolean>;
}) {
  // Page memory only: never stored, never in a URL, cleared after success.
  const [code, setCode] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await props.onApprove(code.trim())) setCode("");
  };

  if (props.permit) {
    const { permit } = props;
    return (
      <article className="card card-blue" aria-live="polite">
        <p className="card-kicker kicker-blue">PurchasePermit issued</p>
        <h3 className="card-title">
          <span className="check" aria-hidden="true">
            ✓
          </span>{" "}
          Human approved <span className="mono">{opLabel(permit.operation)}</span>
        </h3>
        <dl className="fields">
          <Field label="Authorized" mono>
            {permit.operation.method} {permit.operation.resource} · {opLabel(permit.operation)}
          </Field>
          <Field label="Agent" mono>
            {shorten(permit.authorizedAgent, 6)}
          </Field>
          <Field label="Budget">
            {formatUnits(permit.maxTotalAtomic)} units total · {formatUnits(permit.maxPerCallAtomic)} per call
          </Field>
          <Field label="Trusted issuer" mono>
            {shorten(permit.issuer, 6)}
          </Field>
          <Field label="Expires">{new Date(permit.expiresAt).toLocaleTimeString()}</Field>
        </dl>
        <p className="helper">The agent received only this signed permit. It cannot create or widen one.</p>
      </article>
    );
  }

  return (
    <form className="card card-blue" onSubmit={(event) => void submit(event)}>
      <p className="card-kicker kicker-blue">Blue team · human approval</p>
      <h3 className="card-title">Allow the agent to:</h3>
      <dl className="fields">
        <Field label="Operation">
          <span className="chip chip-blue">Summarize</span>
        </Field>
        <Field label="Dataset">
          <span className="chip chip-blue mono">{APPROVED.datasetId}</span>
        </Field>
        <Field label="Budget">{props.terms ? `${formatUnits(props.terms.maxTotalAtomic)} units total · ${formatUnits(props.terms.maxPerCallAtomic)} per call` : "—"}</Field>
        <Field label="Service">{props.terms ? `Report service (${props.terms.method} ${props.terms.resource})` : "—"}</Field>
        <Field label="Agent" mono>
          {shorten(props.agent, 6)}
        </Field>
      </dl>
      <label className="code-field">
        <span>Approval code</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-describedby="approval-code-help"
        />
      </label>
      <p className="helper" id="approval-code-help">
        Human approval is isolated from the autonomous agent. Read the code with{" "}
        <code>docker compose exec approver cat /keys/approval-code</code>.
      </p>
      <ErrorNote message={props.error} />
      <button className="button button-blue" type="submit" disabled={props.busy || code.trim() === "" || props.agent === null}>
        {props.busy ? "Approving…" : "Approve permission"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 02 Agent action: approved (BLUE/PURPLE) vs violation (RED)
// ---------------------------------------------------------------------------

export function ActionCards(props: { enabled: boolean; busy: "allow" | "deny" | null; onRun: (kind: "allow" | "deny") => void }) {
  return (
    <div className="action-grid">
      <article className="card card-purple">
        <p className="card-kicker kicker-blue">Approved operation</p>
        <h3 className="card-title mono">{opLabel({ method: "POST", resource: "", ...APPROVED })}</h3>
        <p className="card-copy">Exactly what the human approved.</p>
        <button className="button button-purple" type="button" disabled={!props.enabled || props.busy !== null} onClick={() => props.onRun("allow")}>
          {props.busy === "allow" ? "Running…" : "Run approved operation"}
        </button>
      </article>
      <article className="card card-red">
        <p className="card-kicker kicker-red">Try a policy violation</p>
        <h3 className="card-title mono">{opLabel({ method: "POST", resource: "", ...VIOLATION })}</h3>
        <ul className="same-list" aria-label="What stays identical">
          <li>Same service.</li>
          <li>Same recipient.</li>
          <li>Same token.</li>
          <li>Same price.</li>
        </ul>
        <button className="button button-red" type="button" disabled={!props.enabled || props.busy !== null} onClick={() => props.onRun("deny")}>
          {props.busy === "deny" ? "Trying…" : "Try unauthorized export"}
        </button>
      </article>
      {!props.enabled && <p className="helper action-hint">Approve the permission first.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 03 Outcome
// ---------------------------------------------------------------------------

type ServiceResult = { result?: { kind?: string; totalRevenue?: number; topRegion?: string; rowCount?: number } };

export function OutcomeCard({ run, approved }: { run: { httpStatus: number; response: DemoResponse }; approved: Permit["operation"] | null }) {
  const { response } = run;
  const authorization = response.authorization;

  if (!authorization) {
    return (
      <article className="card outcome outcome-neutral" aria-live="polite">
        <p className="card-kicker">Request refused</p>
        <h3 className="card-title mono">{response.authority?.reasonCode ?? response.status ?? `HTTP ${run.httpStatus}`}</h3>
        <p className="card-copy">{response.authority?.error ?? "The authority refused the request before any decision."}</p>
      </article>
    );
  }

  const payment = authorization.payment;
  const quote = response.quote;
  const decimals = quote?.display?.decimals ?? 6;

  if (authorization.decision === "DENY") {
    return (
      <article className="card outcome outcome-blocked" aria-live="polite">
        <p className="outcome-label">Blocked</p>
        <h3 className="outcome-title mono">{opLabel(response.operation)}</h3>
        <p className="reason-code">{authorization.receipt.reasonCodes.join(" · ")}</p>
        <ul className="none-list">
          <li>No service request.</li>
          <li>{payment === null ? "No transaction signed." : "Transaction signed."}</li>
          <li>{payment?.transactionId ? `Payment ${shorten(payment.transactionId)}` : "No payment."}</li>
        </ul>
        {approved && <p className="helper">The human approved {opLabel(approved)}, not this.</p>}
      </article>
    );
  }

  const result = (authorization.result as ServiceResult | null)?.result;

  return (
    <article className="card outcome outcome-authorized" aria-live="polite">
      <p className="outcome-label">Authorized</p>
      <h3 className="outcome-title mono">{opLabel(response.operation)}</h3>
      <dl className="fields">
        <Field label="Paid">
          {formatToken(payment?.amountAtomic ?? null, decimals)} sandbox USDC ({formatUnits(payment?.amountAtomic ?? null)} units)
        </Field>
        <Field label="Transaction" mono>
          <span title={payment?.transactionId ?? ""}>{shorten(payment?.transactionId, 8)}</span>
        </Field>
        <Field label="Result">
          {result?.kind === "summary"
            ? `Summary of ${result.rowCount ?? "?"} rows · total revenue ${result.totalRevenue ?? "?"} · top region ${result.topRegion ?? "?"}`
            : "Received"}
        </Field>
      </dl>
      {authorization.replay && <p className="helper">Replay: the original result was returned without paying again.</p>}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Purchase timeline (real state only)
// ---------------------------------------------------------------------------

const STATE_ICON: Record<TimelineStep["state"], string> = { done: "✓", blocked: "✕", "not-reached": "–", pending: "…" };

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="timeline" aria-label="Checks performed for this request">
      {steps.map((step) => (
        <li key={step.id} className={`timeline-step state-${step.state}`}>
          <span className="timeline-icon" aria-hidden="true">
            {STATE_ICON[step.state]}
          </span>
          <span className="timeline-label">{step.label}</span>
          <span className="timeline-value">{step.value}</span>
          {step.detail && <span className="timeline-detail">{step.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

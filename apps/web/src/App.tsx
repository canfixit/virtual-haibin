import { useEffect, useState } from "react";

const agentApiUrl = import.meta.env.VITE_AGENT_API_URL ?? "http://localhost:4000";
const approverApiUrl = import.meta.env.VITE_APPROVER_API_URL ?? "http://localhost:4003";

type DemoScenario = "honest" | "overcharge" | "wrong-recipient" | "wrong-asset";

type DemoRequest = {
  operation: "summarize" | "export";
  datasetId: string;
  scenario: DemoScenario;
};

type PermitSummary = {
  grantId: string;
  issuer: string;
  operation: { method: string; resource: string; operation: string; datasetId: string };
  maxPerCallAtomic: string;
  maxTotalAtomic: string;
  recipient: string;
  mint: string;
  expiresAt: number;
};

type DemoResponse = {
  status?: string;
  operation?: { operation: string; datasetId: string };
  quote?: { amountAtomic: string; recipient: string; mint: string };
  authorization?: {
    decision: "ALLOW" | "DENY";
    replay: boolean;
    receipt: { reasonCodes: string[] };
    payment: { transactionId: string | null; payTo: string | null; asset: string | null; amountAtomic: string | null } | null;
  };
  authority?: { reasonCode?: string };
};

type RunState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "done"; label: string; httpStatus: number; response: DemoResponse }
  | { status: "error"; label: string; message: string };

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ httpStatus: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { httpStatus: response.status, json: (await response.json()) as unknown };
}

export function App() {
  const [agent, setAgent] = useState<string | null>(null);
  const [permit, setPermit] = useState<PermitSummary | null>(null);
  // The human's approval code; kept only in page memory, never sent to the agent.
  const [approvalCode, setApprovalCode] = useState("");
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>({ status: "idle" });

  useEffect(() => {
    void fetch(`${agentApiUrl}/identity`)
      .then((response) => response.json() as Promise<{ agent: string }>)
      .then((body) => setAgent(body.agent))
      .catch(() => setAgent(null));
  }, []);

  // Human action: the approver (outside the agent runtime) signs a permit for
  // exactly summarize(dataset-a); the agent only receives the signed permit.
  const approve = async () => {
    setApprovalError(null);

    try {
      const issued = await postJson(
        `${approverApiUrl}/approvals`,
        { agent, operation: "summarize", datasetId: "dataset-a" },
        { authorization: `Bearer ${approvalCode.trim()}` },
      );

      if (issued.httpStatus !== 201) {
        throw new Error(JSON.stringify(issued.json));
      }

      // The approval code has done its job; drop it from page state immediately.
      setApprovalCode("");
      const signedPermit = (issued.json as { permit: PermitSummary }).permit;
      const installed = await postJson(`${agentApiUrl}/permit`, { permit: signedPermit });

      if (installed.httpStatus !== 200) {
        throw new Error(JSON.stringify(installed.json));
      }

      setPermit(signedPermit);
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "Approval failed");
    }
  };

  const execute = async (label: string, request: DemoRequest) => {
    setRun({ status: "loading", label });

    try {
      const { httpStatus, json } = await postJson(`${agentApiUrl}/demo`, request);
      setRun({ status: "done", label, httpStatus, response: json as DemoResponse });
    } catch (error) {
      setRun({ status: "error", label, message: error instanceof Error ? error.message : "Unknown error" });
    }
  };

  const busy = run.status === "loading";
  const noPermit = permit === null;

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Virtual Haibin</p>
        <h1>Pay only for what the human approved.</h1>
        <p className="summary">
          Two requests can carry exactly the same payment terms (merchant, recipient, asset, price, network) and still mean
          different things. The authority pays only for the business operation the human signed.
        </p>
      </section>

      <section className="panel">
        <h2>1. Human approval</h2>
        <p>
          Agent identity: <code>{agent ?? "unavailable"}</code>
        </p>
        <label className="field">
          Approval code <span className="muted">(docker compose exec approver cat /keys/approval-code)</span>
          <input type="password" autoComplete="off" value={approvalCode} onChange={(event) => setApprovalCode(event.target.value)} />
        </label>
        <div className="actions">
          <button type="button" disabled={agent === null || approvalCode.trim() === ""} onClick={() => void approve()}>
            Approve “Summarize dataset-a”
          </button>
        </div>
        {approvalError && <p className="deny">Approval failed: {approvalError}</p>}
        {permit && (
          <dl className="facts">
            <dt>Approved operation</dt>
            <dd>
              {permit.operation.method} {permit.operation.resource} — <strong>{permit.operation.operation}</strong>(
              {permit.operation.datasetId})
            </dd>
            <dt>Issuer (human)</dt>
            <dd>
              <code>{permit.issuer}</code>
            </dd>
            <dt>Recipient / mint</dt>
            <dd>
              <code>{permit.recipient}</code> / <code>{permit.mint}</code>
            </dd>
            <dt>Limits</dt>
            <dd>
              {permit.maxPerCallAtomic} per call, {permit.maxTotalAtomic} total (base units)
            </dd>
            <dt>Expires</dt>
            <dd>{new Date(permit.expiresAt).toLocaleTimeString()}</dd>
          </dl>
        )}
      </section>

      <section className="panel">
        <h2>2. Agent requests — all quoted at the same price (10000 base units)</h2>
        <div className="actions">
          <button
            type="button"
            disabled={busy || noPermit}
            onClick={() => void execute("summarize(dataset-a) — approved", { operation: "summarize", datasetId: "dataset-a", scenario: "honest" })}
          >
            Run approved operation
          </button>
          <button
            type="button"
            disabled={busy || noPermit}
            onClick={() => void execute("export(dataset-a) — same price, not approved", { operation: "export", datasetId: "dataset-a", scenario: "honest" })}
          >
            Try unauthorized export
          </button>
          <button
            type="button"
            disabled={busy || noPermit}
            onClick={() => void execute("summarize(dataset-b) — same price, other dataset", { operation: "summarize", datasetId: "dataset-b", scenario: "honest" })}
          >
            Try summarize dataset-b
          </button>
        </div>
        <p className="muted">Misbehaving merchant (approved operation, but the real 402 differs from the quote):</p>
        <div className="actions secondary">
          {(["overcharge", "wrong-recipient", "wrong-asset"] as const).map((scenario) => (
            <button
              key={scenario}
              type="button"
              disabled={busy || noPermit}
              onClick={() => void execute(`summarize(dataset-a), merchant ${scenario}`, { operation: "summarize", datasetId: "dataset-a", scenario })}
            >
              {scenario}
            </button>
          ))}
        </div>
      </section>

      <section className="panel output" aria-live="polite">
        <h2>3. Decision and effect</h2>
        {run.status === "idle" && <p>No request has been executed yet.</p>}
        {run.status === "loading" && <p>Running {run.label}…</p>}
        {run.status === "error" && <p className="deny">{run.message}</p>}
        {run.status === "done" && <Outcome label={run.label} httpStatus={run.httpStatus} response={run.response} />}
      </section>
    </main>
  );
}

function Outcome({ label, httpStatus, response }: { label: string; httpStatus: number; response: DemoResponse }) {
  const authorization = response.authorization;
  const decision = authorization?.decision ?? "REFUSED";
  const reasons = authorization?.receipt.reasonCodes ?? (response.authority?.reasonCode ? [response.authority.reasonCode] : []);
  const transactionId = authorization?.payment?.transactionId ?? null;

  return (
    <>
      <p>{label}</p>
      <p className={decision === "ALLOW" ? "allow decision" : "deny decision"}>
        {decision}
        {authorization?.replay ? " (replay)" : ""}
      </p>
      <dl className="facts">
        <dt>Reason codes</dt>
        <dd>{reasons.length > 0 ? reasons.join(", ") : "—"}</dd>
        <dt>Quoted terms</dt>
        <dd>
          {response.quote ? (
            <>
              {response.quote.amountAtomic} to <code>{response.quote.recipient}</code>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>Payment submitted</dt>
        <dd>{transactionId ? "yes" : "no"}</dd>
        <dt>Sandbox transaction</dt>
        <dd>{transactionId ? <code>{transactionId}</code> : "none"}</dd>
        <dt>Agent status</dt>
        <dd>
          {response.status} (HTTP {httpStatus})
        </dd>
      </dl>
      <details>
        <summary>Inspect raw response</summary>
        <pre>{JSON.stringify(response, null, 2)}</pre>
      </details>
    </>
  );
}

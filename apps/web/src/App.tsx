import { useEffect, useMemo, useState } from "react";
import { ApiError, approve, getAgentIdentity, getApproverTerms, getEvidence, installPermit, runOperation, startSession, verifyEvidence, type ApprovalTerms } from "./api";
import { Comparison } from "./components/Comparison";
import { ActionCards, APPROVED, ApprovalCard, OutcomeCard, Timeline, VIOLATION } from "./components/Demo";
import { DetailsPanel, JsonBlock } from "./components/Details";
import { EvidencePanel } from "./components/Evidence";
import { Journey } from "./components/Journey";
import { ErrorNote, Header, Hero, Section } from "./components/Layout";
import { buildComparison, buildTimeline, opLabel, type DemoResponse, type Permit, type VerificationReport } from "./model";

type Run = { httpStatus: number; response: DemoResponse };
type Kind = "allow" | "deny";

const message = (error: unknown) =>
  error instanceof ApiError && error.status === 401
    ? "Your demo session has ended. A new one was started: approve the permission again."
    : error instanceof Error
      ? error.message
      : "Unexpected error";

export function App() {
  const [agent, setAgent] = useState<string | null>(null);
  const [terms, setTerms] = useState<ApprovalTerms | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [permit, setPermit] = useState<Permit | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const [runs, setRuns] = useState<Partial<Record<Kind, Run>>>({});
  const [latest, setLatest] = useState<Kind | null>(null);
  const [running, setRunning] = useState<Kind | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [bundle, setBundle] = useState<string | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [trust, setTrust] = useState<{ issuer: string; authority: string; service: string | null } | null>(null);
  const [verifying, setVerifying] = useState<"offline" | "online" | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const [extraRuns, setExtraRuns] = useState<Array<{ label: string; run: Run }>>([]);

  useEffect(() => {
    // One agent session per page load: permits and purchases are scoped to it.
    startSession().catch(() => setSetupError("The agent is not reachable on its configured URL."));
    getAgentIdentity()
      .then(setAgent)
      .catch(() => setSetupError("The agent is not reachable on its configured URL."));
    getApproverTerms()
      .then((health) => setTerms(health.terms))
      .catch(() => setSetupError("The approval service is not reachable on its configured URL."));
  }, []);

  // Human action: the approver signs; the agent receives only the signed permit.
  const onApprove = async (approvalCode: string): Promise<boolean> => {
    if (agent === null) return false;
    setApproving(true);
    setApprovalError(null);

    try {
      const issued = await approve(agent, approvalCode, APPROVED.operation, APPROVED.datasetId);
      await installPermit(issued);
      setPermit(issued);
      setRuns({});
      setLatest(null);
      setBundle(null);
      setReport(null);
      return true;
    } catch (error) {
      setApprovalError(message(error));
      await recoverExpiredSession(error);
      return false;
    } finally {
      setApproving(false);
    }
  };

  const verify = async (bundleText: string, mode: "offline" | "online") => {
    setVerifying(mode);
    setEvidenceError(null);

    try {
      const verified = await verifyEvidence(bundleText, mode);
      setReport(verified.report);
      setTrust(verified.trust);
    } catch (error) {
      setEvidenceError(message(error));
    } finally {
      setVerifying(null);
    }
  };

  const onRun = async (kind: Kind) => {
    setRunning(kind);
    setRunError(null);

    try {
      const run = await runOperation(kind === "allow" ? APPROVED : VIOLATION);
      setRuns((previous) => ({ ...previous, [kind]: run }));
      setLatest(kind);

      const { authorization, invocationId } = run.response;

      // A completed purchase: fetch its real evidence and verify it offline.
      if (kind === "allow" && authorization?.decision === "ALLOW" && authorization.payment?.transactionId && invocationId) {
        setBundle(null);
        setReport(null);

        try {
          const exported = await getEvidence(invocationId);
          setBundle(exported);
          await verify(exported, "offline");
        } catch (error) {
          setEvidenceError(message(error));
        }
      }
    } catch (error) {
      setRunError(message(error));
      await recoverExpiredSession(error);
    } finally {
      setRunning(null);
    }
  };

  // An expired/evicted session cannot be resumed: start a fresh one, which
  // owns nothing, so the human must approve again.
  const recoverExpiredSession = async (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setPermit(null);
      await startSession().catch(() => setSetupError("The agent is not reachable on its configured URL."));
    }
  };

  const onExtra = async (label: string, body: { operation: string; datasetId: string; scenario?: string }) => {
    try {
      const run = await runOperation(body);
      setExtraRuns((previous) => [{ label, run }, ...previous].slice(0, 6));
    } catch (error) {
      setRunError(message(error));
    }
  };

  const latestRun = latest ? runs[latest] : undefined;
  const timeline = useMemo(
    () => (latestRun ? buildTimeline(latestRun.response, { bundleFetched: latest === "allow" && bundle !== null, report: latest === "allow" ? report : null }) : null),
    [latestRun, latest, bundle, report],
  );
  const comparison = useMemo(() => buildComparison(permit, runs.allow?.response ?? null, runs.deny?.response ?? null), [permit, runs]);
  const journeyOutcome = !latestRun?.response.authorization ? "none" : latestRun.response.authorization.decision === "ALLOW" ? "allowed" : "blocked";

  return (
    <>
      <Header />
      <Hero />
      <main>
        <Section id="demo" step="01" title="Human approval" tone="blue" lede="A person approves one exact operation. The approval happens outside the agent.">
          <ErrorNote message={setupError} />
          <ApprovalCard agent={agent} terms={terms} permit={permit} busy={approving} error={approvalError} onApprove={onApprove} />
        </Section>

        <Section id="action" step="02" title="Agent action" lede="Both requests cost exactly the same. Only the business operation differs.">
          <ActionCards enabled={permit !== null} busy={running} onRun={(kind) => void onRun(kind)} />
          <ErrorNote message={runError} />
        </Section>

        {latestRun && timeline && (
          <Section id="result" step="03" title={latest === "deny" ? "Decision: blocked" : "Decision: authorized"} tone={latest === "deny" ? "red" : "purple"}>
            <div className="result-grid">
              <OutcomeCard run={latestRun} approved={permit?.operation ?? null} />
              <div className="card">
                <p className="card-kicker">Purchase timeline · {opLabel(latestRun.response.operation)}</p>
                <Timeline steps={timeline} />
              </div>
            </div>
          </Section>
        )}

        <Section id="compare" step="04" title="Same payment. Different operation." lede="Both requests, side by side, from the authority's signed decisions.">
          <Comparison rows={comparison} haveBoth={Boolean(runs.allow && runs.deny)} />
        </Section>

        <Section id="how" title="How it works" lede="Each stop is an independent check. A denied operation stops at the authority: nothing is paid.">
          <Journey outcome={journeyOutcome} />
        </Section>

        <Section id="evidence" title="Verify evidence" tone="purple">
          <EvidencePanel
            available={bundle !== null}
            report={report}
            trust={trust}
            busy={verifying}
            error={evidenceError}
            onVerify={(mode) => bundle !== null && void verify(bundle, mode)}
          />
        </Section>

        <Section id="details" title="Technical details" lede="Raw protocol objects and additional adversarial tests.">
          <DetailsPanel>
            <div className="button-row">
              <button className="button button-outline" type="button" disabled={permit === null} onClick={() => void onExtra("summarize(dataset-b) — unapproved argument", { operation: "summarize", datasetId: "dataset-b" })}>
                Try summarize(dataset-b)
              </button>
              {(["overcharge", "wrong-recipient", "wrong-asset"] as const).map((scenario) => (
                <button key={scenario} className="button button-outline" type="button" disabled={permit === null} onClick={() => void onExtra(`merchant ${scenario}`, { ...APPROVED, scenario })}>
                  Merchant: {scenario}
                </button>
              ))}
            </div>
            {extraRuns.length > 0 && (
              <ul className="extra-runs">
                {extraRuns.map(({ label, run }, index) => (
                  <li key={`${label}-${index}`}>
                    <span>{label}</span>
                    <span className={`status ${run.response.authorization?.decision === "ALLOW" ? "status-verified" : "status-invalid"}`}>{run.response.authorization?.decision ?? run.response.status}</span>
                    <span className="mono">{run.response.authorization?.receipt.reasonCodes.join(", ") || run.response.authority?.reasonCode || "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            <JsonBlock title="Signed PurchasePermit" value={permit} />
            <JsonBlock title="Approved request — agent response" value={runs.allow?.response} />
            <JsonBlock title="Unauthorized request — agent response" value={runs.deny?.response} />
            <JsonBlock title="Evidence bundle" value={bundle ? JSON.parse(bundle) : null} />
            <JsonBlock title="Verifier report" value={report} />
          </DetailsPanel>
        </Section>
      </main>
      <footer className="site-footer">
        <div className="container">CanFixIT · Virtual Haibin — Solana payment sandbox demo. No real funds are used.</div>
      </footer>
    </>
  );
}

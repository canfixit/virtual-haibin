import { groupClaims, STATUS_LABEL, type VerificationReport } from "../model";
import { ErrorNote } from "./Layout";

export function EvidencePanel(props: {
  available: boolean;
  report: VerificationReport | null;
  trust: { issuer: string; authority: string; service: string | null } | null;
  busy: "offline" | "online" | null;
  error: string | null;
  onVerify: (mode: "offline" | "online") => void;
}) {
  return (
    <div className="evidence">
      <div className="card card-purple evidence-intro">
        <p className="card-kicker kicker-purple">Portable evidence</p>
        <h3 className="card-title">This purchase can be checked independently, even when Virtual Haibin is offline.</h3>
        <p className="card-copy">
          A separate verifier, with its own pinned trust keys and no access to Virtual Haibin, checks the signed evidence bundle. Online mode also observes the payment on
          the Solana sandbox.
        </p>
        <div className="button-row">
          <button className="button button-purple" type="button" disabled={!props.available || props.busy !== null} onClick={() => props.onVerify("offline")}>
            {props.busy === "offline" ? "Verifying…" : "Verify evidence"}
          </button>
          <button className="button button-outline" type="button" disabled={!props.available || props.busy !== null} onClick={() => props.onVerify("online")}>
            {props.busy === "online" ? "Observing…" : "Verify + observe settlement on-chain"}
          </button>
        </div>
        {!props.available && <p className="helper">Run the approved operation first.</p>}
        <ErrorNote message={props.error} />
      </div>

      {props.report && (
        <div className="report" aria-live="polite">
          <div className={`report-overall overall-${props.report.overall.toLowerCase()}`}>
            <span className="report-overall-value">{props.report.overall}</span>
            <span className="report-overall-meta">
              {props.report.mode === "online" ? "Online: settlement observed on the sandbox RPC" : "Offline: no network access"} · {props.report.decision} · {props.report.purchaseState}
            </span>
          </div>
          <div className="claim-groups">
            {groupClaims(props.report).map((group) => (
              <section key={group.id} className={`claim-group group-${group.id}`} aria-label={group.title}>
                <h4>{group.title}</h4>
                <ul>
                  {group.claims.map((claim) => (
                    <li key={claim.id} title={claim.detail ?? claim.id}>
                      <span className="claim-label">{claim.label}</span>
                      <span className={`status status-${claim.status.toLowerCase().replace(/_/g, "-")}`}>{STATUS_LABEL[claim.status]}</span>
                    </li>
                  ))}
                  {group.id === "limits" &&
                    props.report?.notProven.map((item) => (
                      <li key={item}>
                        <span className="claim-label">{item}</span>
                        <span className="status status-not-provable-from-bundle">Not provable</span>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
          {props.trust && (
            <p className="helper mono trust-line">
              Pinned by the verifier — issuer {props.trust.issuer} · authority {props.trust.authority}
              {props.trust.service ? ` · service ${props.trust.service}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

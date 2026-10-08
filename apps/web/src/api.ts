import type { DemoResponse, Permit, VerificationReport } from "./model";

const agentApiUrl = import.meta.env.VITE_AGENT_API_URL ?? "http://localhost:4000";
const approverApiUrl = import.meta.env.VITE_APPROVER_API_URL ?? "http://localhost:4003";
const verifierApiUrl = import.meta.env.VITE_VERIFIER_API_URL ?? "http://localhost:4004";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; reasonCode?: string };

  if (!response.ok) {
    throw new ApiError(body.reasonCode ? `${body.reasonCode}: ${body.error ?? ""}` : (body.error ?? `HTTP ${response.status}`), response.status);
  }

  return body;
}

/**
 * The demo session capability for the agent API, held in page memory only:
 * never written to browser storage or cookies, never put in a URL,
 * never logged, and sent only as an Authorization header to the agent.
 */
let sessionToken: string | null = null;

/** Starts a new demo session; any permit or purchase of a previous session is not carried over. */
export async function startSession(): Promise<void> {
  const response = await fetch(`${agentApiUrl}/session`, { method: "POST" });
  sessionToken = (await json<{ token: string }>(response)).token;
}

function agentAuth(): Record<string, string> {
  if (sessionToken === null) {
    throw new ApiError("No demo session. Reload the page to start one.", 401);
  }
  return { authorization: `Bearer ${sessionToken}` };
}

export type ApprovalTerms = {
  service: string;
  network: string;
  mint: string;
  recipient: string;
  maxPerCallAtomic: string;
  maxTotalAtomic: string;
  ttlMs: number;
  method: string;
  resource: string;
};

export const getAgentIdentity = async () => (await json<{ agent: string }>(await fetch(`${agentApiUrl}/identity`))).agent;

export const getApproverTerms = async () => (await json<{ issuer: string; terms: ApprovalTerms }>(await fetch(`${approverApiUrl}/health`)));

/**
 * Human approval. The approval code is sent ONLY as a request header to the
 * approver; it is never stored, logged, put in a URL or sent to the agent.
 */
export async function approve(agent: string, approvalCode: string, operation: string, datasetId: string): Promise<Permit> {
  const response = await fetch(`${approverApiUrl}/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${approvalCode}` },
    body: JSON.stringify({ agent, operation, datasetId }),
  });
  return (await json<{ permit: Permit }>(response)).permit;
}

/** The agent receives only the signed permit. */
export async function installPermit(permit: Permit): Promise<void> {
  await json(await fetch(`${agentApiUrl}/permit`, { method: "POST", headers: { "content-type": "application/json", ...agentAuth() }, body: JSON.stringify({ permit }) }));
}

/** Asks the agent to buy an operation. Refusals (4xx) are returned as data, not thrown. */
export async function runOperation(body: { operation: string; datasetId: string; scenario?: string }): Promise<{ httpStatus: number; response: DemoResponse }> {
  const response = await fetch(`${agentApiUrl}/demo`, { method: "POST", headers: { "content-type": "application/json", ...agentAuth() }, body: JSON.stringify(body) });
  const payload = (await response.json().catch(() => ({}))) as DemoResponse & { error?: string };

  if (response.status === 401 || response.status >= 500) {
    throw new ApiError(payload.error ?? `HTTP ${response.status}`, response.status);
  }

  return { httpStatus: response.status, response: payload };
}

/** Exported evidence bundle, relayed by the agent (raw text: verified by signatures, not by transport). */
export async function getEvidence(invocationId: string): Promise<string> {
  const response = await fetch(`${agentApiUrl}/evidence/${encodeURIComponent(invocationId)}`, { headers: agentAuth() });

  if (!response.ok) {
    throw new ApiError(`Evidence export failed (HTTP ${response.status})`, response.status);
  }

  return response.text();
}

/** The standalone verifier with its OWN pinned trust roots; it never contacts Virtual Haibin. */
export async function verifyEvidence(bundle: string, mode: "offline" | "online") {
  const response = await fetch(`${verifierApiUrl}/verify?mode=${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: bundle });
  return json<{ report: VerificationReport; trust: { issuer: string; authority: string; service: string | null } }>(response);
}

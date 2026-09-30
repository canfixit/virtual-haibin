import { useState } from "react";

const agentApiUrl =
  import.meta.env.VITE_AGENT_API_URL ?? "http://localhost:4000";

type DemoState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "done"; label: string; response: unknown }
  | { status: "error"; label: string; message: string };

type DemoScenario = "honest" | "overcharge" | "wrong-recipient" | "wrong-asset";

async function executeDemo(scenario: DemoScenario): Promise<unknown> {
  const response = await fetch(`${agentApiUrl}/demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ scenario }),
  });

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    return payload;
  }

  return payload;
}

export function App() {
  const [state, setState] = useState<DemoState>({ status: "idle" });

  const run = async (label: string, scenario: DemoScenario) => {
    setState({ status: "loading", label });

    try {
      const response = await executeDemo(scenario);
      setState({ status: "done", label, response });
    } catch (error) {
      setState({
        status: "error",
        label,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Virtual Haibin</p>
        <h1>Verifiable authority for AI agents.</h1>
        <p className="summary">
          A thin vertical slice demonstrating delegated authority, policy
          decisions, machine-to-machine interaction, mock payment, and audit.
        </p>
      </section>

      <section className="panel">
        <h2>Development vertical slice</h2>
        <p>
          The signed demo permit authorizes the research service to be paid
          at most 20000 base units per call (0.02) and 50000 in total (0.05)
          of sandbox USDC on the Pay.sh Solana Payment Sandbox (a hosted test
          validator; no real funds). The authority fetches the service's real
          x402 402 challenge, validates it against the permit, and only then
          settles on the sandbox.
        </p>

        <div className="actions">
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Allowed paid request (0.01)", "honest")}
          >
            Run allowed request
          </button>
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Merchant overcharges (challenge asks 0.10)", "overcharge")}
          >
            Run overcharged challenge
          </button>
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Merchant redirects payment (wrong payTo)", "wrong-recipient")}
          >
            Run wrong recipient
          </button>
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Merchant asks for another asset (USDT)", "wrong-asset")}
          >
            Run wrong asset
          </button>
        </div>
      </section>

      <section className="panel output" aria-live="polite">
        <h2>Result</h2>
        {state.status === "idle" && <p>No request has been executed yet.</p>}
        {state.status === "loading" && <p>Running {state.label}…</p>}
        {state.status === "error" && (
          <pre>{JSON.stringify({ error: state.message }, null, 2)}</pre>
        )}
        {state.status === "done" && (
          <>
            <p>{state.label}</p>
            <pre>{JSON.stringify(state.response, null, 2)}</pre>
          </>
        )}
      </section>
    </main>
  );
}

import { useState } from "react";

const agentApiUrl =
  import.meta.env.VITE_AGENT_API_URL ?? "http://localhost:4000";

type DemoState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "done"; label: string; response: unknown }
  | { status: "error"; label: string; message: string };

async function executeDemo(quotedPrice: number): Promise<unknown> {
  const response = await fetch(`${agentApiUrl}/demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ quotedPrice }),
  });

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    return payload;
  }

  return payload;
}

export function App() {
  const [state, setState] = useState<DemoState>({ status: "idle" });

  const run = async (label: string, quotedPrice: number) => {
    setState({ status: "loading", label });

    try {
      const response = await executeDemo(quotedPrice);
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
          The demo mandate permits research and caps each transaction at
          0.02 USDC with a total budget of 0.05 USDC.
        </p>

        <div className="actions">
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Allowed request", 0.01)}
          >
            Run allowed request
          </button>
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void run("Denied overspend", 0.1)}
          >
            Run denied overspend
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

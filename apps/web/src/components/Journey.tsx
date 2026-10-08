type NodeState = "idle" | "done" | "blocked" | "skipped";

const NODES: Array<{ id: string; label: string; role: string; tone: "blue" | "neutral" | "purple" }> = [
  { id: "human", label: "Human", role: "Approves an exact operation", tone: "blue" },
  { id: "agent", label: "Agent", role: "Requests a purchase", tone: "neutral" },
  { id: "authority", label: "Virtual Haibin authority", role: "Checks permit, operation, budget", tone: "purple" },
  { id: "service", label: "Service verification", role: "Merchant checks the authorization", tone: "purple" },
  { id: "payment", label: "x402 / Solana", role: "Sandbox settlement", tone: "neutral" },
  { id: "result", label: "Result", role: "Returned to the agent", tone: "neutral" },
  { id: "evidence", label: "Evidence", role: "Independently verifiable", tone: "purple" },
];

/** Orientation, not architecture: which stops the last request actually reached. */
export function Journey({ outcome }: { outcome: "none" | "allowed" | "blocked" }) {
  const state = (index: number): NodeState => {
    if (outcome === "none") return "idle";
    if (outcome === "allowed") return "done";
    return index < 2 ? "done" : index === 2 ? "blocked" : "skipped";
  };

  return (
    <ol className="journey" aria-label="Purchase journey">
      {NODES.map((node, index) => (
        <li key={node.id} className={`journey-node tone-${node.tone} journey-${state(index)}`}>
          <span className="journey-label">{node.label}</span>
          <span className="journey-role">{state(index) === "blocked" ? "Stopped here: operation not authorized" : node.role}</span>
        </li>
      ))}
    </ol>
  );
}

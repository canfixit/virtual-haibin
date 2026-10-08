import type { ReactNode } from "react";

export function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return value === null || value === undefined ? null : (
    <details className="json-block">
      <summary>{title}</summary>
      <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function DetailsPanel({ children }: { children: ReactNode }) {
  return <div className="details-panel">{children}</div>;
}

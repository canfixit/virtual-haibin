// The demo paid operation: POST /api/v1/report {operation, datasetId}.
// Pure; no I/O.

export const SERVICE_ID = "mock-dataset-reports";
export const CAPABILITY = "reports.generate";
export const REPORT_RESOURCE = "/api/v1/report";
export const OPERATIONS = ["summarize", "export"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type ReportRequest = { operation: Operation; datasetId: string };

// Synthetic demo data. "export" returns the rows; "summarize" only aggregates.
export const DATASETS: Record<string, Array<{ region: string; revenue: number }>> = {
  "dataset-a": [
    { region: "north", revenue: 120 },
    { region: "south", revenue: 95 },
    { region: "east", revenue: 143 },
  ],
  "dataset-b": [
    { region: "west", revenue: 88 },
    { region: "central", revenue: 131 },
  ],
};

/** Strict body validation: exactly {operation, datasetId}; anything else is 400 before any 402. */
export function parseReportRequest(body: unknown): ReportRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (keys.length !== 2 || keys[0] !== "datasetId" || keys[1] !== "operation") {
    return null;
  }

  if (typeof record.operation !== "string" || !(OPERATIONS as readonly string[]).includes(record.operation)) {
    return null;
  }

  if (typeof record.datasetId !== "string" || !Object.hasOwn(DATASETS, record.datasetId)) {
    return null;
  }

  return { operation: record.operation as Operation, datasetId: record.datasetId };
}

export function runReport({ operation, datasetId }: ReportRequest): unknown {
  const rows = DATASETS[datasetId] ?? [];

  if (operation === "export") {
    return { kind: "export", rowCount: rows.length, rows };
  }

  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return { kind: "summary", rowCount: rows.length, totalRevenue: total, topRegion: [...rows].sort((a, b) => b.revenue - a.revenue)[0]?.region ?? null };
}

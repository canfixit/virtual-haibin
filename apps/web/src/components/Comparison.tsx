import type { ComparisonRow } from "../model";

/** ALLOWED vs BLOCKED, computed from the two real requests. */
export function Comparison({ rows, haveBoth }: { rows: ComparisonRow[]; haveBoth: boolean }) {
  return (
    <div className="comparison card">
      <table>
        <caption className="visually-hidden">Approved request compared with the unauthorized request</caption>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="col-allowed">
              Allowed
            </th>
            <th scope="col" className="col-blocked">
              Blocked
            </th>
            <th scope="col" className="col-diff">
              <span className="visually-hidden">Same or different</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className={row.emphasis ? `row-${row.emphasis}` : row.same === false ? "row-different" : undefined}>
              <th scope="row">{row.label}</th>
              <td className="col-allowed mono">{row.allowed}</td>
              <td className="col-blocked mono">{row.blocked}</td>
              <td className="col-diff">
                {row.emphasis ? null : row.same === null ? null : row.same ? <span className="tag tag-same">Same</span> : <span className="tag tag-different">Different</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={haveBoth ? "comparison-verdict" : "helper"}>
        {haveBoth ? "The money is identical. The business operation is different." : "Run both actions to compare the two real requests side by side."}
      </p>
    </div>
  );
}

import { readFileSync, statSync } from "node:fs";
import { isAddress } from "@solana/addresses";
import {
  createRpcSettlementSource,
  MAX_BUNDLE_BYTES,
  verifyEvidenceBundle,
  type OnlineSettlementSource,
  type VerificationReport,
} from "@virtual-haibin/evidence";
import { solanaPaymentSandboxProfile, SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL } from "@virtual-haibin/payments";

export const USAGE = `Usage:
  verify <bundle.json> --issuer-trust <file> --authority-trust <file> [--offline | --online [--rpc <url>]] [--json]

  --issuer-trust     file holding the pinned human-issuer public key (base58)
  --authority-trust  file holding the pinned Virtual Haibin authority public key (base58)
  --offline          (default) no network access at all
  --online           additionally observe settlement on the configured sandbox RPC
  --rpc              settlement RPC for --online (default ${SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL});
                     never taken from the bundle
  --json             print only the JSON report

Exit codes: 0 VALID, 1 INVALID, 2 INDETERMINATE, 64 usage/configuration error.`;

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Injected for tests; defaults to the verifier-configured JSON-RPC client. */
  rpcFactory?: (url: string) => OnlineSettlementSource;
};

class UsageError extends Error {}

type Args = { bundle: string; issuerTrust: string; authorityTrust: string; online: boolean; rpc: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;

  if (command !== "verify") {
    throw new UsageError("expected the 'verify' command");
  }

  const args: Partial<Args> = { online: false, rpc: SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL, json: false };
  let sawOffline = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };

    switch (arg) {
      case "--issuer-trust":
        args.issuerTrust = value();
        break;
      case "--authority-trust":
        args.authorityTrust = value();
        break;
      case "--rpc":
        args.rpc = value();
        break;
      case "--online":
        args.online = true;
        break;
      case "--offline":
        sawOffline = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        if (arg === undefined || arg.startsWith("--") || args.bundle !== undefined) throw new UsageError(`unexpected argument ${String(arg)}`);
        args.bundle = arg;
    }
  }

  if (sawOffline && args.online) throw new UsageError("--offline and --online are exclusive");
  if (!args.bundle || !args.issuerTrust || !args.authorityTrust) throw new UsageError("bundle, --issuer-trust and --authority-trust are required");
  return args as Args;
}

/** Reads one pinned public key from a verifier-local trust file. */
function readTrustKey(path: string, label: string): string {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > 256) throw new UsageError(`${label} trust file must be a small regular file`);
  const key = readFileSync(path, "utf8").trim();
  if (!isAddress(key)) throw new UsageError(`${label} trust file must contain exactly one base58 public key`);
  return key;
}

function readBundle(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile()) throw new UsageError("bundle must be a regular file");
  // Oversized input is reported as an INVALID bundle by the parser's own limit.
  if (stats.size > MAX_BUNDLE_BYTES) return "x".repeat(MAX_BUNDLE_BYTES + 1);
  return readFileSync(path, "utf8");
}

export function formatReport(report: VerificationReport): string {
  const lines = [
    `overall: ${report.overall}   mode: ${report.mode}   decision: ${report.decision ?? "-"}   state: ${report.purchaseState ?? "-"}`,
    `invocation: ${report.invocationId ?? "-"}`,
    "",
  ];
  let category = "";

  for (const claim of report.claims) {
    if (claim.category !== category) {
      category = claim.category;
      lines.push(category);
    }
    lines.push(`  ${claim.status.padEnd(24)} ${claim.required ? "*" : " "} ${claim.id}${claim.detail ? ` -- ${claim.detail}` : ""}`);
  }

  lines.push("", "(* = required for overall VALID)", "", "NOT PROVEN by this bundle:", ...report.notProven.map((item) => `  - ${item}`));
  return lines.join("\n");
}

/** Runs the CLI. Returns the process exit code. Never contacts the authority. */
export async function runVerifierCli(argv: string[], io: CliIo): Promise<number> {
  let args: Args;
  let bundle: string;
  let issuer: string;
  let authority: string;

  try {
    args = parseArgs(argv);
    issuer = readTrustKey(args.issuerTrust, "issuer");
    authority = readTrustKey(args.authorityTrust, "authority");
    bundle = readBundle(args.bundle);
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : "invalid arguments"}\n\n${USAGE}\n`);
    return 64;
  }

  const profile = solanaPaymentSandboxProfile(args.rpc);
  const trust = { issuer, authority, settlementProfiles: new Map([[profile.permitNetwork, profile]]) };
  const report = await verifyEvidenceBundle(
    bundle,
    trust,
    args.online ? { mode: "online", rpc: (io.rpcFactory ?? ((url: string) => createRpcSettlementSource(url)))(profile.rpcUrl) } : { mode: "offline" },
  );

  io.stdout(`${args.json ? JSON.stringify(report, null, 2) : `${formatReport(report)}\n\n${JSON.stringify(report)}`}\n`);
  return report.overall === "VALID" ? 0 : report.overall === "INDETERMINATE" ? 2 : 1;
}

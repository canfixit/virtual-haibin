// Failure classification for the EXTERNAL sandbox scripts.
//
//   exit 0  every check passed
//   exit 1  INTEGRATION REGRESSION: a deterministic product assertion failed
//   exit 3  EXTERNAL ENVIRONMENT FAILURE: the hosted sandbox / its RPC / the
//           paid service's facilitator was unavailable, or an externally
//           submitted payment ended uncertain (RECONCILIATION_REQUIRED).
//
// A regression always wins over an external failure. Nothing is ever turned
// into success: checks that depend on an externally failed payment are
// reported as SKIP, and the run still exits non-zero.
//
// Only payment-path outcomes can be external. Every authorization, denial,
// replay-protection and conflict assertion is product behavior.

export const EXIT_REGRESSION = 1;
export const EXIT_EXTERNAL = 3;

/**
 * True when an agent /demo result shows the payment left the authority but
 * its outcome is unknown, or the paid service could not be reached -- the
 * signatures of sandbox/facilitator trouble. The authority's correct
 * response is to block (RECONCILIATION_REQUIRED) and never retry; the test
 * does not retry either.
 */
export function isExternalPaymentFailure(result) {
  return (
    (result.http === 409 && result.refusal === "RECONCILIATION_REQUIRED") ||
    (result.http === 502 && (result.refusal === "PAID_SERVICE_UNAVAILABLE" || result.refusal === "PAYMENT_NOT_SUBMITTED"))
  );
}

export class Outcome {
  regressions = 0;
  externals = 0;
  skipped = 0;

  ok(name) {
    console.log(`  ok   ${name}`);
  }

  check(name, condition, detail) {
    if (condition) {
      this.ok(name);
    } else {
      this.regressions += 1;
      console.log(`  FAIL ${name}: ${JSON.stringify(detail)}`);
    }
    return condition;
  }

  external(name, reason, detail) {
    this.externals += 1;
    console.log(`  EXT  ${name}: EXTERNAL ENVIRONMENT FAILURE -- ${reason}: ${JSON.stringify(detail)}`);
  }

  skip(name, reason) {
    this.skipped += 1;
    console.log(`  SKIP ${name}: ${reason}`);
  }

  finish(label) {
    if (this.regressions > 0) {
      console.log(`\n${label}: ${this.regressions} INTEGRATION REGRESSION(S)${this.externals ? `, ${this.externals} external failure(s)` : ""}`);
      process.exit(EXIT_REGRESSION);
    }

    if (this.externals > 0) {
      console.log(`\n${label}: EXTERNAL ENVIRONMENT FAILURE (${this.externals} external, ${this.skipped} dependent check(s) skipped). No product assertion failed; rerun when the sandbox is healthy.`);
      process.exit(EXIT_EXTERNAL);
    }

    console.log(`\n${label}: all checks passed.`);
    process.exit(0);
  }
}

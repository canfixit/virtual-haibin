// Demo helper: writes a copy of an evidence bundle with ONE security-relevant
// edit (no re-signing -- an attacker has no authority key).
//
//   node scripts/tamper-evidence.mjs <in.json> <out.json> <operation|amount|recipient|settlement|authority-key|service-ack>

import { readFileSync, writeFileSync } from "node:fs";

const [input, output, kind] = process.argv.slice(2);
const bundle = JSON.parse(readFileSync(input, "utf8"));
const OTHER_ADDRESS = "DS2xXiLQwn48Laj3XYvCMETqUGXsjBUcXRFTP6G3NYVr";

const edits = {
  operation: (b) => (b.authorizationRequest.request.operation.operation = "export"),
  amount: (b) => (b.paymentRequirement.amountAtomic = "20000"),
  recipient: (b) => (b.paymentRequirement.payTo = OTHER_ADDRESS),
  settlement: (b) => (b.settlement.transactionId = b.purchasePermit.signature.signature),
  "authority-key": (b) => (b.manifest.authority = OTHER_ADDRESS),
  // Phase 5C: claim the service returned different bytes than it signed for.
  "service-ack": (b) => (b.serviceAcknowledgement.result.sha256 = "0".repeat(64)),
};

if (!edits[kind]) {
  console.error(`unknown tamper kind ${kind}; one of ${Object.keys(edits).join(", ")}`);
  process.exit(64);
}

edits[kind](bundle);
writeFileSync(output, JSON.stringify(bundle));

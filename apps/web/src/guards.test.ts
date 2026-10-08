import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Static guards for the demo UI.
const here = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): Array<{ name: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!/\.(tsx?|css)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [{ name: path.slice(here.length + 1), text: readFileSync(path, "utf8") }];
  });
}

const files = sources(here);

test("the approval code is never persisted or placed in a URL: no browser storage, cookies or URL params anywhere", () => {
  for (const { name, text } of files) {
    for (const forbidden of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /URLSearchParams/, /history\.(push|replace)State/, /console\.(log|info|debug)/]) {
      assert.doesNotMatch(text, forbidden, `${name} must not use ${forbidden}`);
    }
  }

  const api = files.find((file) => file.name === "api.ts")?.text ?? "";
  // The code travels only as a header to the approver.
  assert.match(api, /authorization: `Bearer \$\{approvalCode\}`/);
  assert.doesNotMatch(api, /approvals\?|approvalCode\}`?\s*\)?\s*\+|\$\{approvalCode\}[^`]*`\s*\)/);
});

test("colours are defined only in theme.css (design tokens), never hard-coded in components", () => {
  for (const { name, text } of files) {
    if (name === "theme.css") continue;
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, `${name} must use theme variables, not hex colours`);
    assert.doesNotMatch(text, /\b(rgb|rgba|hsl|hsla)\(/, `${name} must use theme variables, not colour functions`);
  }

  const theme = files.find((file) => file.name === "theme.css")?.text ?? "";
  for (const token of ["--canfixit-blue", "--canfixit-red", "--canfixit-purple", "--surface-primary", "--surface-secondary", "--text-primary", "--text-secondary", "--border-subtle"]) {
    assert.match(theme, new RegExp(`${token}:`), token);
  }
});

test("the UI never claims mainnet or real funds", () => {
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /mainnet/i, name);
  }
  assert.match(files.find((file) => file.name === "components/Layout.tsx")?.text ?? "", /no real funds/i);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("JSON mode wraps Commander usage errors", () => {
  const result = run("--json", "approvals", "get");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.code, "invalid_cli_usage");
});

test("requests create without flags errors in non-TTY with missing_required_flags", () => {
  const result = run("--json", "requests", "create");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error.code, "missing_required_flags");
  assert.ok(parsed.error.message.includes("--account"));
});

test("requests create without flags in plain non-TTY prints error to stderr", () => {
  const result = run("requests", "create");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Missing required flags"));
});

test("approvals approve without request-id errors with usage error", () => {
  const result = run("--json", "approvals", "approve");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error.code, "invalid_cli_usage");
  assert.ok(parsed.error.message.includes("request-id"));
});

test("init without --app-url errors in non-TTY with missing_required_flags", () => {
  const result = run("--json", "init");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error.code, "missing_required_flags");
  assert.ok(parsed.error.message.includes("--app-url"));
});

test("init without --app-url in plain non-TTY prints error to stderr", () => {
  const result = run("init");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Missing required flags: --app-url"));
});

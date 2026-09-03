import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runWithEnv(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
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

test("auth login without --chrome is invalid usage", () => {
  const result = run("--json", "auth", "login");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "invalid_cli_usage");
  assert.equal(error.message, "auth login requires --chrome");
});

test("JSON Chrome login requires a TTY before config or Chrome access", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-approvals-cli-"));
  try {
    const result = runWithEnv(["--json", "auth", "login", "--chrome"], { HOME: home });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const error = JSON.parse(result.stdout).error;
    assert.deepEqual(error, {
      code: "tty_required",
      message: "Chrome authentication requires an interactive terminal",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auth help keeps the import fallback", () => {
  const result = run("auth", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bimport\b.*Prompt for, validate, and save a Cognito refresh token/);
});

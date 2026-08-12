import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("JSON mode wraps Commander usage errors", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "approvals", "get"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.code, "invalid_cli_usage");
});

import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthCode } from "../src/browser.js";
import { CliError } from "../src/errors.js";

test("getOAuthCode accepts only the exact redirect and expected state", () => {
  assert.equal(
    getOAuthCode(
      "https://team.example.com/?code=authorization-code&state=expected",
      "https://team.example.com/",
      "expected",
    ),
    "authorization-code",
  );
  assert.throws(
    () =>
      getOAuthCode(
        "https://team.example.com.evil.test/?code=stolen&state=expected",
        "https://team.example.com/",
        "expected",
      ),
    (error: unknown) => error instanceof CliError && error.code === "callback_origin_mismatch",
  );
  assert.throws(
    () =>
      getOAuthCode(
        "https://team.example.com/?code=authorization-code&state=wrong",
        "https://team.example.com/",
        "expected",
      ),
    (error: unknown) => error instanceof CliError && error.code === "oauth_state_mismatch",
  );
  assert.throws(
    () =>
      getOAuthCode(
        "https://team.example.com/?code=first&code=second&state=expected",
        "https://team.example.com/",
        "expected",
      ),
    (error: unknown) => error instanceof CliError && error.code === "callback_parameters_invalid",
  );
});

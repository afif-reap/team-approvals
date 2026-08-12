import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";

const valid = {
  appUrl: "https://team.example.com/",
  graphQlEndpoint: "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
  cognitoDomain: "https://example.auth.ap-southeast-1.amazoncognito.com",
  clientId: "client-id",
  redirectUri: "https://team.example.com/",
  userPoolId: "ap-southeast-1_EXAMPLE",
  scopes: ["openid", "email", "profile"],
};

test("parseConfig accepts AWS endpoints and matching app redirects", () => {
  assert.equal(parseConfig(valid).clientId, "client-id");
});

test("parseConfig rejects non-AWS token and API destinations", () => {
  assert.throws(
    () => parseConfig({ ...valid, cognitoDomain: "https://attacker.example" }),
    (error: unknown) => error instanceof CliError && error.code === "invalid_config",
  );
  assert.throws(
    () => parseConfig({ ...valid, graphQlEndpoint: "https://attacker.example/graphql" }),
    (error: unknown) => error instanceof CliError && error.code === "invalid_config",
  );
});

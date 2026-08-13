import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getCognitoIssuer, parseImportedRefreshToken, verifyIdentityToken } from "../src/auth.js";
import type { TeamConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";

const config: TeamConfig = {
  appUrl: "https://team.example.com/",
  graphQlEndpoint: "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
  cognitoDomain: "https://example.auth.ap-southeast-1.amazoncognito.com/",
  clientId: "client-id",
  userPoolId: "ap-southeast-1_EXAMPLE",
};

test("verifyIdentityToken verifies signature and Cognito claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();
  const token = await new SignJWT({
    email: "approver@example.com",
    "cognito:username": "idc_approver",
    token_use: "id",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(getCognitoIssuer(config.userPoolId))
    .setAudience(config.clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  assert.deepEqual(await verifyIdentityToken(token, config, { ...jwk, kid }), {
    email: "approver@example.com",
    username: "idc_approver",
  });
});

test("parseImportedRefreshToken rejects empty, short, and whitespace-containing input", () => {
  const token = "a".repeat(200);
  assert.equal(parseImportedRefreshToken(`\n${token}\n`), token);
  for (const input of ["", "short", `${token} invalid`]) {
    assert.throws(
      () => parseImportedRefreshToken(input),
      (error: unknown) => error instanceof CliError && error.code === "invalid_refresh_token",
    );
  }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildAuthorizeUrl, getCognitoIssuer, verifyIdentityToken } from "../src/auth.js";
import type { TeamConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";

const config: TeamConfig = {
  appUrl: "https://team.example.com/",
  graphQlEndpoint: "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
  cognitoDomain: "https://example.auth.ap-southeast-1.amazoncognito.com/",
  clientId: "client-id",
  redirectUri: "https://team.example.com/",
  userPoolId: "ap-southeast-1_EXAMPLE",
  scopes: ["openid", "email", "profile"],
};

test("buildAuthorizeUrl uses authorization code with PKCE, state, and nonce", () => {
  const url = new URL(buildAuthorizeUrl("challenge", "state", "nonce", config));
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("nonce"), "nonce");
});

test("verifyIdentityToken verifies signature and Cognito claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();
  const token = await new SignJWT({
    email: "approver@example.com",
    "cognito:username": "idc_approver",
    token_use: "id",
    nonce: "nonce",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(getCognitoIssuer(config.userPoolId))
    .setAudience(config.clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  assert.deepEqual(await verifyIdentityToken(token, config, { ...jwk, kid }, "nonce"), {
    email: "approver@example.com",
    username: "idc_approver",
  });
  await assert.rejects(
    verifyIdentityToken(token, config, { ...jwk, kid }, "wrong-nonce"),
    (error: unknown) => error instanceof CliError && error.code === "invalid_token",
  );
});

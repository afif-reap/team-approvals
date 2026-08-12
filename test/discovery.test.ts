import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTeamConfig, isPublicAddress, parseAmplifyConfig, writeTeamConfig } from "../src/discovery.js";
import { CliError } from "../src/errors.js";

const bundle = `
  const config = {
    aws_project_region: "ap-southeast-1",
    aws_appsync_graphqlEndpoint: "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
    aws_user_pools_id: "ap-southeast-1_EXAMPLE",
    aws_user_pools_web_client_id: "client-id",
    oauth: {
      domain: "example.auth.ap-southeast-1.amazoncognito.com",
      scope: ["openid", "email", "profile"],
      redirectSignIn: "https://team.example.com/",
      redirectSignOut: "https://team.example.com/",
      responseType: "code"
    },
    federationTarget: "COGNITO_USER_POOLS"
  };
`;

test("parseAmplifyConfig derives every local config field", () => {
  assert.deepEqual(parseAmplifyConfig(bundle, "https://team.example.com/"), {
    appUrl: "https://team.example.com/",
    graphQlEndpoint: "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
    cognitoDomain: "https://example.auth.ap-southeast-1.amazoncognito.com/",
    clientId: "client-id",
    redirectUri: "https://team.example.com/",
    userPoolId: "ap-southeast-1_EXAMPLE",
    scopes: ["openid", "email", "profile"],
  });
});

test("isPublicAddress rejects private and compressed mapped addresses", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("::ffff:7f00:1"), false);
  assert.equal(isPublicAddress("fc00::1"), false);
  assert.equal(isPublicAddress("ff02::1"), false);
});

test("parseAmplifyConfig ignores commented stale configurations", () => {
  const stale = bundle
    .replace("example.appsync-api", "stale.appsync-api")
    .replace("const config", "const stale");
  assert.equal(
    parseAmplifyConfig(`/* ${stale} */ ${bundle}`, "https://team.example.com/").graphQlEndpoint,
    "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
  );
});

test("parseAmplifyConfig ignores similarly named decoy properties", () => {
  assert.deepEqual(
    parseAmplifyConfig(
      bundle.replace(
        "aws_appsync_graphqlEndpoint:",
        'decoy_aws_appsync_graphqlEndpoint: "https://attacker.example/graphql", aws_appsync_graphqlEndpoint:',
      ),
      "https://team.example.com/",
    ).graphQlEndpoint,
    "https://example.appsync-api.ap-southeast-1.amazonaws.com/graphql",
  );
});

test("discoverTeamConfig reads same-origin scripts only", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://team.example.com/") {
      return new Response(
        '<script src="https://attacker.example/app.js"></script><script src="/static/main.js"></script>',
      );
    }
    if (url === "https://team.example.com/static/main.js") return new Response(bundle);
    throw new Error(`Unexpected request to ${url}`);
  };

  const discovered = await discoverTeamConfig("https://team.example.com/approvals", fetcher);
  assert.equal(discovered.clientId, "client-id");
  assert.deepEqual(requested, ["https://team.example.com/", "https://team.example.com/static/main.js"]);
});

test("discoverTeamConfig skips malformed candidate scripts", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://team.example.com/") {
      return new Response('<script src="/bad.js"></script><script src="/good.js"></script>');
    }
    if (url.endsWith("/bad.js")) {
      return new Response("aws_appsync_graphqlEndpoint aws_user_pools_id");
    }
    if (url.endsWith("/good.js")) return new Response(bundle);
    throw new Error(`Unexpected request to ${url}`);
  };

  assert.equal((await discoverTeamConfig("https://team.example.com/", fetcher)).clientId, "client-id");
});

test("discoverTeamConfig ignores script tags inside HTML comments", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://team.example.com/") {
      return new Response('<!-- <script src="/stale.js"></script> --><script src="/good.js"></script>');
    }
    if (url.endsWith("/good.js")) return new Response(bundle);
    throw new Error(`Unexpected request to ${url}`);
  };
  assert.equal((await discoverTeamConfig("https://team.example.com/", fetcher)).clientId, "client-id");
});

test("discoverTeamConfig rejects conflicting configs across scripts", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://team.example.com/") {
      return new Response('<script src="/first.js"></script><script src="/second.js"></script>');
    }
    if (url.endsWith("/first.js")) return new Response(bundle);
    if (url.endsWith("/second.js")) return new Response(bundle.replace('"client-id"', '"other-client"'));
    throw new Error(`Unexpected request to ${url}`);
  };
  await assert.rejects(
    discoverTeamConfig("https://team.example.com/", fetcher),
    (error: unknown) => error instanceof CliError && error.code === "discovery_config_ambiguous",
  );
});

test("discoverTeamConfig does not suppress ambiguity inside another script", async () => {
  const conflicting = bundle.replace("const config", "const otherConfig").replace('"client-id"', '"other-client"');
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://team.example.com/") {
      return new Response('<script src="/valid.js"></script><script src="/ambiguous.js"></script>');
    }
    if (url.endsWith("/valid.js")) return new Response(bundle);
    if (url.endsWith("/ambiguous.js")) return new Response(`${bundle}\n${conflicting}`);
    throw new Error(`Unexpected request to ${url}`);
  };
  await assert.rejects(
    discoverTeamConfig("https://team.example.com/", fetcher),
    (error: unknown) => error instanceof CliError && error.code === "discovery_config_ambiguous",
  );
});

test("parseAmplifyConfig rejects spread overrides", () => {
  assert.throws(
    () => parseAmplifyConfig(bundle.replace("const config = {", "const override = {}; const config = { ...override,"), "https://team.example.com/"),
    (error: unknown) => error instanceof CliError && error.code === "discovery_config_missing",
  );
});

test("writeTeamConfig writes mode 600 and requires force to replace", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-approvals-test-"));
  const destination = path.join(directory, "nested", "config.json");
  const config = parseAmplifyConfig(bundle, "https://team.example.com/");
  try {
    writeTeamConfig(config, destination);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), config);
    assert.throws(
      () => writeTeamConfig(config, destination),
      (error: unknown) => error instanceof CliError && error.code === "config_exists",
    );
    assert.doesNotThrow(() => writeTeamConfig(config, destination, true));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

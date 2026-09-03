import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import vm from "node:vm";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import * as chromeAuth from "../src/chrome-auth.js";
import { CliError } from "../src/errors.js";

const APP_ORIGIN = "https://team.example.test";
const APP_URL = `${APP_ORIGIN}/signed-in`;
const HOSTILE_CLIENT_ID = `client-\"');throw new Error('SENTINEL_CLIENT');//`;
const REFRESH_TOKEN = `SENTINEL_REFRESH_TOKEN_${"x".repeat(180)}`;
const SESSION_ID = "test-session";
const OBJECT_ID = "test-global-object";
const ENDPOINT_ERROR =
  "Chrome remote debugging is unavailable. Open chrome://inspect/#remote-debugging, enable remote debugging, then retry. If needed, run `team-approvals auth import`.";

type TestRequest = {
  id: number;
  method: string;
  params: Record<string, unknown> | undefined;
  sessionId: string | undefined;
};

type Observations = {
  closed: boolean;
  connections: number;
  errors: unknown[];
  extensionsHeader: string | string[] | undefined;
  functionDeclaration: string | undefined;
  hostHeader: string | undefined;
  requestPath: string | undefined;
  requests: TestRequest[];
  storageReads: string[];
};

type Scenario = {
  frameOrigin?: string;
  override?: (socket: WebSocket, request: TestRequest) => boolean;
  targets?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function parseRequest(data: RawData, isBinary: boolean): TestRequest {
  assert.equal(isBinary, false);
  assert.ok(Buffer.isBuffer(data));
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  const record = requireRecord(parsed);
  assert.ok(typeof record.id === "number");
  assert.ok(Number.isInteger(record.id));
  assert.ok(typeof record.method === "string");
  const params = record.params === undefined ? undefined : requireRecord(record.params);
  const sessionId = record.sessionId;
  assert.ok(sessionId === undefined || typeof sessionId === "string");
  return { id: record.id, method: record.method, params, sessionId };
}

function sendResult(socket: WebSocket, request: TestRequest, result: unknown): void {
  const response: Record<string, unknown> = { id: request.id, result };
  if (request.sessionId !== undefined) response.sessionId = request.sessionId;
  socket.send(JSON.stringify(response));
}

function endpointPath(home: string): string {
  return path.join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort");
}

async function writeEndpoint(home: string, contents: string): Promise<void> {
  const target = endpointPath(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, { mode: 0o600 });
}

async function withTemporaryHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "team-approvals-chrome-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function invokeReader(
  functionDeclaration: string,
  options: {
    argumentOrigin: string;
    clientId: string;
    entries: ReadonlyArray<readonly [string, string]>;
    locationOrigin: string;
    reads: string[];
  },
): unknown {
  const values = new Map(options.entries);
  const localStorage = {};
  for (const key of values.keys()) {
    Object.defineProperty(localStorage, key, { enumerable: true, value: values.get(key) });
  }
  Object.defineProperty(localStorage, "getItem", {
    enumerable: false,
    value: (key: unknown): string | null => {
      assert.ok(typeof key === "string");
      options.reads.push(key);
      return values.get(key) ?? null;
    },
  });
  const context = vm.createContext({ location: { origin: options.locationOrigin }, localStorage });
  const candidate: unknown = vm.runInContext(`(${functionDeclaration})`, context, { timeout: 100 });
  assert.ok(typeof candidate === "function");
  return Reflect.apply(candidate, undefined, [options.argumentOrigin, options.clientId]);
}

function defaultTargets(): unknown[] {
  return [
    { targetId: "same-origin-worker", type: "service_worker", url: `${APP_ORIGIN}/worker.js` },
    { targetId: "lookalike", type: "page", url: "https://team.example.test.evil.invalid/" },
    { targetId: "team-page", type: "page", url: `${APP_ORIGIN}/requests` },
    { targetId: "other-page", type: "page", url: "https://other.example.test/" },
  ];
}

function respondToValidCommand(
  socket: WebSocket,
  request: TestRequest,
  scenario: Scenario,
  observations: Observations,
): void {
  switch (request.method) {
    case "Target.getTargets":
      assert.equal(request.params, undefined);
      assert.equal(request.sessionId, undefined);
      sendResult(socket, request, { targetInfos: scenario.targets ?? defaultTargets() });
      return;
    case "Target.attachToTarget":
      assert.deepEqual(request.params, { targetId: "team-page", flatten: true });
      assert.equal(request.sessionId, undefined);
      sendResult(socket, request, { sessionId: SESSION_ID });
      return;
    case "Runtime.runIfWaitingForDebugger":
      assert.equal(request.params, undefined);
      assert.equal(request.sessionId, SESSION_ID);
      sendResult(socket, request, {});
      return;
    case "Page.getFrameTree":
      assert.equal(request.params, undefined);
      assert.equal(request.sessionId, SESSION_ID);
      sendResult(socket, request, {
        frameTree: { frame: { securityOrigin: scenario.frameOrigin ?? APP_ORIGIN } },
      });
      return;
    case "Runtime.evaluate":
      assert.deepEqual(request.params, { expression: "globalThis", returnByValue: false, silent: true });
      assert.equal(request.sessionId, SESSION_ID);
      sendResult(socket, request, { result: { type: "object", objectId: OBJECT_ID } });
      return;
    case "Runtime.callFunctionOn": {
      const params = requireRecord(request.params);
      assert.equal(request.sessionId, SESSION_ID);
      assert.equal(params.objectId, OBJECT_ID);
      assert.equal(params.awaitPromise, false);
      assert.equal(params.generatePreview, false);
      assert.equal(params.returnByValue, true);
      assert.equal(params.silent, true);
      assert.equal(params.userGesture, false);
      assert.ok(typeof params.functionDeclaration === "string");
      assert.deepEqual(params.arguments, [{ value: APP_ORIGIN }, { value: HOSTILE_CLIENT_ID }]);
      observations.functionDeclaration = params.functionDeclaration;
      const prefix = `CognitoIdentityServiceProvider.${HOSTILE_CLIENT_ID}.`;
      const suffix = ".refreshToken";
      const value = invokeReader(params.functionDeclaration, {
        argumentOrigin: APP_ORIGIN,
        clientId: HOSTILE_CLIENT_ID,
        entries: [
          [`${prefix}approver${suffix}`, REFRESH_TOKEN],
          [`${prefix}${suffix}`, "empty-user-decoy"],
          ["CognitoIdentityServiceProvider.other-client.approver.refreshToken", "other-client-decoy"],
        ],
        locationOrigin: APP_ORIGIN,
        reads: observations.storageReads,
      });
      sendResult(socket, request, { result: { type: "string", value } });
      return;
    }
    case "Runtime.releaseObject":
      assert.deepEqual(request.params, { objectId: OBJECT_ID });
      assert.equal(request.sessionId, SESSION_ID);
      sendResult(socket, request, {});
      return;
    case "Target.detachFromTarget":
      assert.deepEqual(request.params, { sessionId: SESSION_ID });
      assert.equal(request.sessionId, undefined);
      sendResult(socket, request, {});
      return;
    default:
      assert.fail(`Unexpected method ${request.method}`);
  }
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withChromeServer<T>(scenario: Scenario, run: (observations: Observations) => Promise<T>): Promise<T> {
  return withTemporaryHome(async (home) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const observations: Observations = {
      closed: false,
      connections: 0,
      errors: [],
      extensionsHeader: undefined,
      functionDeclaration: undefined,
      hostHeader: undefined,
      requestPath: undefined,
      requests: [],
      storageReads: [],
    };
    server.on("connection", (socket, request) => {
      observations.connections += 1;
      observations.extensionsHeader = request.headers["sec-websocket-extensions"];
      observations.hostHeader = request.headers.host;
      observations.requestPath = request.url;
      socket.on("close", () => {
        observations.closed = true;
      });
      socket.on("message", (data, isBinary) => {
        try {
          const request = parseRequest(data, isBinary);
          observations.requests.push(request);
          if (!scenario.override?.(socket, request)) {
            respondToValidCommand(socket, request, scenario, observations);
          }
        } catch (error) {
          observations.errors.push(error);
          socket.close();
        }
      });
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeEndpoint(home, `${address.port}\n/devtools/browser/test-browser-id\n`);
    try {
      return await run(observations);
    } finally {
      await closeServer(server);
    }
  });
}

async function expectCliError(promise: Promise<unknown>, code: string, message: string): Promise<CliError> {
  try {
    await promise;
    assert.fail("Expected CliError");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return error;
  }
}

test("Chrome login uses one bounded CDP session and returns a non-renderable single-use token", async () => {
  await withChromeServer({}, async (observations) => {
    assert.deepEqual(Object.keys(chromeAuth), ["readChromeRefreshToken"]);
    const wrapped = await chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID });

    assert.equal(observations.connections, 1);
    assert.equal(observations.closed, true);
    assert.deepEqual(observations.errors, []);
    assert.equal(observations.extensionsHeader, undefined);
    assert.match(observations.hostHeader ?? "", /^127\.0\.0\.1:\d+$/);
    assert.equal(observations.requestPath, "/devtools/browser/test-browser-id");
    assert.deepEqual(observations.requests.map((request) => request.method), [
      "Target.getTargets",
      "Target.attachToTarget",
      "Runtime.runIfWaitingForDebugger",
      "Page.getFrameTree",
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
      "Target.detachFromTarget",
    ]);
    assert.deepEqual(observations.storageReads, [
      `CognitoIdentityServiceProvider.${HOSTILE_CLIENT_ID}.approver.refreshToken`,
    ]);
    const functionDeclaration = observations.functionDeclaration;
    assert.ok(typeof functionDeclaration === "string");
    assert.ok(!functionDeclaration.includes(HOSTILE_CLIENT_ID));
    assert.ok(!functionDeclaration.includes(APP_ORIGIN));

    const mismatchedOriginReads: string[] = [];
    assert.throws(() =>
      invokeReader(functionDeclaration, {
        argumentOrigin: APP_ORIGIN,
        clientId: HOSTILE_CLIENT_ID,
        entries: [],
        locationOrigin: "https://other.example.test",
        reads: mismatchedOriginReads,
      }),
    );
    assert.deepEqual(mismatchedOriginReads, []);

    const duplicateReads: string[] = [];
    const prefix = `CognitoIdentityServiceProvider.${HOSTILE_CLIENT_ID}.`;
    assert.throws(() =>
      invokeReader(functionDeclaration, {
        argumentOrigin: APP_ORIGIN,
        clientId: HOSTILE_CLIENT_ID,
        entries: [
          [`${prefix}one.refreshToken`, REFRESH_TOKEN],
          [`${prefix}two.refreshToken`, REFRESH_TOKEN],
        ],
        locationOrigin: APP_ORIGIN,
        reads: duplicateReads,
      }),
    );
    assert.deepEqual(duplicateReads, []);

    assert.equal(String(wrapped), "[redacted]");
    assert.equal(JSON.stringify(wrapped), '"[redacted]"');
    assert.equal(inspect(wrapped), "[redacted]");
    assert.deepEqual(Object.keys(wrapped), []);
    assert.equal(await wrapped.use(async (token) => token), REFRESH_TOKEN);
    await expectCliError(
      wrapped.use(async () => "unexpected"),
      "chrome_token_consumed",
      "Chrome authentication token was already used",
    );
  });
});

test("Chrome login fails closed when zero or multiple TEAM pages match", async () => {
  for (const targets of [
    [{ targetId: "other", type: "page", url: "https://other.example.test/" }],
    [
      { targetId: "team-page", type: "page", url: `${APP_ORIGIN}/one` },
      { targetId: "team-page-2", type: "page", url: `${APP_ORIGIN}/two` },
    ],
  ]) {
    await withChromeServer({ targets }, async (observations) => {
      await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "chrome_team_tab_required",
        "Open exactly one signed-in TEAM tab in Chrome and retry",
      );
      assert.deepEqual(observations.errors, []);
      assert.deepEqual(observations.requests.map((request) => request.method), ["Target.getTargets"]);
      assert.equal(observations.closed, true);
    });
  }
});

test("Chrome login rejects malformed, oversized, and symlinked endpoint files", async () => {
  for (const contents of [
    "not-a-port\n/devtools/browser/test-browser-id\n",
    "9222\n/devtools/page/not-a-browser\n",
    "9222\n/devtools/browser/..\n",
    "9".repeat(4097),
  ]) {
    await withTemporaryHome(async (home) => {
      await writeEndpoint(home, contents);
      await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "chrome_remote_debugging_unavailable",
        ENDPOINT_ERROR,
      );
    });
  }

  await withTemporaryHome(async (home) => {
    const target = path.join(home, "endpoint-source");
    await fs.writeFile(target, "9222\n/devtools/browser/test-browser-id\n");
    const link = endpointPath(home);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    await expectCliError(
      chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
      "chrome_remote_debugging_unavailable",
      ENDPOINT_ERROR,
    );
  });
});

test("Chrome login rejects malformed protocol data and command results", async () => {
  await withChromeServer(
    {
      override: (socket, request) => {
        if (request.method !== "Target.getTargets") return false;
        socket.send("{");
        return true;
      },
    },
    async (observations) => {
      await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "invalid_chrome_response",
        "Chrome remote debugging returned an invalid response",
      );
      assert.deepEqual(observations.errors, []);
      assert.equal(observations.closed, true);
    },
  );

  await withChromeServer(
    {
      override: (socket, request) => {
        if (request.method !== "Target.getTargets") return false;
        sendResult(socket, request, { targetInfos: "not-an-array" });
        return true;
      },
    },
    async (observations) => {
      await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "invalid_chrome_response",
        "Chrome remote debugging returned an invalid response",
      );
      assert.deepEqual(observations.errors, []);
      assert.equal(observations.closed, true);
    },
  );
});

test("Chrome login verifies the attached main-frame security origin", async () => {
  await withChromeServer({ frameOrigin: "https://SENTINEL-FRAME.invalid" }, async (observations) => {
    const error = await expectCliError(
      chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
      "chrome_origin_mismatch",
      "Chrome TEAM tab origin verification failed",
    );
    assert.ok(!inspect(error).includes("SENTINEL-FRAME"));
    assert.deepEqual(observations.errors, []);
    assert.deepEqual(observations.requests.map((request) => request.method), [
      "Target.getTargets",
      "Target.attachToTarget",
      "Runtime.runIfWaitingForDebugger",
      "Page.getFrameTree",
      "Target.detachFromTarget",
    ]);
    assert.equal(observations.closed, true);
  });
});

test("Chrome login redacts protocol failures and cleans up acquired resources", async () => {
  const sentinelFrame = "https://SENTINEL-FRAME.invalid/private";
  await withChromeServer(
    {
      override: (socket, request) => {
        if (request.method !== "Runtime.callFunctionOn") return false;
        const response: Record<string, unknown> = {
          id: request.id,
          error: {
            code: -32_000,
            message: `failure ${REFRESH_TOKEN}`,
            data: { frame: sentinelFrame },
          },
        };
        if (request.sessionId !== undefined) response.sessionId = request.sessionId;
        socket.send(JSON.stringify(response));
        return true;
      },
    },
    async (observations) => {
      const error = await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "chrome_cdp_failed",
        "Chrome remote debugging command failed",
      );
      const rendered = [error.message, error.stack, JSON.stringify(error), inspect(error)].join("\n");
      assert.ok(!rendered.includes(REFRESH_TOKEN));
      assert.ok(!rendered.includes("SENTINEL-FRAME"));
      assert.equal(error.details, undefined);
      assert.equal(error.cause, undefined);
      assert.deepEqual(observations.errors, []);
      assert.deepEqual(observations.requests.map((request) => request.method), [
        "Target.getTargets",
        "Target.attachToTarget",
        "Runtime.runIfWaitingForDebugger",
        "Page.getFrameTree",
        "Runtime.evaluate",
        "Runtime.callFunctionOn",
        "Runtime.releaseObject",
        "Target.detachFromTarget",
      ]);
      assert.equal(observations.closed, true);
    },
  );
});

test("Chrome login times out without leaking the response or leaving the socket open", async () => {
  await withChromeServer(
    {
      override: (_socket, request) => request.method === "Runtime.callFunctionOn",
    },
    async (observations) => {
      const error = await expectCliError(
        chromeAuth.readChromeRefreshToken({ appUrl: APP_URL, clientId: HOSTILE_CLIENT_ID }),
        "chrome_cdp_timeout",
        "Chrome remote debugging command timed out",
      );
      assert.ok(!inspect(error).includes(REFRESH_TOKEN));
      assert.equal(error.details, undefined);
      assert.equal(observations.closed, true);
    },
  );
});

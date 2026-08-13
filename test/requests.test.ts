import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRequestDraft,
  buildRequestOptions,
  excludeManagementRoles,
  RequestsApi,
  type Entitlement,
} from "../src/requests.js";
import type { AuthSession } from "../src/auth.js";
import { CliError } from "../src/errors.js";

const account = { id: "123456789012", name: "Production" };
const role = {
  id: "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1234567890abcdef",
  name: "PowerUserAccess",
};

const entitlements: Entitlement[] = [
  { accounts: [account], permissions: [role], approvalRequired: true, duration: "4" },
  { accounts: [account], permissions: [role], approvalRequired: false, duration: 8 },
];

test("buildRequestOptions returns unique eligible combinations with the broadest entitlement", () => {
  assert.deepEqual(buildRequestOptions(entitlements), [
    {
      ...account,
      roles: [{ ...role, maxDuration: 8, approvalRequired: false }],
    },
  ]);
});

test("excludeManagementRoles removes roles that TEAM does not allow in delegated requests", () => {
  assert.deepEqual(excludeManagementRoles(buildRequestOptions(entitlements), [role.id]), []);
});

test("buildRequestDraft resolves eligible names and validates policy limits", () => {
  const options = buildRequestOptions(entitlements);
  const draft = buildRequestDraft(options, { ticketRequired: true, maxDuration: 6, approvalRequired: true }, {
    account: "Production",
    role: "PowerUserAccess",
    duration: 6,
    justification: "Production support",
    ticket: "CHANGE123",
    startTime: "2026-08-13T10:00:00Z",
  });
  assert.deepEqual(draft, {
    approvalRequired: false,
    input: {
      accountId: account.id,
      accountName: account.name,
      role: role.name,
      roleId: role.id,
      startTime: "2026-08-13T10:00:00.000Z",
      duration: "6",
      justification: "Production support",
      ticketNo: "CHANGE123",
    },
  });
});

test("buildRequestDraft rejects ineligible and policy-invalid requests", () => {
  const options = buildRequestOptions(entitlements);
  const base = {
    account: account.id,
    role: role.id,
    duration: 4,
    justification: "Production support",
    ticket: "CHANGE123",
  };
  const cases: Array<[Partial<typeof base>, string]> = [
    [{ account: "000000000000" }, "account_not_eligible"],
    [{ role: "ReadOnlyAccess" }, "role_not_eligible"],
    [{ duration: 9 }, "invalid_duration"],
    [{ ticket: "" }, "invalid_ticket"],
    [{ justification: "-invalid" }, "invalid_justification"],
    [{ startTime: "2026-02-30T10:00:00Z" } as Partial<typeof base>, "invalid_start_time"],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => buildRequestDraft(options, { ticketRequired: true, maxDuration: 8, approvalRequired: true }, { ...base, ...override }),
      (error: unknown) => error instanceof CliError && error.code === code,
    );
  }
});

test("RequestsApi creates the validated request through the TEAM mutation", async () => {
  const session: AuthSession = {
    email: "requester@example.com",
    username: "idc_requester",
    accessToken: "access-token",
    idToken: "id-token",
    expiresAt: "2026-08-13T11:00:00Z",
  };
  let body: { query: string; variables: Record<string, unknown> } | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return new Response(
      JSON.stringify({ data: { createRequests: { id: "request-1", status: "pending", createdAt: "now", ...body?.variables.input } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { input } = buildRequestDraft(buildRequestOptions(entitlements), { ticketRequired: true, maxDuration: 8, approvalRequired: true }, {
    account: account.id,
    role: role.id,
    duration: 4,
    justification: "Production support",
    ticket: "CHANGE123",
    startTime: "2026-08-13T10:00:00Z",
  });

  const created = await new RequestsApi(session, "https://example.test/graphql", fetcher).create(input);
  assert.equal(created.id, "request-1");
  assert.deepEqual(body?.variables, { input });
  assert.match(body?.query ?? "", /createRequests/);
});

test("RequestsApi accepts an independent account approver", async () => {
  const session: AuthSession = {
    email: "requester@example.com",
    username: "idc_requester",
    groupIds: ["requester-group"],
    accessToken: "access-token",
    idToken: "id-token",
    expiresAt: "2026-08-13T11:00:00Z",
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
    const data = query.includes("GetApprovers")
      ? { getApprovers: { groupIds: ["approver-group"] } }
      : { listGroups: { members: ["approver-user"] } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.doesNotReject(
    new RequestsApi(session, "https://example.test/graphql", fetcher).assertApproverAvailable(account.id),
  );
});

test("RequestsApi rejects when the requester is the only account and OU approver", async () => {
  const session: AuthSession = {
    email: "requester@example.com",
    username: "idc_requester",
    groupIds: ["approver-group"],
    accessToken: "access-token",
    idToken: "id-token",
    expiresAt: "2026-08-13T11:00:00Z",
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
    const data = query.includes("GetApprovers")
      ? { getApprovers: { groupIds: ["approver-group"] } }
      : query.includes("GetOU")
        ? { getOU: { Id: "ou-1" } }
        : { listGroups: { members: ["requester-user"] } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    new RequestsApi(session, "https://example.test/graphql", fetcher).assertApproverAvailable(account.id),
    (error: unknown) => error instanceof CliError && error.code === "approver_unavailable",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildPendingFilter, TeamApi, type TeamRequest, validateApproval } from "../src/api.js";
import { CliError } from "../src/errors.js";

const request: TeamRequest = {
  id: "request-1",
  email: "requester@example.com",
  accountId: "123456789012",
  accountName: "Example",
  role: "PowerUserAccess",
  roleId: "role-id",
  startTime: "2026-08-12T00:00:00Z",
  duration: "4",
  justification: "Deploy",
  status: "pending",
  comment: null,
  approver: null,
  approvers: ["approver@example.com"],
  ticketNo: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

test("buildPendingFilter matches TEAM's approval queue", () => {
  assert.deepEqual(buildPendingFilter("approver@example.com"), {
    and: [
      { email: { ne: "approver@example.com" } },
      { status: { eq: "pending" } },
      { approvers: { contains: "approver@example.com" } },
    ],
  });
});

test("validateApproval accepts an assigned pending request", () => {
  assert.doesNotThrow(() => validateApproval(request, "approver@example.com"));
});

test("validateApproval rejects non-pending requests", () => {
  assert.throws(
    () => validateApproval({ ...request, status: "approved" }, "approver@example.com"),
    (error: unknown) => error instanceof CliError && error.code === "request_not_pending",
  );
});

test("validateApproval rejects self approval", () => {
  assert.throws(
    () => validateApproval({ ...request, email: "approver@example.com" }, "approver@example.com"),
    (error: unknown) => error instanceof CliError && error.code === "self_approval_forbidden",
  );
});

test("listPending exhausts fixed-size pages before selecting the newest matches", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const responses = [
    { data: { listRequests: { items: [], nextToken: "next" } } },
    { data: { listRequests: { items: [request], nextToken: null } } },
  ];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
    calls.push(body.variables);
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await new TeamApi("token", "https://example.test/graphql", fetcher).listPending(
    "approver@example.com",
    1,
  );

  assert.equal(result.length, 1);
  assert.deepEqual(calls.map((call) => call.limit), [1000, 1000]);
  assert.deepEqual(calls.map((call) => call.nextToken), [null, "next"]);
});

test("approve sends a pending condition and maps AppSync conditional races", async () => {
  let variables: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
    return new Response(
      JSON.stringify({
        errors: [
          {
            message: "The conditional request failed",
            errorType: "DynamoDB:ConditionalCheckFailedException",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await assert.rejects(
    new TeamApi("token", "https://example.test/graphql", fetcher).approve("request-1", "Approved"),
    (error: unknown) => error instanceof CliError && error.code === "request_not_pending",
  );
  assert.deepEqual(variables, {
    input: { id: "request-1", status: "approved", comment: "Approved" },
    condition: { status: { eq: "pending" } },
  });
});

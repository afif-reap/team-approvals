import { getConfig } from "./config.js";
import { CliError } from "./errors.js";

export type TeamRequest = {
  id: string;
  email: string | null;
  accountId: string;
  accountName: string;
  role: string;
  roleId: string;
  startTime: string;
  duration: string;
  justification: string | null;
  status: string | null;
  comment: string | null;
  approver: string | null;
  approvers: string[] | null;
  ticketNo: string | null;
  createdAt: string;
  updatedAt: string;
};

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string; errorType?: string }>;
};

const requestFields = `
  id email accountId accountName role roleId startTime duration justification
  status comment approver approvers ticketNo createdAt updatedAt
`;

const getRequestQuery = `
  query GetRequests($id: ID!) {
    getRequests(id: $id) { ${requestFields} }
  }
`;

const listRequestsQuery = `
  query ListRequests($filter: ModelRequestsFilterInput, $limit: Int, $nextToken: String) {
    listRequests(filter: $filter, limit: $limit, nextToken: $nextToken) {
      items { ${requestFields} }
      nextToken
    }
  }
`;

const actionRequestMutation = `
  mutation ActionRequest($input: UpdateRequestsInput!, $condition: ModelRequestsConditionInput) {
    updateRequests(input: $input, condition: $condition) { ${requestFields} }
  }
`;

export function buildPendingFilter(email: string): Record<string, unknown> {
  return {
    and: [{ email: { ne: email } }, { status: { eq: "pending" } }, { approvers: { contains: email } }],
  };
}

export function validateAction(request: TeamRequest, approverEmail: string): void {
  if (request.status !== "pending") {
    throw new CliError(`Request ${request.id} is ${request.status ?? "missing"}, not pending`, "request_not_pending");
  }
  if (request.email === approverEmail) {
    throw new CliError("TEAM does not allow users to action their own requests", "self_approval_forbidden");
  }
  if (!request.approvers?.includes(approverEmail)) {
    throw new CliError(`You are not an approver for request ${request.id}`, "not_request_approver");
  }
}

export class TeamApi {
  constructor(
    private readonly accessToken: string,
    private readonly graphQlEndpoint = getConfig().graphQlEndpoint,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.graphQlEndpoint, {
      method: "POST",
      headers: {
        authorization: this.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const body = (await response.json()) as GraphQlResponse<T>;
    if (!response.ok || body.errors?.length) {
      const first = body.errors?.[0];
      throw new CliError(
        first?.message ?? `TEAM API request failed with HTTP ${response.status}`,
        first?.errorType?.endsWith("ConditionalCheckFailedException") ? "request_not_pending" : "team_api_error",
        body.errors,
      );
    }
    if (!body.data) throw new CliError("TEAM API returned no data", "invalid_api_response");
    return body.data;
  }

  async getRequest(id: string): Promise<TeamRequest | null> {
    const data = await this.request<{ getRequests: TeamRequest | null }>(getRequestQuery, { id });
    return data.getRequests;
  }

  async check(): Promise<void> {
    await this.request<{ listRequests: { items: TeamRequest[]; nextToken: string | null } }>(listRequestsQuery, {
      limit: 1,
    });
  }

  async listPending(email: string, limit: number): Promise<TeamRequest[]> {
    const items: TeamRequest[] = [];
    let nextToken: string | null = null;
    const seenTokens = new Set<string>();
    const deadline = Date.now() + 30_000;
    do {
      if (Date.now() >= deadline) {
        throw new CliError("TEAM request listing exceeded 30 seconds", "pagination_timeout");
      }
      const data: {
        listRequests: { items: TeamRequest[]; nextToken: string | null };
      } = await this.request(listRequestsQuery, {
        filter: buildPendingFilter(email),
        limit: 1000,
        nextToken,
      });
      items.push(...data.listRequests.items);
      nextToken = data.listRequests.nextToken;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new CliError("TEAM request pagination returned a repeated cursor", "pagination_cursor_repeated");
      }
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);

    return items
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async action(id: string, status: "approved" | "rejected", comment: string): Promise<TeamRequest> {
    const data = await this.request<{ updateRequests: TeamRequest }>(actionRequestMutation, {
      input: { id, status, comment },
      condition: { status: { eq: "pending" } },
    });
    return data.updateRequests;
  }

  approve(id: string, comment: string): Promise<TeamRequest> {
    return this.action(id, "approved", comment);
  }

  reject(id: string, comment: string): Promise<TeamRequest> {
    return this.action(id, "rejected", comment);
  }
}

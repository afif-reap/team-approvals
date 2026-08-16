# team-approvals

`team-approvals` creates and approves AWS TEAM elevated-access requests from the command line. It uses the same Cognito identity and AppSync API as the TEAM web application.

## Install

Requirements: macOS, Node.js 22+, and pnpm.

`make install-local` installs a symlink in `~/.cargo/bin`, which is already on the local `PATH`.

```sh
pnpm install
make install-local
team-approvals init
team-approvals --help
```

`init` run alone in a terminal prompts for the TEAM application URL, discovers the public Amplify settings, shows the result, and asks before replacing an existing config. For automation, pass the URL directly:

```sh
team-approvals init --app-url https://your-team-app.example.com/
```

`init` downloads same-origin JavaScript from the supplied TEAM application, extracts every required public Amplify value, validates the Cognito and AppSync destinations, and creates `~/.config/team-approvals/config.json` with mode `600`. It never evaluates downloaded JavaScript.

Preview the discovered values without writing:

```sh
team-approvals --json init --app-url https://your-team-app.example.com/ --dry-run
```

Use `--force` only to replace an existing config (or answer Yes when prompted interactively). `config.example.json` documents the generated format; deployment-specific values remain outside this repository.

## Authenticate

```sh
team-approvals auth import
team-approvals auth status
```

`auth import` prints the DevTools snippet for copying the refresh token from an existing TEAM browser session, then accepts it in a hidden prompt. The CLI validates it with Cognito, verifies the signed ID token, and stores it under `team-approvals.refresh-token` in macOS Keychain. When it expires or is revoked, import a new token.

```sh
team-approvals auth logout
```

## Interactive mode

When run in a terminal without all required flags, commands launch an interactive wizard instead of erroring. The wizard guides you through each field with selects, type-to-filter lists, and validated inputs.

```sh
team-approvals requests create      # interactive wizard
team-approvals approvals             # interactive review loop
```

Partial flags pre-fill the wizard; only missing fields are prompted:

```sh
team-approvals requests create --account payments-prod   # prompts for role, duration, etc.
```

Interactive mode activates only in a TTY without `--json` or `CI`. Scripts and agents always get the flag-based interface and are never prompted.

## Approvals

```sh
team-approvals approvals list
team-approvals approvals get <request-id>
team-approvals approvals approve <request-id> --dry-run
team-approvals approvals approve <request-id>
team-approvals approvals approve <request-id> --comment "Reviewed and approved"
team-approvals approvals reject <request-id> --comment "Insufficient justification" --dry-run
team-approvals approvals reject <request-id> --comment "Insufficient justification"
```

Running `team-approvals approvals` without a subcommand in a terminal opens an interactive review loop where you can approve, reject, or skip each pending request. Running `approve` or `reject` without a request-id opens the same picker.

Approval and rejection always read the request first, check that it is still pending, block self-action, verify the authenticated email is assigned as an approver, and send an AppSync conditional update requiring `status == pending`. Approval defaults its comment to `Approved via TEAM CLI`; rejection requires an explicit reason.

## Access requests

List account and role combinations from the authenticated user's TEAM entitlement policy:

```sh
team-approvals requests options
```

Create a request interactively (recommended):

```sh
team-approvals requests create
```

Or with explicit flags for scripts and automation:

```sh
team-approvals requests create \
  --account 123456789012 \
  --role PowerUserAccess \
  --duration 4 \
  --ticket CHANGE123 \
  --justification "Production support" \
  --start-time 2026-08-13T10:00:00Z \
  --dry-run
```

Review the dry-run, then rerun the same command with the same `--start-time` and remove `--dry-run` to submit. `--account` accepts an eligible account ID or exact name. `--role` accepts an eligible permission-set ARN or exact name. `--start-time` accepts an RFC 3339 date-time with timezone and defaults to now for direct human use.

The CLI resolves account and role values only from the caller's TEAM entitlement policy, enforces the narrower of policy and global duration limits, honors TEAM's ticket requirement, and submits the same `createRequests` mutation as the web form. TEAM's backend revalidates eligibility before granting access.

## JSON

Pass `--json` before or after subcommands for stable machine-readable output:

```sh
team-approvals --json doctor
team-approvals --json approvals list --limit 20
team-approvals --json approvals approve <request-id> --dry-run
```

Successful list output uses `{ "requests": [...], "count": number }`. Approval uses `{ "approved": true, "request": {...} }`; rejection uses `{ "rejected": true, "request": {...} }`. Errors use `{ "error": { "code": string, "message": string, "details"?: unknown } }` and a nonzero exit code. Tokens are never printed.

## Development

```sh
pnpm check
pnpm build
```

The local deployment config is read only from `~/.config/team-approvals/config.json`; environment variables cannot redirect token or API traffic.

## Agent skill

The portable skill is at `skills/team-approvals/SKILL.md`. Install it using your agent harness's normal skill workflow.

# team-approvals

`team-approvals` lists and approves AWS TEAM elevated-access requests from the command line. It uses the same Cognito user identity and AppSync API as the deployed TEAM web application, preserving TEAM's approver authorization and audit attribution.

## Install

Requirements: macOS, Node.js 22+, pnpm, and a web browser.

`make install-local` installs a symlink in `~/.cargo/bin`, which is already on the local `PATH`.

```sh
pnpm install
make install-local
team-approvals init --app-url https://your-team-app.example.com/
team-approvals --help
```

`init` downloads same-origin JavaScript from the supplied TEAM application, extracts every required public Amplify value, validates the Cognito and AppSync destinations, and creates `~/.config/team-approvals/config.json` with mode `600`. It never evaluates downloaded JavaScript.

Preview the discovered values without writing:

```sh
team-approvals --json init --app-url https://your-team-app.example.com/ --dry-run
```

Use `--force` only to replace an existing config. `config.example.json` documents the generated format; deployment-specific values remain outside this repository.

## Authenticate

```sh
team-approvals auth login
team-approvals auth status
```

`auth login` prints the Cognito authorization URL and opens it in the normal default browser. Immediately after sign-in, copy the full callback URL from the browser address bar and paste it into the CLI prompt before the TEAM application removes the OAuth parameters. Paste it only into the local CLI, never into chat or an agent prompt. The CLI validates the exact redirect origin, OAuth state, and authorization code before exchanging it. No browser extension, native host, automation permission, remote debugging, or temporary profile is required.

Only the refresh token is persisted, under the `team-approvals` service in macOS Keychain. Each later command exchanges it for fresh access and ID tokens automatically and verifies the ID token signature and Cognito claims. When the refresh token expires or is revoked, run `auth login` again.

```sh
team-approvals auth logout
```

## Approvals

```sh
team-approvals approvals list
team-approvals approvals get <request-id>
team-approvals approvals approve <request-id> --dry-run
team-approvals approvals approve <request-id>
team-approvals approvals approve <request-id> --comment "Reviewed and approved"
```

The default comment is `Approved via TEAM CLI`. Approval always reads the request first, checks that it is still pending, rejects self-approval, verifies the authenticated email is assigned as an approver, and sends an AppSync conditional update requiring `status == pending`.

## JSON

Pass `--json` before or after subcommands for stable machine-readable output:

```sh
team-approvals --json doctor
team-approvals --json approvals list --limit 20
team-approvals --json approvals approve <request-id> --dry-run
```

Successful list output uses `{ "requests": [...], "count": number }`. Approval uses `{ "approved": true, "request": {...} }`. Errors use `{ "error": { "code": string, "message": string, "details"?: unknown } }` and a nonzero exit code. Tokens are never printed.

## Development

```sh
pnpm check
pnpm build
```

The local deployment config is read only from `~/.config/team-approvals/config.json`; environment variables cannot redirect token or API traffic.

## Agent skill

The repository includes a portable agent skill at `skills/team-approvals/SKILL.md`. It teaches agents the authenticated read-first workflow and prevents ambiguous, bulk, self, stale, or unauthorized approvals.

Agent runtimes that load repository skills from `skills/` can use it directly. Keep this path as the canonical skill and point runtime-specific installers at it rather than copying the file.

To make the skill available to agents from any workspace, symlink it into the personal OpenCode skills directory:

```sh
make install-agent-skill
```

The target symlinks `skills/team-approvals` to `~/.config/opencode/skills/team-approvals`. A symlink keeps the installed skill updated when this repository is updated. Restart OpenCode after installing it, then ask an agent to check TEAM approvals or explicitly load the `team-approvals` skill.

Verify the installation:

```sh
test -f ~/.config/opencode/skills/team-approvals/SKILL.md
team-approvals --json doctor
```

If `~/.config/opencode/skills/team-approvals` already exists, remove or rename that existing installation before creating the symlink. Do not replace it until any local customizations have been reviewed.

# team-approvals

`team-approvals` lists and approves AWS TEAM elevated-access requests from the command line. It uses the same Cognito user identity and AppSync API as the deployed TEAM web application, preserving TEAM's approver authorization and audit attribution.

## Install

Requirements: macOS, Node.js 22+, pnpm, Google Chrome, and the Opzero Chrome extension/native host.

`make install-local` installs a symlink in `~/.cargo/bin`, which is already on the local `PATH`.

Create the local deployment config before building:

```sh
mkdir -p ~/.config/team-approvals
cp config.example.json ~/.config/team-approvals/config.json
chmod 600 ~/.config/team-approvals/config.json
```

Fill in the public deployment identifiers from the TEAM web application's Amplify configuration. The CLI validates that Cognito and AppSync destinations are HTTPS AWS service endpoints. The real config remains outside this repository.

```sh
pnpm install
make install-local
team-approvals --help
```

## Authenticate

```sh
team-approvals auth login
team-approvals auth status
```

`auth login` opens a dedicated Chrome tab for Cognito's authorization-code + PKCE flow. Only the refresh token is persisted, under the `team-approvals` service in macOS Keychain. Each later command exchanges it for fresh access and ID tokens automatically and verifies the ID token signature and Cognito claims. When the refresh token expires or is revoked, run `auth login` again.

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

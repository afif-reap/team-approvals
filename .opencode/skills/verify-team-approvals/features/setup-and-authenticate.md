# Set up and authenticate

Setup discovers public TEAM deployment settings, while authentication imports, checks, or removes the user's Cognito session from macOS Keychain.

## Sub-features

- `setup-discover` discovers and validates TEAM web-app configuration.
- `setup-write` creates or explicitly replaces the local mode-600 config.
- `auth-chrome-login` imports authentication from one signed-in TEAM tab through Chrome's built-in remote debugging.
- `auth-import` validates and stores a pasted refresh token through hidden TTY input.
- `auth-status` reports the authenticated identity and token expiry.
- `auth-logout` revokes and deletes stored authentication.
- `doctor` checks config, authentication, and TEAM API reachability together.

## How to get to it (user POV)

- Run `team-approvals init` in a terminal and enter a TEAM application URL.
- Run `team-approvals --json init --app-url <TEAM-URL> --dry-run` for non-interactive discovery.
- Run `team-approvals auth login --chrome` in a terminal with one signed-in TEAM tab.
- Run `team-approvals auth import`, `team-approvals --json auth status`, or `team-approvals auth logout`.
- Run `team-approvals --json doctor`.

## Driving it with control-team-approvals

Preconditions:

- The compiled CLI is current.
- Routine verification uses the existing config and current-format Keychain item read-only. A legacy credential can migrate on first read.
- The user, not the agent, handles any refresh token in their own terminal.

- **Health check.** Run `.opencode/skills/verify-team-approvals/scripts/control-team-approvals doctor`. Exit code is `0`; JSON has `ok: true`, authenticated identity, and reachable API.
- **Authentication status.** Run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture auth-status -- --json auth status`. Exit code is `0`, stderr is empty, and stdout has `authenticated: true`, an email, and `expires_at`.
- **Discovery dry-run.** If setup discovery changed, run `shasum -a 256 ~/.config/team-approvals/config.json` and `stat -f '%Lp' ~/.config/team-approvals/config.json`. Then run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture setup-discovery -- --json init --app-url <TEAM-URL> --dry-run`. Repeat the hash and mode commands. The capture returns `written: false`; the content hash and mode are unchanged. Redact discovered deployment values before publishing.
- **Chrome login.** Only when authentication is unavailable, ask the user to follow the repository README and run `team-approvals auth login --chrome` in an unrecorded terminal. Do not automate Chrome's native **Allow** action or record browser debugging traffic. After the command closes its socket, run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture auth-after-chrome-login -- --json auth status`.
- **TTY import.** Only when authentication is unavailable, ask the user to run `team-approvals auth import` in an unrecorded terminal. After the user finishes, run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture auth-after-import -- --json auth status`. The user must handle the hidden token input because no safe artifact can contain it.
- **Authorized config write.** Only when the user asks to create the config, run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture setup-write -- --json init --app-url <TEAM-URL>`. Add `--force` only when the user asks to replace an existing config. Require mode `600`, then run doctor. Do not replace an existing config solely for proof.
- **Authorized logout.** Only when the user asks to remove authentication, run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture auth-logout -- --json auth logout`. Then run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture auth-after-logout -- --json auth status`. The first output reports `authenticated: false`; the status command fails with the documented missing-auth error. Do not log out solely for proof.

## Gotchas

- Config and Keychain state are shared with the installed CLI and cannot be redirected by environment variables.
- `doctor` refreshes Cognito authentication and calls the live AppSync API, but does not mutate TEAM requests.
- `init --dry-run` performs network reads even though it does not write the config.
- Chrome login supports Google Chrome Stable's default macOS profile. Disable remote debugging after login finishes.
- Chrome's **Allow** action grants temporary debugging access to the whole browser profile. Never drive that consent solely for verification.
- Never put a token in command arguments, shell history, transcripts, artifacts, or chat.
- Do not publish doctor or discovery output without redacting identity and deployment data.

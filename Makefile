.PHONY: check install-local install-agent-skill

check:
	pnpm check

install-local: check
	pnpm build
	chmod +x "$(CURDIR)/dist/cli.js"
	mkdir -p "$(HOME)/.cargo/bin"
	ln -sf "$(CURDIR)/dist/cli.js" "$(HOME)/.cargo/bin/team-approvals"

install-agent-skill:
	mkdir -p "$(HOME)/.config/opencode/skills"
	@if [ -L "$(HOME)/.config/opencode/skills/team-approvals" ] && [ "$$(readlink "$(HOME)/.config/opencode/skills/team-approvals")" = "$(CURDIR)/skills/team-approvals" ]; then exit 0; fi; \
	if [ -e "$(HOME)/.config/opencode/skills/team-approvals" ] || [ -L "$(HOME)/.config/opencode/skills/team-approvals" ]; then echo "team-approvals skill already exists" >&2; exit 1; fi; \
	ln -s "$(CURDIR)/skills/team-approvals" "$(HOME)/.config/opencode/skills/team-approvals"

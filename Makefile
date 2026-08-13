.PHONY: check install-local

check:
	pnpm check

install-local: check
	pnpm build
	chmod +x "$(CURDIR)/dist/cli.js"
	mkdir -p "$(HOME)/.cargo/bin"
	ln -sf "$(CURDIR)/dist/cli.js" "$(HOME)/.cargo/bin/team-approvals"

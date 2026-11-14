SHELL := /bin/bash
.DEFAULT_GOAL := help
BUN ?= bun
-include .env
export
VAE := python3 tmp/vae-tooling/plugin/scripts/vae.py

.PHONY: help setup build lint test coverage e2e verify bench bench-scale metrics vae-setup vae prose release start stop restart status log
help: ## List available targets.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "%-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
setup: ## Install pinned dependencies, Chromium and the VAE runtime.
	@if command -v mise >/dev/null 2>&1; then mise install; fi
	$(BUN) install --frozen-lockfile
	$(BUN) x playwright install chromium
	$(BUN) scripts/vae.ts
build: ## Build ESM, CommonJS and declarations.
	$(BUN) run build
lint: ## Typecheck, lint and enforce source-folder architecture documentation.
	$(BUN) run lint
	$(BUN) x tsc -p tsconfig.browser.json
	$(BUN) scripts/check-architecture.ts
test: ## Test actual memory and native storage, replay and recovery.
	$(BUN) run test
coverage: ## Measure production-code coverage with enforced thresholds.
	$(BUN) run coverage
e2e: build ## Install the tarball and test Node, Bun and a real Chromium worker.
	$(BUN) scripts/e2e.ts
verify: lint test coverage e2e ## Execute the complete automated verification suite.
bench: build ## Compare v0.2/v0.3 across Node/Bun, native async/sync and memory.
	$(BUN) scripts/bench.ts
bench-scale: build ## Compare 10000-record native async workloads with three measured rounds.
	$(BUN) scripts/bench.ts --scale
metrics: ## Print the last benchmark report.
	@cat output/bench.json
vae-setup: ## Extract the pinned VAE runtime without network access.
	$(BUN) scripts/vae.ts
vae: vae-setup ## Run VAE verification, review and documentation gates.
	$(VAE) gate --repo . --session dbsonl-release
prose: vae-setup ## Check project documentation with VAE.
	$(VAE) prose --repo .
release: verify bench vae ## Build a complete local ZIP and installable tarball.
	$(BUN) scripts/release.ts
start stop restart status log: ## This library has no background service.
	@echo "$@: no service"

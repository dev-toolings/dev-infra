.PHONY: help install uninstall up up-async down restart ps logs doctor dev pair db-create db-list test feature-env-test version release

DEVHUB := ./bin/devhub
BUMP ?= patch

.DEFAULT_GOAL := help
C_SECTION := \033[1;33m
C_TARGET := \033[36m
C_OK := \033[32m
C_WARN := \033[33m
C_ERR := \033[31m
C_RESET := \033[0m

# --- Help ---
help: ## Show grouped targets
	@awk -v section='$(C_SECTION)' -v target='$(C_TARGET)' -v reset='$(C_RESET)' '/^# --- / { title=$$0; sub(/^# --- /,"",title); sub(/ ---$$/,"",title); printf "\n%s%s%s\n", section,title,reset } /^[a-zA-Z0-9_-]+:.*## / { name=$$1; sub(/:$$/,"",name); sub(/^.*## /,"",$$0); printf "  %s%-16s%s %s\n",target,name,reset,$$0 }' $(MAKEFILE_LIST)

# --- Install ---
install: ## Install CLI and shell shortcuts
	@./data/scripts/install.sh

uninstall: ## Remove CLI and shell shortcuts
	@./data/scripts/uninstall.sh

# --- Services ---
up: ## Start core and async
	@$(DEVHUB) up

up-async: ## Start core and async (compatibility alias)
	@$(DEVHUB) up --with async

down: ## Stop shared containers, keep volumes
	@$(DEVHUB) down

restart: ## Restart core and async
	@$(DEVHUB) restart

ps: ## Show service status
	@$(DEVHUB) ps

logs: ## Follow service logs
	@$(DEVHUB) logs

doctor: ## Check health, network and configured ports
	@$(DEVHUB) doctor

# --- Dev servers ---
dev: ## Start the control panel (Vite on 5175) and its local API
	@$(DEVHUB) serve --dev

pair: ## Create a one-time pairing code for the control panel
	@$(DEVHUB) pair

# --- Databases ---
db-create: ## Create PostgreSQL database (DB=name)
	@$(DEVHUB) db create $(DB)

db-list: ## List PostgreSQL databases
	@$(DEVHUB) db list

# --- Checks ---
test: ## Run CLI Bats tests
	@bats tests/*.bats

feature-env-test: ## Run the isolated feature environment Docker scenario
	@python3 tests/feature-environments.py
	@python3 tests/feature-recovery.py
	@python3 tests/feature-project.py
	@python3 tests/feature-hmr.py

# --- Releases ---
version: ## Show installed version
	@$(DEVHUB) version

release: ## Cut release (BUMP=patch|minor|major|X.Y.Z)
	@./data/scripts/release.sh $(BUMP)

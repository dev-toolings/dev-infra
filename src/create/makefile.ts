export type MakeTask = { name: string; about: string; command: string };
export type MakeOptions = { id: string; docker: boolean; install: string; checks: MakeTask[]; tools?: MakeTask[]; database?: MakeTask[] };

const banner = (title: string) => `# ─── ${title} ${"─".repeat(Math.max(3, 70 - title.length))}`;
const target = ({ name, about, command }: MakeTask) => [`${name}: ## ${about}`, `\t${command}`, ""];
const inApp = (task: MakeTask): MakeTask => ({ ...task, command: `$(EXEC) ${task.command}` });

/** Help reads the banners, so `make help` always follows the file. Commands run where the project runs: its container, or this machine. */
export function makefile({ id, docker, install, checks, tools = [], database = [] }: MakeOptions): string {
  const devhub = (name: string, about: string): MakeTask => ({ name, about, command: `@$(DEVHUB) project ${name} $(PROJECT)` });
  const lifecycle = [devhub("start", "Start the project"), devhub("stop", "Stop the project"), devhub("restart", "Restart the project"), devhub("status", "Show its state"), devhub("logs", "Show its logs")];
  const sections: [string, MakeTask[]][] = [
    ["Project", [...lifecycle, ...(docker ? [{ name: "shell", about: "Open a shell in the container", command: "$(EXEC) sh" }] : [])]],
    ["Dependencies", [inApp({ name: "install", about: "Install the dependencies", command: install })]],
    ["Code quality", tools.map(inApp)],
    ["Database", database.map(inApp)],
    ["Image", docker ? [{ name: "image", about: "Build the image for preprod and prod", command: "docker build --target prod -t $(PROJECT):prod ." }] : []],
  ];
  const names = ["help", ...sections.flatMap(([, tasks]) => tasks.map((task) => task.name)), ...checks.map((task) => task.name), "check"];
  return [
    `.PHONY: ${names.join(" ")}`,
    "",
    ".DEFAULT_GOAL := help",
    `PROJECT := ${id}`,
    "DEVHUB ?= devhub",
    `EXEC ?= ${docker ? "docker compose -p devhub-$(PROJECT) exec app" : ""}`.trimEnd(),
    "",
    "C_SECTION := \\033[1;33m",
    "C_TARGET := \\033[36m",
    "C_OK := \\033[32m",
    "C_WARN := \\033[33m",
    "C_ERR := \\033[31m",
    "C_RESET := \\033[0m",
    "",
    banner("Help"),
    "help: ## Show the targets by section",
    `\t@awk -v section='$(C_SECTION)' -v target='$(C_TARGET)' -v reset='$(C_RESET)' '/^# ─── / { title=$$0; sub(/^# ─── /, "", title); sub(/ ───.*$$/, "", title); printf "\\n%s%s%s\\n", section, title, reset } /^[a-zA-Z0-9_-]+:.*## / { name=$$1; sub(/:.*/, "", name); about=$$0; sub(/^[^#]*## /, "", about); printf "  %s%-12s%s %s\\n", target, name, reset, about }' $(MAKEFILE_LIST)`,
    "",
    ...sections.filter(([, tasks]) => tasks.length).flatMap(([title, tasks]) => [banner(title), ...tasks.flatMap(target)]),
    banner("Checks"),
    ...checks.map(inApp).flatMap(target),
    `check: ${checks.map((task) => task.name).join(" ")} ## Run every check`,
    "\t@printf '$(C_OK)[make] All checks pass$(C_RESET)\\n'",
    "",
  ].join("\n");
}

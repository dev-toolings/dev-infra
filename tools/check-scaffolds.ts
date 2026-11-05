/**
 * Generates each code option of the catalog, bare and with services, and runs the checks of the new project.
 * Usage: bun run check:scaffolds [node|python|php]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recipe } from "../src/create";
import { STACKS } from "../src/create/catalog";
import type { StackDefinition } from "../src/contracts";

const ALL_SERVICES = ["postgres", "redis", "mailpit"];

/** Options that change the code. Docker-only ones change the image, which this does not build. */
function combinations(stack: StackDefinition): Record<string, string>[] {
  let results: Record<string, string>[] = [{}];
  for (const option of stack.options.filter((item) => !item.docker)) {
    results = results.flatMap((chosen) => {
      if (option.when && chosen[option.when.option] !== option.when.value) return [chosen];
      return option.choices.map((choice) => ({ ...chosen, [option.id]: choice.value }));
    });
  }
  return results;
}

/** Same scripts through Bun: this repository does not run npm. */
const withoutNpm = (command: string) => command === "npm install" ? "bun install" : command.replace(/^npm (run )?/, "bun run ");

async function run(command: string, cwd: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
}

async function check(stack: string, options: Record<string, string>, services: string[], mode: "native" | "docker" = "native"): Promise<boolean> {
  const label = [stack, mode === "docker" ? "docker" : "", ...Object.values(options), ...services].filter(Boolean).join(" ");
  const root = mkdtempSync(join(tmpdir(), "devhub-scaffold-"));
  try {
    const { files, install, checks } = recipe(stack, "scaffold", mode, 4100, options, services);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    // Neither needs a database: drizzle-kit reads the schema, and alembic reads its migrations.
    const migrations = options.orm === "drizzle" ? ["bun run db:generate"] : options.orm === "sqlalchemy" ? ["uv run alembic heads"] : [];
    for (const command of ["git init -q", install, ...migrations, ...checks].map(withoutNpm)) {
      const { code, output } = await run(command, root);
      if (code === 0) continue;
      console.log(`FAIL ${label}: ${command}\n${output.trim().split("\n").slice(-25).join("\n")}`);
      return false;
    }
    console.log(`PASS ${label}`);
    return true;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const only = process.argv[2];
let failed = 0, total = 0;
for (const stack of STACKS.filter((item) => !only || item.id === only)) {
  for (const options of combinations(stack)) {
    const needed = stack.options.flatMap((option) => option.choices.find((choice) => choice.value === options[option.id])?.services ?? []);
    for (const services of [needed, ALL_SERVICES]) {
      total += 1;
      if (!(await check(stack.id, options, services))) failed += 1;
    }
    // Octane is a dependency of Docker projects only.
    if (options.framework === "laravel") {
      total += 1;
      if (!(await check(stack.id, options, needed, "docker"))) failed += 1;
    }
  }
}
console.log(`${total - failed}/${total} passed`);
process.exit(failed > 0 || total === 0 ? 1 : 0);

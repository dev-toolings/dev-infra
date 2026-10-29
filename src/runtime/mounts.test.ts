import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSharedDataUntouched } from "./mounts";

test("mount policy catches symlink aliases, driver-backed devices and shared volumes", () => {
  const base = mkdtempSync(join(tmpdir(), "devhub-mounts-"));
  try {
    const state = join(base, "state"); mkdirSync(state);
    const alias = join(base, "alias"); symlinkSync(state, alias);
    expect(() => assertSharedDataUntouched({ services: { web: { volumes: [{ type: "bind", source: join(alias, "catalog.sqlite") }] } } }, ["web"], state)).toThrow("Docker socket or DevHub data");
    expect(() => assertSharedDataUntouched({ services: { web: { volumes: [{ type: "volume", source: "data" }] } }, volumes: { data: { driver_opts: { type: "none", o: "bind", device: alias } } } }, ["web"], state)).toThrow("Docker socket or DevHub data");
    expect(() => assertSharedDataUntouched({ services: { web: { volumes: ["pg:/var/lib/postgresql/data"] } }, volumes: { pg: { name: "dev-infra_infra_postgres_data", external: true } } }, ["web"], state)).toThrow("shared DevHub volumes");
    expect(() => assertSharedDataUntouched({ services: { web: { volumes: [{ type: "bind", source: join(base, "app") }, { type: "volume", source: "cache" }] } }, volumes: { cache: { name: "shop_cache" } } }, ["web"], state)).not.toThrow();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

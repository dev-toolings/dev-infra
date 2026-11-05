import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSharedDataUntouched, managedEntry, sharedVolumeName, type ComposeModel } from "./mounts";

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

test("Docker volume storage is protected even behind a harmless volume name", () => {
  const device = "/var/lib/docker/volumes/dev-infra_infra_postgres_data/_data";
  expect(() => assertSharedDataUntouched({ services: { web: { volumes: [{ type: "volume", source: "data" }] } }, volumes: { data: { name: "shop_data", driver_opts: { type: "none", o: "bind", device } } } }, ["web"], "/tmp/devhub-state-fixture")).toThrow("Docker socket or DevHub data");
  expect(() => assertSharedDataUntouched({ services: { web: { volumes: [{ type: "bind", source: device }] } } }, ["web"], "/tmp/devhub-state-fixture")).toThrow("Docker socket or DevHub data");
});

test("the volumes of service instances are protected like the shared ones", () => {
  for (const name of ["infra_postgres_data", "infra_postgres_17_data", "infra_mysql_8_4_data", "dev-infra_infra_mysql_8_4_data"]) expect(sharedVolumeName(name)).toBe(true);
  for (const name of ["shop_data", "infra_cache_data", "shop_infra_cache_data", "devhub-shop_node_modules"]) expect(sharedVolumeName(name)).toBe(false);
});

test("a managed stack may mount only its own start script, and only read-only", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devhub-entry-"));
  try {
    const entry = managedEntry(stateDir, "shop"), other = managedEntry(stateDir, "bank");
    const check = (volumes: NonNullable<NonNullable<ComposeModel["services"]>[string]>["volumes"], allowed?: string) => () => assertSharedDataUntouched({ services: { app: { volumes } } }, ["app"], stateDir, allowed);
    expect(check([`${entry}:/devhub/entry.sh:ro`], entry)).not.toThrow();
    expect(check([{ type: "bind", source: entry, read_only: true }], entry)).not.toThrow();
    expect(check([`${entry}:/devhub/entry.sh`], entry)).toThrow("cannot mount");
    expect(check([{ type: "bind", source: entry }], entry)).toThrow("cannot mount");
    expect(check([`${other}:/devhub/entry.sh:ro`], entry)).toThrow("cannot mount");
    expect(check([`${entry}:/devhub/entry.sh:ro`])).toThrow("cannot mount");
    expect(check([`${join(stateDir, "catalog.sqlite")}:/data:ro`], entry)).toThrow("cannot mount");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

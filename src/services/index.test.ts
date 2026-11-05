import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { DiscoveryPort, Executor } from "../contracts";
import { SERVICE_OPTIONS, SharedServices, projectNetwork } from "./index";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(healthy: string[] = [], volumes: string[] = []) {
  const stateDir = mkdtempSync(join(tmpdir(), "devhub-services-")); dirs.push(stateDir);
  const commands: string[][] = [], up = new Set(healthy);
  const run: Executor = async (argv) => {
    commands.push(argv);
    if (argv[1] === "inspect") return { code: 0, stdout: up.has(argv.at(-1)!) ? "healthy\n" : "starting\n", stderr: "" };
    if (argv[1] === "volume") return { code: volumes.includes(argv.at(-1)!) ? 0 : 1, stdout: "", stderr: "" };
    if (argv[1] === "port") return { code: 0, stdout: "127.0.0.1:15000\n", stderr: "" };
    if (argv[1] === "compose") up.add(argv[3]!);
    if (argv[1]?.endsWith("bin/devhub")) up.add("infra-mariadb");
    return { code: 0, stdout: "", stderr: "" };
  };
  const discovery = { freePort: async (start: number) => start } as unknown as DiscoveryPort;
  return { stateDir, commands, services: new SharedServices({ run, discovery, stateDir, infraDir: "/infra" }) };
}

test("the shared version stays the compose container and is not recreated when healthy", async () => {
  const { commands, services } = fixture(["infra-postgres"]);
  expect(await services.ensure("postgres", "16")).toEqual({ container: "infra-postgres", port: 5432, hostPort: 15000 });
  expect(commands.some((argv) => argv.includes("up"))).toBe(false);
});

test("a stopped shared service starts through devhub up", async () => {
  const { commands, services } = fixture();
  await services.ensure("mariadb", "12.3");
  expect(commands.find((argv) => argv.includes("up"))).toEqual(["bash", "/infra/bin/devhub", "up"]);
});

test("another version gets its own container, volume and port, and keeps them on the next start", async () => {
  const { stateDir, commands, services } = fixture();
  expect(await services.ensure("postgres", "17")).toEqual({ container: "infra-postgres-17", port: 5432, hostPort: 15000, admin: "devhub" });
  const file = join(stateDir, "services", "infra-postgres-17", "compose.yml");
  const before = readFileSync(file, "utf8");
  const compose = parse(before);
  expect(compose.services.service.image).toBe("postgres:17-alpine");
  expect(compose.services.service.ports).toEqual(["127.0.0.1:15000:5432"]);
  expect(compose.services.service.volumes).toEqual(["data:/var/lib/postgresql/data"]);
  expect(compose.volumes.data.name).toBe("infra_postgres_17_data");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(commands.find((argv) => argv[1] === "compose")).toEqual(["docker", "compose", "-p", "infra-postgres-17", "-f", file, "up", "-d"]);

  const again = new SharedServices({ run: async (argv) => argv[1] === "inspect" ? { code: 0, stdout: "healthy\n", stderr: "" } : { code: 0, stdout: "127.0.0.1:15000\n", stderr: "" }, discovery: { freePort: async () => 16000 } as unknown as DiscoveryPort, stateDir, infraDir: "/infra" });
  await again.ensure("postgres", "17");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("Postgres 18 mounts the folder its image expects", async () => {
  const { stateDir, services } = fixture();
  await services.ensure("postgres", "18");
  expect(parse(readFileSync(join(stateDir, "services", "infra-postgres-18", "compose.yml"), "utf8")).services.service.volumes).toEqual(["data:/var/lib/postgresql"]);
});

test("every service keeps its shared version in its list", () => {
  for (const service of SERVICE_OPTIONS) expect(service.versions).toContain(service.default);
});

test("a stopped instance keeps its port: the next one takes another", async () => {
  const { stateDir, services } = fixture();
  await services.ensure("postgres", "17");
  await services.ensure("redis", "8");
  expect(parse(readFileSync(join(stateDir, "services", "infra-redis-8", "compose.yml"), "utf8")).services.service.ports).toEqual(["127.0.0.1:15001:6379"]);
});

test("a volume without its compose file is refused, since a new secret could not open it", async () => {
  const { services } = fixture([], ["infra_mysql_8_4_data"]);
  await expect(services.ensure("mysql", "8.4")).rejects.toThrow("Volume infra_mysql_8_4_data exists");
});

test("a project gets a new network when its services change, whatever their order", () => {
  expect(projectNetwork("shop", ["infra-redis", "infra-postgres"])).toBe(projectNetwork("shop", ["infra-postgres", "infra-redis"]));
  expect(projectNetwork("shop", ["infra-postgres"])).not.toBe(projectNetwork("shop", ["infra-postgres-17"]));
});

test("simultaneous first starts create one instance per version, each on its own port", async () => {
  const { stateDir, commands, services } = fixture();
  await Promise.all([services.ensure("postgres", "17"), services.ensure("postgres", "17"), services.ensure("redis", "8")]);
  expect(commands.filter((argv) => argv[1] === "compose").map((argv) => argv[3])).toEqual(["infra-postgres-17", "infra-redis-8"]);
  const port = (container: string) => parse(readFileSync(join(stateDir, "services", container, "compose.yml"), "utf8")).services.service.ports[0].split(":")[1];
  expect(port("infra-postgres-17")).not.toBe(port("infra-redis-8"));
});

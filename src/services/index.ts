import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { DevHubError, type DiscoveryPort, type Executor, type ServiceInstance, type ServiceOption, type SharedServicesPort } from "../contracts";

const FIRST_INSTANCE_PORT = 15000;
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 2_000;
const INSTANCE_ADMIN = "devhub";
const NETWORK = "dev-shared-net";

/** How a version other than the shared one runs: same engine, its own secret, volume and port. */
type Instance = { image: string; data: string; health: string[]; environment?: Record<string, string>; command?: string[]; hostname?: string };
type Definition = ServiceOption & { port: number; instance?: (secret: string, container: string, version: string) => Instance };

/** `default` is the version of the container in compose.yml, which every project on that version shares. */
const SERVICES: Definition[] = [{
  id: "postgres", name: "PostgreSQL", versions: ["18", "17", "16", "15"], default: "16", port: 5432,
  instance: (secret, _container, version) => ({
    image: `postgres:${version}-alpine`,
    // From 18 the image keeps its data in a versioned folder under this path.
    data: Number(version) >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data",
    // Over TCP: the server that initializes the data directory listens only on its socket.
    health: ["CMD-SHELL", `pg_isready -h 127.0.0.1 -U ${INSTANCE_ADMIN} -d ${INSTANCE_ADMIN}`],
    environment: { POSTGRES_DB: INSTANCE_ADMIN, POSTGRES_USER: INSTANCE_ADMIN, POSTGRES_PASSWORD: secret, POSTGRES_INITDB_ARGS: "--encoding=UTF8 --lc-collate=C --lc-ctype=C" },
  }),
}, {
  id: "mysql", name: "MySQL", versions: ["9.7", "8.4", "8.0"], default: "8.0", port: 3306,
  instance: (secret, _container, version) => ({ image: `mysql:${version}`, data: "/var/lib/mysql", health: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"], environment: { MYSQL_ROOT_PASSWORD: secret } }),
}, {
  id: "mariadb", name: "MariaDB", versions: ["12.3", "11.8", "11.4", "10.11"], default: "12.3", port: 3306,
  instance: (secret, _container, version) => ({ image: `mariadb:${version}`, data: "/var/lib/mysql", health: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"], environment: { MARIADB_ROOT_PASSWORD: secret } }),
}, {
  id: "redis", name: "Redis", versions: ["8", "7"], default: "7", port: 6379,
  instance: (_secret, _container, version) => ({ image: `redis:${version}-alpine`, data: "/data", health: ["CMD", "redis-cli", "ping"], command: ["redis-server", "--appendonly", "yes", "--maxmemory", "512mb", "--maxmemory-policy", "allkeys-lru"] }),
}, {
  id: "meilisearch", name: "Meilisearch", versions: ["v1.48"], default: "v1.48", port: 7700,
}, {
  id: "rabbitmq", name: "RabbitMQ", versions: ["4", "4.4", "4.3"], default: "4", port: 5672,
  instance: (secret, container, version) => ({
    image: `rabbitmq:${version}-management-alpine`, data: "/var/lib/rabbitmq", health: ["CMD", "rabbitmq-diagnostics", "ping"], hostname: container,
    environment: { RABBITMQ_NODENAME: `rabbit@${container}`, RABBITMQ_DEFAULT_USER: INSTANCE_ADMIN, RABBITMQ_DEFAULT_PASS: secret, RABBITMQ_DEFAULT_VHOST: "/" },
  }),
}, {
  id: "mailpit", name: "Mailpit", versions: ["v1.30.7"], default: "v1.30.7", port: 1025,
}];

export const SERVICE_OPTIONS: ServiceOption[] = SERVICES.map(({ id, name, versions, default: fallback }) => ({ id, name, versions, default: fallback }));

const containerName = (service: ServiceOption, version: string) => version === service.default ? `infra-${service.id}` : `infra-${service.id}-${version.replace(/\./g, "-")}`;
export const serviceContainer = (id: string, version: string) => containerName(SERVICE_OPTIONS.find((service) => service.id === id)!, version);
/** Every container a project may join: a managed stack reaches nothing else. */
export const SERVICE_CONTAINERS = SERVICES.flatMap((service) => service.versions.map((version) => containerName(service, version)));

/** Docker cannot change the label of a network: a project whose services change gets a new network, so `devhub up` reconnects the right ones. */
export const projectNetwork = (id: string, infra: string[]) => `devhub-${id}-${createHash("sha256").update([...infra].sort().join(",")).digest("hex").slice(0, 8)}`;

const fail = (message: string): never => { throw new DevHubError(message, "provisioning_failed", 409); };

type Options = { run: Executor; discovery: DiscoveryPort; stateDir: string; infraDir: string };

/** Runs the shared services: compose.yml owns the default version of each, this class the instances of other versions. */
export class SharedServices implements SharedServicesPort {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Options) {}

  /** One at a time: a second first start would rewrite the secret of the instance, or take the same port. */
  ensure(id: string, version: string): Promise<ServiceInstance> {
    const turn = this.queue.then(() => this.reach(id, version));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async reach(id: string, version: string): Promise<ServiceInstance> {
    const service = SERVICES.find((item) => item.id === id) ?? fail(`Unknown service: ${id}`);
    const shared = version === service.default;
    const container = containerName(service, version);
    if (await this.health(container) !== "healthy") {
      await (shared ? this.startShared() : this.startInstance(service, version, container));
      await this.waitHealthy(container);
    }
    const published = await this.options.run(["docker", "port", container, String(service.port)], { timeoutMs: 10_000, maxOutputBytes: 8_000 });
    const hostPort = Number(/:(\d+)\s*$/m.exec(published.stdout)?.[1]) || fail(`${container} publishes no port`);
    return { container, port: service.port, hostPort, ...(!shared && id === "postgres" ? { admin: INSTANCE_ADMIN } : {}) };
  }

  async containerEnv(container: string, name: string): Promise<string> {
    const result = await this.options.run(["docker", "exec", container, "printenv", name], { timeoutMs: 10_000, maxOutputBytes: 8_000 });
    return result.code === 0 ? result.stdout.trim() : fail(`${container} has no ${name}`);
  }

  private async health(container: string): Promise<string> {
    const result = await this.options.run(["docker", "inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", container], { timeoutMs: 10_000, maxOutputBytes: 8_000 });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private async waitHealthy(container: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (await this.health(container) !== "healthy") {
      if (Date.now() >= deadline) fail(`${container} did not become healthy; check it with devhub ps`);
      await Bun.sleep(HEALTH_POLL_MS);
    }
  }

  private async startShared(): Promise<void> {
    const { run, infraDir } = this.options;
    const started = await run(["bash", resolve(infraDir, "bin/devhub"), "up"], { cwd: infraDir, timeoutMs: 600_000, maxOutputBytes: 256_000 });
    if (started.code !== 0) fail("The shared services did not start; run devhub up");
  }

  /** A stopped instance listens on nothing, but its file still owns the port. */
  private reservedPorts(): Set<number> {
    const root = join(this.options.stateDir, "services");
    if (!existsSync(root)) return new Set();
    const files = readdirSync(root).map((name) => join(root, name, "compose.yml")).filter(existsSync);
    return new Set(files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/127\.0\.0\.1:(\d+):/g)].map((match) => Number(match[1]))));
  }

  /** The file is written once: it holds the port and the secret that the projects on this instance already use. */
  private async startInstance(service: Definition, version: string, container: string): Promise<void> {
    const { run, discovery, stateDir } = this.options;
    const dir = join(stateDir, "services", container), file = join(dir, "compose.yml");
    if (!existsSync(file)) {
      const volume = `${container.replace(/-/g, "_")}_data`;
      // A new secret would not open data created with the old one.
      if ((await run(["docker", "volume", "inspect", volume], { timeoutMs: 10_000, maxOutputBytes: 64_000 })).code === 0) fail(`Volume ${volume} exists but ${file} is missing; restore that file or remove the volume`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { data, health, ...runtime } = service.instance!(randomBytes(24).toString("hex"), container, version);
      const taken = this.reservedPorts();
      let port = await discovery.freePort(FIRST_INSTANCE_PORT);
      while (taken.has(port)) port = await discovery.freePort(port + 1);
      writeFileSync(file, stringify({
        services: { service: {
          container_name: container, restart: "unless-stopped", ...runtime,
          labels: { "devhub.service-instance": `${service.id}:${version}` },
          logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
          volumes: [`data:${data}`],
          ports: [`127.0.0.1:${port}:${service.port}`],
          healthcheck: { test: health, interval: "5s", timeout: "5s", retries: 30 },
          networks: [NETWORK],
        } },
        volumes: { data: { name: volume } },
        networks: { [NETWORK]: { external: true } },
      }), { mode: 0o600 });
    }
    // Refused when the network already exists, which is the usual case.
    await run(["docker", "network", "create", NETWORK], { timeoutMs: 30_000, maxOutputBytes: 8_000 });
    const started = await run(["docker", "compose", "-p", container, "-f", file, "up", "-d"], { cwd: dir, timeoutMs: 600_000, maxOutputBytes: 256_000 });
    if (started.code !== 0) fail(`${container} did not start: ${started.stderr.slice(-300)}`);
  }
}

import versions from "../../data/versions.json";
import { honoFiles } from "./hono";

export type NodeOptions = { name: string; runtime: string; pattern: string; orm: string; services: string[] };

/** Exact versions, kept in one file that `devhub versions` checks: two projects created apart get the same code. */
const VERSIONS = versions.npm;
/** Same layout as the Biome formatter, so that a new project passes its own lint. */
const json = (value: unknown) => `${JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, items: string) => `[${items.replace(/\s*\n\s*/g, " ")}]`)}\n`;

export function nodeFiles({ name, runtime, pattern, orm, services }: NodeOptions): Record<string, string> {
  const bun = runtime === "bun", modules = pattern === "modules";
  const postgres = services.includes("postgres"), redis = services.includes("redis"), mail = services.includes("mailpit");
  const lib = modules ? "src/shared/infrastructure" : "src/lib";
  const files: Record<string, string> = honoFiles(name, modules, orm === "drizzle");

  files["package.json"] = json({
    name, private: true, type: "module",
    scripts: {
      dev: bun ? "bun run --hot src/index.ts" : "node --watch src/index.ts",
      start: bun ? "bun run src/index.ts" : "node src/index.ts",
      test: bun ? "bun test" : "node --test",
      typecheck: "tsc --noEmit",
      lint: "biome check .",
      ...(orm === "drizzle" ? { "db:generate": "drizzle-kit generate", "db:migrate": "drizzle-kit migrate" } : {}),
    },
    dependencies: {
      hono: VERSIONS.hono, zod: VERSIONS.zod, "@hono/zod-validator": VERSIONS["@hono/zod-validator"], pino: VERSIONS.pino,
      ...(bun ? {} : { "@hono/node-server": VERSIONS["@hono/node-server"] }),
      ...(postgres ? { postgres: VERSIONS.postgres } : {}),
      ...(orm === "drizzle" ? { "drizzle-orm": VERSIONS["drizzle-orm"] } : {}),
      ...(redis ? { ioredis: VERSIONS.ioredis } : {}),
      ...(mail ? { nodemailer: VERSIONS.nodemailer } : {}),
    },
    devDependencies: {
      "@biomejs/biome": VERSIONS["@biomejs/biome"], typescript: VERSIONS.typescript, "pino-pretty": VERSIONS["pino-pretty"],
      ...(bun ? { "@types/bun": VERSIONS["@types/bun"] } : { "@types/node": VERSIONS["@types/node"] }),
      ...(orm === "drizzle" ? { "drizzle-kit": VERSIONS["drizzle-kit"] } : {}),
      ...(mail ? { "@types/nodemailer": VERSIONS["@types/nodemailer"] } : {}),
    },
  });
  files["tsconfig.json"] = json({
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: [bun ? "bun" : "node"], strict: true, noUncheckedIndexedAccess: true,
      noEmit: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, skipLibCheck: true,
    },
    include: ["src", ...(orm === "drizzle" ? ["drizzle.config.ts"] : [])],
  });
  files["biome.json"] = json({ vcs: { enabled: true, clientKind: "git", useIgnoreFile: true }, files: { includes: ["**", "!**/.agents", "!**/.claude", "!**/drizzle"] }, formatter: { indentStyle: "space", lineWidth: 100 } });
  files[".gitignore"] = "node_modules\ndist\n.env\n.claude/settings.local.json\n";
  files[".env.example"] = [
    "PORT=3000",
    "HOST=127.0.0.1",
    ...(postgres ? ["DATABASE_URL="] : []),
    ...(redis ? ["REDIS_URL=", "REDIS_PREFIX="] : []),
    ...(mail ? ["SMTP_HOST=", "SMTP_PORT="] : []),
    "",
  ].join("\n");
  files["README.md"] = [
    `# ${name}`, "",
    "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
    "```sh",
    `${bun ? "bun" : "npm"} run typecheck`,
    `${bun ? "bun" : "npm"} run lint`,
    `${bun ? "bun" : "npm"} test`,
    "```", "",
    "In Docker, run these inside the `app` container: dependencies live there.", "",
    modules
      ? "Each feature lives in `src/modules/<name>`: `domain` holds the rules and the ports, `application` the use cases, `infrastructure` HTTP and storage. Dependencies point inward, a module shows only its `index.ts`, and `src/index.ts` wires them. `notes` is an example to copy or delete."
      : "`src/routes` holds the HTTP routes, `src/schemas` the request shapes, `src/services` the logic, `src/middleware` the access log and error handling, and `src/index.ts` wires them. `notes` is an example to copy or delete.",
    "",
    ...(orm === "drizzle" ? [`\`/notes\` answers 500 until its table exists: run \`${bun ? "bun" : "npm"} run db:generate\`, then \`${bun ? "bun" : "npm"} run db:migrate\`.`, ""] : []),
  ].join("\n");

  files["src/config.ts"] = [
    'import { z } from "zod";', "",
    "const schema = z.object({",
    "  PORT: z.coerce.number().int().default(3000),",
    '  HOST: z.string().default("127.0.0.1"),',
    ...(postgres ? ["  DATABASE_URL: z.url(),"] : []),
    ...(redis ? ["  REDIS_URL: z.url(),", '  REDIS_PREFIX: z.string().default(""),'] : []),
    ...(mail ? ["  SMTP_HOST: z.string(),", "  SMTP_PORT: z.coerce.number().int(),"] : []),
    "});", "",
    "/** Read once at startup: a missing variable stops the app with a clear error. */",
    "export const config = schema.parse(process.env);", "",
  ].join("\n");

  const checks: string[] = [], imports: string[] = [];
  if (postgres) {
    files[`${lib}/database.ts`] = [
      ...(orm === "drizzle" ? ['import { drizzle } from "drizzle-orm/postgres-js";'] : []),
      'import postgres from "postgres";',
      `import { config } from "${modules ? "../../config.ts" : "../config.ts"}";`, "",
      "/** Kept on globalThis: `bun --hot` runs this file again at each save. */",
      "const shared = globalThis as typeof globalThis & { sql?: ReturnType<typeof postgres> };",
      "shared.sql ??= postgres(config.DATABASE_URL);", "",
      "export const sql = shared.sql;",
      ...(orm === "drizzle" ? ["export const db = drizzle(sql);"] : []),
      "",
    ].join("\n");
    imports.push(`import { ${orm === "drizzle" ? "db, sql" : "sql"} } from "./${lib.slice(4)}/database.ts";`);
    checks.push('{ name: "database", run: () => sql`select 1` }');
  }
  if (orm === "drizzle") {
    const schema = modules ? "src/modules/notes/infrastructure/persistence/schema.ts" : `${lib}/schema.ts`;
    files[schema] = [
      'import { pgTable, text } from "drizzle-orm/pg-core";', "",
      'export const notes = pgTable("notes", {',
      '  id: text("id").primaryKey(),',
      '  body: text("body").notNull(),',
      '  createdAt: text("created_at").notNull(),',
      "});", "",
    ].join("\n");
    files["drizzle.config.ts"] = [
      'import { defineConfig } from "drizzle-kit";', "",
      "export default defineConfig({",
      '  dialect: "postgresql",',
      `  schema: "./${modules ? "src/modules/*/infrastructure/persistence/schema.ts" : schema}",`,
      '  out: "./drizzle",',
      "  dbCredentials: { url: process.env.DATABASE_URL ?? \"\" },",
      "});", "",
    ].join("\n");
  }
  if (redis) {
    files[`${lib}/redis.ts`] = [
      'import Redis from "ioredis";',
      `import { config } from "${modules ? "../../config.ts" : "../config.ts"}";`,
      'import { logger } from "./logger.ts";', "",
      "function connect() {",
      "  const client = new Redis(config.REDIS_URL, {",
      "    keyPrefix: config.REDIS_PREFIX,",
      "    lazyConnect: true,",
      "  });",
      '  client.on("error", (error) => logger.warn({ err: error }, "redis error"));',
      "  return client;",
      "}", "",
      "/** Kept on globalThis: `bun --hot` runs this file again at each save. */",
      "const shared = globalThis as typeof globalThis & { redis?: Redis };",
      "shared.redis ??= connect();", "",
      "export const redis = shared.redis;",
      "",
    ].join("\n");
    imports.push(`import { redis } from "./${lib.slice(4)}/redis.ts";`);
    checks.push('{ name: "redis", run: () => redis.ping() }');
  }
  if (mail) {
    files[`${lib}/mailer.ts`] = [
      'import nodemailer from "nodemailer";',
      `import { config } from "${modules ? "../../config.ts" : "../config.ts"}";`, "",
      "export const mailer = nodemailer.createTransport({",
      "  host: config.SMTP_HOST,",
      "  port: config.SMTP_PORT,",
      "});", "",
    ].join("\n");
  }
  const store = `${orm === "drizzle" ? "drizzle" : "memory"}${modules ? "NoteRepository" : "NoteStore"}`;
  files["src/index.ts"] = [
    ...(bun ? [] : ['import { serve } from "@hono/node-server";']),
    'import { createApp } from "./app.ts";',
    'import { config } from "./config.ts";',
    ...(modules ? [`import { ${store} } from "./modules/notes/index.ts";`] : []),
    ...imports,
    ...(modules ? [] : [`import { ${store} } from "./services/${orm === "drizzle" ? "drizzle-note-store" : "notes"}.ts";`]), "",
    "const app = createApp({",
    ...(checks.length > 1 ? ["  checks: [", ...checks.map((check) => `    ${check},`), "  ],"] : [`  checks: [${checks[0] ?? ""}],`]),
    `  notes: ${store}(${orm === "drizzle" ? "db" : ""}),`,
    "});", "",
    ...(bun
      ? ["export default { port: config.PORT, hostname: config.HOST, fetch: app.fetch };"]
      : ["serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });"]),
    "",
  ].join("\n");
  return files;
}

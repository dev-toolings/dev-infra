/** DevHub names what it provisions once. Each framework then reads its own official variables. */
export function frameworkEnv(framework: string, env: Record<string, string>): Record<string, string> {
  const { DATABASE_URL, REDIS_URL, SMTP_HOST, SMTP_PORT, ...rest } = env;
  if (framework === "laravel") {
    const redis = REDIS_URL ? new URL(REDIS_URL) : undefined;
    return {
      ...rest,
      ...(DATABASE_URL ? { DB_CONNECTION: "pgsql", DB_URL: DATABASE_URL } : {}),
      ...(redis ? { REDIS_HOST: redis.hostname, REDIS_PORT: redis.port } : {}),
      ...(SMTP_HOST ? { MAIL_MAILER: "smtp", MAIL_HOST: SMTP_HOST, MAIL_PORT: SMTP_PORT ?? "" } : {}),
    };
  }
  return {
    ...rest,
    ...(DATABASE_URL ? { DATABASE_URL } : {}),
    ...(REDIS_URL ? { REDIS_URL } : {}),
    ...(SMTP_HOST ? { MAILER_DSN: `smtp://${SMTP_HOST}:${SMTP_PORT}` } : {}),
  };
}

/** The file a developer would get from `cp .env.example .env`, with the values of this project. */
export function fillEnv(example: string, values: Record<string, string>): string {
  const left = new Map(Object.entries(values));
  const lines = example.trimEnd().split("\n").map((line) => {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    const value = key === undefined ? undefined : left.get(key);
    if (value === undefined) return line;
    left.delete(key!);
    return `${key}=${value}`;
  });
  return `${[...lines, ...(left.size ? ["", ...[...left].map(([key, value]) => `${key}=${value}`)] : [])].join("\n")}\n`;
}

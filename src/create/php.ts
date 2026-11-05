import versions from "../../data/versions.json";
import { laravelFiles } from "./laravel";
import { symfonyFiles } from "./symfony";

export type PhpOptions = { name: string; framework: string; pattern?: string; symfonyVersion?: string; orm?: string; services: string[]; docker?: boolean };

/** Exact versions, kept in one file that `devhub versions` checks. */
const VERSIONS = versions.Packagist;
const json = (value: unknown) => `${JSON.stringify(value, null, 4)}\n`;
const CHECKS = { lint: "php-cs-fixer check", analyse: "phpstan analyse --memory-limit=1G", test: "phpunit" };

function composer(name: string, source: string, require: Record<string, string>, dev: Record<string, string>, services: string[], extra: Record<string, unknown>, scripts: Record<string, string>) {
  return json({
    name: `app/${name}`, type: "project", license: "proprietary",
    require: { php: ">=8.4", ...require, ...(services.includes("postgres") ? { "ext-pdo_pgsql": "*" } : {}), ...(services.includes("redis") ? { "predis/predis": VERSIONS["predis/predis"] } : {}) },
    "require-dev": { "phpstan/phpstan": VERSIONS["phpstan/phpstan"], "phpunit/phpunit": VERSIONS["phpunit/phpunit"], ...dev },
    autoload: { "psr-4": { "App\\": source } },
    "autoload-dev": { "psr-4": { "App\\Tests\\": "tests/" } },
    scripts,
    ...extra,
  });
}

export function phpFiles({ name, framework, pattern = "standard", symfonyVersion = "7.4", orm = "none", services, docker = false }: PhpOptions): Record<string, string> {
  const modules = pattern === "modules", postgres = services.includes("postgres"), redis = services.includes("redis"), mail = services.includes("mailpit");
  if (framework === "laravel") {
    const eloquent = orm === "eloquent";
    return {
      ...laravelFiles({ name, modules, eloquent, postgres, redis, mail, docker }),
      "composer.json": composer(name, "app/", {
        "laravel/framework": VERSIONS["laravel/framework"],
        ...(docker ? { "laravel/octane": VERSIONS["laravel/octane"] } : {}),
        ...(eloquent ? {} : { "ext-pdo_sqlite": "*" }),
      }, { "larastan/larastan": VERSIONS["larastan/larastan"], "laravel/pint": VERSIONS["laravel/pint"] }, services, {}, { ...CHECKS, lint: "pint --test" }),
    };
  }
  const doctrine = orm === "doctrine";
  const { "symfony/mailer": mailer, ...core } = versions.lines.symfony[symfonyVersion as "7.4" | "8.1"];
  return {
    ...symfonyFiles({ name, modules, doctrine, postgres, redis, mail }),
    "composer.json": composer(name, "src/", {
      ...core,
      "symfony/monolog-bundle": VERSIONS["symfony/monolog-bundle"],
      ...(mail ? { "symfony/mailer": mailer } : {}),
      ...(doctrine ? { "doctrine/orm": VERSIONS["doctrine/orm"], "doctrine/doctrine-bundle": VERSIONS["doctrine/doctrine-bundle"], "doctrine/doctrine-migrations-bundle": VERSIONS["doctrine/doctrine-migrations-bundle"] } : { "ext-pdo_sqlite": "*" }),
    }, { "friendsofphp/php-cs-fixer": VERSIONS["friendsofphp/php-cs-fixer"] }, services, {
      config: { "allow-plugins": { "symfony/runtime": true } },
      // DevHub gives the environment: Docker has no `.env` file, and the runtime would stop on it.
      extra: { runtime: { disable_dotenv: true } },
    }, CHECKS),
  };
}

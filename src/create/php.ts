import versions from "../../data/versions.json";
import { laravelFiles } from "./laravel";
import { symfonyFiles } from "./symfony";

export type PhpOptions = { name: string; framework: string; pattern?: string; symfonyVersion?: string; orm?: string; apiPlatform?: boolean; services: string[]; docker?: boolean };

/** Exact versions, kept in one file that `devhub versions` checks. */
const VERSIONS = versions.Packagist;
const json = (value: unknown) => `${JSON.stringify(value, null, 4)}\n`;
/** Only the direct dependencies are pinned, and they accept the next major: without this, a 7.4 project gets 8.x components. */
const LINE_COMPONENTS = ["asset", "cache", "config", "dependency-injection", "doctrine-bridge", "error-handler", "event-dispatcher", "filesystem", "finder", "http-foundation", "http-kernel", "mime", "monolog-bridge", "password-hasher", "routing", "security-core", "stopwatch", "twig-bridge", "type-info", "uid", "var-dumper", "var-exporter", "web-link"];
const CHECKS = { lint: "php-cs-fixer check", analyse: "phpstan analyse --memory-limit=1G", test: "pest" };
const PEST_PLUGIN = { "pestphp/pest-plugin": true };

function composer(name: string, source: string, require: Record<string, string>, dev: Record<string, string>, services: string[], extra: Record<string, unknown>, scripts: Record<string, string | string[]>) {
  return json({
    name: `app/${name}`, type: "project", license: "proprietary",
    require: { php: ">=8.4", ...require, ...(services.includes("postgres") ? { "ext-pdo_pgsql": "*" } : {}), ...(services.includes("redis") ? { "predis/predis": VERSIONS["predis/predis"] } : {}) },
    // Pest accepts a single PHPUnit patch and installs it: a pin of ours would only conflict.
    "require-dev": { "pestphp/pest": VERSIONS["pestphp/pest"], "phpstan/phpstan": VERSIONS["phpstan/phpstan"], ...dev },
    autoload: { "psr-4": { "App\\": source } },
    "autoload-dev": { "psr-4": { "App\\Tests\\": "tests/" } },
    scripts,
    ...extra,
  });
}

export function phpFiles({ name, framework, pattern = "standard", symfonyVersion = "7.4", orm = "none", apiPlatform = false, services, docker = false }: PhpOptions): Record<string, string> {
  const modules = pattern === "modules", postgres = services.includes("postgres"), redis = services.includes("redis"), mail = services.includes("mailpit");
  if (framework === "laravel") {
    const eloquent = orm === "eloquent";
    return {
      ...laravelFiles({ name, modules, eloquent, postgres, redis, mail, docker }),
      "composer.json": composer(name, "app/", {
        "laravel/framework": VERSIONS["laravel/framework"],
        ...(docker ? { "laravel/octane": VERSIONS["laravel/octane"] } : {}),
      }, { "larastan/larastan": VERSIONS["larastan/larastan"], "laravel/pint": VERSIONS["laravel/pint"], "pestphp/pest-plugin-laravel": VERSIONS["pestphp/pest-plugin-laravel"] }, services, { config: { "allow-plugins": PEST_PLUGIN } }, {
        // Laravel builds its list of packages once: without this, a package added later is never loaded.
        "post-autoload-dump": "@php artisan package:discover --ansi",
        ...CHECKS, lint: "pint --test",
      }),
    };
  }
  const doctrine = orm === "doctrine";
  const { "symfony/mailer": mailer, "symfony/twig-bundle": twig, ...core } = versions.lines.symfony[symfonyVersion as "7.4" | "8.1"];
  // The API docs are static files of the bundle: `public/` has to hold a copy.
  const assets: Record<string, string> = apiPlatform ? { "post-install-cmd": "@php bin/console assets:install public", "post-update-cmd": "@php bin/console assets:install public" } : {};
  return {
    ...symfonyFiles({ name, modules, doctrine, apiPlatform, postgres, redis, mail, docker }),
    "composer.json": composer(name, "src/", {
      ...core,
      "symfony/monolog-bundle": VERSIONS["symfony/monolog-bundle"],
      ...(mail ? { "symfony/mailer": mailer } : {}),
      ...(doctrine ? { "doctrine/orm": VERSIONS["doctrine/orm"], "doctrine/doctrine-bundle": VERSIONS["doctrine/doctrine-bundle"], "doctrine/doctrine-migrations-bundle": VERSIONS["doctrine/doctrine-migrations-bundle"] } : {}),
      ...(apiPlatform ? { "api-platform/symfony": VERSIONS["api-platform/symfony"], "nelmio/cors-bundle": VERSIONS["nelmio/cors-bundle"], "symfony/twig-bundle": twig } : {}),
      ...(apiPlatform && doctrine ? { "api-platform/doctrine-orm": VERSIONS["api-platform/doctrine-orm"] } : {}),
    }, { "friendsofphp/php-cs-fixer": VERSIONS["friendsofphp/php-cs-fixer"], "phpstan/phpstan-symfony": VERSIONS["phpstan/phpstan-symfony"] }, services, {
      ...(symfonyVersion === "7.4" ? { conflict: Object.fromEntries(LINE_COMPONENTS.map((item) => [`symfony/${item}`, ">=8"])) } : {}),
      config: { "allow-plugins": { ...PEST_PLUGIN, "symfony/runtime": true } },
      // phpstan-symfony reads the container that this dumps: without it, its service checks see nothing.
    }, { ...assets, ...CHECKS, analyse: ["@php bin/console cache:warmup --env=dev", CHECKS.analyse] }),
  };
}

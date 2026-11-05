import versions from "../../data/versions.json";

export type PhpOptions = { name: string; framework: string; symfonyVersion?: string; services: string[] };

/** Exact versions, kept in one file that `devhub versions` checks. */
const VERSIONS = versions.Packagist;
const json = (value: unknown) => `${JSON.stringify(value, null, 4)}\n`;
const lines = (...items: string[]) => [...items, ""].join("\n");
const KEEP = "*\n!.gitignore\n";

function composer(name: string, require: Record<string, string>, extra: Record<string, unknown>, services: string[]) {
  return json({
    name: `app/${name}`, type: "project", license: "proprietary",
    require: { ...require, ...(services.includes("postgres") ? { "ext-pdo_pgsql": "*" } : {}), ...(services.includes("redis") ? { "predis/predis": VERSIONS["predis/predis"] } : {}) },
    autoload: { "psr-4": { "App\\": extra.source } },
    ...(extra.config ? { config: extra.config } : {}),
  });
}

function symfonyFiles(name: string, line: "7.4" | "8.1", services: string[]): Record<string, string> {
  return {
    "composer.json": composer(name, { php: line === "7.4" ? ">=8.2" : ">=8.4", ...versions.lines.symfony[line] }, { source: "src/", config: { "allow-plugins": { "symfony/runtime": true } } }, services),
    "public/index.php": lines(
      "<?php", "", "use App\\Kernel;", "", "require_once dirname(__DIR__).'/vendor/autoload_runtime.php';", "",
      "return static fn (array $context) => new Kernel($context['APP_ENV'] ?? 'dev', (bool) ($context['APP_DEBUG'] ?? true));",
    ),
    "src/Kernel.php": lines(
      "<?php", "", "namespace App;", "",
      "use Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle;",
      "use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;",
      "use Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator;",
      "use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;",
      "use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;", "",
      "final class Kernel extends BaseKernel", "{", "    use MicroKernelTrait;", "",
      "    public function registerBundles(): iterable", "    {", "        yield new FrameworkBundle();", "    }", "",
      "    protected function configureContainer(ContainerConfigurator $container): void", "    {",
      "        $container->extension('framework', ['secret' => '%env(APP_SECRET)%']);",
      "        $container->services()->load('App\\\\Controller\\\\', __DIR__.'/Controller/')->autowire()->autoconfigure();",
      "    }", "",
      "    protected function configureRoutes(RoutingConfigurator $routes): void", "    {",
      "        $routes->import(__DIR__.'/Controller/', 'attribute');", "    }", "}",
    ),
    "src/Controller/HealthController.php": lines(
      "<?php", "", "namespace App\\Controller;", "",
      "use Symfony\\Component\\HttpFoundation\\JsonResponse;", "use Symfony\\Component\\Routing\\Attribute\\Route;", "",
      "final class HealthController", "{", "    #[Route('/health')]", "    public function __invoke(): JsonResponse", "    {",
      "        return new JsonResponse(['status' => 'ok']);", "    }", "}",
    ),
    ".gitignore": lines(".env", "/var/", "/vendor/", ".claude/settings.local.json"),
  };
}

function laravelFiles(name: string, services: string[]): Record<string, string> {
  return {
    "composer.json": composer(name, { php: ">=8.3", "laravel/framework": VERSIONS["laravel/framework"] }, { source: "app/" }, services),
    // Laravel merges these with its defaults: DevHub gives every stack the same variable names.
    ...(services.includes("mailpit") ? { "config/mail.php": lines(
      "<?php", "", "return [", "    'default' => 'smtp',", "    'mailers' => [", "        'smtp' => ['transport' => 'smtp', 'host' => env('SMTP_HOST'), 'port' => env('SMTP_PORT')],", "    ],", "];",
    ) } : {}),
    artisan: lines(
      "#!/usr/bin/env php", "<?php", "", "use Symfony\\Component\\Console\\Input\\ArgvInput;", "",
      "require __DIR__.'/vendor/autoload.php';", "",
      "$app = require_once __DIR__.'/bootstrap/app.php';", "", "exit($app->handleCommand(new ArgvInput));",
    ),
    "bootstrap/app.php": lines(
      "<?php", "", "use Illuminate\\Foundation\\Application;", "use Illuminate\\Foundation\\Configuration\\Exceptions;", "use Illuminate\\Foundation\\Configuration\\Middleware;", "",
      "return Application::configure(basePath: dirname(__DIR__))",
      "    ->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: '')",
      "    ->withMiddleware(function (Middleware $middleware): void {})",
      "    ->withExceptions(function (Exceptions $exceptions): void {})",
      "    ->create();",
    ),
    "public/index.php": lines(
      "<?php", "", "use Illuminate\\Http\\Request;", "", "define('LARAVEL_START', microtime(true));", "",
      "require __DIR__.'/../vendor/autoload.php';", "", "(require_once __DIR__.'/../bootstrap/app.php')->handleRequest(Request::capture());",
    ),
    "routes/api.php": lines(
      "<?php", "", "use Illuminate\\Support\\Facades\\Route;", "", "Route::get('/health', fn () => ['status' => 'ok']);",
    ),
    ...(services.includes("postgres") ? { "config/database.php": lines(
      "<?php", "", "return [", "    'default' => 'pgsql',", "    'connections' => [", "        'pgsql' => ['driver' => 'pgsql', 'url' => env('DATABASE_URL')],", "    ],", "];",
    ) } : {}),
    "bootstrap/cache/.gitignore": KEEP,
    "storage/logs/.gitignore": KEEP,
    "storage/framework/cache/.gitignore": KEEP,
    "storage/framework/sessions/.gitignore": KEEP,
    "storage/framework/views/.gitignore": KEEP,
    ".gitignore": lines(".env", "/vendor/", ".claude/settings.local.json"),
  };
}

export const phpFiles = ({ name, framework, symfonyVersion = "7.4", services }: PhpOptions) => framework === "laravel" ? laravelFiles(name, services) : symfonyFiles(name, symfonyVersion as "7.4" | "8.1", services);

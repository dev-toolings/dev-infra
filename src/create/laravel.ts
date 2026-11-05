import { layoutFor, phpClass, sharedFiles } from "./php-shared";

const raw = String.raw;

export type LaravelOptions = { name: string; modules: boolean; eloquent: boolean; postgres: boolean; redis: boolean; mail: boolean; docker: boolean };

const KEEP = "*\n!.gitignore\n";
const lines = (...items: string[]) => [...items, ""].join("\n");

export function laravelFiles({ name, modules, eloquent, postgres, redis, mail, docker }: LaravelOptions): Record<string, string> {
  const layout = layoutFor("app", modules, { error: "App\\Exceptions\\AppError", logging: "App\\Logging", health: "App\\Health" });
  const http = modules ? "App\\Shared\\Infrastructure\\Http" : "App\\Http\\Middleware";
  const errorResponse = modules ? `${http}\\ErrorResponse` : "App\\Exceptions\\ErrorResponse";
  const health = modules ? "App\\Modules\\Health\\Infrastructure" : "App\\Health";
  const healthController = modules ? `${health}\\Http\\HealthController` : "App\\Http\\Controllers\\HealthController";
  const databaseCheck = `${health}\\DatabaseCheck`, redisCheck = `${health}\\RedisCheck`;
  const checks = [...(postgres ? ["new DatabaseCheck"] : []), ...(redis ? ["new RedisCheck"] : [])];

  const files: Record<string, string> = {
    ...sharedFiles(layout),
    artisan: lines(
      "#!/usr/bin/env php", "<?php", "", "use Symfony\\Component\\Console\\Input\\ArgvInput;", "",
      "require __DIR__.'/vendor/autoload.php';", "",
      "$app = require_once __DIR__.'/bootstrap/app.php';", "", "exit($app->handleCommand(new ArgvInput));",
    ),
    "bootstrap/app.php": lines(
      "<?php", "",
      ...[`${http}\\AccessLog`, errorResponse, layout.error, "Illuminate\\Foundation\\Application", "Illuminate\\Foundation\\Configuration\\Exceptions", "Illuminate\\Foundation\\Configuration\\Middleware", "Illuminate\\Http\\Request"].sort().map((item) => `use ${item};`), "",
      "return Application::configure(basePath: dirname(__DIR__))",
      "    ->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: '')",
      "    ->withMiddleware(function (Middleware $middleware): void {",
      "        $middleware->prepend(AccessLog::class);",
      "    })",
      "    ->withExceptions(function (Exceptions $exceptions): void {",
      "        $exceptions->dontReport(AppError::class);",
      "        $exceptions->context(fn () => ['requestId' => request()->attributes->get('requestId')]);",
      "        $exceptions->render(fn (Throwable $error, Request $request) => ErrorResponse::for($error, $request));",
      "    })",
      "    ->create();",
    ),
    "bootstrap/providers.php": lines("<?php", "", "use App\\Providers\\AppServiceProvider;", "", "return [", "    AppServiceProvider::class,", "];"),
    "public/index.php": lines(
      "<?php", "", "use Illuminate\\Http\\Request;", "", "define('LARAVEL_START', microtime(true));", "",
      "require __DIR__.'/../vendor/autoload.php';", "", "(require_once __DIR__.'/../bootstrap/app.php')->handleRequest(Request::capture());",
    ),
    "routes/api.php": lines(
      "<?php", "",
      ...[healthController, "Illuminate\\Support\\Facades\\Route"].sort().map((item) => `use ${item};`), "",
      "Route::get('/', [HealthController::class, 'index']);",
      "Route::get('/health', [HealthController::class, 'health']);",
    ),
    // Laravel merges these with its defaults.
    "config/app.php": lines("<?php", "", "return [", `    'name' => '${name}',`, "];"),
    // An API has no session: the default driver would need a table in the database.
    "config/session.php": lines("<?php", "", "return [", "    'driver' => env('SESSION_DRIVER', 'array'),", "];"),
    "config/logging.php": lines(
      "<?php", "",
      ...[layout.formatter, layout.redactor, "Monolog\\Formatter\\JsonFormatter", "Monolog\\Handler\\StreamHandler"].sort().map((item) => `use ${item};`), "",
      "$local = env('APP_ENV') === 'local';", "",
      "return [",
      "    'default' => env('LOG_CHANNEL', 'stderr'),",
      "    'channels' => [",
      "        'stderr' => [",
      "            'driver' => 'monolog',",
      "            'handler' => StreamHandler::class,",
      "            'with' => ['stream' => 'php://stderr'],",
      "            'level' => $local ? 'debug' : 'info',",
      "            'formatter' => $local ? PrettyLogFormatter::class : JsonFormatter::class,",
      "            'processors' => [RedactLogProcessor::class],",
      "        ],",
      "    ],",
      "];",
    ),
    ...(postgres || redis ? { "config/database.php": lines(
      "<?php", "", "return [",
      ...(postgres ? ["    'default' => env('DB_CONNECTION', 'pgsql'),", "    'connections' => [", "        'pgsql' => ['driver' => 'pgsql', 'url' => env('DB_URL'), 'options' => [PDO::ATTR_TIMEOUT => 2]],", "    ],"] : []),
      ...(redis ? ["    'redis' => [", "        'client' => env('REDIS_CLIENT', 'predis'),", "        'options' => ['prefix' => env('REDIS_PREFIX', '')],", "        'default' => ['host' => env('REDIS_HOST', '127.0.0.1'), 'port' => env('REDIS_PORT', '6379'), 'timeout' => 2, 'read_write_timeout' => 2],", "    ],"] : []),
      "];",
    ) } : {}),
    ...(docker ? { "config/octane.php": lines(
      "<?php", "", "return [", "    'server' => 'frankenphp',",
      "    // Explicit paths: the default of FrankenPHP also covers what the app writes in `storage`.",
      "    'watch' => ['app/**/*.php', 'bootstrap/app.php', 'bootstrap/providers.php', 'config/**/*.php', 'routes/**/*.php'],", "];",
    ) } : {}),
    ...phpClass("app", "App\\Providers\\AppServiceProvider", [
      layout.getHealth, "Illuminate\\Support\\ServiceProvider",
      ...(postgres ? [databaseCheck] : []), ...(redis ? [redisCheck] : []),
    ], raw`final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->when(GetHealth::class)->needs('$checks')->give(fn () => [${checks.join(", ")}]);
    }
}
`),
    ...phpClass("app", healthController, [layout.getHealth, "Illuminate\\Http\\JsonResponse"], raw`final class HealthController
{
    public function index(): JsonResponse
    {
        return new JsonResponse(['name' => config('app.name'), 'health' => '/health']);
    }

    public function health(GetHealth $getHealth): JsonResponse
    {
        $report = $getHealth();

        // An object even without checks, as in the other stacks.
        return new JsonResponse([...$report, 'checks' => (object) $report['checks']], $report['status'] === 'ok' ? 200 : 503);
    }
}
`),
    ...phpClass("app", `${http}\\AccessLog`, ["Closure", "Illuminate\\Http\\Request", "Illuminate\\Support\\Facades\\Log", "Illuminate\\Support\\Str", "Symfony\\Component\\HttpFoundation\\Response"], raw`/** One line per request. What it remembers stays on the request: under Octane, this object can outlive it. */
final class AccessLog
{
    public function handle(Request $request, Closure $next): Response
    {
        $started = hrtime(true);
        $given = (string) $request->headers->get('X-Request-Id');
        $requestId = preg_match('/^[\w=-]{1,255}$/D', $given) === 1 ? $given : (string) Str::uuid();
        $request->attributes->set('requestId', $requestId);
        $response = $next($request);
        $response->headers->set('X-Request-Id', $requestId);
        $status = $response->getStatusCode();
        $fields = [
            'requestId' => $requestId,
            'method' => $request->getMethod(),
            'path' => $request->getPathInfo(),
            'route' => $request->route()?->uri(),
            'status' => $status,
            'durationMs' => intdiv(hrtime(true) - $started, 1_000_000),
        ];
        if ($request->attributes->has('errorCode')) {
            $fields['errorCode'] = $request->attributes->get('errorCode');
        }
        Log::log($status >= 500 ? 'error' : ($status >= 400 ? 'warning' : 'info'), 'http request', $fields);

        return $response;
    }
}
`),
    ...phpClass("app", errorResponse, [layout.error, "Illuminate\\Http\\JsonResponse", "Illuminate\\Http\\Request", "Illuminate\\Support\\Arr", "Illuminate\\Validation\\ValidationException", "Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface", "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException", "Throwable"], raw`/** Every failure leaves as the same JSON, and an unknown one never shows its details. */
final class ErrorResponse
{
    private const STATUS = ['invalid' => 400, 'not_found' => 404];

    public static function for(Throwable $error, Request $request): JsonResponse
    {
        $requestId = $request->attributes->getString('requestId');
        [$status, $code, $message] = match (true) {
            $error instanceof AppError => [self::STATUS[$error->errorCode], $error->errorCode, $error->getMessage()],
            $error instanceof ValidationException => [400, 'invalid', implode('; ', Arr::flatten($error->errors()))],
            $error instanceof NotFoundHttpException => [404, 'not_found', 'Route not found'],
            $error instanceof HttpExceptionInterface => [$error->getStatusCode(), 'http_error', $error->getMessage()],
            default => [500, 'internal', "Internal server error ($requestId)"],
        };
        $request->attributes->set('errorCode', $code);

        return new JsonResponse(['error' => ['code' => $code, 'message' => $message]], $status);
    }
}
`),
    "tests/TestCase.php": lines("<?php", "", "namespace App\\Tests;", "", "use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;", "", "abstract class TestCase extends BaseTestCase {}"),
    "tests/AppTest.php": raw`<?php

namespace App\Tests;

${[layout.getHealth, layout.healthCheck].sort().map((item) => `use ${item};`).join("\n")}
use RuntimeException;

final class AppTest extends TestCase
{
    public function test_health_is_degraded_when_a_dependency_fails(): void
    {
        $check = new class implements HealthCheck
        {
            public function name(): string
            {
                return 'database';
            }

            public function run(): void
            {
                throw new RuntimeException('down');
            }
        };

        self::assertSame(['status' => 'degraded', 'checks' => ['database' => false]], (new GetHealth([$check]))());
    }

    public function test_the_app_answers(): void
    {
        $this->getJson('/')->assertOk();
    }

    public function test_every_failure_answers_the_same_json_with_a_request_id(): void
    {
        $cases = [
            [$this->getJson('/unknown'), 404, 'not_found'],
            [$this->postJson('/health'), 405, 'http_error'],
        ];
        foreach ($cases as [$response, $status, $code]) {
            $response->assertStatus($status)->assertJsonPath('error.code', $code)->assertHeader('X-Request-Id');
        }
    }
}
`,
    "tests/LogTest.php": raw`<?php

namespace App\Tests;

${[layout.formatter, layout.redactor, "DateTimeImmutable", "Monolog\\Level", "Monolog\\LogRecord", "PHPUnit\\Framework\\TestCase"].sort().map((item) => `use ${item};`).join("\n")}

final class LogTest extends TestCase
{
    public function test_an_http_line_is_readable_and_keeps_its_fields(): void
    {
        $fields = ['requestId' => 'r', 'method' => 'GET', 'path' => '/users/1', 'route' => 'users/{id}', 'status' => 200, 'durationMs' => 5];
        $line = (new PrettyLogFormatter(false))->format(new LogRecord(new DateTimeImmutable, 'app', Level::Info, 'http request', $fields));

        self::assertStringEndsWith("INFO: GET /users/1 200 5ms  requestId=r route=users/{id}\n", $line);
    }

    public function test_secrets_are_redacted(): void
    {
        $record = new LogRecord(new DateTimeImmutable, 'app', Level::Info, 'login', ['password' => 'hunter2', 'nested' => ['token' => 'abc']]);

        self::assertSame(['password' => '[redacted]', 'nested' => ['token' => '[redacted]']], (new RedactLogProcessor)($record)->context);
    }
}
`.replace("use PHPUnit\\Framework\\TestCase;\n", ""),
    "phpstan.neon": lines("includes:", "    - vendor/larastan/larastan/extension.neon", "", "parameters:", "    level: 6", "    paths:", "        - app", "        - tests"),
    "phpunit.xml": lines(
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<phpunit bootstrap="vendor/autoload.php" colors="true" cacheDirectory=".phpunit.cache">',
      "    <php>",
      '        <env name="APP_ENV" value="testing" force="true"/>',
      '        <env name="APP_KEY" value="base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" force="true"/>',
      '        <env name="LOG_CHANNEL" value="null" force="true"/>',
      "    </php>",
      "    <testsuites>",
      '        <testsuite name="app">',
      "            <directory>tests</directory>",
      "        </testsuite>",
      "    </testsuites>",
      "</phpunit>",
    ),
    "bootstrap/cache/.gitignore": KEEP,
    "storage/app/.gitignore": KEEP,
    "storage/logs/.gitignore": KEEP,
    "storage/framework/cache/.gitignore": KEEP,
    "storage/framework/sessions/.gitignore": KEEP,
    "storage/framework/views/.gitignore": KEEP,
    ".gitignore": lines(".env", "/vendor/", ".phpunit.cache", ".claude/settings.local.json", ...(docker ? ["/public/frankenphp-worker.php"] : [])),
    // The file of the official skeleton. Only what this API needs differs: logs, and stores that need no table.
    ".env.example": lines(
      `APP_NAME=${name}`, "APP_ENV=local", "APP_KEY=", "APP_DEBUG=true", "APP_URL=http://localhost:8000", "",
      "APP_LOCALE=en", "APP_FALLBACK_LOCALE=en", "APP_FAKER_LOCALE=en_US", "",
      "APP_MAINTENANCE_DRIVER=file", "# APP_MAINTENANCE_STORE=database", "",
      "# PHP_CLI_SERVER_WORKERS=4", "", "BCRYPT_ROUNDS=12", "",
      "LOG_CHANNEL=stderr", "LOG_DEPRECATIONS_CHANNEL=null", "LOG_LEVEL=debug", "",
      `DB_CONNECTION=${postgres ? "pgsql" : "sqlite"}`, ...(postgres ? ["DB_URL="] : []), "# DB_HOST=127.0.0.1", "# DB_PORT=3306", "# DB_DATABASE=laravel", "# DB_USERNAME=root", "# DB_PASSWORD=", "",
      "SESSION_DRIVER=array", "SESSION_LIFETIME=120", "SESSION_ENCRYPT=false", "SESSION_PATH=/", "SESSION_DOMAIN=null", "",
      "BROADCAST_CONNECTION=log", "FILESYSTEM_DISK=local", "QUEUE_CONNECTION=sync", "",
      "CACHE_STORE=file", "# CACHE_PREFIX=", "", "MEMCACHED_HOST=127.0.0.1", "",
      `REDIS_CLIENT=${redis ? "predis" : "phpredis"}`, "REDIS_HOST=127.0.0.1", "REDIS_PASSWORD=null", "REDIS_PORT=6379", ...(redis ? ["REDIS_PREFIX="] : []), "",
      `MAIL_MAILER=${mail ? "smtp" : "log"}`, "MAIL_SCHEME=null", "MAIL_HOST=127.0.0.1", "MAIL_PORT=2525", "MAIL_USERNAME=null", "MAIL_PASSWORD=null", 'MAIL_FROM_ADDRESS="hello@example.com"', 'MAIL_FROM_NAME="${APP_NAME}"', "",
      "AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=", "AWS_DEFAULT_REGION=us-east-1", "AWS_BUCKET=", "AWS_USE_PATH_STYLE_ENDPOINT=false", "",
      'VITE_APP_NAME="${APP_NAME}"',
    ),
    "README.md": lines(
      `# ${name}`, "",
      "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
      "```sh", "composer validate --no-check-publish", "composer lint", "composer analyse", "composer test", "```", "",
      "In Docker, run these inside the `app` container: dependencies live there.", "",
      modules
        ? "Each feature lives in `app/Modules/<Name>`: `Domain` holds the rules and the ports, `Application` the use cases, `Infrastructure` HTTP and storage. Dependencies point inward, and `app/Providers/AppServiceProvider.php` wires them. `Health` shows the layout."
        : "`routes/api.php` holds the routes, `app/Http/Controllers` the controllers, and `app/Providers/AppServiceProvider.php` wires them.",
    ),
  };

  if (eloquent) files["database/migrations/.gitignore"] = "";
  if (postgres) {
    Object.assign(files, phpClass("app", databaseCheck, [layout.healthCheck, "Illuminate\\Support\\Facades\\DB"], raw`final class DatabaseCheck implements HealthCheck
{
    public function name(): string
    {
        return 'database';
    }

    public function run(): void
    {
        DB::select('select 1');
    }
}
`));
  }
  if (redis) {
    Object.assign(files, phpClass("app", redisCheck, [layout.healthCheck, "Illuminate\\Support\\Facades\\Redis"], raw`final class RedisCheck implements HealthCheck
{
    public function name(): string
    {
        return 'redis';
    }

    public function run(): void
    {
        Redis::connection()->command('ping');
    }
}
`));
  }
  return files;
}

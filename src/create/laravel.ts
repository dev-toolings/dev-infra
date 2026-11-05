import { layoutFor, namespaceOf, noteCalls, phpClass, sharedFiles, shortName } from "./php-shared";

const raw = String.raw;

export type LaravelOptions = { name: string; modules: boolean; eloquent: boolean; postgres: boolean; redis: boolean; mail: boolean; docker: boolean };

const KEEP = "*\n!.gitignore\n";
const lines = (...items: string[]) => [...items, ""].join("\n");

export function laravelFiles({ name, modules, eloquent, postgres, redis, mail, docker }: LaravelOptions): Record<string, string> {
  const layout = layoutFor("app", modules, { error: "App\\Exceptions\\AppError", model: "App\\Models\\Note", repositories: "App\\Repositories", service: "App\\Services\\NoteService", logging: "App\\Logging", health: "App\\Health" });
  const http = modules ? "App\\Shared\\Infrastructure\\Http" : "App\\Http\\Middleware";
  const errorResponse = modules ? `${http}\\ErrorResponse` : "App\\Exceptions\\ErrorResponse";
  const health = modules ? "App\\Modules\\Health\\Infrastructure" : "App\\Health";
  const persistence = namespaceOf(layout.memory);
  const record = modules ? `${persistence}\\NoteRecord` : "App\\Models\\NoteRecord";
  const eloquentStore = `${persistence}\\EloquentNoteRepository`;
  const controllers = modules
    ? { health: `${health}\\Http\\HealthController`, notes: "App\\Modules\\Notes\\Infrastructure\\Http\\NoteController", input: "App\\Modules\\Notes\\Infrastructure\\Http\\NoteRequest" }
    : { health: "App\\Http\\Controllers\\HealthController", notes: "App\\Http\\Controllers\\NoteController", input: "App\\Http\\Requests\\NoteRequest" };
  const databaseCheck = `${health}\\DatabaseCheck`, redisCheck = `${health}\\RedisCheck`;
  const calls = noteCalls(layout);
  const Note = shortName(layout.note);
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
      ...[controllers.health, controllers.notes, "Illuminate\\Support\\Facades\\Route"].sort().map((item) => `use ${item};`), "",
      "Route::get('/', [HealthController::class, 'index']);",
      "Route::get('/health', [HealthController::class, 'health']);",
      "Route::get('/notes', [NoteController::class, 'index']);",
      "Route::post('/notes', [NoteController::class, 'store']);",
      "Route::get('/notes/{id}', [NoteController::class, 'show']);",
      "Route::patch('/notes/{id}', [NoteController::class, 'update']);",
      "Route::delete('/notes/{id}', [NoteController::class, 'destroy']);",
    ),
    // Laravel merges these with its defaults: DevHub gives every stack the same variable names.
    "config/app.php": lines("<?php", "", "return [", `    'name' => '${name}',`, "];"),
    // An API has no session: the default driver would need a table in the database.
    "config/session.php": lines("<?php", "", "return [", "    'driver' => 'array',", "];"),
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
    ...(mail ? { "config/mail.php": lines(
      "<?php", "", "return [", "    'default' => 'smtp',", "    'mailers' => [", "        'smtp' => ['transport' => 'smtp', 'host' => env('SMTP_HOST'), 'port' => env('SMTP_PORT')],", "    ],", "];",
    ) } : {}),
    ...(postgres ? { "config/database.php": lines(
      "<?php", "", "return [", "    'default' => 'pgsql',", "    'connections' => [", "        'pgsql' => ['driver' => 'pgsql', 'url' => env('DATABASE_URL')],", "    ],", "];",
    ) } : {}),
    ...(docker ? { "config/octane.php": lines(
      "<?php", "", "return [", "    'server' => 'frankenphp',",
      "    // Explicit paths: the default of FrankenPHP also covers what the app writes in `storage`.",
      "    'watch' => ['app/**/*.php', 'bootstrap/app.php', 'bootstrap/providers.php', 'config/**/*.php', 'routes/**/*.php'],", "];",
    ) } : {}),
    ...phpClass("app", "App\\Providers\\AppServiceProvider", [
      layout.getHealth, layout.repository, "Illuminate\\Support\\ServiceProvider",
      ...(eloquent ? [eloquentStore] : [layout.sqlite]),
      ...(postgres ? [databaseCheck] : []), ...(redis ? [redisCheck] : []),
    ], raw`final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        ${eloquent
    ? `$this->app->singleton(${shortName(layout.repository)}::class, EloquentNoteRepository::class);`
    : `$this->app->singleton(${shortName(layout.repository)}::class, fn () => new SqliteNoteRepository(storage_path('app/notes.sqlite')));`}
        $this->app->when(GetHealth::class)->needs('$checks')->give(fn () => [${checks.join(", ")}]);
    }
}
`),
    ...phpClass("app", controllers.input, ["Illuminate\\Foundation\\Http\\FormRequest"], raw`/** The shape of a request. Business rules stay out of it. */
final class NoteRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, list<string>> */
    public function rules(): array
    {
        return ['body' => ['required', 'string', 'max:10000']];
    }
}
`),
    ...phpClass("app", controllers.health, [layout.getHealth, "Illuminate\\Http\\JsonResponse"], raw`final class HealthController
{
    public function index(): JsonResponse
    {
        return new JsonResponse(['name' => config('app.name'), 'health' => '/health']);
    }

    public function health(GetHealth $getHealth): JsonResponse
    {
        $report = $getHealth();

        return new JsonResponse($report, $report['status'] === 'ok' ? 200 : 503);
    }
}
`),
    ...phpClass("app", controllers.notes, [...calls.uses, controllers.input, "Illuminate\\Http\\JsonResponse", "Illuminate\\Http\\Response"], raw`final class NoteController
{
    public function __construct(${calls.args.length > 1 ? `\n        ${calls.args.join(",\n        ")},\n    ` : calls.args[0]!}) {}

    public function index(): JsonResponse
    {
        return new JsonResponse(${calls.list});
    }

    public function store(NoteRequest $request): JsonResponse
    {
        return new JsonResponse(${calls.create("$request->string('body')->value()")}, 201);
    }

    public function show(string $id): JsonResponse
    {
        return new JsonResponse(${calls.get});
    }

    public function update(string $id, NoteRequest $request): JsonResponse
    {
        return new JsonResponse(${calls.update("$request->string('body')->value()")});
    }

    public function destroy(string $id): Response
    {
        ${calls.delete};

        return response()->noContent();
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

${[layout.getHealth, layout.healthCheck, layout.memory, layout.repository].sort().map((item) => `use ${item};`).join("\n")}
use RuntimeException;

final class AppTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->app->instance(${shortName(layout.repository)}::class, new MemoryNoteRepository);
    }

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

    public function test_a_note_can_be_created_read_and_deleted(): void
    {
        $created = $this->postJson('/notes', ['body' => ' hello ']);
        $created->assertCreated()->assertJsonPath('body', 'hello');
        $id = $created->json('id');
        $this->getJson("/notes/$id")->assertOk();
        $this->patchJson("/notes/$id", ['body' => 'bye'])->assertJsonPath('body', 'bye');
        $this->deleteJson("/notes/$id")->assertNoContent();
        $this->getJson("/notes/$id")->assertNotFound();
    }

    public function test_every_failure_answers_the_same_json_with_a_request_id(): void
    {
        $cases = [
            [$this->postJson('/notes', ['body' => '   ']), 400, 'invalid'],
            [$this->postJson('/notes', ['body' => 1]), 400, 'invalid'],
            [$this->getJson('/notes/unknown'), 404, 'not_found'],
            [$this->getJson('/unknown'), 404, 'not_found'],
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
        $fields = ['requestId' => 'r', 'method' => 'GET', 'path' => '/notes/1', 'route' => 'notes/{id}', 'status' => 200, 'durationMs' => 5];
        $line = (new PrettyLogFormatter(false))->format(new LogRecord(new DateTimeImmutable, 'app', Level::Info, 'http request', $fields));

        self::assertStringEndsWith("INFO: GET /notes/1 200 5ms  requestId=r route=notes/{id}\n", $line);
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
    ".env.example": lines("APP_ENV=local", "APP_DEBUG=true", "APP_KEY=", ...(postgres ? ["DATABASE_URL="] : []), ...(redis ? ["REDIS_URL=", "REDIS_PREFIX=", "REDIS_CLIENT=predis"] : []), ...(mail ? ["SMTP_HOST=", "SMTP_PORT="] : [])),
    "README.md": lines(
      `# ${name}`, "",
      "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
      "```sh", "composer validate --no-check-publish", "composer lint", "composer analyse", "composer test", "```", "",
      "In Docker, run these inside the `app` container: dependencies live there.", "",
      modules
        ? "Each feature lives in `app/Modules/<Name>`: `Domain` holds the rules and the ports, `Application` the use cases, `Infrastructure` HTTP and storage. Dependencies point inward, and `app/Providers/AppServiceProvider.php` wires them. `Notes` is an example to copy or delete."
        : "`routes/api.php` holds the routes, `app/Http/Controllers` the controllers, `app/Http/Requests` the request shapes, `app/Services` the logic, `app/Repositories` the storage, and `app/Providers/AppServiceProvider.php` wires them. `Notes` is an example to copy or delete.",
      "",
      eloquent ? "`/notes` answers 500 until its table exists: run `php artisan migrate`." : "`/notes` keeps its data in `storage/app/notes.sqlite`.",
    ),
  };

  if (eloquent) {
    Object.assign(files, phpClass("app", record, ["Illuminate\\Database\\Eloquent\\Model"], raw`final class NoteRecord extends Model
{
    public $incrementing = false;

    public $timestamps = false;

    protected $table = 'notes';

    protected $keyType = 'string';

    protected $fillable = ['id', 'body', 'created_at'];
}
`), phpClass("app", eloquentStore, [layout.note, layout.repository, record], raw`final class EloquentNoteRepository implements ${shortName(layout.repository)}
{
    public function all(): array
    {
        return NoteRecord::query()->orderBy('created_at')->get()->map(self::toNote(...))->values()->all();
    }

    public function find(string $id): ?${Note}
    {
        $record = NoteRecord::query()->find($id);

        return $record === null ? null : self::toNote($record);
    }

    public function save(${Note} $note): void
    {
        NoteRecord::query()->updateOrCreate(['id' => $note->id], ['body' => $note->body, 'created_at' => $note->createdAt]);
    }

    public function delete(string $id): bool
    {
        return NoteRecord::query()->whereKey($id)->delete() > 0;
    }

    private static function toNote(NoteRecord $record): ${Note}
    {
        return new ${Note}($record->getAttribute('id'), $record->getAttribute('body'), $record->getAttribute('created_at'));
    }
}
`));
    files["database/migrations/2026_01_01_000000_create_notes_table.php"] = lines(
      "<?php", "", "use Illuminate\\Database\\Migrations\\Migration;", "use Illuminate\\Database\\Schema\\Blueprint;", "use Illuminate\\Support\\Facades\\Schema;", "",
      "return new class extends Migration", "{", "    public function up(): void", "    {", "        Schema::create('notes', function (Blueprint $table): void {",
      "            $table->string('id')->primary();", "            $table->text('body');", "            $table->string('created_at');", "        });", "    }", "",
      "    public function down(): void", "    {", "        Schema::dropIfExists('notes');", "    }", "};",
    );
  }
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

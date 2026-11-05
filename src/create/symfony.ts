import { layoutFor, pathOf, phpClass, sharedFiles, shortName } from "./php-shared";

const raw = String.raw;

export type SymfonyOptions = { name: string; modules: boolean; doctrine: boolean; postgres: boolean; redis: boolean; mail: boolean; docker: boolean };

/** Same lines in every Symfony file of `config/`. */
const configFile = (uses: string[], body: string) => ["<?php", "", ...[...uses.filter((item) => !item.startsWith("function ")), "Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator"].sort().map((item) => `use ${item};`), "", ...uses.filter((item) => item.startsWith("function ")).flatMap((item) => [`use ${item};`, ""]), "return static function (ContainerConfigurator $container): void {", body, "};", ""].join("\n");

export function symfonyFiles({ name, modules, doctrine, postgres, redis, mail, docker }: SymfonyOptions): Record<string, string> {
  const layout = layoutFor("src", modules, { error: "App\\Exception\\AppError", logging: "App\\Logging", health: "App\\Health" });
  const http = modules ? "App\\Shared\\Infrastructure\\Http" : "App\\EventListener";
  const health = modules ? "App\\Modules\\Health\\Infrastructure" : "App\\Health";
  const healthController = modules ? `${health}\\Http\\HealthController` : "App\\Controller\\HealthController";
  const databaseCheck = `${health}\\DatabaseCheck`, redisCheck = `${health}\\RedisCheck`;
  const excluded = ["../src/Kernel.php", pathOf("../src", layout.error), ...(doctrine && !modules ? ["../src/Entity/"] : [])];

  const files: Record<string, string> = {
    ...sharedFiles(layout),
    "src/Kernel.php": ["<?php", "", "namespace App;", "", "use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;", "use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;", "", "final class Kernel extends BaseKernel", "{", "    use MicroKernelTrait;", "}", ""].join("\n"),
    "public/index.php": ["<?php", "", "use App\\Kernel;", "", "require_once dirname(__DIR__).'/vendor/autoload_runtime.php';", "", "return static fn (array $context) => new Kernel($context['APP_ENV'] ?? 'dev', (bool) ($context['APP_DEBUG'] ?? true));", ""].join("\n"),
    "bin/console": raw`#!/usr/bin/env php
<?php

use App\Kernel;
use Symfony\Bundle\FrameworkBundle\Console\Application;

if (!is_dir(dirname(__DIR__).'/vendor')) {
    throw new LogicException('Dependencies are missing. Try running "composer install".');
}

if (!is_file(dirname(__DIR__).'/vendor/autoload_runtime.php')) {
    throw new LogicException('Symfony Runtime is missing. Try running "composer require symfony/runtime".');
}

require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

return function (array $context) {
    $kernel = new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);

    return new Application($kernel);
};
`,
    "config/bundles.php": ["<?php", "", "return [", "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],", "    Symfony\\Bundle\\MonologBundle\\MonologBundle::class => ['all' => true],", ...(doctrine ? ["    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],", "    Doctrine\\Bundle\\MigrationsBundle\\DoctrineMigrationsBundle::class => ['all' => true],"] : []), "];", ""].join("\n"),
    "config/routes.php": ["<?php", "", "use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;", "", "return static function (RoutingConfigurator $routes): void {", "    $routes->import('../src/', 'attribute');", "};", ""].join("\n"),
    "config/packages/framework.php": configFile([], [
      "    $container->extension('framework', [",
      "        'secret' => '%env(APP_SECRET)%',",
      "        'validation' => ['enabled' => true],",
      "        'serializer' => ['enabled' => true],",
      "        'property_info' => ['enabled' => true, 'with_constructor_extractor' => true],",
      ...(mail ? ["        'mailer' => ['dsn' => '%env(MAILER_DSN)%'],"] : []),
      "    ]);",
    ].join("\n")),
    "config/packages/monolog.php": configFile([layout.formatter], raw`    $handler = match ($container->env()) {
        'test' => ['type' => 'null'],
        // Without these channels: event logs each listener, request repeats the access log, doctrine logs each query.
        'dev' => ['type' => 'stream', 'path' => 'php://stderr', 'level' => 'debug', 'channels' => ['!event', '!request', '!doctrine'], 'formatter' => ${shortName(layout.formatter)}::class],
        default => ['type' => 'stream', 'path' => 'php://stderr', 'level' => 'info', 'channels' => ['!event', '!request', '!doctrine'], 'formatter' => 'monolog.formatter.json'],
    };
    $container->extension('monolog', ['handlers' => ['main' => $handler]]);`),
    "config/services.php": configFile([
      layout.redactor, layout.healthCheck, layout.getHealth,
      ...(postgres && !doctrine ? [databaseCheck] : []),
      ...(redis ? ["Predis\\Client"] : []),
      "function Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\tagged_iterator",
    ], [
      "    $services = $container->services()->defaults()->autowire()->autoconfigure();",
      "    // Before load(): instanceof only applies to the services defined after it.",
      "    $services->instanceof(HealthCheck::class)->tag('app.health_check');",
      `    $services->load('App\\\\', '../src/')->exclude([${excluded.map((item) => `'${item}'`).join(", ")}]);`,
      "    $services->set(GetHealth::class)->arg('$checks', tagged_iterator('app.health_check'));",
      `    $services->set(${shortName(layout.redactor)}::class)->tag('monolog.processor');`,
      ...(postgres && !doctrine ? ["    $services->set(DatabaseCheck::class)->arg('$url', '%env(DATABASE_URL)%');"] : []),
      ...(redis ? ["    $services->set(Client::class)->args(['%env(REDIS_URL)%?timeout=2&read_write_timeout=2', ['prefix' => '%env(REDIS_PREFIX)%']]);"] : []),
    ].join("\n")),
    ...phpClass("src", healthController, [layout.getHealth, "Symfony\\Component\\HttpFoundation\\JsonResponse", "Symfony\\Component\\Routing\\Attribute\\Route"], raw`final readonly class HealthController
{
    public function __construct(private GetHealth $getHealth)
    {
    }

    #[Route('/', methods: ['GET'])]
    public function index(): JsonResponse
    {
        return new JsonResponse(['name' => ${phpString(name)}, 'health' => '/health']);
    }

    #[Route('/health', methods: ['GET'])]
    public function health(): JsonResponse
    {
        $report = ($this->getHealth)();

        // An object even without checks, as in the other stacks.
        return new JsonResponse([...$report, 'checks' => (object) $report['checks']], 'ok' === $report['status'] ? 200 : 503);
    }
}
`),
    ...phpClass("src", `${http}\\RequestLogSubscriber`, ["Psr\\Log\\LoggerInterface", "Symfony\\Component\\EventDispatcher\\EventSubscriberInterface", "Symfony\\Component\\HttpKernel\\Event\\RequestEvent", "Symfony\\Component\\HttpKernel\\Event\\ResponseEvent", "Symfony\\Component\\HttpKernel\\KernelEvents"], raw`/** One line per request. What it remembers stays on the request: in worker mode, this object outlives it. */
final readonly class RequestLogSubscriber implements EventSubscriberInterface
{
    public function __construct(private LoggerInterface $logger)
    {
    }

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::REQUEST => ['start', 4096], KernelEvents::RESPONSE => ['finish', -4096]];
    }

    public function start(RequestEvent $event): void
    {
        if (false === $event->isMainRequest()) {
            return;
        }
        $request = $event->getRequest();
        $given = (string) $request->headers->get('X-Request-Id');
        $request->attributes->set('requestId', 1 === preg_match('/^[\w=-]{1,255}$/D', $given) ? $given : bin2hex(random_bytes(16)));
        $request->attributes->set('startedAt', hrtime(true));
    }

    public function finish(ResponseEvent $event): void
    {
        if (false === $event->isMainRequest()) {
            return;
        }
        $request = $event->getRequest();
        $response = $event->getResponse();
        $status = $response->getStatusCode();
        $response->headers->set('X-Request-Id', $request->attributes->getString('requestId'));
        $fields = [
            'requestId' => $request->attributes->getString('requestId'),
            'method' => $request->getMethod(),
            'path' => $request->getPathInfo(),
            'route' => $request->attributes->get('_route'),
            'status' => $status,
            'durationMs' => intdiv(hrtime(true) - $request->attributes->getInt('startedAt'), 1_000_000),
        ];
        if ($request->attributes->has('errorCode')) {
            $fields['errorCode'] = $request->attributes->get('errorCode');
        }
        $level = $status >= 500 ? 'error' : ($status >= 400 ? 'warning' : 'info');
        $this->logger->log($level, 'http request', $fields);
    }
}
`),
    ...phpClass("src", `${http}\\ErrorSubscriber`, [layout.error, "Psr\\Log\\LoggerInterface", "Symfony\\Component\\EventDispatcher\\EventSubscriberInterface", "Symfony\\Component\\HttpFoundation\\JsonResponse", "Symfony\\Component\\HttpKernel\\Event\\ExceptionEvent", "Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface", "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException", "Symfony\\Component\\HttpKernel\\KernelEvents", "Symfony\\Component\\Validator\\Exception\\ValidationFailedException"], raw`/** Every failure leaves as the same JSON, and an unknown one never shows its details. */
final readonly class ErrorSubscriber implements EventSubscriberInterface
{
    private const STATUS = ['invalid' => 400, 'not_found' => 404];

    public function __construct(private LoggerInterface $logger)
    {
    }

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::EXCEPTION => ['onException', 1]];
    }

    public function onException(ExceptionEvent $event): void
    {
        $error = $event->getThrowable();
        $request = $event->getRequest();
        $requestId = $request->attributes->getString('requestId');
        $invalid = $error->getPrevious();
        [$status, $code, $message] = match (true) {
            $error instanceof AppError => [self::STATUS[$error->errorCode], $error->errorCode, $error->getMessage()],
            $invalid instanceof ValidationFailedException => [400, 'invalid', self::issues($invalid)],
            $error instanceof NotFoundHttpException => [404, 'not_found', 'Route not found'],
            $error instanceof HttpExceptionInterface => [$error->getStatusCode(), 'http_error', $error->getMessage()],
            default => [500, 'internal', "Internal server error ($requestId)"],
        };
        if (500 === $status) {
            $this->logger->error('unhandled error', ['exception' => $error, 'requestId' => $requestId]);
        }
        $request->attributes->set('errorCode', $code);
        $event->setResponse(new JsonResponse(['error' => ['code' => $code, 'message' => $message]], $status));
    }

    private static function issues(ValidationFailedException $error): string
    {
        $issues = [];
        foreach ($error->getViolations() as $violation) {
            $issues[] = $violation->getPropertyPath().': '.$violation->getMessage();
        }

        return implode('; ', $issues);
    }
}
`),
    "tests/AppTest.php": raw`<?php

namespace App\Tests;

${[...new Set([layout.getHealth, layout.healthCheck, "App\\Kernel", "PHPUnit\\Framework\\TestCase", "Symfony\\Component\\HttpFoundation\\Request", "Symfony\\Component\\HttpFoundation\\Response"])].sort().map((item) => `use ${item};`).join("\n")}

final class AppTest extends TestCase
{
    private Kernel $kernel;

    protected function setUp(): void
    {
        $this->kernel = new Kernel('test', false);
    }

    protected function tearDown(): void
    {
        $this->kernel->shutdown();
    }

    public function testHealthIsDegradedWhenADependencyFails(): void
    {
        $check = new class implements HealthCheck {
            public function name(): string
            {
                return 'database';
            }

            public function run(): void
            {
                throw new \RuntimeException('down');
            }
        };

        self::assertSame(['status' => 'degraded', 'checks' => ['database' => false]], (new GetHealth([$check]))());
    }

    public function testTheAppAnswers(): void
    {
        self::assertSame(200, $this->send('GET', '/')->getStatusCode());
    }

    public function testEveryFailureAnswersTheSameJsonWithARequestId(): void
    {
        $cases = [
            [$this->send('GET', '/unknown'), 404, 'not_found'],
            [$this->send('POST', '/health'), 405, 'http_error'],
        ];
        foreach ($cases as [$response, $status, $code]) {
            self::assertSame($status, $response->getStatusCode());
            self::assertSame($code, $this->json($response)['error']['code']);
            self::assertNotEmpty($response->headers->get('X-Request-Id'));
        }
    }

    private function send(string $method, string $path, ?string $body = null): Response
    {
        return $this->kernel->handle(Request::create($path, $method, server: ['CONTENT_TYPE' => 'application/json'], content: $body));
    }

    /** @return array<string, mixed> */
    private function json(Response $response): array
    {
        return json_decode((string) $response->getContent(), true, flags: JSON_THROW_ON_ERROR);
    }
}
`,
    "tests/LogTest.php": raw`<?php

namespace App\Tests;

${[...[layout.formatter, layout.redactor], "Monolog\\Level", "Monolog\\LogRecord", "PHPUnit\\Framework\\TestCase"].sort().map((item) => `use ${item};`).join("\n")}

final class LogTest extends TestCase
{
    public function testAnHttpLineIsReadableAndKeepsItsFields(): void
    {
        $fields = ['requestId' => 'r', 'method' => 'GET', 'path' => '/users/1', 'route' => 'users', 'status' => 200, 'durationMs' => 5];
        $line = (new PrettyLogFormatter(false))->format(new LogRecord(new \DateTimeImmutable(), 'app', Level::Info, 'http request', $fields));

        self::assertStringEndsWith("INFO: GET /users/1 200 5ms  requestId=r route=users\n", $line);
    }

    public function testSecretsAreRedacted(): void
    {
        $record = new LogRecord(new \DateTimeImmutable(), 'app', Level::Info, 'login', ['password' => 'hunter2', 'nested' => ['token' => 'abc']]);

        self::assertSame(['password' => '[redacted]', 'nested' => ['token' => '[redacted]']], (new RedactLogProcessor())($record)->context);
    }
}
`,
    ".php-cs-fixer.dist.php": ["<?php", "", "$finder = (new PhpCsFixer\\Finder())->in(__DIR__)->exclude('var');", "", "return (new PhpCsFixer\\Config())->setRules(['@Symfony' => true])->setFinder($finder);", ""].join("\n"),
    "phpstan.dist.neon": ["parameters:", "    level: 6", "    paths:", "        - src", "        - tests", ""].join("\n"),
    "phpunit.dist.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<phpunit bootstrap="vendor/autoload.php" colors="true" cacheDirectory=".phpunit.cache">',
      "    <php>",
      '        <server name="APP_ENV" value="test" force="true"/>',
      '        <server name="APP_SECRET" value="test"/>',
      // Doctrine reads the variable at boot, and connects only on a first query, which tests never make.
      ...(doctrine ? ['        <server name="DATABASE_URL" value="postgres://test:test@127.0.0.1:5432/test"/>'] : []),
      "    </php>",
      "    <testsuites>",
      '        <testsuite name="app">',
      "            <directory>tests</directory>",
      "        </testsuite>",
      "    </testsuites>",
      "</phpunit>", "",
    ].join("\n"),
    ".gitignore": ["/.env.local", "/.env.local.php", "/.env.*.local", "/var/", "/vendor/", ".php-cs-fixer.cache", ".phpunit.cache", ".claude/settings.local.json", ""].join("\n"),
    // As in the official skeleton: `.env` is committed and holds no secret, `.env.local` holds the values of this machine.
    ".env": [
      "# In all environments, the following files are loaded if they exist,",
      "# the latter taking precedence over the former:",
      "#",
      "#  * .env                contains default values for the environment variables needed by the app",
      "#  * .env.local          uncommitted file with local overrides",
      "#  * .env.$APP_ENV       committed environment-specific defaults",
      "#  * .env.$APP_ENV.local uncommitted environment-specific overrides",
      "#",
      "# Real environment variables win over .env files.",
      "#",
      "# DO NOT DEFINE PRODUCTION SECRETS IN THIS FILE NOR IN ANY OTHER COMMITTED FILES.",
      "# https://symfony.com/doc/current/configuration/secrets.html",
      "",
      "###> symfony/framework-bundle ###", "APP_ENV=dev", "APP_SECRET=", "APP_SHARE_DIR=var/share", "###< symfony/framework-bundle ###", "",
      "###> symfony/routing ###", "# Configure how to generate URLs in non-HTTP contexts, such as CLI commands.", "# See https://symfony.com/doc/current/routing.html#generating-urls-in-commands", "DEFAULT_URI=http://localhost", "###< symfony/routing ###", "",
      ...(mail ? ["###> symfony/mailer ###", "MAILER_DSN=null://null", "###< symfony/mailer ###", ""] : []),
      ...(postgres ? ["###> doctrine/doctrine-bundle ###", "# Format described at https://www.doctrine-project.org/projects/doctrine-dbal/en/latest/reference/configuration.html#connecting-using-a-url", 'DATABASE_URL="postgresql://app:!ChangeMe!@127.0.0.1:5432/app?serverVersion=16&charset=utf8"', "###< doctrine/doctrine-bundle ###", ""] : []),
      ...(redis ? ["###> predis/predis ###", "REDIS_URL=redis://127.0.0.1:6379", "REDIS_PREFIX=", "###< predis/predis ###", ""] : []),
    ].join("\n"),
    "README.md": [
      `# ${name}`, "",
      "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
      "```sh", "composer validate --no-check-publish", "composer lint", "composer analyse", "composer test", "```", "",
      "In Docker, run these inside the `app` container: dependencies live there.", "",
      modules
        ? "Each feature lives in `src/Modules/<Name>`: `Domain` holds the rules and the ports, `Application` the use cases, `Infrastructure` HTTP and storage. Dependencies point inward, and `config/services.php` wires them. `Health` shows the layout."
        : "`src/Controller` holds the HTTP routes, `src/EventListener` the access log and error handling, and `config/services.php` wires them.",
      "",
    ].join("\n"),
  };

  if (docker) {
    files.Caddyfile = [
      "# Paths are explicit: the default of `watch` also covers `var/cache`, which the app rewrites at boot.",
      "{", "\tskip_install_trust", "}", "",
      "http://:{$PORT} {", "\troot public/", "\tphp_server {", "\t\tworker {", "\t\t\tfile ./public/index.php", "\t\t\tnum 2",
      "\t\t\twatch ./src/**/*.php", "\t\t\twatch ./config/**/*.php", "\t\t}", "\t}", "}", "",
    ].join("\n");
  }
  if (doctrine) {
    files["config/packages/doctrine.php"] = configFile([], [
      "    $container->extension('doctrine', [",
      "        // The lowest PostgreSQL that DevHub offers: Doctrine picks its SQL from this, and stops without it.",
      "        'dbal' => ['url' => '%env(DATABASE_URL)%', 'server_version' => '15', 'options' => [PDO::ATTR_TIMEOUT => 2]],",
      "        'orm' => ['mappings' => ['App' => [",
      "            'type' => 'attribute',",
      // In modules, one mapping covers every feature, so a copied module needs no configuration.
      `            'dir' => '%kernel.project_dir%/${modules ? "src/Modules" : "src/Entity"}',`,
      `            'prefix' => '${modules ? "App\\\\Modules" : "App\\\\Entity"}',`,
      "        ]]],",
      "    ]);",
      "    $container->extension('doctrine_migrations', ['migrations_paths' => ['DoctrineMigrations' => '%kernel.project_dir%/migrations']]);",
    ].join("\n"));
    files["migrations/.gitignore"] = "";
    if (!modules) files["src/Entity/.gitignore"] = "";
  }
  if (postgres) {
    Object.assign(files, phpClass("src", databaseCheck, [layout.healthCheck, ...(doctrine ? ["Doctrine\\DBAL\\Connection"] : [])], doctrine ? raw`final readonly class DatabaseCheck implements HealthCheck
{
    public function __construct(private Connection $connection)
    {
    }

    public function name(): string
    {
        return 'database';
    }

    public function run(): void
    {
        $this->connection->executeQuery('select 1');
    }
}
` : raw`final readonly class DatabaseCheck implements HealthCheck
{
    public function __construct(private string $url)
    {
    }

    public function name(): string
    {
        return 'database';
    }

    public function run(): void
    {
        $url = parse_url($this->url) ?: [];
        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'] ?? '', $url['port'] ?? 5432, ltrim($url['path'] ?? '', '/'));
        $pdo = new \PDO($dsn, $url['user'] ?? null, $url['pass'] ?? null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 2]);
        $pdo->query('select 1');
    }
}
`));
  }
  if (redis) {
    Object.assign(files, phpClass("src", redisCheck, [layout.healthCheck, "Predis\\Client"], raw`final readonly class RedisCheck implements HealthCheck
{
    public function __construct(private Client $client)
    {
    }

    public function name(): string
    {
        return 'redis';
    }

    public function run(): void
    {
        $this->client->ping();
    }
}
`));
  }
  return files;
}

const phpString = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

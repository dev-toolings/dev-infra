import { layoutFor, namespaceOf, noteCalls, pathOf, phpClass, sharedFiles, shortName } from "./php-shared";

const raw = String.raw;

export type SymfonyOptions = { name: string; modules: boolean; doctrine: boolean; postgres: boolean; redis: boolean; mail: boolean };

/** Same lines in every Symfony file of `config/`. */
const configFile = (uses: string[], body: string) => ["<?php", "", ...[...uses.filter((item) => !item.startsWith("function ")), "Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator"].sort().map((item) => `use ${item};`), "", ...uses.filter((item) => item.startsWith("function ")).flatMap((item) => [`use ${item};`, ""]), "return static function (ContainerConfigurator $container): void {", body, "};", ""].join("\n");

export function symfonyFiles({ name, modules, doctrine, postgres, redis, mail }: SymfonyOptions): Record<string, string> {
  const layout = layoutFor("src", modules, { error: "App\\Exception\\AppError", model: "App\\Model\\Note", repositories: "App\\Repository", service: "App\\Service\\NoteService", logging: "App\\Logging", health: "App\\Health" });
  const http = modules ? "App\\Shared\\Infrastructure\\Http" : "App\\EventListener";
  const health = modules ? "App\\Modules\\Health\\Infrastructure" : "App\\Health";
  const persistence = namespaceOf(layout.memory);
  const record = modules ? `${persistence}\\NoteRecord` : "App\\Entity\\NoteRecord";
  const doctrineStore = `${persistence}\\DoctrineNoteRepository`;
  const controllers = modules ? { health: `${health}\\Http\\HealthController`, notes: "App\\Modules\\Notes\\Infrastructure\\Http\\NoteController", input: "App\\Modules\\Notes\\Infrastructure\\Http\\NoteInput" } : { health: "App\\Controller\\HealthController", notes: "App\\Controller\\NoteController", input: "App\\Dto\\NoteInput" };
  const databaseCheck = `${health}\\DatabaseCheck`, redisCheck = `${health}\\RedisCheck`;
  const calls = noteCalls(layout);
  const Note = shortName(layout.note);
  const args = calls.args.map((arg) => arg.replace("private readonly ", "private "));
  const controllerConstructor = args.length > 1 ? `    public function __construct(\n        ${args.join(",\n        ")},\n    ) {\n    }` : `    public function __construct(${args[0]})\n    {\n    }`;
  const excluded = [
    "../src/Kernel.php", pathOf("../src", layout.error), pathOf("../src", layout.note), pathOf("../src", controllers.input),
    ...(doctrine ? [pathOf("../src", record)] : []),
  ];

  const files: Record<string, string> = {
    ...sharedFiles(layout),
    "src/Kernel.php": ["<?php", "", "namespace App;", "", "use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;", "use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;", "", "final class Kernel extends BaseKernel", "{", "    use MicroKernelTrait;", "}", ""].join("\n"),
    "public/index.php": ["<?php", "", "use App\\Kernel;", "", "require_once dirname(__DIR__).'/vendor/autoload_runtime.php';", "", "return static fn (array $context) => new Kernel($context['APP_ENV'] ?? 'dev', (bool) ($context['APP_DEBUG'] ?? true));", ""].join("\n"),
    "bin/console": raw`#!/usr/bin/env php
<?php

use App\Kernel;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Input\ArgvInput;
use Symfony\Component\Dotenv\Dotenv;

require dirname(__DIR__).'/vendor/autoload.php';

// A running app gets its environment from DevHub. A command started by hand reads this file in native mode.
if (is_file(dirname(__DIR__).'/.env')) {
    (new Dotenv())->load(dirname(__DIR__).'/.env');
}

$env = $_SERVER['APP_ENV'] ?? 'dev';
$application = new Application(new Kernel($env, (bool) ($_SERVER['APP_DEBUG'] ?? 'prod' !== $env)));
exit($application->run(new ArgvInput()));
`,
    "config/bundles.php": ["<?php", "", "return [", "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],", "    Symfony\\Bundle\\MonologBundle\\MonologBundle::class => ['all' => true],", ...(doctrine ? ["    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],", "    Doctrine\\Bundle\\MigrationsBundle\\DoctrineMigrationsBundle::class => ['all' => true],"] : []), "];", ""].join("\n"),
    "config/routes.php": ["<?php", "", "use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;", "", "return static function (RoutingConfigurator $routes): void {", "    $routes->import('../src/', 'attribute');", "};", ""].join("\n"),
    "config/packages/framework.php": configFile([], [
      "    $container->extension('framework', [",
      "        'secret' => '%env(APP_SECRET)%',",
      "        'validation' => ['enabled' => true],",
      "        'serializer' => ['enabled' => true],",
      "        'property_info' => ['enabled' => true, 'with_constructor_extractor' => true],",
      ...(mail ? ["        'mailer' => ['dsn' => 'smtp://%env(SMTP_HOST)%:%env(SMTP_PORT)%'],"] : []),
      "    ]);",
    ].join("\n")),
    "config/packages/monolog.php": configFile([layout.formatter], raw`    $handler = match ($container->env()) {
        'test' => ['type' => 'null'],
        'dev' => ['type' => 'stream', 'path' => 'php://stderr', 'level' => 'debug', 'formatter' => ${shortName(layout.formatter)}::class],
        default => ['type' => 'stream', 'path' => 'php://stderr', 'level' => 'info', 'formatter' => 'monolog.formatter.json'],
    };
    $container->extension('monolog', ['handlers' => ['main' => $handler]]);`),
    "config/services.php": configFile([
      layout.redactor, layout.healthCheck, layout.getHealth, layout.repository,
      ...(doctrine ? [doctrineStore] : [layout.sqlite]),
      ...(postgres && !doctrine ? [databaseCheck] : []),
      ...(redis ? ["Predis\\Client"] : []),
      "function Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\tagged_iterator",
    ], [
      "    $services = $container->services()->defaults()->autowire()->autoconfigure();",
      `    $services->load('App\\\\', '../src/')->exclude([${excluded.map((item) => `'${item}'`).join(", ")}]);`,
      "    $services->instanceof(HealthCheck::class)->tag('app.health_check');",
      "    $services->set(GetHealth::class)->arg('$checks', tagged_iterator('app.health_check'));",
      `    $services->set(${shortName(layout.redactor)}::class)->tag('monolog.processor');`,
      ...(doctrine ? [`    $services->alias(${shortName(layout.repository)}::class, DoctrineNoteRepository::class);`] : [
        "    $services->set(SqliteNoteRepository::class)->arg('$path', '%kernel.project_dir%/var/notes.sqlite');",
        `    $services->alias(${shortName(layout.repository)}::class, SqliteNoteRepository::class);`,
      ]),
      ...(postgres && !doctrine ? ["    $services->set(DatabaseCheck::class)->arg('$url', '%env(DATABASE_URL)%');"] : []),
      ...(redis ? ["    $services->set(Client::class)->args(['%env(REDIS_URL)%', ['prefix' => '%env(REDIS_PREFIX)%', 'timeout' => 2]]);"] : []),
    ].join("\n")),
    "config/services_test.php": configFile([layout.memory, layout.repository], `    $container->services()->set(${shortName(layout.repository)}::class, MemoryNoteRepository::class);`),
    ...phpClass("src", controllers.input, ["Symfony\\Component\\Validator\\Constraints as Assert"], raw`/** The shape of a request. Business rules stay out of it. */
final readonly class NoteInput
{
    public function __construct(
        #[Assert\NotNull]
        #[Assert\Length(max: 10_000)]
        public string $body,
    ) {
    }
}
`),
    ...phpClass("src", controllers.health, [layout.getHealth, "Symfony\\Component\\HttpFoundation\\JsonResponse", "Symfony\\Component\\Routing\\Attribute\\Route"], raw`final readonly class HealthController
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

        return new JsonResponse($report, 'ok' === $report['status'] ? 200 : 503);
    }
}
`),
    ...phpClass("src", controllers.notes, [...calls.uses, controllers.input, "Symfony\\Component\\HttpFoundation\\JsonResponse", "Symfony\\Component\\HttpFoundation\\Response", "Symfony\\Component\\HttpKernel\\Attribute\\MapRequestPayload", "Symfony\\Component\\Routing\\Attribute\\Route"], raw`final readonly class NoteController
{
${controllerConstructor}

    #[Route('/notes', methods: ['GET'])]
    public function list(): JsonResponse
    {
        return new JsonResponse(${calls.list});
    }

    #[Route('/notes', methods: ['POST'])]
    public function create(#[MapRequestPayload] NoteInput $input): JsonResponse
    {
        return new JsonResponse(${calls.create("$input->body")}, Response::HTTP_CREATED);
    }

    #[Route('/notes/{id}', methods: ['GET'])]
    public function show(string $id): JsonResponse
    {
        return new JsonResponse(${calls.get});
    }

    #[Route('/notes/{id}', methods: ['PATCH'])]
    public function update(string $id, #[MapRequestPayload] NoteInput $input): JsonResponse
    {
        return new JsonResponse(${calls.update("$input->body")});
    }

    #[Route('/notes/{id}', methods: ['DELETE'])]
    public function delete(string $id): Response
    {
        ${calls.delete};

        return new Response(status: Response::HTTP_NO_CONTENT);
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

    public function testANoteCanBeCreatedReadAndDeleted(): void
    {
        $created = $this->send('POST', '/notes', '{"body":" hello "}');
        self::assertSame(201, $created->getStatusCode());
        $note = $this->json($created);
        self::assertSame('hello', $note['body']);
        self::assertSame(200, $this->send('GET', "/notes/{$note['id']}")->getStatusCode());
        self::assertSame('bye', $this->json($this->send('PATCH', "/notes/{$note['id']}", '{"body":"bye"}'))['body']);
        self::assertSame(204, $this->send('DELETE', "/notes/{$note['id']}")->getStatusCode());
        self::assertSame(404, $this->send('GET', "/notes/{$note['id']}")->getStatusCode());
    }

    public function testEveryFailureAnswersTheSameJsonWithARequestId(): void
    {
        $cases = [
            [$this->send('POST', '/notes', '{"body":"   "}'), 400, 'invalid'],
            [$this->send('POST', '/notes', '{"body":1}'), 400, 'invalid'],
            [$this->send('POST', '/notes', '{'), 400, 'http_error'],
            [$this->send('GET', '/notes/unknown'), 404, 'not_found'],
            [$this->send('GET', '/unknown'), 404, 'not_found'],
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
        $fields = ['requestId' => 'r', 'method' => 'GET', 'path' => '/notes/1', 'route' => 'notes', 'status' => 200, 'durationMs' => 5];
        $line = (new PrettyLogFormatter(false))->format(new LogRecord(new \DateTimeImmutable(), 'app', Level::Info, 'http request', $fields));

        self::assertStringEndsWith("INFO: GET /notes/1 200 5ms  requestId=r route=notes\n", $line);
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
    ".gitignore": ["/.env", "/var/", "/vendor/", ".php-cs-fixer.cache", ".phpunit.cache", ".claude/settings.local.json", ""].join("\n"),
    ".env.example": ["APP_ENV=dev", "APP_DEBUG=1", "APP_SECRET=", ...(postgres ? ["DATABASE_URL="] : []), ...(redis ? ["REDIS_URL=", "REDIS_PREFIX="] : []), ...(mail ? ["SMTP_HOST=", "SMTP_PORT="] : []), ""].join("\n"),
    "README.md": [
      `# ${name}`, "",
      "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
      "```sh", "composer validate --no-check-publish", "composer lint", "composer analyse", "composer test", "```", "",
      "In Docker, run these inside the `app` container: dependencies live there.", "",
      modules
        ? "Each feature lives in `src/Modules/<Name>`: `Domain` holds the rules and the ports, `Application` the use cases, `Infrastructure` HTTP and storage. Dependencies point inward, and `config/services.php` wires them. `Notes` is an example to copy or delete."
        : "`src/Controller` holds the HTTP routes, `src/Dto` the request shapes, `src/Service` the logic, `src/Repository` the storage, `src/EventListener` the access log and error handling, and `config/services.php` wires them. `Notes` is an example to copy or delete.",
      "",
      doctrine ? "`/notes` answers 500 until its table exists: run `php bin/console doctrine:migrations:migrate --no-interaction`." : "`/notes` keeps its data in `var/notes.sqlite`.",
      "",
    ].join("\n"),
  };

  if (doctrine) {
    files["config/packages/doctrine.php"] = configFile([], [
      "    $container->extension('doctrine', [",
      "        // The lowest PostgreSQL that DevHub offers: Doctrine picks its SQL from this, and stops without it.",
      "        'dbal' => ['url' => '%env(DATABASE_URL)%', 'server_version' => '15'],",
      "        'orm' => ['mappings' => ['App' => [",
      "            'type' => 'attribute',",
      `            'dir' => '%kernel.project_dir%/${pathOf("src", record).replace(/\/[^/]+$/, "")}',`,
      `            'prefix' => '${namespaceOf(record).replaceAll("\\", "\\\\")}',`,
      "        ]]],",
      "    ]);",
      "    $container->extension('doctrine_migrations', ['migrations_paths' => ['DoctrineMigrations' => '%kernel.project_dir%/migrations']]);",
    ].join("\n"));
    Object.assign(files, phpClass("src", record, ["Doctrine\\ORM\\Mapping as ORM"], raw`#[ORM\Entity]
#[ORM\Table(name: 'notes')]
class NoteRecord
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column]
        public string $id,
        #[ORM\Column(type: 'text')]
        public string $body,
        #[ORM\Column(name: 'created_at')]
        public string $createdAt,
    ) {
    }
}
`), phpClass("src", doctrineStore, [layout.note, layout.repository, record, "Doctrine\\ORM\\EntityManagerInterface"], raw`final readonly class DoctrineNoteRepository implements ${shortName(layout.repository)}
{
    public function __construct(private EntityManagerInterface $entities)
    {
    }

    public function all(): array
    {
        $records = $this->entities->getRepository(NoteRecord::class)->findBy([], ['createdAt' => 'ASC']);

        return array_map(self::toNote(...), $records);
    }

    public function find(string $id): ?${Note}
    {
        $record = $this->entities->find(NoteRecord::class, $id);

        return null === $record ? null : self::toNote($record);
    }

    public function save(${Note} $note): void
    {
        $record = $this->entities->find(NoteRecord::class, $note->id);
        if (null === $record) {
            $this->entities->persist(new NoteRecord($note->id, $note->body, $note->createdAt));
        } else {
            $record->body = $note->body;
        }
        $this->entities->flush();
    }

    public function delete(string $id): bool
    {
        $record = $this->entities->find(NoteRecord::class, $id);
        if (null === $record) {
            return false;
        }
        $this->entities->remove($record);
        $this->entities->flush();

        return true;
    }

    private static function toNote(NoteRecord $record): ${Note}
    {
        return new ${Note}($record->id, $record->body, $record->createdAt);
    }
}
`));
    files["migrations/Version20260101000000.php"] = raw`<?php

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260101000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE notes (id VARCHAR(255) NOT NULL, body TEXT NOT NULL, created_at VARCHAR(255) NOT NULL, PRIMARY KEY (id))');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE notes');
    }
}
`;
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

/** Code that Symfony and Laravel projects share, so that both behave alike. It has to pass PHP-CS-Fixer and Pint. */

const raw = String.raw;

/** Where each class of a project lives. */
export type PhpLayout = {
  root: "src" | "app";
  modules: boolean;
  error: string; note: string; repository: string; memory: string; sqlite: string;
  service: string; useCases: string; healthCheck: string; getHealth: string; formatter: string; redactor: string;
};

export const namespaceOf = (name: string) => name.slice(0, name.lastIndexOf("\\"));
export const shortName = (name: string) => name.slice(name.lastIndexOf("\\") + 1);
/** `App\Service\NoteService` as its file. */
export const pathOf = (root: string, name: string) => `${root}/${name.replace(/^App\\/, "").replaceAll("\\", "/")}.php`;

/** A class file: imports of its own namespace are dropped, the rest sorted as the formatters want. */
export function phpClass(root: string, name: string, uses: string[], body: string): Record<string, string> {
  const namespace = namespaceOf(name);
  const imports = [...new Set(uses)].filter((item) => namespaceOf(item) !== namespace).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return { [pathOf(root, name)]: ["<?php", "", `namespace ${namespace};`, "", ...(imports.length ? [...imports.map((item) => `use ${item};`), ""] : []), body].join("\n") };
}

export const layoutFor = (root: "src" | "app", modules: boolean, standard: { error: string; model: string; repositories: string; service: string; logging: string; health: string }): PhpLayout => {
  const notes = "App\\Modules\\Notes", health = "App\\Modules\\Health", logging = "App\\Shared\\Infrastructure\\Logging";
  return modules ? {
    root, modules, error: "App\\Shared\\Domain\\AppError",
    note: `${notes}\\Domain\\Note`, repository: `${notes}\\Domain\\NoteRepository`,
    memory: `${notes}\\Infrastructure\\Persistence\\MemoryNoteRepository`, sqlite: `${notes}\\Infrastructure\\Persistence\\SqliteNoteRepository`,
    service: "", useCases: `${notes}\\Application`,
    healthCheck: `${health}\\Domain\\HealthCheck`, getHealth: `${health}\\Application\\GetHealth`,
    formatter: `${logging}\\PrettyLogFormatter`, redactor: `${logging}\\RedactLogProcessor`,
  } : {
    root, modules, error: standard.error,
    note: standard.model, repository: `${standard.repositories}\\NoteRepository`,
    memory: `${standard.repositories}\\MemoryNoteRepository`, sqlite: `${standard.repositories}\\SqliteNoteRepository`,
    service: standard.service, useCases: "",
    healthCheck: `${standard.health}\\HealthCheck`, getHealth: `${standard.health}\\GetHealth`,
    formatter: `${standard.logging}\\PrettyLogFormatter`, redactor: `${standard.logging}\\RedactLogProcessor`,
  };
};

/** What a controller needs: its constructor arguments and the call behind each route. */
export function noteCalls(layout: PhpLayout) {
  if (!layout.modules) {
    return {
      uses: [layout.service], args: [`private readonly ${shortName(layout.service)} $notes`],
      list: "$this->notes->list()", create: (body: string) => `$this->notes->create(${body})`, get: "$this->notes->get($id)",
      update: (body: string) => `$this->notes->update($id, ${body})`, delete: "$this->notes->delete($id)",
    };
  }
  const names = ["ListNotes", "CreateNote", "GetNote", "UpdateNote", "DeleteNote"];
  return {
    uses: names.map((item) => `${layout.useCases}\\${item}`),
    args: names.map((item) => `private readonly ${item} $${item[0]!.toLowerCase()}${item.slice(1)}`),
    list: "($this->listNotes)()", create: (body: string) => `($this->createNote)(${body})`, get: "($this->getNote)($id)",
    update: (body: string) => `($this->updateNote)($id, ${body})`, delete: "($this->deleteNote)($id)",
  };
}

/** The rules where PHP-CS-Fixer and Pint disagree: each project passes the formatter it ships. */
const styleOf = (root: PhpLayout["root"]) => root === "src"
  ? { eq: (value: string, expression: string) => `${value} === ${expression}`, emptyBody: "\n    {\n    }", plainNew: (name: string) => `new ${name}()`, tagGap: "\n     *" }
  : { eq: (value: string, expression: string) => `${expression} === ${value}`, emptyBody: " {}", plainNew: (name: string) => `new ${name}`, tagGap: "" };

/** The domain, the two stores without a framework, and the health report. */
export function sharedFiles(layout: PhpLayout): Record<string, string> {
  const { root, error, note, repository, memory, sqlite, healthCheck, getHealth, formatter, redactor } = layout;
  const Note = shortName(note), Port = shortName(repository);
  const { eq, emptyBody, plainNew, tagGap } = styleOf(root);
  const paramDoc = root === "src" ? `@param array<array-key, mixed> $fields${tagGap}` : "@param  array<array-key, mixed>  $fields";
  return {
    ...phpClass(root, error, [], raw`/** An expected failure. It knows nothing of HTTP: the error handler picks the status. */
final class AppError extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}
`),
    ...phpClass(root, note, [error], raw`final readonly class ${Note}
{
    public function __construct(public string $id, public string $body, public string $createdAt)${emptyBody}

    public static function create(string $body): self
    {
        $createdAt = (${plainNew("\\DateTimeImmutable")})->format('Y-m-d\TH:i:s.uP');

        return new self(bin2hex(random_bytes(16)), self::clean($body), $createdAt);
    }

    public function withBody(string $body): self
    {
        return new self($this->id, self::clean($body), $this->createdAt);
    }

    /** A rule of the domain: blank text is not a note. */
    private static function clean(string $body): string
    {
        $clean = trim($body);
        if (${eq("''", "$clean")}) {
            throw new AppError('invalid', 'A note needs some text');
        }

        return $clean;
    }
}
`),
    ...phpClass(root, repository, [note], raw`/** The port: the code says what it needs, and a store provides it. */
interface ${Port}
{
    /** @return list<${Note}> */
    public function all(): array;

    public function find(string $id): ?${Note};

    public function save(${Note} $note): void;

    public function delete(string $id): bool;
}
`),
    ...phpClass(root, memory, [note, repository], raw`/** Lost at the end of the request: for tests only. */
final class MemoryNoteRepository implements ${Port}
{
    /** @var array<string, ${Note}> */
    private array $notes = [];

    public function all(): array
    {
        return array_values($this->notes);
    }

    public function find(string $id): ?${Note}
    {
        return $this->notes[$id] ?? null;
    }

    public function save(${Note} $note): void
    {
        $this->notes[$note->id] = $note;
    }

    public function delete(string $id): bool
    {
        $found = isset($this->notes[$id]);
        unset($this->notes[$id]);

        return $found;
    }
}
`),
    ...phpClass(root, sqlite, [note, repository], raw`/** A file on disk: PHP forgets its memory between requests, and each worker has its own. */
final class SqliteNoteRepository implements ${Port}
{
    private readonly \PDO $pdo;

    public function __construct(string $path)
    {
        $this->pdo = new \PDO("sqlite:$path", options: [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 5]);
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)');
    }

    public function all(): array
    {
        $rows = $this->pdo->query('SELECT id, body, created_at FROM notes ORDER BY created_at');

        return array_map(self::toNote(...), $rows->fetchAll(\PDO::FETCH_ASSOC));
    }

    public function find(string $id): ?${Note}
    {
        $query = $this->pdo->prepare('SELECT id, body, created_at FROM notes WHERE id = ?');
        $query->execute([$id]);
        $row = $query->fetch(\PDO::FETCH_ASSOC);

        return is_array($row) ? self::toNote($row) : null;
    }

    public function save(${Note} $note): void
    {
        $query = $this->pdo->prepare('INSERT INTO notes (id, body, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body');
        $query->execute([$note->id, $note->body, $note->createdAt]);
    }

    public function delete(string $id): bool
    {
        $query = $this->pdo->prepare('DELETE FROM notes WHERE id = ?');
        $query->execute([$id]);

        return $query->rowCount() > 0;
    }

    /** @param array<string, string> $row */
    private static function toNote(array $row): ${Note}
    {
        return new ${Note}($row['id'], $row['body'], $row['created_at']);
    }
}
`),
    ...noteLogic(layout),
    ...phpClass(root, healthCheck, [], raw`interface HealthCheck
{
    public function name(): string;

    /** Throws when the dependency does not answer. */
    public function run(): void;
}
`),
    ...phpClass(root, getHealth, [healthCheck], raw`final readonly class GetHealth
{
    /** @param iterable<HealthCheck> $checks */
    public function __construct(private iterable $checks)${emptyBody}

    /** @return array{status: string, checks: array<string, bool>} */
    public function __invoke(): array
    {
        $results = [];
        foreach ($this->checks as $check) {
            try {
                $check->run();
                $results[$check->name()] = true;
            } catch (\Throwable) {
                $results[$check->name()] = false;
            }
        }

        return ['status' => in_array(false, $results, true) ? 'degraded' : 'ok', 'checks' => $results];
    }
}
`),
    ...phpClass(root, redactor, ["Monolog\\LogRecord", "Monolog\\Processor\\ProcessorInterface"], raw`final class RedactLogProcessor implements ProcessorInterface
{
    private const SECRET_KEYS = ['authorization', 'cookie', 'password', 'token', 'secret', 'apikey'];

    public function __invoke(LogRecord $record): LogRecord
    {
        return $record->with(context: self::redact($record->context), extra: self::redact($record->extra));
    }

    /**
     * ${paramDoc}
     * @return array<array-key, mixed>
     */
    private static function redact(array $fields): array
    {
        foreach ($fields as $key => $value) {
            if (in_array(strtolower((string) $key), self::SECRET_KEYS, true)) {
                $fields[$key] = '[redacted]';
            } elseif (is_array($value)) {
                $fields[$key] = self::redact($value);
            }
        }

        return $fields;
    }
}
`),
    ...phpClass(root, formatter, ["Monolog\\Formatter\\FormatterInterface", "Monolog\\LogRecord"], raw`/** One readable line per event, for development. */
final class PrettyLogFormatter implements FormatterInterface
{
    private const RENDERED_KEYS = ['method', 'path', 'status', 'durationMs'];

    private const LEVEL_COLORS = ['DEBUG' => '34', 'INFO' => '32', 'NOTICE' => '32', 'WARNING' => '33', 'ERROR' => '31'];

    private readonly bool $color;

    public function __construct(?bool $color = null)
    {
        // Forced: DevHub reads logs through a pipe, where a TTY check turns colors off.
        $this->color = $color ?? in_array(getenv('NO_COLOR'), [false, ''], true);
    }

    public function format(LogRecord $record): string
    {
        $fields = [...$record->context, ...$record->extra];
        $message = $record->message;
        if (${eq("'http request'", "$message")} && is_int($fields['status'] ?? null)) {
            $method = $this->paint('1', (string) $fields['method']);
            $message = "$method {$fields['path']} {$this->status($fields['status'])} {$fields['durationMs']}ms";
        }
        $rest = [];
        foreach ($fields as $key => $value) {
            if (in_array($key, self::RENDERED_KEYS, true)) {
                continue;
            }
            $rest[] = $key.'='.self::value($value);
        }
        $clock = $record->datetime->format('H:i:s.v');
        $level = $this->paint(self::LEVEL_COLORS[$record->level->getName()] ?? '41', $record->level->getName());
        $line = "[$clock] $level: $message";

        return $line.(${eq("[]", "$rest")} ? '' : '  '.$this->paint('90', implode(' ', $rest)))."\n";
    }

    public function formatBatch(array $records): string
    {
        return implode('', array_map($this->format(...), $records));
    }

    private function status(int $status): string
    {
        return $this->paint($status >= 500 ? '31' : ($status >= 400 ? '33' : '32'), (string) $status);
    }

    private function paint(string $color, string $text): string
    {
        return $this->color ? "\033[{$color}m$text\033[0m" : $text;
    }

    private static function value(mixed $value): string
    {
        if ($value instanceof \Throwable) {
            return json_encode($value->getMessage().' at '.$value->getFile().':'.$value->getLine(), JSON_UNESCAPED_SLASHES) ?: '';
        }
        if (is_string($value)) {
            return ${eq("1", `preg_match('/[\\s"=]/', $value)`)} ? (json_encode($value, JSON_UNESCAPED_SLASHES) ?: '') : $value;
        }

        return json_encode($value, JSON_UNESCAPED_SLASHES) ?: '';
    }
}
`),
  };
}

function noteLogic(layout: PhpLayout): Record<string, string> {
  const { root, error, note, repository, service, useCases, modules } = layout;
  const Note = shortName(note), Port = shortName(repository);
  const { emptyBody } = styleOf(root);
  if (!modules) {
    return phpClass(root, service, [error, note, repository], raw`final readonly class NoteService
{
    public function __construct(private ${Port} $notes)${emptyBody}

    /** @return list<${Note}> */
    public function list(): array
    {
        return $this->notes->all();
    }

    public function get(string $id): ${Note}
    {
        return $this->notes->find($id) ?? throw new AppError('not_found', 'Note not found');
    }

    public function create(string $body): ${Note}
    {
        $note = ${Note}::create($body);
        $this->notes->save($note);

        return $note;
    }

    public function update(string $id, string $body): ${Note}
    {
        $note = $this->get($id)->withBody($body);
        $this->notes->save($note);

        return $note;
    }

    public function delete(string $id): void
    {
        if ($this->notes->delete($id)) {
            return;
        }

        throw new AppError('not_found', 'Note not found');
    }
}
`);
  }
  const useCase = (name: string, uses: string[], body: string) => phpClass(root, `${useCases}\\${name}`, uses, `final readonly class ${name}\n{\n    public function __construct(private ${Port} $notes)${emptyBody}\n\n${body}}\n`);
  return {
    ...useCase("ListNotes", [note, repository], raw`    /** @return list<${Note}> */
    public function __invoke(): array
    {
        return $this->notes->all();
    }
`),
    ...useCase("GetNote", [error, note, repository], raw`    public function __invoke(string $id): ${Note}
    {
        return $this->notes->find($id) ?? throw new AppError('not_found', 'Note not found');
    }
`),
    ...useCase("CreateNote", [note, repository], raw`    public function __invoke(string $body): ${Note}
    {
        $note = ${Note}::create($body);
        $this->notes->save($note);

        return $note;
    }
`),
    ...phpClass(root, `${useCases}\\UpdateNote`, [note, repository], raw`final readonly class UpdateNote
{
    public function __construct(private ${Port} $notes, private GetNote $getNote)${emptyBody}

    public function __invoke(string $id, string $body): ${Note}
    {
        $note = ($this->getNote)($id)->withBody($body);
        $this->notes->save($note);

        return $note;
    }
}
`),
    ...useCase("DeleteNote", [error, repository], raw`    public function __invoke(string $id): void
    {
        if ($this->notes->delete($id)) {
            return;
        }

        throw new AppError('not_found', 'Note not found');
    }
`),
  };
}

/** Code that Symfony and Laravel projects share, so that both behave alike. It has to pass PHP-CS-Fixer and Pint. */

const raw = String.raw;

/** Where each class of a project lives. */
export type PhpLayout = {
  root: "src" | "app";
  modules: boolean;
  error: string; healthCheck: string; getHealth: string; formatter: string; redactor: string;
};

export const namespaceOf = (name: string) => name.slice(0, name.lastIndexOf("\\"));
export const shortName = (name: string) => name.slice(name.lastIndexOf("\\") + 1);
/** `App\Service\Mailer` as its file. */
export const pathOf = (root: string, name: string) => `${root}/${name.replace(/^App\\/, "").replaceAll("\\", "/")}.php`;

/** A class file: imports of its own namespace are dropped, the rest sorted as the formatters want. */
export function phpClass(root: string, name: string, uses: string[], body: string): Record<string, string> {
  const namespace = namespaceOf(name);
  const imports = [...new Set(uses)].filter((item) => namespaceOf(item) !== namespace).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return { [pathOf(root, name)]: ["<?php", "", `namespace ${namespace};`, "", ...(imports.length ? [...imports.map((item) => `use ${item};`), ""] : []), body].join("\n") };
}

export const layoutFor = (root: "src" | "app", modules: boolean, standard: { error: string; logging: string; health: string }): PhpLayout => {
  const health = "App\\Modules\\Health", logging = "App\\Shared\\Infrastructure\\Logging";
  return modules ? {
    root, modules, error: "App\\Shared\\Domain\\AppError",
    healthCheck: `${health}\\Domain\\HealthCheck`, getHealth: `${health}\\Application\\GetHealth`,
    formatter: `${logging}\\PrettyLogFormatter`, redactor: `${logging}\\RedactLogProcessor`,
  } : {
    root, modules, error: standard.error,
    healthCheck: `${standard.health}\\HealthCheck`, getHealth: `${standard.health}\\GetHealth`,
    formatter: `${standard.logging}\\PrettyLogFormatter`, redactor: `${standard.logging}\\RedactLogProcessor`,
  };
};

/** The rules where PHP-CS-Fixer and Pint disagree: each project passes the formatter it ships. */
const styleOf = (root: PhpLayout["root"]) => root === "src"
  ? { eq: (value: string, expression: string) => `${value} === ${expression}`, emptyBody: "\n    {\n    }", tagGap: "\n     *" }
  : { eq: (value: string, expression: string) => `${expression} === ${value}`, emptyBody: " {}", tagGap: "" };

/** What both frameworks share: the expected failure, the health report and the logs. */
export function sharedFiles(layout: PhpLayout): Record<string, string> {
  const { root, error, healthCheck, getHealth, formatter, redactor } = layout;
  const { eq, emptyBody, tagGap } = styleOf(root);
  const paramDoc = root === "src" ? `@param array<array-key, mixed> $fields${tagGap}` : "@param  array<array-key, mixed>  $fields";
  return {
    ...phpClass(root, error, [], raw`/** An expected failure. It knows nothing of HTTP: the error handler picks the status. */
final class AppError extends \RuntimeException
{
    /** @param string $errorCode The code of the JSON error, which also picks its status. */
    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}
`),
    ...phpClass(root, healthCheck, [], raw`/** A dependency that /health reports on. */
interface HealthCheck
{
    /** The key of this dependency in the report. */
    public function name(): string;

    /** Throws when the dependency does not answer. */
    public function run(): void;
}
`),
    ...phpClass(root, getHealth, [healthCheck], raw`/** Runs every health check and sums up the result. */
final readonly class GetHealth
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
    ...phpClass(root, redactor, ["Monolog\\LogRecord", "Monolog\\Processor\\ProcessorInterface"], raw`/** Hides the secrets of a log context, at any depth. */
final class RedactLogProcessor implements ProcessorInterface
{
    private const SECRET_KEYS = ['authorization', 'cookie', 'password', 'token', 'secret', 'apikey', 'api_key'];

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

    /** Colors stay on unless NO_COLOR is set. */
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

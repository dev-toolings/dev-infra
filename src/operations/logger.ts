export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerLike {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface LoggerOptions {
  mode?: "development" | "production";
  level?: LogLevel;
  color?: boolean;
  write?: (line: string) => void;
  now?: () => Date;
}

export const REDACTED = "[redacted]" as const;
export const LOG_REDACT_CENSOR = REDACTED;
export const SENSITIVE_KEY_NAMES = Object.freeze([
  "auth", "authentication", "authorization", "proxy-authorization", "cookie", "set-cookie", "session", "password", "passwd",
  "passphrase", "token", "secret", "apiKey", "credential", "privateKey", "accessKey", "email",
  "body", "requestBody", "responseBody", "payload", "headers", "requestHeaders", "responseHeaders", "request",
] as const);
export const LOG_REDACT_PATHS = Object.freeze([
  "authorization", "cookie", "set-cookie", "*.authorization", "*.proxy-authorization", "*.cookie", "*.set-cookie",
  "*.auth", "*.session", "*.password", "*.passwordHash",
  "*.token", "*.secret", "*.apiKey", "*.credential", "*.privateKey", "*.accessKey",
  "*.email", "*.body", "*.payload", "*.headers", "*.request",
] as const);

const MAX_DEPTH = 5;
const MAX_ENTRIES = 64;
const MAX_STRING_LENGTH = 1024;
const MAX_KEY_LENGTH = 80;
const MAX_INPUT_STRING_LENGTH = 8192;
const MAX_JSON_LOG_LINE = 32_768;
const MAX_OUTPUT_LENGTH = 8192;
const MAX_FIELD_VALUE_LENGTH = 1200;
const TRUNCATED = "[truncated]";
const CIRCULAR = "[circular]";
const MAX_DEPTH_MARKER = "[max-depth]";
const UNSUPPORTED = "[unsupported]";
const COLORS: Record<LogLevel, string> = {
  debug: "\u001b[34m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const GRAY = "\u001b[90m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*\u001b\\)/g;
// The lookbehinds start a match only at the beginning of a token: without them, a long unbroken token costs quadratic time.
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]*@)/gi;
const ASSIGNMENT_KEY = /(?:"[^"]+"|'[^']+'|(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+)\s*[:=]\s*/g;
const ASSIGNMENT_VALUE = /(?:(?:Bearer|Basic)\s+[^\s,;}&]+|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}&]+)/iy;
const EXACT_SENSITIVE_KEYS = new Set([
  "auth", "request", "pass", "pwd",
]);
const SENSITIVE_KEY_PARTS = SENSITIVE_KEY_NAMES
  .filter((name) => !EXACT_SENSITIVE_KEYS.has(normalizeKey(name)))
  .map(normalizeKey);

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(value: string): boolean {
  const key = normalizeKey(value);
  return EXACT_SENSITIVE_KEYS.has(key) || SENSITIVE_KEY_PARTS.some((sensitive) => key.includes(sensitive));
}

type TextLayout = "single-line" | "multiline";

function cleanControls(value: string, layout: TextLayout = "single-line"): string {
  const plain = value.replace(ANSI_SEQUENCE, "");
  if (layout === "multiline") {
    return plain.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
  }
  return plain
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodedKey(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Replaces the value of each sensitive `key=value` or `key: value`. Only a sensitive key takes its
 * value: after `status=` the scan goes on, so `status= password=x` and `status=\npassword=x` hide x.
 */
function redactAssignments(text: string): string {
  let safe = "", copied = 0;
  ASSIGNMENT_KEY.lastIndex = 0;
  for (let match = ASSIGNMENT_KEY.exec(text); match; match = ASSIGNMENT_KEY.exec(text)) {
    const key = match[0].replace(/\s*[:=]\s*$/, "").replace(/^["']|["']$/g, "");
    if (!isSensitiveKey(key)) continue;
    const start = match.index + match[0].length;
    ASSIGNMENT_VALUE.lastIndex = start;
    if (!ASSIGNMENT_VALUE.exec(text)) continue;
    safe += `${text.slice(copied, start)}${REDACTED}`;
    copied = ASSIGNMENT_KEY.lastIndex = ASSIGNMENT_VALUE.lastIndex;
  }
  return safe + text.slice(copied);
}

/** Removes terminal controls and credential-shaped values at any length. */
function redactSecrets(text: string, layout: TextLayout = "single-line"): string {
  let safe = cleanControls(text.replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi, (header) => `${header.slice(0, header.indexOf(":") + 1)} ${REDACTED}`), layout);
  safe = safe.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  // The value is optional so a key without `=` is consumed whole: the scan never restarts inside it, which keeps a run of `?` linear.
  safe = safe.replace(/([?&])([^=&#\s]+)(?:=([^&#\s]*))?/g, (match, separator: string, key: string, value: string | undefined) =>
    value !== undefined && isSensitiveKey(decodedKey(key)) ? `${separator}${key}=${REDACTED}` : match,
  );
  safe = redactAssignments(safe);
  safe = safe.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match) => {
    const scheme = /^\S+/.exec(match)?.[0] ?? "Bearer";
    return `${scheme} ${REDACTED}`;
  });
  return safe.replace(EMAIL, REDACTED);
}

/** Bounded redactSecrets for logs and other diagnostics. */
export function redactText(text: string, layout: TextLayout = "single-line"): string {
  if (text.length > MAX_INPUT_STRING_LENGTH) return TRUNCATED;
  const safe = redactSecrets(text, layout);
  if (safe.length > MAX_STRING_LENGTH) return `${safe.slice(0, MAX_STRING_LENGTH - TRUNCATED.length)}${TRUNCATED}`;
  return safe;
}

interface RedactionLimits {
  depth: number;
  entries: number;
  keyLength: number;
  text: (value: string) => string;
}

const LOG_LIMITS: RedactionLimits = { depth: MAX_DEPTH, entries: MAX_ENTRIES, keyLength: MAX_KEY_LENGTH, text: redactText };
const UNBOUNDED_LIMITS = { depth: Infinity, entries: Infinity, keyLength: Infinity };
const OUTPUT_LIMITS: RedactionLimits = { ...UNBOUNDED_LIMITS, text: (value) => redactSecrets(value, "multiline") };

interface CloneContext {
  seen: WeakSet<object>;
  entries: number;
  limits: RedactionLimits;
}

function ownDataEntries(value: object, limit = MAX_ENTRIES): { entries: Array<[string, unknown]>; truncated: boolean } {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return { entries: [], truncated: false };
  }
  const entries: Array<[string, unknown]> = [];
  for (let index = 0; index < keys.length && index < limit; index += 1) {
    const key = keys[index]!;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (descriptor && "value" in descriptor) entries.push([key, descriptor.value]);
  }
  return { entries, truncated: keys.length > limit };
}

function cloneSafe(value: unknown, context: CloneContext, depth: number, key?: string): unknown {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return context.limits.text(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return UNSUPPORTED;
  if (depth >= context.limits.depth) return MAX_DEPTH_MARKER;
  if (context.seen.has(value)) return CIRCULAR;

  context.seen.add(value);
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "[invalid-date]" : value.toISOString();
    }
    if (value instanceof Error) {
      const result: Record<string, unknown> = {
        name: context.limits.text(value.name || "Error"),
        message: context.limits.text(value.message),
      };
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause && "value" in cause && cause.value !== undefined) {
        context.entries += 1;
        result.cause = cloneSafe(cause.value, context, depth + 1, "cause");
      }
      const ownEntries = ownDataEntries(value, context.limits.entries - context.entries);
      for (const [entryKey, entryValue] of ownEntries.entries) {
        if (entryKey === "name" || entryKey === "message" || entryKey === "stack" || entryKey === "cause") continue;
        if (context.entries >= context.limits.entries) {
          result[TRUNCATED] = true;
          break;
        }
        context.entries += 1;
        result[context.limits.text(entryKey)] = cloneSafe(entryValue, context, depth + 1, entryKey);
      }
      if (ownEntries.truncated) result[TRUNCATED] = true;
      return result;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const length = Math.min(value.length, context.limits.entries);
      for (let index = 0; index < length; index += 1) {
        if (context.entries >= context.limits.entries) {
          result.push(TRUNCATED);
          break;
        }
        context.entries += 1;
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        } catch {
          result.push(UNSUPPORTED);
          continue;
        }
        result.push(descriptor && "value" in descriptor
          ? cloneSafe(descriptor.value, context, depth + 1)
          : UNSUPPORTED);
      }
      if (value.length > length && result.length < context.limits.entries) result.push(TRUNCATED);
      return result;
    }

    const result: Record<string, unknown> = Object.create(null);
    const ownEntries = ownDataEntries(value, context.limits.entries - context.entries);
    for (const [entryKey, entryValue] of ownEntries.entries) {
      if (context.entries >= context.limits.entries) {
        result[TRUNCATED] = true;
        break;
      }
      context.entries += 1;
      const safeKey = context.limits.text(entryKey).slice(0, context.limits.keyLength);
      if (!safeKey) continue;
      result[safeKey] = cloneSafe(entryValue, context, depth + 1, entryKey);
    }
    if (ownEntries.truncated) result[TRUNCATED] = true;
    return result;
  } catch {
    return UNSUPPORTED;
  } finally {
    context.seen.delete(value);
  }
}

/** Creates a bounded sanitized copy. Inputs and nested values are never mutated. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe = cloneSafe(fields, { seen: new WeakSet(), entries: 0, limits: LOG_LIMITS }, 0);
  if (safe && typeof safe === "object" && !Array.isArray(safe)) return safe as Record<string, unknown>;
  return { fields: UNSUPPORTED };
}

/** Applies the redactFields secret rules with no size limit and preserves command output layout. */
export function redactOutput(value: unknown): unknown {
  return cloneSafe(value, { seen: new WeakSet(), entries: 0, limits: OUTPUT_LIMITS }, 0);
}

const SGR_SPLIT = /(\u001b\[[0-9;]*m)/;
const SGR = /\u001b\[[0-9;]*m/g;

/** Cuts on a space, because a cut inside a credential would hide it from the patterns that redact it. */
function boundedLogText(text: string): string {
  if (text.length <= MAX_INPUT_STRING_LENGTH) return text;
  let end = text.lastIndexOf(" ", MAX_INPUT_STRING_LENGTH);
  // A quote left open at the cut may hold the rest of a quoted secret.
  for (const quote of ['"', "'"]) {
    const head = text.slice(0, Math.max(end, 0));
    if (head.split(quote).length % 2 === 0) end = head.lastIndexOf(quote);
  }
  return end > 0 ? `${text.slice(0, end)} ${TRUNCATED}` : TRUNCATED;
}

const LOG_LINE_LIMITS: RedactionLimits = { ...UNBOUNDED_LIMITS, text: (value) => redactSecrets(boundedLogText(value)) };

/** Keeps color codes and spacing, drops every other terminal control. */
function displayControls(line: string): string {
  return line.split(SGR_SPLIT).map((part, index) => index % 2 ? part : part.replace(ANSI_SEQUENCE, "").replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, "")).join("");
}

/**
 * One line of container output for display. JSON is redacted by structure so it stays valid JSON.
 * Text keeps its colors and spacing unless a secret was found, then it falls back to the plain redacted form.
 */
export function redactLogLine(line: string): string {
  if (line.length <= MAX_JSON_LOG_LINE && /^\s*[{[]/.test(line)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") return JSON.stringify(cloneSafe(parsed, { seen: new WeakSet(), entries: 0, limits: LOG_LINE_LIMITS }, 0));
    } catch { /* A line that only looks like JSON, or nests too deep, is plain text. */ }
  }
  // The decision is made on what would be shown: stripping controls can rejoin or reveal a credential.
  const shown = displayControls(boundedLogText(line)), plain = shown.replace(SGR, "");
  const safe = redactSecrets(plain);
  return safe === cleanControls(plain) ? shown : safe;
}

function resolveMode(mode?: LoggerOptions["mode"]): "development" | "production" {
  if (mode) return mode;
  const environment = process.env.DEVHUB_ENV ?? process.env.NODE_ENV ?? process.env.APP_ENV;
  return environment === "development" ? "development" : "production";
}

function resolveColor(options: LoggerOptions): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return options.color ?? true;
}

function safeDate(now?: () => Date): Date {
  try {
    const value = now?.() ?? new Date();
    return Number.isNaN(value.getTime()) ? new Date(0) : value;
  } catch {
    return new Date(0);
  }
}

function timestamp(date: Date, mode: "development" | "production"): string {
  const iso = date.toISOString();
  return mode === "production" ? iso : iso.slice(11, 23);
}

function color(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function safeMessage(message: string): string {
  return redactText(message);
}

function quoted(value: string): string {
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return quoted(value);
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = UNSUPPORTED;
  }
  return rendered.length > MAX_FIELD_VALUE_LENGTH ? JSON.stringify(TRUNCATED) : rendered;
}

function boundedProductionLine(level: LogLevel, message: string, fields: Record<string, unknown>, time: string): string {
  const record: Record<string, unknown> = Object.assign(Object.create(null), { time, level, msg: message });
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "time" || key === "level" || key === "msg") continue;
    const candidate = { ...record, [key]: value };
    let serialized: string;
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      continue;
    }
    if (serialized.length > MAX_OUTPUT_LENGTH) break;
    record[key] = value;
  }
  return JSON.stringify(record);
}

function boundedDevelopmentLine(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
  time: string,
  colorEnabled: boolean,
): string {
  const levelLabel = level.toUpperCase();
  const prefix = `[${time}] ${color(levelLabel, COLORS[level], colorEnabled)}: `;
  let line = prefix;
  const isHttp = typeof fields.method === "string"
    && (typeof fields.route === "string" || typeof fields.path === "string")
    && typeof fields.status === "number"
    && typeof fields.durationMs === "number";

  if (isHttp) {
    const method = /^[A-Za-z]{1,16}$/.test(fields.method as string) ? (fields.method as string).toUpperCase() : "?";
    const routeValue = typeof fields.route === "string" && fields.route
      ? fields.route
      : String(fields.path ?? "?").split(/[?#]/, 1)[0] || "/";
    const rawRoute = String(routeValue);
    const route = safeMessage(rawRoute);
    const statusNumber = Number(fields.status);
    const status = Number.isInteger(statusNumber) && statusNumber >= 100 && statusNumber <= 599 ? String(statusNumber) : "?";
    const duration = Number.isFinite(fields.durationMs) && Number(fields.durationMs) >= 0
      ? `${Math.round(Number(fields.durationMs))}ms`
      : "?ms";
    const statusColor = statusNumber >= 500 ? "\u001b[31m" : statusNumber >= 400 ? "\u001b[33m" : "\u001b[32m";
    line += `${color(method, BOLD, colorEnabled)} ${route} ${color(status, statusColor, colorEnabled)} ${duration}`;
  } else if (message) {
    line += message;
  }

  const renderedFields: string[] = [];
  let used = line.length;
  const textBudget = MAX_OUTPUT_LENGTH - (colorEnabled ? 9 : 0);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (isHttp && ["method", "path", "route", "status", "durationMs"].includes(key))) continue;
    const safeKey = redactText(key).slice(0, 80);
    if (!safeKey) continue;
    const field = `${quoted(safeKey)}=${formatValue(value)}`;
    if (used + field.length + 2 > textBudget) {
      if (used + "fieldsTruncated=true".length + 3 <= textBudget) renderedFields.push("fieldsTruncated=true");
      break;
    }
    renderedFields.push(field);
    used += field.length + 1;
  }
  if (renderedFields.length) {
    const fieldsText = renderedFields.join(" ");
    line += `  ${color(fieldsText, GRAY, colorEnabled)}`;
  }
  if (line.length > MAX_OUTPUT_LENGTH) return `${line.slice(0, MAX_OUTPUT_LENGTH - TRUNCATED.length)}${TRUNCATED}${colorEnabled ? RESET : ""}`;
  return line;
}

/** Formats one safe line without writing it. */
export function formatLogLine(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
  options: LoggerOptions = {},
): string {
  const mode = resolveMode(options.mode);
  const safeFields = redactFields(fields);
  const safeMsg = safeMessage(message);
  const time = timestamp(safeDate(options.now), mode);
  if (mode === "production") return boundedProductionLine(level, safeMsg, safeFields, time);
  return boundedDevelopmentLine(level, safeMsg, safeFields, time, resolveColor(options));
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): LoggerLike {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  // Mode is resolved per line so a mode chosen at startup (devhub serve --dev-origin) applies to this shared instance.
  const emit = (level: LogLevel, fields: Record<string, unknown>, message = "") => {
    const mode = resolveMode(options.mode);
    const minimumLevel = options.level ?? (mode === "development" ? "debug" : "info");
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) return;
    write(formatLogLine(level, message, fields, { ...options, mode, now }));
  };

  return {
    debug: (fields, message) => emit("debug", fields, message),
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
  };
}

/** Safe default instance. Importing this module never emits output. */
export const logger = createLogger();

export function logEvent(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  logger[level](fields, message);
}

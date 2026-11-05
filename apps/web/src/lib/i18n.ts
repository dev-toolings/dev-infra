import { fr } from "./messages.fr";

/** English text is the key, so the source stays readable and a missing French entry fails the typecheck. */
export type MessageKey = keyof typeof fr;
export type Locale = "en" | "fr";

const LOCALE_STORAGE_KEY = "devhub-locale";

function initialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "en" || stored === "fr") return stored;
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const locale: Locale = initialLocale();
document.documentElement.lang = locale;

/** Labels declared at module level read the locale once, so changing it reloads the page. */
export function setLocale(next: Locale): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, next);
  window.location.reload();
}

const fill = (text: string, params?: Record<string, string | number>) =>
  params ? text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match)) : text;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return fill(locale === "fr" ? fr[key] : key, params);
}

/** For text that comes from the API, such as catalog labels: unknown values stay as they are. */
export function translate(text: string): string {
  return locale === "fr" ? (fr as Record<string, string>)[text] ?? text : text;
}

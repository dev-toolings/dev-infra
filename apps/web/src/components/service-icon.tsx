import { cn } from "../lib/utils";

const icons = import.meta.glob<string>("../assets/services/*.svg", { eager: true, query: "?url", import: "default" });
const iconFor = (name: string) => icons[`../assets/services/${name}.svg`];

/** Shared services run in `infra-<name>` containers, and other versions in `infra-<name>-<version>`. */
export const containerService = (container: string) => /^infra-([a-z]+)(?:-[0-9-]+)?$/.exec(container)?.[1];

/** A logo as a mask: it takes the text color, so it follows the theme and color stays reserved for state. */
export function ServiceIcon({ name, className }: { name: string; className?: string }) {
  const src = iconFor(name);
  if (!src) return null;
  return <span aria-hidden="true" className={cn("inline-block size-4 shrink-0 bg-current", className)} style={{ mask: `url("${src}") center / contain no-repeat` }} />;
}

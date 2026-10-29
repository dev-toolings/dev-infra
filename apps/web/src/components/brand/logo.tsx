import { cn } from "../../lib/utils";

/** Brand mark shared with the favicon: a radar sweep and its target. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground", className)}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-4">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" opacity="0.35" />
        <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        <path d="M12 12 L20.2 7.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

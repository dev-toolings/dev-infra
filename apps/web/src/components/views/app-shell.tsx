import type { ReactNode } from "react";
import { Box, FolderKanban, Logs, ShieldCheck, ServerCog } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type AppView = "projects" | "containers" | "logs" | "maintenance";

export interface AppShellProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void | Promise<void>;
  children: ReactNode;
  title?: string;
  description?: string;
  toolbar?: ReactNode;
}

const navigation: { id: AppView; label: string; icon: typeof FolderKanban }[] = [
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "containers", label: "Containers", icon: Box },
  { id: "logs", label: "Logs", icon: Logs },
  { id: "maintenance", label: "Maintenance", icon: ShieldCheck },
];

export function AppShell({ activeView, onNavigate, children, title, description, toolbar }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-card px-4 py-3 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-shell-border bg-shell p-4 md:flex">
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ServerCog aria-hidden="true" className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-5">DevHub</span>
            <span className="block text-xs leading-4 text-muted-foreground">Local development</span>
          </span>
        </div>

        <nav aria-label="Main navigation" className="mt-8 flex flex-col gap-1">
          {navigation.map(({ id, label, icon: Icon }) => {
            const selected = id === activeView;
            return (
              <Button
                key={id}
                type="button"
                variant={selected ? "secondary" : "ghost"}
                className={cn("w-full justify-start", selected && "font-semibold")}
                aria-current={selected ? "page" : undefined}
                onClick={() => onNavigate(id)}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-shell-border px-2 pt-4">
          <p className="text-xs leading-5 text-muted-foreground">A local workspace for your projects and shared services.</p>
        </div>
      </aside>

      <div className="min-w-0 md:pl-60">
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex max-w-screen-2xl flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex min-h-11 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 md:hidden">
                <ServerCog aria-hidden="true" className="size-5 shrink-0 text-primary" />
                <span className="truncate text-sm font-semibold">DevHub</span>
              </div>
              {toolbar ? <div className="ml-auto flex min-w-0 items-center gap-2">{toolbar}</div> : null}
            </div>

            <nav aria-label="Main navigation" className="flex max-w-full gap-1 overflow-x-auto md:hidden">
              {navigation.map(({ id, label, icon: Icon }) => {
                const selected = id === activeView;
                return (
                  <Button
                    key={id}
                    type="button"
                    variant={selected ? "secondary" : "ghost"}
                    className="shrink-0 justify-start px-3"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onNavigate(id)}
                  >
                    <Icon aria-hidden="true" />
                    {label}
                  </Button>
                );
              })}
            </nav>

            {title ? (
              <div className="min-w-0 pb-1">
                <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
                {description ? <p className="mt-0.5 max-w-3xl text-sm leading-5 text-muted-foreground">{description}</p> : null}
              </div>
            ) : null}
          </div>
        </header>

        <main id="main-content" className="mx-auto min-w-0 max-w-screen-2xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

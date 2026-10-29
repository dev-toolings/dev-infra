import type { CSSProperties, ReactNode } from "react";
import { Box, ChevronsUpDown, FolderKanban, LogOut, Logs, Monitor, Moon, Palette, ShieldCheck, Sun } from "lucide-react";
import { cn } from "../../lib/utils";
import { routePath } from "../../lib/router";
import { LogoMark } from "../brand/logo";
import { useTheme, type Theme } from "../theme";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";

export type AppView = "projects" | "containers" | "logs" | "maintenance";

export interface AppShellProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void | Promise<void>;
  onLogout: () => void;
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

const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
      {themes.map(({ value, label, icon: Icon }) => {
        const selected = theme === value;
        return (
          <Button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            variant="ghost"
            size="icon-xs"
            onClick={() => setTheme(value)}
            className={cn("rounded-full", selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </Button>
        );
      })}
    </div>
  );
}

function SessionMenu({ onLogout }: { onLogout: () => void }) {
  const { isMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Open the session menu"
              className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
            >
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">DH</span>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-semibold">This browser</span>
                <span className="truncate text-xs text-muted-foreground">Paired local session</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50 group-data-[collapsible=icon]:hidden" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" sideOffset={8} className="w-60">
            <DropdownMenuLabel className="flex flex-col py-2">
              <span className="truncate text-sm font-semibold">This browser</span>
              <span className="truncate text-xs font-normal text-muted-foreground">Paired with the local DevHub manager</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={(event) => event.preventDefault()} className="cursor-default focus:bg-transparent!">
              <Palette aria-hidden="true" />
              Theme
              <div className="ml-auto"><ThemeSwitch /></div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut aria-hidden="true" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppShell({ activeView, onNavigate, onLogout, children, title, description, toolbar }: AppShellProps) {
  return (
    <SidebarProvider
      className="h-svh bg-muted"
      style={{ "--sidebar-width": "244px", "--sidebar": "var(--background)", "--header-height": "52px" } as CSSProperties}
    >
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-card px-4 py-3 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <Sidebar variant="floating" collapsible="icon">
        <SidebarHeader className="px-2 pt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!">
                <div>
                  <LogoMark />
                  <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate text-sm font-semibold">DevHub</span>
                    <span className="truncate text-xs text-muted-foreground">Local development</span>
                  </div>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu aria-label="Main navigation" className="gap-1">
              {navigation.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    asChild
                    isActive={id === activeView}
                    aria-current={id === activeView ? "page" : undefined}
                    tooltip={label}
                  >
                    <a
                      href={routePath({ view: id })}
                      onClick={(event) => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onNavigate(id);
                      }}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-2">
          <SessionMenu onLogout={onLogout} />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="m-2 flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background shadow-xs md:ml-0">
        <header className="flex h-(--header-height) shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ms-1.5" />
            {title ? (
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
                {description ? <p className="truncate text-xs text-muted-foreground">{description}</p> : null}
              </div>
            ) : null}
          </div>
          {toolbar ? <div className="flex shrink-0 items-center gap-2">{toolbar}</div> : null}
        </header>
        <div id="main-content" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [scrollbar-width:thin]">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

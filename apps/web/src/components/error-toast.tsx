import * as React from "react";
import { CircleAlert, XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { t } from "../lib/i18n";
import { Button } from "./ui/button";

/** Hosts every `ErrorToast` rendered below it, stacked in the bottom right corner. */
export function ErrorToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider label={t("Notification")}>
      {children}
      <ToastPrimitive.Viewport
        label={t("Notifications ({hotkey})")}
        className="pointer-events-none fixed right-0 bottom-0 z-60 flex max-h-dvh w-full max-w-sm flex-col gap-2 overflow-y-auto p-4 outline-none"
      />
    </ToastPrimitive.Provider>
  );
}

export interface ErrorToastProps {
  title: string;
  message: string;
  onDismiss?: () => void;
}

/**
 * Failure notice for content already on screen. It stays until closed, so a long Docker error
 * can be read, and a closed message stays closed while a refresh keeps returning the same one.
 */
export function ErrorToast({ title, message, onDismiss }: ErrorToastProps) {
  const [dismissed, setDismissed] = React.useState<string>();
  return (
    <ToastPrimitive.Root
      open={dismissed !== message}
      duration={Infinity}
      onOpenChange={(open) => {
        if (open) return;
        setDismissed(message);
        onDismiss?.();
      }}
      className="pointer-events-auto flex min-w-0 items-start gap-3 rounded-lg border border-destructive/30 bg-popover p-3 text-sm text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[swipe=cancel]:translate-x-0 data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <ToastPrimitive.Title className="font-medium tracking-tight">{title}</ToastPrimitive.Title>
        <ToastPrimitive.Description className="max-h-40 overflow-y-auto text-xs break-words text-muted-foreground">{message}</ToastPrimitive.Description>
      </div>
      <ToastPrimitive.Close asChild>
        <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={t("Dismiss")}><XIcon /></Button>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

import * as React from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState = React.forwardRef<HTMLElement, EmptyStateProps>(
  ({ title, description, icon, action, className, ...props }, ref) => {
    const titleId = React.useId();
    const descriptionId = React.useId();
    return (
      <section
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn("flex min-h-48 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-12 text-center text-balance", className)}
        {...props}
      >
        {icon ? <span aria-hidden="true" className="text-muted-foreground">{icon}</span> : null}
        <div className="max-w-md space-y-1.5">
          <h2 id={titleId} className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="pt-1">{action}</div> : null}
      </section>
    );
  },
);
EmptyState.displayName = "EmptyState";

export interface ErrorStateProps extends React.HTMLAttributes<HTMLElement> {
  title?: string;
  description: string;
  action?: React.ReactNode;
}

export const ErrorState = React.forwardRef<HTMLElement, ErrorStateProps>(
  ({ title = "Unable to load this view", description, action, className, ...props }, ref) => {
    const titleId = React.useId();
    const descriptionId = React.useId();
    return (
      <section
        ref={ref}
        role="alert"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={cn("flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-7 text-center", className)}
        {...props}
      >
        <CircleAlert aria-hidden="true" className="size-5 text-destructive" />
        <div className="max-w-md space-y-1.5">
          <h2 id={titleId} className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {action ? <div className="pt-1">{action}</div> : null}
      </section>
    );
  },
);
ErrorState.displayName = "ErrorState";

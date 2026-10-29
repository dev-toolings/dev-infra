import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export interface ActionBannerProps {
  title: string;
  message: string;
  onDismiss?: () => void;
}

/** Dismissible failure notice for an action. It never replaces the view it belongs to. */
export function ActionBanner({ title, message, onDismiss }: ActionBannerProps) {
  return (
    <Alert variant="destructive" className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="break-words">{message}</AlertDescription>
      </div>
      {onDismiss ? <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onDismiss}>Dismiss</Button> : null}
    </Alert>
  );
}

import { t, translate } from "../../lib/i18n";
import * as React from "react";
import { ArrowUp, Folder, FolderPlus } from "lucide-react";
import type { DirectoryListing, Root } from "../../../../../src/contracts";
import { addRoot, errorMessage, isAbortError, listDirectories } from "../../lib/api";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export interface FolderPickerProps {
  open: boolean;
  roots: Root[];
  onOpenChange: (open: boolean) => void;
  onPicked: (root: Root) => void;
}

/** Browses the machine running DevHub, not the browser's, so it works the same locally and through an SSH tunnel. */
export function FolderPicker({ open, roots, onOpenChange, onPicked }: FolderPickerProps) {
  const [listing, setListing] = React.useState<DirectoryListing>();
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const request = React.useRef<AbortController>(undefined);

  /** Only the latest request counts. A failed one keeps the current folder on screen, so the user is never stuck. */
  const run = React.useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    request.current?.abort();
    const own = new AbortController();
    request.current = own;
    setBusy(true);
    setError(undefined);
    try { await work(own.signal); }
    catch (caught) { if (!isAbortError(caught)) setError(translate(errorMessage(caught))); }
    finally { if (request.current === own) setBusy(false); }
  }, []);

  const go = React.useCallback((path?: string) => run(async (signal) => {
    const next = await listDirectories(path, signal);
    setListing(next);
    setDraft(next.path);
  }), [run]);

  React.useEffect(() => {
    if (!open) return;
    void go();
    return () => request.current?.abort();
  }, [open, go]);

  /** Approval is not aborted with navigation: closing the dialog cannot undo a POST the server accepted, so its result must still reach the caller. */
  const approved = roots.find((item) => item.path === listing?.path);
  const atDiskRoot = listing?.parent === null;
  /** What gets approved is always the folder on screen, never a path still being typed. */
  const canApprove = Boolean(listing && !busy && !atDiskRoot && draft === listing.path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Choose a folder")}</DialogTitle>
          <DialogDescription>{t("These are the folders of the machine running DevHub.")}</DialogDescription>
        </DialogHeader>

        <form className="flex min-w-0 gap-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void go(draft.trim()); }}>
          <Input aria-label={t("Folder path")} className="font-mono" placeholder="/home/you/code" value={draft} autoComplete="off" spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
          <Button type="submit" variant="outline" disabled={busy || !draft.trim()}>{t("Open")}</Button>
        </form>

        {listing ? (
          <div className="flex flex-wrap gap-1.5">
            {listing.places.map((place) => (
              <Button key={place} type="button" variant="outline" size="sm" className="font-mono" disabled={busy} onClick={() => void go(place)}>{place}</Button>
            ))}
          </div>
        ) : null}

        {error ? <Alert variant="destructive"><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}

        <ul aria-label={t("Subfolders")} aria-busy={busy} className="h-64 min-w-0 overflow-y-auto rounded-lg border border-border p-1">
          {listing?.parent ? (
            <li>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" disabled={busy} onClick={() => void go(listing.parent ?? undefined)}>
                <ArrowUp aria-hidden="true" />
                {t("Parent folder")}
              </Button>
            </li>
          ) : null}
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start font-normal" disabled={busy} onClick={() => void go(entry.path)}>
                <Folder aria-hidden="true" />
                <span className="truncate">{entry.name}</span>
              </Button>
            </li>
          ))}
          {listing?.entries.length === 0 ? <li className="px-2 py-1.5 text-sm text-muted-foreground">{t("No subfolders here.")}</li> : null}
        </ul>

        <p className="text-xs text-muted-foreground">
          {atDiskRoot ? t("The disk root cannot be approved: open a folder inside it.") : t("Approve only folders you trust: DevHub can run projects found inside them.")}
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button type="button" disabled={!canApprove} onClick={() => void run(async () => { onPicked(approved ?? await addRoot(listing!.path)); })}>
            <FolderPlus aria-hidden="true" />
            {approved ? t("Use this folder") : t("Approve this folder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

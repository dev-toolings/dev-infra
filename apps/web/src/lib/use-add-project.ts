import * as React from "react";
import type { PublicDetection, PublicProject, PublicSetupPlan, Root, SetupInput } from "../../../../src/contracts";
import { createProject, discover, errorMessage, isAbortError, listPresets, listRoots, previewProject } from "./api";
import type { Lifetime } from "./use-lifetime";
import { useResource } from "./use-resource";

/** State and requests behind the add-project wizard: discover, preview a plan, then apply it. */
export function useAddProject(lifetime: Lifetime, onCreated: (project: PublicProject) => void) {
  const [open, setOpenState] = React.useState(false);
  const [detections, setDetections] = React.useState<PublicDetection[]>([]);
  const [plan, setPlan] = React.useState<PublicSetupPlan>();
  const [pending, setPending] = React.useState(false);
  const [taskError, setTaskError] = React.useState<string>();
  const session = React.useRef(new AbortController());
  const busy = React.useRef(false);
  const roots = useResource(listRoots, open ? "roots" : undefined);
  const presets = useResource(listPresets, open ? "presets" : undefined);

  const reset = React.useCallback(() => {
    session.current.abort();
    session.current = new AbortController();
    busy.current = false;
    setDetections([]);
    setPlan(undefined);
    setPending(false);
    setTaskError(undefined);
  }, []);

  React.useEffect(() => () => session.current.abort(), []);

  const setOpen = React.useCallback((next: boolean) => {
    reset();
    setOpenState(next);
  }, [reset]);

  const task = React.useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    const life = lifetime();
    if (!life || busy.current) return;
    const own = session.current;
    busy.current = true;
    setPending(true);
    setTaskError(undefined);
    try {
      await work(AbortSignal.any([life, own.signal]));
    } catch (caught) {
      if (!isAbortError(caught) && session.current === own) setTaskError(errorMessage(caught));
    } finally {
      if (session.current === own) { busy.current = false; setPending(false); }
    }
  }, [lifetime]);

  const loaded = !roots.loading && !presets.loading;
  return {
    open: open && loaded,
    requestOpen: () => setOpen(true),
    onOpenChange: setOpen,
    onRootApproved: (root: Root) => roots.update((current = []) => current.some((item) => item.id === root.id) ? current : [...current, root]),
    roots: roots.data ?? [],
    presets: presets.data ?? [],
    detections,
    plan,
    busy: pending,
    error: taskError ?? roots.error ?? presets.error,
    onDiscover: (path: string) => task(async (signal) => {
      setPlan(undefined);
      setDetections(await discover(path, signal));
    }),
    onPreview: (input: SetupInput) => task(async (signal) => {
      setPlan(await previewProject(input, signal));
    }),
    onApply: (planId: string) => task(async (signal) => {
      const project = await createProject(planId, signal);
      setOpen(false);
      onCreated(project);
    }),
  };
}

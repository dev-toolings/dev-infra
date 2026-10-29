import * as React from "react";
import { errorMessage, getSession, isAbortError, isUnauthorized, logout, pair, setUnauthorizedListener } from "./lib/api";
import { Button } from "./components/ui/button";
import { ErrorState, LoadingState } from "./components/ui/state";
import { PairingForm } from "./components/views";
import { Workspace } from "./workspace";

type Phase = "checking" | "unauthenticated" | "ready" | "signingOut" | "unavailable";

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-[100svh] w-full max-w-md items-center px-4 py-8"><div className="w-full">{children}</div></main>;
}

/**
 * Session gate. The browser holds the session in an HttpOnly cookie, so the only credential
 * this component ever touches is the one-time pairing code, which is not kept after use.
 */
export function App() {
  const [phase, setPhase] = React.useState<Phase>("checking");
  const [attempt, setAttempt] = React.useState(0);
  const [epoch, setEpoch] = React.useState(0);
  const [notice, setNotice] = React.useState<string>();
  const [pairError, setPairError] = React.useState<string>();
  const [pairing, setPairing] = React.useState(false);
  const pairController = React.useRef<AbortController>(undefined);

  React.useEffect(() => {
    setUnauthorizedListener(() => setPhase("unauthenticated"));
    return () => setUnauthorizedListener(undefined);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(
      (session) => setPhase(session.authenticated ? "ready" : "unauthenticated"),
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorized(error)) return setPhase("unauthenticated");
        setNotice(errorMessage(error));
        setPhase("unavailable");
      },
    );
    return () => controller.abort();
  }, [attempt]);

  React.useEffect(() => () => pairController.current?.abort(), []);

  async function handlePair(code: string) {
    if (pairing) return;
    const controller = new AbortController();
    pairController.current = controller;
    setPairing(true);
    setPairError(undefined);
    try {
      await pair(code, controller.signal);
      setEpoch((value) => value + 1);
      setPhase("ready");
    } catch (error) {
      if (!isAbortError(error)) setPairError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPairing(false);
    }
  }

  async function handleLogout() {
    // Unmounting the workspace first drops all cached data and aborts its requests and streams.
    setPhase("signingOut");
    setEpoch((value) => value + 1);
    try {
      await logout();
      setPairError(undefined);
      setPhase("unauthenticated");
    } catch (error) {
      if (isUnauthorized(error)) return setPhase("unauthenticated");
      setNotice(`Sign out could not be confirmed. ${errorMessage(error)}`);
      setPhase("unavailable");
    }
  }

  function retry() {
    setNotice(undefined);
    setPhase("checking");
    setAttempt((value) => value + 1);
  }

  if (phase === "unauthenticated") return <PairingForm busy={pairing} error={pairError} onPair={handlePair} />;
  if (phase === "ready") return <Workspace key={epoch} onLogout={handleLogout} />;
  if (phase === "unavailable") {
    return (
      <Centered>
        <ErrorState
          title="DevHub is not available"
          description={notice ?? "The local manager did not respond."}
          action={<Button type="button" onClick={retry}>Try again</Button>}
        />
      </Centered>
    );
  }
  return <Centered><LoadingState label={phase === "signingOut" ? "Signing out" : "Connecting to DevHub"} rows={2} /></Centered>;
}

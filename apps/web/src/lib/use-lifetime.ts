import * as React from "react";

/** Returns a getter for a signal that aborts when the owning component unmounts. */
export function useLifetime(): () => AbortSignal | undefined {
  const controller = React.useRef<AbortController>(undefined);
  React.useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    return () => own.abort();
  }, []);
  return React.useCallback(() => controller.current?.signal, []);
}

export type Lifetime = ReturnType<typeof useLifetime>;

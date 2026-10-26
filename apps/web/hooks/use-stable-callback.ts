import { useCallback, useInsertionEffect, useRef } from "react";

/** A function that keeps one identity across renders and always calls the latest `fn`, so a memoized child given it doesn't redraw. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}

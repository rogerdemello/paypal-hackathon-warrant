import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: ApiError | Error | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * Run an async loader when `deps` change and expose the result. A newer request wins: a slow earlier response never
 * overwrites a later one, and nothing is set after unmount.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    loader.current().then(
      (data) => {
        if (latest.current === id) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (latest.current === id) setState((s) => ({ data: s.data, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
      },
    );
    return () => {
      latest.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's list; `load` is read through a ref.
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Run an action and track its progress and error, for buttons. */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): { run: (...args: A) => Promise<R | undefined>; busy: boolean; error: Error | null; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await action(...args);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e : new Error(String(e)));
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [action],
  );
  return { run, busy, error, clear: () => setError(null) };
}

/** Call `fn` every `ms` while `active`. */
export function useInterval(fn: () => void, ms: number, active = true): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

export function errorText(error: Error | null): string | null {
  if (error === null) return null;
  if (error instanceof ApiError && error.problems.length > 0) return `${error.message}: ${error.problems.join('; ')}`;
  return error.message;
}

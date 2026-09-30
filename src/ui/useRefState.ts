import { useReducer, useRef } from "react";

// State readable synchronously: keystrokes can arrive faster than React re-renders,
// so input handlers must see the latest value, not the one from the last render.
export function useRefState<T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void] {
  const ref = useRef(initial);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const get = () => ref.current;
  const set = (next: T | ((prev: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (prev: T) => T)(ref.current) : next;
    rerender();
  };
  return [get, set];
}

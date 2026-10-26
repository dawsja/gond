"use client";

import { useState } from "react";

/** The value as it was while `open`, held while a pop-up closes, so its words don't change as it fades. */
export function useHeld<T>(value: T, open: boolean): T {
  const [held, setHeld] = useState(value);
  if (open && !Object.is(held, value)) setHeld(value);
  return open ? value : held;
}

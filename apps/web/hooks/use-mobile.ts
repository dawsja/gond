import * as React from "react"
import { mobileShell } from "@/lib/shell"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => Boolean(mobileShell()) || window.matchMedia(QUERY).matches,
    () => false
  )
}

const COARSE = "(pointer: coarse)"

function subscribeCoarse(onChange: () => void) {
  const mql = window.matchMedia(COARSE)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useCoarsePointer() {
  return React.useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE).matches,
    () => false
  )
}

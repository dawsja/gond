/** Runs `tick` every `ms` while the page is shown, and once as it's shown again; a hidden page polls nothing. */
export function pollWhileShown(tick: () => void, ms: number): () => void {
  const timer = window.setInterval(() => {
    if (!document.hidden) tick();
  }, ms);
  const onShown = () => {
    if (!document.hidden) tick();
  };
  document.addEventListener("visibilitychange", onShown);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onShown);
  };
}

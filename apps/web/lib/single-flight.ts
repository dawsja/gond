/** One call at a time: a call made while one runs waits for it and then runs once more, however many were made. */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again: Promise<void> | null = null;
  const start = (): Promise<void> => {
    running = run().finally(() => {
      running = null;
    });
    return running;
  };
  return () => {
    if (!running) return start();
    again ??= running.catch(() => undefined).then(() => {
      again = null;
      return start();
    });
    return again;
  };
}

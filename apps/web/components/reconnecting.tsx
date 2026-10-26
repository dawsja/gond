"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { GondBot } from "@/components/hq/gond-bot";
import { Spinner } from "@/components/ui/spinner";

const RETRY_MS = 3_000;

/** In place of the app while the API doesn't answer, as after an update: the session is kept, so the page comes back by itself. */
export function Reconnecting() {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const check = async () => {
      const up = await fetch("/api/health", { cache: "no-store" })
        .then((res) => res.ok)
        .catch(() => false);
      if (!alive) return;
      if (up) router.refresh();
      timer = window.setTimeout(() => void check(), RETRY_MS);
    };
    timer = window.setTimeout(() => void check(), RETRY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [router]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-6 text-center text-foreground">
      <GondBot color="#2F6FD6" size={72} greet={false} />
      <div className="flex max-w-sm flex-col gap-2">
        <h1 className="text-[22px] font-semibold">Gond isn&apos;t answering</h1>
        <p className="text-[14.5px] leading-6 text-muted-foreground">It&apos;s probably restarting after an update. This page comes back by itself, and you&apos;re still signed in.</p>
      </div>
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground" aria-live="polite">
        <Spinner className="size-3.5" aria-hidden="true" />
        Trying again…
      </p>
    </main>
  );
}

/** Sends a page that can't name its own path on the server to sign in, coming back to it afterwards. */
export function SignInAgain() {
  useEffect(() => {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(here)}`);
  }, []);
  return null;
}

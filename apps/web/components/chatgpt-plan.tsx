"use client";

import { CHATGPT_USAGE_URL, type ProviderKind, type ProviderMeta } from "@gond/shared";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { McpPasteSignIn } from "@/components/mcp-signin";
import { PlanSignedIn } from "@/components/plan-engine";
import { ProviderCheck } from "@/components/providers-card";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import { mobileShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

const SEEN_KEY = "gond.chatgpt-plan-seen";

/** OpenAI's mark, as their sign-in guidelines ask for next to "Continue with ChatGPT". Ink in both themes. */
export function ChatGptLogo({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={cn("shrink-0", className)}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/** "Continue with ChatGPT", and the field for the address it lands on where nothing hands it back. */
export function ContinueWithChatGpt({ onDone }: { onDone: () => void }) {
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);

  async function begin() {
    setStarting(true);
    try {
      await startSignIn();
      setStarted(true);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't start the sign-in." });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-start gap-3">
      <Button size="lg" disabled={starting} onClick={() => void begin()}>
        {starting ? <Spinner data-icon="inline-start" /> : <ChatGptLogo size={18} />}
        Continue with ChatGPT
      </Button>
      {started ? (
        <div className="w-full rounded-xl border p-4">
          <McpPasteSignIn
            name="ChatGPT"
            onDone={() => {
              setStarted(false);
              onDone();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** "Using ChatGPT plan" with Manage usage, the line OpenAI asks for beside the model picker. */
export function ChatGptPlanLine() {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <ChatGptLogo size={14} />
        Using ChatGPT plan
      </span>
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
        Manage usage
      </a>
    </span>
  );
}

async function startSignIn(): Promise<void> {
  // Opened before the request, or a browser takes the later navigation for a pop-up and blocks it.
  const tab = mobileShell() ? null : window.open("about:blank", "_blank");
  try {
    const { url } = await post<{ url: string }>("/api/providers/chatgpt/sign-in");
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

function markSeen(): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY)) return false;
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* no storage: say it every time rather than never */
  }
  return true;
}

/** Step 2 for the ChatGPT engine: Continue with ChatGPT, or the account it signed in. */
export function ChatGptAccount({ providers, reload }: { providers: Record<ProviderKind, ProviderMeta | null> | null; reload: () => void }) {
  const params = useSearchParams();
  const [welcome, setWelcome] = useState(false);
  const provider = providers?.chatgpt ?? null;

  function welcomed() {
    reload();
    if (markSeen()) setWelcome(true);
  }

  const greeted = useRef(false);

  useEffect(() => {
    if (params.get("chatgpt") !== "1" || greeted.current) return;
    greeted.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("chatgpt");
    window.history.replaceState(null, "", url);
    void Promise.resolve().then(() => {
      if (markSeen()) setWelcome(true);
      else toast.add({ type: "success", title: "Signed in with ChatGPT." });
    });
  }, [params]);

  return (
    <div className="flex flex-col gap-4">
      {!providers ? (
        <Spinner />
      ) : provider?.account ? (
        <PlanSignedIn kind="chatgpt" logo={<ChatGptLogo size={18} />} usageUrl={CHATGPT_USAGE_URL} provider={provider} onChange={reload} />
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[14px]">Sign in with your ChatGPT Plus or Pro account. There is no key to keep.</p>
          {provider?.check && !provider.check.ok ? <ProviderCheck provider={provider} /> : null}
          <ContinueWithChatGpt onDone={welcomed} />
        </div>
      )}
      <p className="text-[12.5px] text-muted-foreground">What your bots do counts toward your ChatGPT plan&apos;s usage limits, separately from anything you pay to run Gond.</p>
      <AlertDialog open={welcome} onOpenChange={setWelcome}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>You&apos;re using your ChatGPT plan</AlertDialogTitle>
            <AlertDialogDescription>Your bots can run on your ChatGPT plan now. What they do counts toward its usage limits, which you can check any time from Manage usage.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

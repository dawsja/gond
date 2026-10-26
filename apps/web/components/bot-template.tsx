"use client";

import type { Bot, BotTemplateSummary } from "@gond/shared";
import { Check, Download, Link2, Minus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { copyToClipboard } from "@/components/hq/clipboard";
import { LoadFailed } from "@/components/load-failed";
import { useStore } from "@/components/store";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";

const NEVER = ["Memory and notes", "Secrets and sign-ins", "Conversations", "Connected apps and MCP servers"];

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What goes with a template, and what never does. */
function Contents({ template }: { template: BotTemplateSummary }) {
  const included = [
    "Name, job and how it works",
    template.picture ? "Its look and picture" : "Its look: color and mascot",
    ...(template.skills.length ? [`${count(template.skills.length, "skill", "skills")}: ${template.skills.map((s) => `/${s}`).join(", ")}`] : []),
    ...(template.routines.length ? [`${count(template.routines.length, "routine", "routines")}: ${template.routines.join(", ")}`] : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-4 text-[13px] leading-5 max-sm:grid-cols-1">
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold">Included</span>
        {included.map((line) => (
          <span key={line} className="flex gap-1.5 wrap-anywhere">
            <Check className="mt-0.5 size-3.5 shrink-0 text-tone-ok" aria-hidden="true" />
            {line}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold">Never included</span>
        {NEVER.map((line) => (
          <span key={line} className="flex gap-1.5 text-muted-foreground">
            <Minus className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

function Who({ template, bot, picture }: { template: BotTemplateSummary; bot?: Bot; picture?: string }) {
  const face = bot ?? { ...template, primary: false, avatar: template.picture && picture ? picture : null };
  return (
    <div className="flex items-center gap-3">
      <BotAvatar bot={face} size={48} />
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px] font-semibold">{template.name}</span>
        <span className="line-clamp-2 text-[13px] text-muted-foreground">{[template.title, template.description.split("\n")[0]].filter(Boolean).join(" · ")}</span>
      </span>
    </div>
  );
}

/** A bot's ⋯ → Share as template: a link for anyone signed in here, or a .bot file for anywhere. */
export function ShareBotDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { botById } = useStore();
  const bot = botById(botId);
  const [template, setTemplate] = useState<BotTemplateSummary | null>(null);
  const [copying, setCopying] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void api<{ template: BotTemplateSummary }>(`/api/bots/${botId}/template/summary`)
      .then((data) => {
        setTemplate(data.template);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }, [botId, attempt]);

  const copy = async () => {
    setCopying(true);
    try {
      const { url } = await post<{ url: string }>(`/api/bots/${botId}/share`);
      const copied = await copyToClipboard(url);
      toast.add(copied ? { title: "Link copied.", description: "Anyone signed in to this Gond can add a copy with it." } : { type: "error", title: "Couldn't copy the link." });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't make the link." });
    } finally {
      setCopying(false);
    }
  };

  const name = bot?.name ?? "this bot";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {name} as a template</DialogTitle>
          <DialogDescription className="sr-only">A copy of {name} someone else can add, without its memory, secrets or conversations.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {template ? (
            <>
              <Who template={template} bot={bot} />
              <Contents template={template} />
            </>
          ) : loadFailed ? (
            <LoadFailed what="what goes in the template" onRetry={() => setAttempt((n) => n + 1)} />
          ) : (
            <Skeleton className="h-40 w-full rounded-2xl" />
          )}
        </div>
        <DialogFooter>
          <Button size="lg" variant="outline" render={<a href={`/api/bots/${botId}/template`} download />} nativeButton={false}>
            <Download data-icon="inline-start" aria-hidden="true" />
            Download .bot file
          </Button>
          <Button size="lg" disabled={copying} onClick={() => void copy()}>
            {copying ? <Spinner data-icon="inline-start" /> : <Link2 data-icon="inline-start" aria-hidden="true" />}
            Copy link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Opens what a shared link (`/app?template=…`) offers, and adds the bot on a yes. */
export function SharedTemplate() {
  const params = useSearchParams();
  const token = params.get("template");
  const router = useRouter();
  const pathname = usePathname();
  const { refresh } = useStore();
  const [template, setTemplate] = useState<BotTemplateSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!token) return;
    void api<{ template: BotTemplateSummary }>(`/api/templates/${encodeURIComponent(token)}`)
      .then((data) => setTemplate(data.template))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "That link doesn't lead to a bot any more."));
  }, [token]);

  if (!token) return null;
  const close = () => {
    setTemplate(null);
    setError(null);
    router.replace(pathname);
  };
  const add = async () => {
    setAdding(true);
    try {
      const { bot } = await post<{ bot: Bot }>(`/api/templates/${encodeURIComponent(token)}`);
      await refresh();
      router.replace(`/app/t/${bot.threadId}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't add it.");
      setAdding(false);
    }
  };

  return (
    <Dialog open={Boolean(template || error)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? `Add ${template.name}?` : "This shared bot can't be added"}</DialogTitle>
          <DialogDescription>{template ? "A copy of a bot someone shared, for you to make your own." : "The link may be old, or the bot it came from is gone."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {template ? (
            <>
              <Who template={template} picture={`/api/templates/${encodeURIComponent(token)}/picture`} />
              <Contents template={template} />
              {template.routines.length ? <p className="text-[12.5px] text-muted-foreground">Its routines come in switched off; turn them on under Routines when you like.</p> : null}
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="lg" variant="outline" onClick={close}>
            Not now
          </Button>
          {template ? (
            <Button size="lg" disabled={adding} onClick={() => void add()}>
              {adding ? <Spinner data-icon="inline-start" /> : null}
              Add {template.name}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

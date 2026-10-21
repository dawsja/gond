"use client";

import { Mic, Square } from "lucide-react";
import { useCallback, useState } from "react";
import { InputGroupButton } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRecorder } from "@/hooks/use-recorder";
import { useVoice } from "@/hooks/use-voice";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceButton({ threadId, onText }: { threadId: string; onText: (text: string) => void }) {
  const { voice } = useVoice();
  const [transcribing, setTranscribing] = useState(false);

  const transcribe = useCallback(
    async (audio: File) => {
      setTranscribing(true);
      const form = new FormData();
      form.set("file", audio, audio.name);
      form.set("threadId", threadId);
      try {
        const { text } = await api<{ text: string }>("/api/transcribe", { method: "POST", body: form });
        if (text) onText(text);
        else toast.add({ title: "Nothing was heard." });
      } catch (failure) {
        toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't turn that into text." });
      } finally {
        setTranscribing(false);
      }
    },
    [threadId, onText],
  );
  const recorder = useRecorder(transcribe);
  const ready = Boolean(voice?.using);

  async function toggle() {
    if (transcribing) return;
    if (!ready) {
      toast.add({ title: "Add an xAI or OpenAI key to talk to your bots.", description: "It goes in Settings → AI, and Settings → Voice picks the model." });
      return;
    }
    if (recorder.recording) return recorder.stop();
    try {
      await recorder.start();
    } catch {
      toast.add({ type: "error", title: "The microphone is blocked.", description: "Allow it for this site, then try again." });
    }
  }

  const label = transcribing ? "Turning it into text" : recorder.recording ? "Stop and turn it into text" : ready ? "Talk instead of typing" : "Add a voice key to talk";
  return (
    <>
      {recorder.recording ? <span className="px-1 text-xs text-muted-foreground tabular-nums">{clock(recorder.seconds)}</span> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <InputGroupButton
              type="button"
              variant={recorder.recording ? "control" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-pressed={recorder.recording}
              aria-disabled={!ready || undefined}
              disabled={transcribing}
              onClick={() => void toggle()}
              className={cn("rounded-full", !ready && "opacity-50")}
            />
          }
        >
          {transcribing ? <Spinner aria-hidden="true" /> : recorder.recording ? <Square aria-hidden="true" className="fill-current" /> : <Mic aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </>
  );
}

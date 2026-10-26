import type { NoteKind } from "@gond/shared";
import { Badge } from "@/components/ui/badge";

/** What a note between bots is: an action the bot it reached had to act on, or information. */
export function NoteBadge({ note }: { note: NoteKind | null }) {
  if (!note) return null;
  return (
    <Badge tone={note === "action" ? "warn" : "neutral"} className="shrink-0">
      {note === "action" ? "Action" : "FYI"}
    </Badge>
  );
}

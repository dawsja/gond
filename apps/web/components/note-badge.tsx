import type { NoteKind } from "@gond/shared";
import { Badge } from "@/components/ui/badge";

export function NoteBadge({ note }: { note: NoteKind | null }) {
  if (!note) return null;
  return (
    <Badge tone={note === "action" ? "warn" : "neutral"} className="shrink-0">
      {note === "action" ? "Action" : "FYI"}
    </Badge>
  );
}

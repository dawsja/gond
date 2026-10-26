"use client";

import type { SpaceDefaults } from "@gond/shared";
import { useEffect, useState } from "react";
import { JoinSpaceDialog, NewSpaceDialog } from "@/components/spaces/space-dialogs";
import { api } from "@/lib/api";

/** The person's space defaults, then the dialog, which offers only the bots they let into spaces (Settings → Spaces). */
function useAllowed(): SpaceDefaults | null {
  const [defaults, setDefaults] = useState<SpaceDefaults | null>(null);
  useEffect(() => {
    void api<{ defaults: SpaceDefaults }>("/api/spaces/defaults")
      .then((data) => setDefaults(data.defaults))
      .catch(() => setDefaults({ level: "talk", bots: [] }));
  }, []);
  return defaults;
}

export function JoinSpace({ link, onClose }: { link?: string; onClose: () => void }) {
  const defaults = useAllowed();
  return defaults ? <JoinSpaceDialog link={link} allowed={defaults.bots} onClose={onClose} /> : null;
}

export function NewSpace({ onClose }: { onClose: () => void }) {
  const defaults = useAllowed();
  return defaults ? <NewSpaceDialog allowed={defaults.bots} onClose={onClose} /> : null;
}

"use client";

import { Copy } from "lucide-react";
import { useSyncExternalStore } from "react";
import { copyToClipboard } from "@/components/hq/clipboard";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

const noChange = () => () => {};

export function JoinLink() {
  const link = useSyncExternalStore(noChange, () => window.location.href, () => "");
  const copy = () => void copyToClipboard(link).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it. Select the link and copy it yourself." }));
  return (
    <Field>
      <FieldLabel htmlFor="join-link">The invite</FieldLabel>
      <div className="flex gap-2">
        <Input id="join-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
        <Button variant="outline" onClick={copy} disabled={!link} className="h-auto self-stretch">
          <Copy data-icon="inline-start" aria-hidden="true" />
          Copy
        </Button>
      </div>
      <FieldDescription>It works once. Don&apos;t have a Gond? Anyone can run one: gond.io.</FieldDescription>
    </Field>
  );
}

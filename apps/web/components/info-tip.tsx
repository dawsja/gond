"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** An (i) beside a setting that says what it does: it opens on hover with a mouse and on a tap on a touch screen. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} render={<Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={label} />}>
        <Info aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" className="gap-2 p-3 text-[13px] leading-5 text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

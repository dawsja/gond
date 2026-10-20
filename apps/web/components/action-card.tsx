import type { ReactNode } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";

export function ActionCard({ icon, title, children, fill = false, className }: { icon: ReactNode; title: ReactNode; children: ReactNode; fill?: boolean; className?: string }) {
  return (
    <Bubble variant="outline" className={cn(fill ? "w-full max-w-none" : "max-w-[80%]", className)}>
      <BubbleContent className={cn("flex flex-col gap-2 rounded-2xl border-primary-edge p-3", fill && "w-full")}>
        <p className="flex items-start gap-1.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">

          <span className="mt-px shrink-0">{icon}</span>
          <span>{title}</span>
        </p>
        {children}
      </BubbleContent>
    </Bubble>
  );
}

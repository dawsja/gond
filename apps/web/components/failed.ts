import { toast } from "@/components/ui/toast";

/** A `.catch` for something the person did: the reason in a toast, or `fallback` when there's none. */
export function failed(fallback: string) {
  return (failure: unknown) => {
    toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : fallback });
  };
}

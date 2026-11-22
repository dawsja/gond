import { toast } from "@/components/ui/toast";

export function failed(fallback: string) {
  return (failure: unknown) => {
    toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : fallback });
  };
}

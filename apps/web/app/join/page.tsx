import { AuthShell } from "@/components/auth-shell";
import { JoinLink } from "./join-link";

/** Where a space invite's link lands when someone opens it here instead of pasting it into their own Gond. */
export default function JoinPage() {
  return (
    <AuthShell eyebrow="Spaces" title="You're invited to a space" description="A room shared between Gonds. Open your own Gond, tap New, then Join a space, and paste this link there.">
      <JoinLink />
    </AuthShell>
  );
}

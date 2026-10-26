"use client";

import { MAX_PROFILES } from "@gond/shared";
import { Check, LogOut, Plus, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openProfile, ProfileMark } from "@/components/profiles";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { failed } from "@/components/failed";
import { authClient } from "@/lib/auth/client";
import { nativeShell } from "@/lib/shell";

export function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    // The apps signed in through the system browser, so the provider's session lives there and its
    // logout page would open there too; they only end Gond's session.
    const { data } = await authClient.signOut(nativeShell() ? { disableRedirect: true } : undefined);

    if (data?.redirect && data.url) return;
    router.replace("/login");
    router.refresh();
  };
}

export function ProfileMenu({
  trigger,
  children,
  side = "top",
  align = "start",
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const signOut = useSignOut();
  const { me, profiles } = useStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align}>
        {profiles.length > 0 ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Profiles</DropdownMenuLabel>
              {profiles.map((profile) => (
                <DropdownMenuItem key={profile.id} onClick={() => profile.id !== me.profile.id && void openProfile(profile.id).catch(failed(`Couldn't open ${profile.label}.`))}>
                  <ProfileMark profile={profile} size={20} />
                  <span className="flex-1 truncate">{profile.label}</span>
                  {profile.id === me.profile.id ? <Check aria-label="Current" /> : profile.unread + profile.needsYou > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{profile.unread + profile.needsYou}</span> : null}
                </DropdownMenuItem>
              ))}
              {profiles.length < MAX_PROFILES ? (
                <DropdownMenuItem onClick={() => openShellDialog({ kind: "add-profile" })}>
                  <Plus aria-hidden="true" />
                  Add a profile
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/app/settings" />}>
            <Settings aria-hidden="true" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align}>
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

"use client";

import { APP_CATALOG, appLogoUrl } from "@gond/shared";
import { Plug } from "lucide-react";
import { useState } from "react";

const COLORS: Record<string, string> = {
  gmail: "#EA4335",
  googlecalendar: "#4285F4",
  googledrive: "#34A853",
  googledocs: "#4285F4",
  googlesheets: "#0F9D58",
  googleslides: "#F4B400",
  googletasks: "#4285F4",
  googlemeet: "#00897B",
};

export function appName(toolkit: string) {
  return APP_CATALOG.find((a) => a.toolkit === toolkit)?.name ?? toolkit;
}

export function AppIcon({ toolkit, logo, size = 24, className }: { toolkit: string; logo?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const name = appName(toolkit);
  const src = logo ?? appLogoUrl(toolkit);
  if (failed) {
    return (
      <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white ${className ?? ""}`} style={{ width: size, height: size, background: COLORS[toolkit] ?? "#6B7280", fontSize: Math.round(size * 0.5) }}>
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`inline-block shrink-0 rounded-md bg-white object-contain ${className ?? ""}`} style={{ width: size, height: size, padding: Math.round(size * 0.06) }} />
  );
}

export function McpIcon({ id, transport, size = 24, className }: { id: string; transport: "http" | "stdio"; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (transport !== "http" || failed) return <Plug aria-hidden="true" className={`shrink-0 text-muted-foreground ${className ?? ""}`} style={{ width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/mcp-servers/${id}/icon`} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className={`inline-block shrink-0 rounded-md bg-white object-contain ${className ?? ""}`} style={{ width: size, height: size, padding: Math.round(size * 0.06) }} />
  );
}

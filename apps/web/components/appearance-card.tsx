"use client";

import { ACCENT_LABELS, ACCENTS, isAccent, type Accent } from "@gond/shared";
import { Eye, Mail, Moon, Sun, SunMoon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { MenuBarField } from "@/components/server-card";
import { useStore } from "@/components/store";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldSeparator, FieldTitle } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { useNativeShell } from "@/lib/shell";

const subscribeNever = () => () => {};

const THEMES = [
  ["system", SunMoon, "System"],
  ["light", Sun, "Light"],
  ["dark", Moon, "Dark"],
] as const;

// The swatch in the list, so every color shows at once; the page itself paints with the --tint tokens.
const SWATCHES: Record<Accent, string> = { blue: "#2F6FD6", purple: "#7650D8", pink: "#CF3D85", red: "#D03A3A", orange: "#E04E0A", amber: "#D98A08", green: "#189C47" };

const ITEMS = ACCENTS.map((value) => ({ value, label: ACCENT_LABELS[value] }));

function Swatch({ accent }: { accent: Accent }) {
  return <span aria-hidden="true" className="size-3.5 shrink-0 self-center rounded-full" style={{ background: SWATCHES[accent] }} />;
}

export function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const { me, setMe } = useStore();
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const shell = useNativeShell();

  async function pick(accent: Accent) {
    if (accent === me.accent) return;
    const before = me;
    setMe({ ...me, accent });
    try {
      await api("/api/me/accent", { method: "PUT", body: JSON.stringify({ accent }) });
    } catch {
      setMe(before);
      toast.add({ type: "error", title: "Couldn't change the color." });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme and color</CardTitle>
        <CardDescription>The theme is this device&apos;s own. Your color follows you to every device.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldTitle id="theme-label">Theme</FieldTitle>
            <FieldDescription>Follow your device, or pick one.</FieldDescription>
            <ToggleGroup aria-labelledby="theme-label" variant="outline" value={[mounted ? theme : "system"]} onValueChange={(v) => v[0] && setTheme(v[0] as typeof theme)}>
              {THEMES.map(([value, Icon, label]) => (
                <ToggleGroupItem key={value} value={value} aria-label={label}>
                  <Icon data-icon="inline-start" />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <FieldSeparator />
          <Field orientation="horizontal">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldTitle id="accent-label">Color</FieldTitle>
              <FieldDescription>Your bubbles, cards and buttons.</FieldDescription>
            </div>
            <Select items={ITEMS} value={me.accent} onValueChange={(value) => isAccent(value) && void pick(value)}>
              <SelectTrigger aria-labelledby="accent-label" className="w-44">
                <SelectValue>
                  {(value: string) =>
                    isAccent(value) ? (
                      <span className="flex items-center gap-2.5">
                        <Swatch accent={value} />
                        {ACCENT_LABELS[value]}
                      </span>
                    ) : null
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ACCENTS.map((accent) => (
                    <SelectItem key={accent} value={accent}>
                      <Swatch accent={accent} />
                      {ACCENT_LABELS[accent]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {shell === "desktop" ? (
            <>
              <FieldSeparator />
              <MenuBarField />
            </>
          ) : null}
        </FieldGroup>

        <div className="flex flex-col gap-2" aria-label="Preview" role="group">
          <p className="text-[12.5px] font-medium text-muted-foreground">Preview</p>
          <div className="flex flex-col gap-2 rounded-3xl border border-primary-edge bg-background p-3.5">
            <p className="max-w-[80%] self-end rounded-2xl bg-bubble-you px-3.5 py-2 text-[14px] leading-6 text-bubble-you-foreground">Anything I should know about tomorrow?</p>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Eye className="size-3.5 text-tint-ink" aria-hidden="true" />
              <span className="font-semibold text-tint-ink">Juniper noticed</span> · 7:42
            </p>
            <div className="flex flex-col gap-3 rounded-3xl border border-tint-edge bg-tint-wash p-3.5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tint-solid text-tint-foreground">
                  <Mail className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] leading-5 font-semibold">Ask Dana to keep 9:30?</p>
                  <p className="text-[12px] leading-4 text-muted-foreground">
                    <span className="font-semibold text-tint-ink">Juniper</span> · Gmail
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="tint" size="lg" tabIndex={-1}>
                  Send it
                </Button>
                <Button variant="outline" size="lg" tabIndex={-1} className="border-tint-edge">
                  I&apos;ll handle it
                </Button>
              </div>
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground">Each bot keeps its own color for its face, and status badges stay green, amber and red whatever you pick.</p>
        </div>
      </CardContent>
    </Card>
  );
}

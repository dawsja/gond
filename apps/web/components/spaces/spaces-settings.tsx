"use client";

import { GOND_RELAY_URL, SPACE_LEVEL_LABELS, SPACE_LEVELS, type Federation, type FederationPeer, type SpaceDefaults, type SpaceLevel } from "@gond/shared";
import { Lock } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { failed } from "@/components/failed";
import { LoadFailed } from "@/components/load-failed";
import { BotPicker, Words } from "@/components/spaces/space-dialogs";
import { useFederation } from "@/components/spaces/use-federation";
import { useStore } from "@/components/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { shortTime } from "@/lib/time";

const RELAY_ITEMS = [
  { value: "gond", label: "Gond's relay" },
  { value: "own", label: "My own relay" },
];
const INVITE_ITEMS = [
  { value: "everyone", label: "Everyone on this Gond" },
  { value: "admin", label: "Only the admin" },
];
const LEVEL_ITEMS = SPACE_LEVELS.map((value) => ({ value, label: SPACE_LEVEL_LABELS[value].label }));

const STATE_LABELS: Record<Federation["state"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  ready: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting", tone: "warn" },
  closed: { label: "Can't reach the relay", tone: "warn" },
  replaced: { label: "Another copy took over", tone: "warn" },
  off: { label: "Off", tone: "neutral" },
};

type Loaded = { federation: Federation; peers: FederationPeer[] };

/** Settings → Other Gonds, the admin's: Spaces on or off, this Gond's name and words, its relay, who may invite, and the Gonds it knows. */
export function OtherGondsSection() {
  const { federation, peers, failed: loadFailed, reload, set } = useFederation();
  const [name, setName] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!federation) return loadFailed ? <LoadFailed what="Spaces" onRetry={reload} /> : <Skeleton className="h-96 rounded-xl" />;

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      set(await api<Loaded>("/api/spaces/federation", { method: "PUT", body: JSON.stringify(patch) }));
      setName(null);
      setRelayUrl(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  const state = STATE_LABELS[federation.state];
  const shownName = name ?? federation.name;
  const shownUrl = relayUrl ?? (federation.relay === "own" ? federation.relayUrl : "");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            This Gond <Badge tone={state.tone}>{state.label}</Badge>
          </CardTitle>
          <CardDescription>Spaces are rooms shared with people and their bots on other Gonds, end-to-end encrypted. Off until you turn them on.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldTitle id="spaces-on">Spaces</FieldTitle>
                <FieldDescription>Off again closes every space here.</FieldDescription>
              </div>
              <Switch checked={federation.enabled} disabled={busy} aria-labelledby="spaces-on" onCheckedChange={(on) => void save(on && !shownName.trim() ? { enabled: on, name: "My Gond" } : { enabled: on })} />
            </Field>
            <FieldSeparator />
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void save({ name: shownName });
              }}
            >
              <Field>
                <FieldLabel htmlFor="gond-name">Its name to others</FieldLabel>
                <div className="flex gap-2">
                  <Input id="gond-name" value={shownName} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ada's Gond" />
                  {name !== null && name.trim() !== federation.name ? (
                    <Button type="submit" variant="outline" disabled={busy} className="h-auto self-stretch">
                      Save
                    </Button>
                  ) : null}
                </div>
                <FieldDescription>People on other Gonds see it beside everyone from here.</FieldDescription>
              </Field>
            </form>
            {federation.words ? (
              <Field>
                <FieldTitle>Its words</FieldTitle>
                <Words words={federation.words} />
                <FieldDescription>Made from this Gond&apos;s key. Every invite shows them, so the other side can check them with you.</FieldDescription>
              </Field>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How other Gonds reach this one</CardTitle>
          <CardDescription>Through a relay, which passes sealed envelopes and can&apos;t read them. It does see that this Gond and another one talk, and when.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldTitle id="relay-pick">Relay</FieldTitle>
                <FieldDescription>{federation.relay === "gond" ? GOND_RELAY_URL : "One you run, from the gond-relay image."}</FieldDescription>
              </div>
              <Select items={RELAY_ITEMS} value={federation.relay} disabled={busy} onValueChange={(value) => value && value !== federation.relay && (value === "gond" || federation.relayUrl !== GOND_RELAY_URL ? void save({ relay: value }) : set({ federation: { ...federation, relay: "own" }, peers }))}>
                <SelectTrigger aria-labelledby="relay-pick" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RELAY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {federation.relay === "own" ? (
              <form
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void save({ relay: "own", relayUrl: shownUrl });
                }}
              >
                <Field>
                  <FieldLabel htmlFor="relay-url">Your relay&apos;s address</FieldLabel>
                  <div className="flex gap-2">
                    <Input id="relay-url" value={shownUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="https://relay.example.com" className="font-mono text-[13px]" />
                    <Button type="submit" variant="outline" disabled={busy || !shownUrl.trim()} className="h-auto self-stretch">
                      {busy ? <Spinner data-icon="inline-start" /> : null}
                      Save
                    </Button>
                  </div>
                </Field>
              </form>
            ) : null}
            <FieldSeparator />
            <Field orientation="horizontal">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldTitle id="invites-pick">Who can invite and join</FieldTitle>
                <FieldDescription>Who on this Gond may bring other Gonds into a room, or join theirs.</FieldDescription>
              </div>
              <Select items={INVITE_ITEMS} value={federation.invites} disabled={busy} onValueChange={(value) => value && void save({ invites: value })}>
                <SelectTrigger aria-labelledby="invites-pick" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {INVITE_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gonds this one knows</CardTitle>
          <CardDescription>Every Gond met through a space. Blocking one takes it out of every space here, and nothing it sends gets through.</CardDescription>
        </CardHeader>
        <CardContent>
          {peers.length ? (
            <ul className="flex flex-col divide-y">
              {peers.map((peer) => (
                <PeerRow key={peer.key} peer={peer} onChange={(loaded) => set(loaded)} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">None yet. Invite someone from a room&apos;s details, or join a space from New.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PeerRow({ peer, onChange }: { peer: FederationPeer; onChange: (loaded: Loaded) => void }) {
  const [busy, setBusy] = useState(false);
  const block = (blocked: boolean) => {
    setBusy(true);
    void api<{ peers: FederationPeer[] }>(`/api/spaces/gonds/${encodeURIComponent(peer.key)}/block`, { method: "POST", body: JSON.stringify({ blocked }) })
      .then(() => api<Loaded>("/api/spaces/federation"))
      .then(onChange)
      .catch(failed(blocked ? "Couldn't block it." : "Couldn't unblock it."))
      .finally(() => setBusy(false));
  };
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[14px] font-medium">
          {peer.name || "Another Gond"}
          {peer.verified ? <Lock className="size-3.5 text-tone-ok" aria-label="Words checked" /> : <Badge tone="neutral">Not checked</Badge>}
          {peer.blocked ? <Badge tone="bad">Blocked</Badge> : null}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          {peer.spaces} {peer.spaces === 1 ? "space" : "spaces"}
          {peer.lastSeen ? ` · heard from ${shortTime(peer.lastSeen)}` : ""}
        </span>
        <Words words={peer.words} />
      </div>
      <Button variant="outline" size="sm" disabled={busy} className={peer.blocked ? undefined : "text-destructive"} onClick={() => block(!peer.blocked)}>
        {peer.blocked ? "Unblock" : "Block"}
      </Button>
    </li>
  );
}

/** Settings → Spaces, everyone's: what their bots may do in a space they join, and which may join at all. */
export function SpaceDefaultsCard() {
  const { bots } = useStore();
  const { federation } = useFederation();
  const [defaults, setDefaults] = useState<SpaceDefaults | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const mine = bots.filter((b) => !b.hidden);

  const load = () =>
    void api<{ defaults: SpaceDefaults }>("/api/spaces/defaults")
      .then((data) => {
        setDefaults(data.defaults);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  if (!defaults) return loadFailed ? <LoadFailed what="your space settings" onRetry={load} /> : <Skeleton className="h-56 rounded-xl" />;

  const save = (next: SpaceDefaults) => {
    setDefaults(next);
    void api<{ defaults: SpaceDefaults }>("/api/spaces/defaults", { method: "PUT", body: JSON.stringify(next) })
      .then((data) => setDefaults(data.defaults))
      .catch(failed("Couldn't save that."));
  };
  const allowed = defaults.bots ?? mine.map((b) => b.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your bots in spaces</CardTitle>
        <CardDescription>
          {federation && !federation.enabled ? "Spaces are off on this Gond. The admin turns them on in Settings → Other Gonds; these are kept for then." : "Where people on other Gonds can talk to your bots. Each space can change this per bot, in its details."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldTitle id="space-level">Your bots join on</FieldTitle>
              <FieldDescription>{SPACE_LEVEL_LABELS[defaults.level].blurb}</FieldDescription>
            </div>
            <Select items={LEVEL_ITEMS} value={defaults.level} onValueChange={(value) => value && save({ ...defaults, level: value as SpaceLevel })}>
              <SelectTrigger aria-labelledby="space-level" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SPACE_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {SPACE_LEVEL_LABELS[level].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <FieldSeparator />
          <Field>
            <FieldTitle id="space-bots">Bots that may join spaces</FieldTitle>
            <BotPicker bots={mine} picked={allowed} labelledBy="space-bots" empty="None of them" onChange={(ids) => save({ ...defaults, bots: ids.length === mine.length ? null : ids })} />
            <FieldDescription>None until you pick them. Leave out a bot that handles money or anything private, and it never joins one.</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

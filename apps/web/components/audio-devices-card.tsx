"use client";

import { Mic, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { canPickSpeaker, chooseDevice, microphone, useChosenDevice, routeToSpeaker, type AudioDeviceKind } from "@/lib/audio-devices";
import { levelOf } from "@/lib/call-audio";
import { cn } from "@/lib/utils";

const SYSTEM = "system";
const SEGMENTS = 16;

type Device = { id: string; label: string };

function listOf(devices: MediaDeviceInfo[], kind: MediaDeviceKind): Device[] {
  return devices.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || (kind === "audioinput" ? `Microphone ${i + 1}` : `Speaker ${i + 1}`) }));
}

function DevicePicker({ kind, id, label, devices }: { kind: AudioDeviceKind; id: string; label: string; devices: Device[] }) {
  const chosen = useChosenDevice(kind);
  // A device that was picked and is gone now falls back to the system's, and says so.
  const present = !chosen || devices.some((d) => d.id === chosen);
  const items = [{ value: SYSTEM, label: "System default" }, ...devices.map((d) => ({ value: d.id, label: d.label }))];
  return (
    <Select items={items} value={present && chosen ? chosen : SYSTEM} onValueChange={(next) => next && chooseDevice(kind, next === SYSTEM ? "" : String(next))}>
      <SelectTrigger id={id} aria-label={label} className="w-full max-w-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** A row of segments that light up with what the picked microphone hears, so the right one is easy to tell. */
function MicTest() {
  const chosen = useChosenDevice("input");
  const [testing, setTesting] = useState(false);
  const segments = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!testing) return;
    const lights = segments.current;
    let frame = 0;
    let stop = () => {};
    let gone = false;
    void (async () => {
      try {
        const stream = await microphone();
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(1024);
        stop = () => {
          cancelAnimationFrame(frame);
          for (const track of stream.getTracks()) track.stop();
          void context.close();
        };
        if (gone) return stop();
        const draw = () => {
          const lit = Math.round(Math.min(1, levelOf(analyser, buffer) * 1.5) * SEGMENTS);
          lights.forEach((segment, i) => segment?.toggleAttribute("data-lit", i < lit));
          frame = requestAnimationFrame(draw);
        };
        draw();
      } catch {
        toast.add({ type: "error", title: "The microphone didn't start.", description: "Allow it for Gond, then try again." });
        setTesting(false);
      }
    })();
    return () => {
      gone = true;
      stop();
      lights.forEach((segment) => segment?.removeAttribute("data-lit"));
    };
  }, [testing, chosen]);

  return (
    <div className="flex max-w-sm items-center gap-3">
      <Button type="button" variant="outline" onClick={() => setTesting((on) => !on)} aria-pressed={testing}>
        {testing ? <Square data-icon="inline-start" className="fill-current" aria-hidden="true" /> : <Mic data-icon="inline-start" aria-hidden="true" />}
        {testing ? "Stop" : "Test"}
      </Button>
      <span aria-hidden="true" className={cn("flex h-3 flex-1 gap-[3px]", !testing && "opacity-50")}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            ref={(node) => {
              segments.current[i] = node;
            }}
            className="flex-1 rounded-full bg-muted data-lit:bg-tint-solid"
          />
        ))}
      </span>
    </div>
  );
}

async function playTestSound(id: string) {
  const context = new AudioContext();
  await routeToSpeaker(context, id);
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.6);
  tone.connect(gain).connect(context.destination);
  tone.start();
  tone.stop(context.currentTime + 0.65);
  tone.onended = () => void context.close();
}

export function AudioDevicesCard() {
  const [inputs, setInputs] = useState<Device[] | null>(null);
  const [outputs, setOutputs] = useState<Device[]>([]);
  const [named, setNamed] = useState(true);
  const speaker = useChosenDevice("output");
  const speakers = useSyncExternalStore(
    () => () => {},
    canPickSpeaker,
    () => false,
  );

  const load = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setInputs([]);
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(listOf(devices, "audioinput"));
    setOutputs(listOf(devices, "audiooutput"));
    // Until the microphone is allowed once, the browser hides what the devices are called.
    setNamed(devices.some((d) => d.kind === "audioinput" && d.label));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, [load]);

  async function reveal() {
    try {
      const stream = await microphone();
      for (const track of stream.getTracks()) track.stop();
      await load();
    } catch {
      toast.add({ type: "error", title: "The microphone is blocked.", description: "Allow it for Gond, then try again." });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Microphone and speaker</CardTitle>
        <CardDescription>What calls and talking instead of typing use. Saved on this device only.</CardDescription>
      </CardHeader>
      <CardContent>
        {inputs && !named ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">Allow the microphone once to see your devices by name.</p>
            <Button variant="outline" onClick={() => void reveal()}>
              <Mic data-icon="inline-start" aria-hidden="true" />
              Show my devices
            </Button>
          </div>
        ) : (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="audio-input">Microphone</FieldLabel>
              <DevicePicker kind="input" id="audio-input" label="Microphone" devices={inputs ?? []} />
              <MicTest />
              <FieldDescription>Speak while testing: the bar fills for the microphone that hears you.</FieldDescription>
            </Field>
            {speakers ? (
              <Field>
                <FieldLabel htmlFor="audio-output">Speaker</FieldLabel>
                <div className="flex max-w-sm flex-col gap-2">
                  <DevicePicker kind="output" id="audio-output" label="Speaker" devices={outputs} />
                  <div>
                    <Button type="button" variant="outline" onClick={() => void playTestSound(speaker)}>
                      <Volume2 data-icon="inline-start" aria-hidden="true" />
                      Play a test sound
                    </Button>
                  </div>
                </div>
              </Field>
            ) : null}
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}

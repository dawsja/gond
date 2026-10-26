"use client";

import { EMOJI_LEVEL_LABELS, EMOJI_LEVELS, REPLY_STYLE_LABELS, REPLY_STYLES, isEmojiLevel, isReplyStyle, type EmojiLevel, type ReplyStyle } from "@gond/shared";
import { failed } from "@/components/failed";
import { useStore } from "@/components/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldSeparator, FieldTitle } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";

const ITEMS = REPLY_STYLES.map((value) => ({ value, label: REPLY_STYLE_LABELS[value].title }));

// One answer to the same question in each style, so a pick shows what it changes.
const SAMPLES: Record<ReplyStyle, string> = {
  default: "Yes, it's up. It answered in 180 ms, and its certificate is good until March.",
  professional: "Yes, the website is up. It responded in 180 ms, and its certificate remains valid until March.",
  friendly: "Yep, it's up and quick today, answering in 180 ms. The certificate's good until March too.",
  candid: "It's up, at 180 ms. The certificate runs out in March and nothing renews it, so let's set that up now.",
  efficient: "Up. 180 ms.",
};

function sample(style: ReplyStyle, emoji: EmojiLevel) {
  return emoji === "more" ? `✅ ${SAMPLES[style]} 🔒` : SAMPLES[style];
}

export function PersonalizationCard() {
  const { me, setMe } = useStore();

  function save(change: { style?: ReplyStyle; emoji?: EmojiLevel }) {
    const before = me;
    setMe({ ...me, ...change });
    api("/api/me/talk", { method: "PUT", body: JSON.stringify(change) }).catch((failure: unknown) => {
      setMe(before);
      failed("Couldn't save that. Try again.")(failure);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How your bots talk to you</CardTitle>
        <CardDescription>Every one of your bots, in every chat. Each keeps its own job and what it knows; only how it says things changes.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldTitle id="style-label">Style</FieldTitle>
              <FieldDescription>The tone and length of their replies.</FieldDescription>
            </div>
            <Select items={ITEMS} value={me.style} onValueChange={(value) => isReplyStyle(value) && value !== me.style && save({ style: value })}>
              <SelectTrigger aria-labelledby="style-label" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {REPLY_STYLES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex flex-col gap-0.5 whitespace-normal">
                        <span className="font-medium">{REPLY_STYLE_LABELS[value].title}</span>
                        <span className="text-[12px] text-muted-foreground">{REPLY_STYLE_LABELS[value].blurb}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <FieldSeparator />
          <Field>
            <FieldTitle id="emoji-label">Emoji</FieldTitle>
            <FieldDescription>How many they use. Reactions to your messages stay either way.</FieldDescription>
            <ToggleGroup aria-labelledby="emoji-label" variant="outline" value={[me.emoji]} onValueChange={(v) => isEmojiLevel(v[0]) && v[0] !== me.emoji && save({ emoji: v[0] })}>
              {EMOJI_LEVELS.map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {EMOJI_LEVEL_LABELS[value]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>

        <div className="flex flex-col gap-2" aria-label="Preview" role="group">
          <p className="text-[12.5px] font-medium text-muted-foreground">Preview</p>
          <div className="flex flex-col gap-2 rounded-3xl border border-primary-edge bg-background p-3.5">
            <p className="max-w-[80%] self-end rounded-2xl bg-bubble-you px-3.5 py-2 text-[14px] leading-6 text-bubble-you-foreground">Is the website up?</p>
            <p className="max-w-[85%] self-start rounded-2xl bg-bubble-bot px-3.5 py-2 text-[14px] leading-6 text-foreground">{sample(me.style, me.emoji)}</p>
          </div>
          <p className="text-[12px] text-muted-foreground">Their next reply follows it, in conversations already going too.</p>
        </div>
      </CardContent>
    </Card>
  );
}

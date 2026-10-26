"use client";

import { cardBrand, CARD_NICKNAME_MAX, type CardMeta } from "@gond/shared";
import { CreditCard } from "lucide-react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export type CardValues = { number: string; expiry: string; cvc: string; name: string; zip: string; nickname: string };

export const EMPTY_CARD: CardValues = { number: "", expiry: "", cvc: "", name: "", zip: "", nickname: "" };

/** The card's brand on a little card, the only picture of it Gond ever draws. */
export function CardMark({ brand, className }: { brand: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex h-7 w-11 shrink-0 items-end justify-end rounded-md bg-foreground px-1.5 pb-1 text-[8.5px] font-bold tracking-wide text-background uppercase", className)}>
      {brand === "Card" ? "" : brand}
    </span>
  );
}

export function cardLine(card: CardMeta): string {
  return `${card.brand === "Card" ? "Card" : card.brand} ending ${card.last4} · expires ${card.expires}`;
}

/** Groups of four as the person types, Amex's 4-6-5. */
function spaced(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 19);
  const groups = /^3[47]/.test(digits) ? [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)] : (digits.match(/.{1,4}/g) ?? []);
  return groups.filter(Boolean).join(" ");
}

function slashed(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

/**
 * A card's fields, with the browser's own card autofill. `keep` is a card being changed: every field
 * may stay empty, which keeps what it had.
 */
export function CardFields({ id, values, onChange, keep = false, nickname = true }: { id: string; values: CardValues; onChange: (values: CardValues) => void; keep?: boolean; nickname?: boolean }) {
  const set = (key: keyof CardValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    onChange({ ...values, [key]: key === "number" ? spaced(raw) : key === "expiry" ? slashed(raw) : key === "cvc" ? raw.replace(/\D/g, "").slice(0, 4) : raw });
  };
  const brand = cardBrand(values.number);
  const unchanged = keep ? "Unchanged" : undefined;
  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${id}-number`}>Card number</FieldLabel>
        <InputGroup>
          <InputGroupAddon>
            <CreditCard aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput id={`${id}-number`} value={values.number} onChange={set("number")} autoComplete="cc-number" inputMode="numeric" placeholder={unchanged ?? "1234 1234 1234 1234"} spellCheck={false} />
          {values.number && brand !== "Card" ? (
            <InputGroupAddon align="inline-end">
              <span className="text-[11px] font-bold tracking-wide uppercase">{brand}</span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field>
          <FieldLabel htmlFor={`${id}-expiry`}>Expires</FieldLabel>
          <Input id={`${id}-expiry`} value={values.expiry} onChange={set("expiry")} autoComplete="cc-exp" inputMode="numeric" placeholder={unchanged ?? "MM/YY"} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-cvc`}>CVC</FieldLabel>
          <Input id={`${id}-cvc`} type="password" value={values.cvc} onChange={set("cvc")} autoComplete="cc-csc" inputMode="numeric" placeholder={unchanged ?? "123"} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-zip`}>ZIP</FieldLabel>
          <Input id={`${id}-zip`} value={values.zip} onChange={set("zip")} autoComplete="postal-code" maxLength={12} placeholder={unchanged} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name on the card</FieldLabel>
        <Input id={`${id}-name`} value={values.name} onChange={set("name")} autoComplete="cc-name" maxLength={100} placeholder={unchanged ?? "As it's printed"} />
      </Field>
      {nickname ? (
        <Field>
          <FieldLabel htmlFor={`${id}-nickname`}>Call it</FieldLabel>
          <Input id={`${id}-nickname`} value={values.nickname} onChange={set("nickname")} maxLength={CARD_NICKNAME_MAX} placeholder="Personal Visa" />
          <FieldDescription>What you&apos;ll see when a bot asks to use it. Leave it empty for the card&apos;s brand and last four digits.</FieldDescription>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

/** What the API takes for a card: the fields the person filled in. */
export function cardBody(values: CardValues) {
  return { card: { number: values.number, expiry: values.expiry, cvc: values.cvc, name: values.name, zip: values.zip }, nickname: values.nickname };
}

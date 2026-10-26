"use client";

import { cardLabel, type Bot, type SecretMeta, type SecretRequest } from "@gond/shared";
import { CreditCard, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ActionCard, ActionCardDone, ActionRows, cheerOnFold, NOBODY_ANSWERED } from "@/components/action-card";
import { cardBody, CardFields, cardLine, CardMark, EMPTY_CARD, type CardValues } from "@/components/card-form";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { apiShared, post } from "@/lib/api";

const ANOTHER = "another";

/** The person's saved cards, newest first; without the list the card still works by typing one in. */
function useSavedCards(pending: boolean) {
  const [cards, setCards] = useState<SecretMeta[] | null>(pending ? null : []);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    apiShared<{ secrets: SecretMeta[] }>("/api/secrets")
      .then((data) => live && setCards(data.secrets.filter((s) => s.card).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))))
      .catch(() => live && setCards([]));
    return () => {
      live = false;
    };
  }, [pending]);
  return cards;
}

/** A bot at a checkout asks to pay: the person picks a saved card, or types one in, and says yes to this total. */
export function PayCard({ request, bot, onAnswered }: { request: SecretRequest; bot: Bot | undefined; onAnswered: (request: SecretRequest) => void }) {
  const cards = useSavedCards(request.status === "pending");
  const [picked, setPicked] = useState<string | null>(null);
  const [values, setValues] = useState<CardValues>(EMPTY_CARD);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = bot?.name ?? "A bot";
  const site = request.site ?? "the checkout";
  const icon = <CreditCard aria-hidden="true" />;
  if (request.status !== "pending") {
    const done = request.status === "given" ? { status: request.card ? `Paid with ${request.card}` : "Paid", tone: "ok" as const } : request.status === "declined" ? { status: "Not now", tone: "neutral" as const } : { status: "Expired", tone: "neutral" as const };
    return <ActionCardDone id={request.id} bot={bot} icon={icon} title={`Pay on ${site}`} by={request.status === "expired" ? NOBODY_ANSWERED : `${name}${request.total ? ` · ${request.total}` : ""}`} status={done.status} tone={done.tone} />;
  }

  const choice = picked ?? cards?.[0]?.name ?? ANOTHER;
  const typing = choice === ANOTHER;
  const ready = !typing || Boolean(values.number && values.expiry && values.cvc);

  async function answer(event?: FormEvent, decline = false) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = decline ? { decline: true } : typing ? { ...cardBody(values), remember } : { saved: choice };
      const data = await post<{ request: SecretRequest }>(`/api/secret-requests/${request.id}`, body);
      setValues(EMPTY_CARD);
      if (!decline) cheerOnFold(request.id);
      onAnswered(data.request);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't send it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={answer} className="contents">
      <ActionCard
        icon={icon}
        title={cards?.length ? "Pay with a saved card?" : "Pay with a card?"}
        by={`${name} · ${site}`}
        actions={
          <>
            <Button type="submit" size="xl" variant="tint" className="w-full" disabled={busy || !cards || !ready}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Use this card
            </Button>
            <Button type="button" size="xl" variant="outline" className="w-full" disabled={busy} onClick={() => void answer(undefined, true)}>
              Not now
            </Button>
          </>
        }
        note={`Typed into this checkout only. ${name} never sees the card.`}
      >
        {request.reason ? <p className="text-[13.5px] text-muted-foreground">{`${request.reason[0]!.toUpperCase()}${request.reason.slice(1)}`}</p> : null}
        {request.total ? <ActionRows rows={[]} total={{ label: "Total", value: request.total }} /> : null}
        <FieldGroup className="gap-3">
          {cards === null ? (
            <Spinner aria-label="Loading your cards" />
          ) : cards.length ? (
            <FieldSet>
              <FieldLegend variant="label">Which card</FieldLegend>
              <RadioGroup value={choice} onValueChange={(value) => setPicked(String(value))}>
                {cards.map((card) => (
                  <FieldLabel key={card.name} htmlFor={`pay-${request.id}-${card.name}`}>
                    <Field orientation="horizontal">
                      <CardMark brand={card.card!.brand} />
                      <FieldContent>
                        <FieldTitle>{cardLabel(card.card!)}</FieldTitle>
                        <FieldDescription>{cardLine(card.card!)}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem value={card.name} id={`pay-${request.id}-${card.name}`} />
                    </Field>
                  </FieldLabel>
                ))}
                <FieldLabel htmlFor={`pay-${request.id}-${ANOTHER}`}>
                  <Field orientation="horizontal">
                    <Plus aria-hidden="true" className="size-4" />
                    <FieldContent>
                      <FieldTitle>Use another card</FieldTitle>
                    </FieldContent>
                    <RadioGroupItem value={ANOTHER} id={`pay-${request.id}-${ANOTHER}`} />
                  </Field>
                </FieldLabel>
              </RadioGroup>
            </FieldSet>
          ) : null}
          {cards && typing ? (
            <>
              <CardFields id={`pay-${request.id}`} values={values} onChange={setValues} nickname={false} />
              <FieldLabel htmlFor={`pay-${request.id}-remember`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Save it for next time</FieldTitle>
                    <FieldDescription>For any site, in Settings → Secrets → Cards.</FieldDescription>
                  </FieldContent>
                  <Switch id={`pay-${request.id}-remember`} checked={remember} onCheckedChange={setRemember} aria-label="Save it for next time" />
                </Field>
              </FieldLabel>
            </>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
      </ActionCard>
    </form>
  );
}

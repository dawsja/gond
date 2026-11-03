"use client";

import { shoppingPrice, type Bot, type Message, type ProductCollection, type SecretMeta, type ShippingAddress, type ShoppingCheckout, type ShoppingOrder, type ShoppingProduct, type ShoppingRecord } from "@gond/shared";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Package, ShoppingBag, Truck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionCard, ActionRows } from "@/components/action-card";
import { CardFields, cardBody, EMPTY_CARD, type CardValues } from "@/components/card-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { apiShared, post } from "@/lib/api";
import { pollWhileShown } from "@/lib/poll";
import { cn } from "@/lib/utils";

function ProductPhoto({ src, title, small = false, gallery = false }: { src?: string; title: string; small?: boolean; gallery?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  return <div className={small ? "grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted" : cn("grid w-full place-items-center overflow-hidden rounded-2xl bg-muted", gallery ? "h-[clamp(128px,22dvh,224px)] sm:aspect-square sm:h-auto" : "aspect-square")}>
    {src && failedSrc !== src ? (
      // Merchant images are validated public URLs; never send them through the server image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={title} loading="lazy" referrerPolicy="no-referrer" className="size-full min-h-0 object-contain" onError={() => setFailedSrc(src)} />
    ) : <ShoppingBag aria-label="No product photo available" />}
  </div>;
}
const optionName = (product: ShoppingProduct, id: string) => Object.values(product.variants.find(v => v.id === id)?.options ?? {}).join(" · ");
const stockLabel = (stock: string) => stock === "in_stock" ? "In stock" : stock === "out_of_stock" ? "Out of stock" : "Check availability";

export function ShoppingCard({ message, bot }: { message: Message; bot?: Bot }) {
  const [record, setRecord] = useState<ShoppingRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const data = await apiShared<{ record: ShoppingRecord }>(`/api/shopping/${message.commerceId}`); setRecord(data.record); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load shopping"); }
  }, [message.commerceId]);
  useEffect(() => { void Promise.resolve().then(load); return pollWhileShown(() => void load(), 5000); }, [load]);
  if (!record) return error ? <Alert><AlertDescription>{error} <Button variant="outline" onClick={() => void load()}>Try again</Button></AlertDescription></Alert> : <Skeleton className="h-64 w-72 rounded-3xl" />;
  return <div className="flex w-full min-w-0 flex-col gap-3">
    {error ? <Alert><AlertDescription>{error}</AlertDescription></Alert> : null}
    {record.kind === "products" ? <Products record={record} /> : record.kind === "checkout" ? <Checkout record={record} bot={bot} onChange={setRecord} /> : <Order record={record} bot={bot} onChange={setRecord} />}
  </div>;
}

function Products({ record }: { record: ProductCollection }) {
  const [product, setProduct] = useState<ShoppingProduct | null>(null);
  const carousel = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState({ back: false, next: false });
  useEffect(() => {
    const element = carousel.current;
    if (!element) return;
    const update = () => setCanScroll({ back: element.scrollLeft > 1, next: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  return <>
    <div role="region" aria-label="Shopping results" className="flex min-w-0 flex-col gap-2">
      <div ref={carousel} className="grid max-w-full auto-cols-[240px] grid-flow-col grid-rows-[auto_auto_auto_auto_auto] snap-x snap-mandatory gap-x-3 overflow-x-auto pb-2" tabIndex={0}>
        {record.products.map(p => {
          const offers = p.variants.flatMap(v => v.offers).sort((a, b) => Number(b.availability === "in_stock") - Number(a.availability === "in_stock"));
          const offer = offers[0]!;
          return <Card key={p.id} className="row-span-5 grid snap-start grid-rows-subgrid gap-y-2 overflow-hidden p-3">
            <CardHeader className="relative p-0">
              <Button variant="ghost" className="h-auto w-full p-0" onClick={() => setProduct(p)} aria-label={`View ${p.title}`}><ProductPhoto src={p.images[0]} title={p.title} /></Button>
              <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-1">{p.badges.map(b => <Badge key={b}>{b}</Badge>)}</div>
            </CardHeader>
            <CardContent className="row-span-3 grid grid-rows-subgrid gap-y-1 p-0">
              <CardTitle><Button variant="ghost" className="h-auto w-full justify-start p-0 text-left whitespace-normal" onClick={() => setProduct(p)}>{p.title}</Button></CardTitle>
              <p className="text-sm text-muted-foreground">{p.rating ? `★ ${p.rating.value} (${p.rating.count.toLocaleString()})` : null}</p>
              <p className="text-lg font-semibold">{shoppingPrice(offer.price)}</p>
            </CardContent>
            <CardFooter variant="plain" className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 px-0 pt-0 pb-3"><span className="text-sm text-muted-foreground">{offer.store}</span><Badge tone={offer.availability === "in_stock" ? "ok" : "neutral"}>{stockLabel(offer.availability)}</Badge></CardFooter>
          </Card>;
        })}
      </div>
      <div className="flex min-h-8 items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Prices and stock checked {new Date(record.createdAt).toLocaleString()}</p><div className="flex gap-1">{canScroll.back ? <Button size="icon" variant="outline" aria-label="Previous products" onClick={() => carousel.current?.scrollBy({ left: -252, behavior: "smooth" })}><ChevronLeft /></Button> : null}{canScroll.next ? <Button size="icon" variant="outline" aria-label="Next products" onClick={() => carousel.current?.scrollBy({ left: 252, behavior: "smooth" })}><ChevronRight /></Button> : null}</div></div>
    </div>
    <Dialog open={Boolean(product)} onOpenChange={open => !open && setProduct(null)}><DialogContent className="sm:max-w-3xl">{product ? <ProductDetails key={product.id} product={product} collectionId={record.id} close={() => setProduct(null)} /> : null}</DialogContent></Dialog>
  </>;
}

function ProductDetails({ product, collectionId, close }: { product: ShoppingProduct; collectionId: string; close: () => void }) {
  const variants = [...product.variants].sort((a, b) => Number(b.offers.some(o => o.availability === "in_stock")) - Number(a.offers.some(o => o.availability === "in_stock")));
  const [variantId, setVariant] = useState(variants[0]!.id);
  const variant = variants.find(v => v.id === variantId)!;
  const [offerId, setOffer] = useState("");
  const offers = [...variant.offers].sort((a, b) => Number(b.availability === "in_stock") - Number(a.availability === "in_stock"));
  const offer = offers.find(o => o.id === offerId) ?? offers[0]!;
  const [photo, setPhoto] = useState(0), [quantity, setQuantity] = useState("1"), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const quantityValue = Number(quantity);
  const quantityValid = quantity.trim() !== "" && Number.isInteger(quantityValue) && quantityValue >= 1 && quantityValue <= 20;
  const actionKey = useRef(crypto.randomUUID());
  const options = variants.map(v => ({ value: v.id, label: Object.values(v.options).join(" · ") || "Standard", disabled: v.offers.every(o => o.availability === "out_of_stock") }));
  const selectVariant = (id: string) => { setVariant(id); setOffer(""); };
  async function buy() {
    if (!quantityValid || busy) return;
    setBusy(true); setError(null);
    try { await post(`/api/shopping/${collectionId}/checkout`, { productId: product.id, variantId, offerId: offer.id, quantity: quantityValue, actionKey: actionKey.current }); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't start checkout"); }
    finally { setBusy(false); }
  }
  return <>
    <DialogHeader><DialogTitle>{product.title}</DialogTitle><DialogDescription>{offer.store} · {shoppingPrice(offer.price)}{product.rating ? ` · ★ ${product.rating.value} (${product.rating.count.toLocaleString()})` : ""}</DialogDescription></DialogHeader>
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="relative self-start" role="region" aria-label="Product images" tabIndex={product.images.length > 1 ? 0 : undefined} onKeyDown={event => {
        if (event.key === "ArrowLeft") { event.preventDefault(); setPhoto(index => Math.max(0, index - 1)); }
        if (event.key === "ArrowRight") { event.preventDefault(); setPhoto(index => Math.min(product.images.length - 1, index + 1)); }
      }}>
        <ProductPhoto src={product.images[photo]} title={product.title} gallery />
        {photo > 0 ? <Button size="icon-lg" className="absolute top-1/2 left-3 -translate-y-1/2" aria-label="Previous image" onClick={() => setPhoto(index => index - 1)}><ChevronLeft /></Button> : null}
        {photo < product.images.length - 1 ? <Button size="icon-lg" className="absolute top-1/2 right-3 -translate-y-1/2" aria-label="Next image" onClick={() => setPhoto(index => index + 1)}><ChevronRight /></Button> : null}
        <span className="sr-only" aria-live="polite">{product.images.length ? `Image ${photo + 1} of ${product.images.length}` : "No product images"}</span>
      </div>
      <FieldGroup>
        <Field><FieldLabel id={`option-label-${product.id}`}>Options</FieldLabel>{options.length > 4 ? <Select items={options} value={variantId} onValueChange={value => { if (typeof value === "string") selectVariant(value); }}>
          <SelectTrigger aria-labelledby={`option-label-${product.id}`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select> : options.length === 1 ? <p className="text-sm">{options[0].label}</p> : <ToggleGroup aria-labelledby={`option-label-${product.id}`} variant="outline" value={[variantId]} onValueChange={value => { if (value[0]) selectVariant(String(value[0])); }} className="flex-wrap">{options.map(option => <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</ToggleGroupItem>)}</ToggleGroup>}</Field>
        <Field><FieldLabel>Store</FieldLabel><RadioGroup value={offer.id} onValueChange={v => setOffer(String(v))}>{offers.map(o => <Field key={o.id} orientation="horizontal"><RadioGroupItem id={`offer-${o.id}`} value={o.id} disabled={o.availability === "out_of_stock"} /><FieldLabel htmlFor={`offer-${o.id}`}>{o.store} · {shoppingPrice(o.price)} · {stockLabel(o.availability)}</FieldLabel></Field>)}</RadioGroup></Field>
        <Field data-invalid={!quantityValid || undefined}>
          <FieldLabel htmlFor="shopping-quantity">Quantity</FieldLabel>
          <Input id="shopping-quantity" className="scroll-mb-40" type="number" inputMode="numeric" min={1} max={20} step={1} required value={quantity} onChange={e => setQuantity(e.target.value)} aria-invalid={!quantityValid} aria-describedby={!quantityValid ? "shopping-quantity-error" : undefined} />
          {!quantityValid ? <FieldError id="shopping-quantity-error">Enter a whole number from 1 to 20.</FieldError> : null}
        </Field>
        <p className="text-sm text-muted-foreground">{offer.delivery || "Delivery confirmed at checkout"}</p>
        <p className="text-xs text-muted-foreground">Checked {new Date(offer.observedAt).toLocaleString()}. Price and stock will be rechecked.</p>
        {error ? <FieldError>{error}</FieldError> : null}
        <p className="text-xs text-muted-foreground">You’ll review the final total before paying.</p>
      </FieldGroup>
    </div>
    <DialogFooter>
      <Button variant="outline" nativeButton={false} render={<a href={offer.url} target="_blank" rel="noopener noreferrer" />}>View at {offer.store}<ExternalLink data-icon="inline-end" /></Button>
      <Button size="lg" disabled={busy || offer.availability === "out_of_stock" || !quantityValid} onClick={() => void buy()}>{busy ? <Spinner /> : null}Buy now</Button>
    </DialogFooter>
  </>;
}

const EMPTY_ADDRESS: ShippingAddress = { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "US", email: "", phone: "" };
function Checkout({ record, bot, onChange }: { record: ShoppingCheckout; bot?: Bot; onChange: (record: ShoppingRecord) => void }) {
  const [editing, setEditing] = useState(false), [address, setAddress] = useState(record.address ?? EMPTY_ADDRESS);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<SecretMeta[]>([]), [saved, setSaved] = useState(""), [values, setValues] = useState<CardValues>(EMPTY_CARD);
  const choice = saved || cards[0]?.name || "another";
  useEffect(() => { if (record.state === "review") void apiShared<{ secrets: SecretMeta[] }>("/api/secrets").then(data => setCards(data.secrets.filter(s => s.card))).catch(() => {}); }, [record.state]);
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => pollWhileShown(() => setAt(Date.now()), 1000), []);
  const expired = Boolean(record.expiresAt && Date.parse(record.expiresAt) < at);
  async function mutate(action: string, body: object) {
    setBusy(true); setError(null);
    try { const data = await post<{ record: ShoppingRecord }>(`/api/shopping/${record.id}/${action}`, { revision: record.revision, ...body }); onChange(data.record); setEditing(false); setValues(EMPTY_CARD); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't update checkout"); }
    finally { setBusy(false); }
  }
  const editable = ["preparing", "review", "approved"].includes(record.state);
  const needsAddress = record.state === "preparing" && !record.address;
  const title = { preparing: "Preparing your order", review: "Review your purchase", approved: "Payment approved", submitting: "Placing your order", unknown: "Checking your order", ordered: "Order submitted", cancelled: "Purchase cancelled", expired: "Approval expired", failed: "Checkout needs your help" }[record.state];
  return <ActionCard icon={<ShoppingBag />} title={expired && record.state === "review" ? "Approval expired" : title} by={`${bot?.name ?? "Your bot"} · ${record.offer.store}`} needs={record.state === "review" && !expired || needsAddress}
    actions={editable ? <><Button variant="outline" disabled={busy} onClick={() => void mutate("cancel", {})}>Cancel</Button>{record.state === "review" && !editing ? <Button variant="tint" disabled={busy || expired} onClick={() => void mutate("approve", choice === "another" ? cardBody(values) : { saved: choice })}>{busy ? <Spinner /> : null}Pay {shoppingPrice(record.quote!.total)}</Button> : null}</> : undefined}
    note="Your card details stay private. Approval applies only to this purchase and total.">
    <div className="flex items-center gap-3"><ProductPhoto small src={record.product.images[0]} title={record.product.title} /><div><p className="font-medium">{record.product.title}</p><p className="text-sm text-muted-foreground">{optionName(record.product, record.variantId)} · Qty {record.quantity}</p></div></div>
    {record.quote ? <ActionRows rows={[{ label: "Items", value: shoppingPrice(record.quote.subtotal) }, { label: "Shipping", value: shoppingPrice(record.quote.shipping) }, { label: "Tax", value: shoppingPrice(record.quote.tax) }, ...(record.quote.discount.amount ? [{ label: "Discount", value: `−${shoppingPrice(record.quote.discount)}` }] : [])]} total={{ label: "Total", value: shoppingPrice(record.quote.total) }} /> : null}
    {record.address && !editing ? <div className="flex items-start justify-between gap-2"><div className="text-sm"><p className="text-muted-foreground">Ship to</p><p>{record.address.name}</p><p>{record.address.line1}</p><p>{record.address.city}, {record.address.region} {record.address.postalCode}</p></div>{editable ? <Button variant="ghost" onClick={() => { setAddress(record.address!); setEditing(true); }}>Edit</Button> : null}</div> : null}
    {needsAddress || editing ? <form onSubmit={e => { e.preventDefault(); void mutate("address", { address }); }}><FieldGroup className="gap-3">{(Object.keys(EMPTY_ADDRESS) as (keyof ShippingAddress)[]).map(key => <Field key={key}><FieldLabel htmlFor={`${record.id}-${key}`}>{{ name: "Full name", line1: "Street address", line2: "Apartment / suite (optional)", city: "City", region: "State / region", postalCode: "ZIP / postal code", country: "Country (2-letter code)", email: "Email", phone: "Phone (optional)" }[key]}</FieldLabel><Input id={`${record.id}-${key}`} type={key === "email" ? "email" : "text"} required={!["line2", "phone"].includes(key)} value={address[key]} onChange={e => setAddress({ ...address, [key]: key === "country" ? e.target.value.toUpperCase() : e.target.value })} /></Field>)}<Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}Use this address</Button></FieldGroup></form> : null}
    {record.state === "review" && !editing && !expired ? <FieldGroup className="gap-3"><Field><FieldLabel>Pay with</FieldLabel><RadioGroup value={choice} onValueChange={v => setSaved(String(v))}>{cards.map(c => <Field key={c.name} orientation="horizontal"><RadioGroupItem id={`${record.id}-${c.name}`} value={c.name} /><FieldLabel htmlFor={`${record.id}-${c.name}`}>{c.card!.brand} •••• {c.card!.last4}</FieldLabel></Field>)}<Field orientation="horizontal"><RadioGroupItem id={`${record.id}-another`} value="another" /><FieldLabel htmlFor={`${record.id}-another`}>Use another card</FieldLabel></Field></RadioGroup></Field>{choice === "another" ? <CardFields id={record.id} values={values} onChange={setValues} nickname={false} /> : null}</FieldGroup> : null}
    {record.quote?.delivery ? <p className="text-sm">Delivery: {record.quote.delivery}</p> : null}
    {record.state === "preparing" && record.address && !editing ? <p className="flex items-center gap-2 text-sm"><Spinner />Checking stock and the final checkout total…</p> : null}
    {record.state === "unknown" ? <Alert><AlertDescription>The store has not confirmed the result yet. Your bot will check before any further purchase attempt.</AlertDescription></Alert> : null}
    {record.paymentLabel ? <p className="text-sm text-muted-foreground">Approved with {record.paymentLabel}</p> : null}
    {error ? <FieldError>{error}</FieldError> : null}
  </ActionCard>;
}

function Order({ record, onChange }: { record: ShoppingOrder; bot?: Bot; onChange: (r: ShoppingRecord) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function refresh() { setBusy(true); try { const data = await post<{ record: ShoppingRecord }>(`/api/shopping/${record.id}/refresh`, {}); onChange(data.record); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't refresh"); } finally { setBusy(false); } }
  return <ActionCard icon={record.shipments.length ? <Truck /> : <Check />} title={record.tracking === "complete" ? "Order complete" : record.shipments.length ? "Shipment updates" : "Order placed"} by={`${record.checkout.offer.store} · ${record.merchantOrderId}`} needs={false}
    actions={<><Button variant="outline" nativeButton={false} render={<a href={record.receiptUrl} target="_blank" rel="noopener noreferrer" />}>View receipt</Button><Button variant="outline" disabled={busy} onClick={() => void refresh()}>{busy ? <Spinner /> : null}Check for updates</Button></>}>
    <div className="flex items-center gap-3"><ProductPhoto small src={record.checkout.product.images[0]} title={record.checkout.product.title} /><div><p className="font-medium">{record.checkout.product.title}</p><p className="text-sm text-muted-foreground">{optionName(record.checkout.product, record.checkout.variantId)} · Qty {record.checkout.quantity}</p></div></div>
    <ActionRows rows={[{ label: "Payment", value: record.payment === "confirmed" ? "Confirmed" : record.payment === "failed" ? "Failed" : record.payment === "pending" ? "Pending" : "Not confirmed" }, { label: "Method", value: record.checkout.paymentLabel ?? "At merchant" }]} total={record.checkout.quote ? { label: "Order total", value: shoppingPrice(record.checkout.quote.total) } : undefined} />
    {!record.shipments.length ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Package />Waiting for shipment. Your bot will check the retailer and connected email.</p> : null}
    {record.shipments.map(s => {
      const stages = ["label_created", "shipped", "out_for_delivery", "delivered"];
      return <div key={s.id} className="flex flex-col gap-3"><Separator /><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{s.carrier}</p><Badge tone={s.stage === "exception" ? "warn" : "ok"}>{s.stage.replaceAll("_", " ")}</Badge></div><p className="text-sm">{s.estimatedArrival}</p><ol aria-label="Shipment progress" className="flex justify-between gap-2">{stages.map((stage, i) => <li key={stage} className="flex flex-1 flex-col gap-1 text-xs"><Badge tone={stages.indexOf(s.stage) >= i ? "ok" : "neutral"}>{i + 1}</Badge>{stage.replaceAll("_", " ")}</li>)}</ol><p className="text-sm">{s.detail}</p><p className="text-xs text-muted-foreground">{new Date(s.eventAt).toLocaleString()} · {s.trackingNumber}</p><Button variant="outline" nativeButton={false} render={<a href={s.url} target="_blank" rel="noopener noreferrer" />}>Track shipment<ExternalLink data-icon="inline-end" /></Button></div>;
    })}
    {record.tracking === "paused" ? <Alert><AlertDescription>Tracking paused. Reconnect the retailer or email account, then check for updates.</AlertDescription></Alert> : null}
    {record.lastCheckedAt ? <p className="text-xs text-muted-foreground">Last checked {new Date(record.lastCheckedAt).toLocaleString()}</p> : null}
    {error ? <FieldError>{error}</FieldError> : null}
  </ActionCard>;
}

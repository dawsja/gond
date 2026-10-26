"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { useInitialFocus } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

const ActionsContext = React.createContext<React.RefObject<AlertDialogPrimitive.Root.Actions | null> | null>(null)

function AlertDialog({ actionsRef, ...props }: AlertDialogPrimitive.Root.Props) {
  const own = React.useRef<AlertDialogPrimitive.Root.Actions | null>(null)
  const actions = actionsRef ?? own
  return (
    <ActionsContext.Provider value={actions}>
      <AlertDialogPrimitive.Root data-slot="alert-dialog" actionsRef={actions} {...props} />
    </ActionsContext.Provider>
  )
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      forceRender
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-[90] bg-black/60 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  initialFocus,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm"
}) {
  const { popup, initialFocus: focusOnOpen } = useInitialFocus()
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        ref={popup}
        initialFocus={initialFocus ?? focusOnOpen}
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "group/alert-dialog-content fixed top-1/2 left-1/2 z-[90] grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-3xl border border-primary-edge bg-card p-6 text-card-foreground shadow-subtle-3 duration-100 outline-none data-[size=sm]:max-w-sm data-[size=default]:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid place-items-start gap-1.5 text-left",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 pt-1 [&>*]:h-9 [&>*]:px-3.5 max-sm:[&>*]:h-11 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  tone,
  ...props
}: React.ComponentProps<"div"> & { tone?: "warn" | "destructive" }) {
  return (
    <div
      data-slot="alert-dialog-media"
      data-tone={tone}
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-full bg-muted *:[svg:not([class*='size-'])]:size-5",
        "data-[tone=warn]:bg-[color-mix(in_oklch,var(--tone-warn)_14%,transparent)] data-[tone=warn]:text-tone-warn",
        "data-[tone=destructive]:bg-[color-mix(in_oklch,var(--destructive)_14%,transparent)] data-[tone=destructive]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "font-heading text-lg leading-tight font-semibold wrap-anywhere",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "text-sm text-balance wrap-anywhere text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * The confirm's main button. With `onAction` it stays open while the work runs (a spinner, the
 * buttons held), closes once it's done, and on a failure stays open with the reason in a toast.
 */
function AlertDialogAction({
  className,
  variant,
  size = "lg",
  onAction,
  children,
  disabled,
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size"> & {
  onAction?: () => Promise<unknown>
}) {
  const actions = React.useContext(ActionsContext)
  const [pending, setPending] = React.useState(false)
  if (onAction) {
    const run = async () => {
      setPending(true)
      try {
        await onAction()
        actions?.current?.close()
      } catch (failure) {
        toast.add({ type: "error", title: failure instanceof Error && failure.message ? failure.message : "That didn't work. Try again." })
      } finally {
        setPending(false)
      }
    }
    return (
      <Button data-slot="alert-dialog-action" variant={variant} size={size} className={cn(className)} disabled={Boolean(disabled) || pending} onClick={() => void run()}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {children}
      </Button>
    )
  }
  return (
    <AlertDialogPrimitive.Close
      disabled={disabled}
      data-slot="alert-dialog-action"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    >
      {children}
    </AlertDialogPrimitive.Close>
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "lg",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}

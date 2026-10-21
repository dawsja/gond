"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/60 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// The header's and footer's dividers show only while something is scrolled under them.
function trackScrollEdges(el: HTMLDivElement | null) {
  if (!el) return
  const update = () => {
    el.toggleAttribute("data-above", el.scrollTop > 0)
    el.toggleAttribute("data-below", el.scrollTop + el.clientHeight < el.scrollHeight - 1)
  }
  update()
  el.addEventListener("scroll", update, { passive: true })
  const resized = new ResizeObserver(update)
  resized.observe(el)
  for (const child of el.children) resized.observe(child)
  return () => {
    el.removeEventListener("scroll", update)
    resized.disconnect()
  }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  bodyClassName,
  container,
  ...props
}: DialogPrimitive.Popup.Props &
  Pick<DialogPrimitive.Portal.Props, "container"> & {
  showCloseButton?: boolean
  overlayClassName?: string
  bodyClassName?: string
}) {
  return (
    <DialogPortal container={container}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(

          "fixed z-50 flex w-full flex-col overflow-hidden border border-primary-edge bg-card text-sm text-card-foreground shadow-subtle-3 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-3xl max-sm:border-b-0 max-sm:data-open:slide-in-from-bottom-4 max-sm:data-closed:slide-out-to-bottom-4",
          "sm:top-1/2 sm:left-1/2 sm:max-h-[calc(100dvh-3rem)] sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:data-open:zoom-in-95 sm:data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {/* Only the body scrolls: the close sits on the card and the footer sticks to the
            body's bottom, so neither scrolls out of reach. */}
        <div
          ref={trackScrollEdges}
          data-slot="dialog-body"
          className={cn(
            "group/dialog-body grid min-h-0 flex-1 gap-5 overflow-y-auto p-6 max-sm:pb-[max(24px,var(--safe-bottom))] has-[[data-slot=dialog-header]]:pt-0 has-[[data-slot=dialog-footer]]:pb-0",
            bodyClassName
          )}
        >
          {children}
        </div>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                className="absolute top-5 right-5 z-20 pointer-coarse:size-11"
                size="icon-lg"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("sticky top-0 z-10 -mx-6 -mb-3 flex flex-col gap-2 border-b border-transparent bg-card px-6 pt-6 pr-18 pb-3 group-data-above/dialog-body:border-border", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "sticky bottom-0 z-10 -mx-6 -mt-2 flex flex-col-reverse gap-2 border-t border-transparent bg-card px-6 pt-3 group-data-below/dialog-body:border-border pb-6 max-sm:pb-[max(24px,var(--safe-bottom))] sm:flex-row sm:justify-end [&>button]:h-9 [&>button]:px-3.5 max-sm:[&>button]:h-11",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-lg leading-tight font-semibold wrap-anywhere",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm wrap-anywhere text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}

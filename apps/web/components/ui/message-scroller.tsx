"use client"

import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ArrowDownIcon } from "lucide-react"

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(

        "min-w-0 shrink-0",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "default",
  size = "icon-xl",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon
          />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

// How far, in pixels, an edge takes to fade in: at the very top or bottom
// the fade is gone, so the first and last lines read in full.
const EDGE_FADE_PX = 48

/**
 * The text fades into the top and bottom edges while there is more to
 * scroll that way, under whatever floats there. Driven by the scroll
 * position, not CSS scroll timelines, which WebView2 and WebKitGTK drew as
 * a fade that never went away.
 */
function MessageScrollerEdges({ top, bottom }: { top: string; bottom: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ top: 0, bottom: 0 })
  React.useEffect(() => {
    const viewport = ref.current?.parentElement?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!viewport) return
    const read = () => {
      const below = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      const next = { top: Math.min(1, Math.max(0, viewport.scrollTop / EDGE_FADE_PX)), bottom: Math.min(1, Math.max(0, below / EDGE_FADE_PX)) }
      setEdges((now) => (now.top === next.top && now.bottom === next.bottom ? now : next))
    }
    Promise.resolve().then(read)
    viewport.addEventListener("scroll", read, { passive: true })
    const resized = new ResizeObserver(read)
    resized.observe(viewport)
    for (const child of viewport.children) resized.observe(child)
    return () => {
      viewport.removeEventListener("scroll", read)
      resized.disconnect()
    }
  }, [])
  const strip = "pointer-events-none absolute inset-x-0 z-10 from-background to-transparent transition-opacity duration-150"
  return (
    <div ref={ref} aria-hidden="true" className="contents">
      <div className={cn(strip, "top-0 bg-linear-to-b")} style={{ height: top, opacity: edges.top }} />
      <div className={cn(strip, "bottom-0 bg-linear-to-t")} style={{ height: bottom, opacity: edges.bottom }} />
    </div>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  MessageScrollerEdges,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}

"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg pointer-coarse:min-h-11 text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-primary-edge bg-transparent hover:border-primary-edge-focus hover:bg-primary",

        pill: "rounded-full border border-primary-edge bg-transparent hover:border-primary-edge-focus hover:bg-primary data-pressed:border-control data-pressed:bg-control data-pressed:text-control-foreground aria-pressed:border-control aria-pressed:bg-control aria-pressed:text-control-foreground",
        // A face to pick (a bot for a room): pressed shows its `tile-check`, nothing more.
        tile: "flex-col rounded-2xl bg-transparent hover:bg-muted aria-pressed:bg-transparent data-pressed:bg-transparent aria-pressed:hover:bg-muted [&_[data-slot=tile-face]]:relative [&_[data-slot=tile-check]]:hidden aria-pressed:[&_[data-slot=tile-check]]:flex",
        // A bell that is on or off: off sinks into the card, on is a pill like a field.
        bell: "rounded-full border border-transparent bg-muted text-muted-foreground hover:border-primary-edge-focus hover:bg-primary-hover hover:text-foreground data-pressed:border-primary-edge data-pressed:bg-primary data-pressed:text-foreground aria-pressed:border-primary-edge aria-pressed:bg-primary aria-pressed:text-foreground",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        tile: "h-auto w-full min-w-0 gap-1.5 px-1 py-2 whitespace-normal",
        icon: "size-10 shrink-0 pointer-coarse:size-11 [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      tone: {
        ok: "bg-[color-mix(in_oklch,var(--tone-ok)_14%,transparent)] text-tone-ok",
        warn: "bg-[color-mix(in_oklch,var(--tone-warn)_14%,transparent)] text-tone-warn",
        bad: "bg-[color-mix(in_oklch,var(--tone-bad)_14%,transparent)] text-tone-bad",
        info: "bg-[color-mix(in_oklch,var(--tone-info)_14%,transparent)] text-tone-info",
        neutral: "bg-bubble-inset text-muted-foreground",
      },
      // Grows to fit instead of clipping: one line is a pill (the radius is
      // half of h-5), more lines a rounded box with the icon on the first.
      // Baseline items let a badge in a sentence sit on the text's baseline.
      wrap: {
        true: "h-auto min-h-5 max-w-full items-baseline justify-start overflow-visible rounded-[0.625rem] text-left whitespace-normal [&>svg]:mt-0.5 [&>svg]:shrink-0 [&>svg]:self-start",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  tone,
  wrap,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, tone, wrap }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
      tone,
    },
  })
}

export { Badge, badgeVariants }

"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "relative inline-flex w-fit shrink-0 items-center justify-center border border-transparent font-medium whitespace-nowrap outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        muted: "bg-muted text-muted-foreground",
        up: "border-status-up/30 bg-status-up/10 text-status-up",
        degraded: "border-status-degraded/30 bg-status-degraded/10 text-status-degraded",
        down: "border-status-down/30 bg-status-down/10 text-status-down",
      },
      size: {
        default: "h-5.5 min-w-5.5 gap-1 rounded-sm px-1.5 py-0.5 text-xs leading-none",
        sm: "h-4.5 min-w-4.5 gap-1 rounded-sm px-1 py-0.25 text-[0.625rem] leading-none",
        lg: "h-6 min-w-6 gap-1.5 rounded-md px-2 py-1 text-xs leading-none",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }

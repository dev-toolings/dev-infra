"use client"

import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * `type="number"` is rendered as `type="text"` constrained by a pattern.
 *
 * The native number field costs more than it gives: the wheel changes the value
 * while scrolling, tiny spinners, `valueAsNumber` returns `NaN` on partial input,
 * and rendering differs per browser. `pattern` keeps the same shape constraint,
 * `inputMode` opens the numeric keypad on mobile, and non-matching keystrokes are
 * rejected instead of reaching the form as `NaN`.
 *
 * Bounds are no longer carried by `min`/`max` (inert on a text field) and must be
 * validated by the server. A field that needs the native step writes its own `<input>`.
 */
function numericPattern(
  min: React.ComponentProps<"input">["min"],
  step: React.ComponentProps<"input">["step"]
): { inputMode: "numeric" | "decimal"; pattern: string } {
  const decimal = step === "any" || (step !== undefined && !Number.isInteger(Number(step)))
  // The sign is only allowed when negative values are.
  const sign = min === undefined || Number(min) < 0 ? "-?" : ""
  // A comma is accepted while typing: some keyboard layouts produce it.
  return {
    inputMode: decimal ? "decimal" : "numeric",
    pattern: `${sign}${decimal ? "[0-9]*[.,]?[0-9]*" : "[0-9]*"}`,
  }
}

function Input({
  className,
  type,
  min,
  max,
  step,
  pattern,
  inputMode,
  onChange,
  ...props
}: React.ComponentProps<"input">) {
  const numeric = type === "number"
  const numericProps = numeric ? numericPattern(min, step) : null
  const effectivePattern = numeric ? (pattern ?? numericProps!.pattern) : pattern

  /**
   * Filtering keystrokes replaces the native field's protection: without it,
   * `type="text"` would let letters reach the caller's `Number()`, and a
   * controlled `value` of `NaN` breaks React rendering.
   */
  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (numeric && effectivePattern) {
        const value = event.target.value
        if (value !== "" && !new RegExp(`^(?:${effectivePattern})$`).test(value)) return
        // A typed comma is normalized before reaching the caller:
        // `Number('12,5')` is `NaN`, `Number('12.5')` is not.
        if (value.includes(",")) event.target.value = value.replace(",", ".")
      }
      onChange?.(event)
    },
    [numeric, effectivePattern, onChange]
  )

  return (
    <input
      type={numeric ? "text" : type}
      inputMode={numeric ? (inputMode ?? numericProps!.inputMode) : inputMode}
      pattern={effectivePattern}
      // On a text field `min`/`max`/`step` constrain nothing: emitting them
      // would suggest a native validation that does not exist.
      min={numeric ? undefined : min}
      max={numeric ? undefined : max}
      step={numeric ? undefined : step}
      onChange={handleChange}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 disabled:bg-input/50",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }

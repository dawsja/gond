"use client"

import { isDay } from "@gond/shared"
import { CalendarDays } from "lucide-react"
import { useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** A YYYY-MM-DD as a date in the browser's own calendar, so a day never slips across time zones. */
function dateOf(day: string): Date | undefined {
  if (!isDay(day)) return undefined
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return new Date(year, month - 1, date)
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

type DatePickerProps = {
  id?: string
  /** YYYY-MM-DD, or empty for none. */
  value: string
  onChange: (day: string) => void
  placeholder?: string
  fromYear: number
  toYear: number
  clearable?: boolean
  className?: string
  "aria-label"?: string
}

function DatePicker({ id, value, onChange, placeholder = "Pick a date", fromYear, toYear, clearable = false, className, "aria-label": label }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const selected = dateOf(value)
  const pick = (day: string) => {
    onChange(day)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        aria-label={label}
        data-slot="date-picker"
        className={cn(
          "flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border border-primary-edge bg-primary px-3 text-left text-base transition-colors outline-none hover:border-primary-edge-focus focus-visible:border-primary-edge-focus disabled:pointer-events-none disabled:opacity-50 data-popup-open:border-primary-edge-focus md:text-sm",
          className
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : placeholder}
        </span>
        <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar
          mode="single"
          captionLayout="dropdown"
          selected={selected}
          defaultMonth={selected}
          startMonth={new Date(fromYear, 0)}
          endMonth={new Date(toYear, 11)}
          onSelect={(date) => date && pick(dayOf(date))}
        />
        {clearable && value ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => pick("")}>
            Clear
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }

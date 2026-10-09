"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * A single headline number. `tone` colours values that warrant attention, e.g.
 * out-of-taxonomy labels (good when zero) and the gap signal (notable when
 * non-zero).
 */
export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: "default" | "good" | "warn" | "bad"
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4 space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums leading-none",
            tone === "good" && "text-emerald-600 dark:text-emerald-400",
            tone === "warn" && "text-amber-600 dark:text-amber-400",
            tone === "bad" && "text-red-600 dark:text-red-400",
          )}
        >
          {value}
        </div>
        {sub && (
          <div className="text-xs text-muted-foreground leading-snug">{sub}</div>
        )}
      </CardContent>
    </Card>
  )
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  )
}

/** Formats a 0..1 metric as a 3-decimal number, or a dash when absent. */
export function fmtMetric(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-"
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(3) : "-"
}

export function fmtInt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-"
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString() : "-"
}

export function fmtPct(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-"
  const n = Number(v)
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "-"
}

"use client"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fmtMetric } from "@/components/stat"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

/** Display order and description of the evaluation segments. */
export const SEGMENT_GROUPS: { name: string; label: string; blurb: string }[] = [
  {
    name: "CATEGORY",
    label: "By category",
    blurb:
      "Category of the gold primary label. NO_GOOD_MATCH is the gold encounters the reference labeler could not place in that taxonomy, which is a gap signal in its own right.",
  },
  {
    name: "LABEL_COUNT",
    label: "By gold label count",
    blurb: "Encounters with one concern vs two.",
  },
  {
    name: "NOTE_LENGTH",
    label: "By note length",
    blurb:
      "SHORT under 300 characters, LONG 700 and over. Short inputs are where regressions most often go unnoticed.",
  },
]

/** PASS / FAIL chip for an EVAL_GATE result string. */
export function GateBadge({ result }: { result?: string | null }) {
  if (!result) {
    return (
      <Badge variant="outline" className="text-[10px]">
        not evaluated
      </Badge>
    )
  }
  const pass = result === "PASS"
  return (
    <Badge
      className={cn(
        "text-[10px] whitespace-nowrap",
        pass
          ? "bg-emerald-600 hover:bg-emerald-600 text-white"
          : "bg-red-600 hover:bg-red-600 text-white",
      )}
      title={result}
    >
      {pass ? "PASS" : result.replace(/^FAIL:\s*/, "FAIL: ")}
    </Badge>
  )
}

/** Accuracy cell coloured the same way everywhere. */
export function AccCell({ v, bold = true }: { v: unknown; bold?: boolean }) {
  const n = Number(v)
  const has = v !== null && v !== undefined && v !== ""
  return (
    <span
      className={cn(
        "tabular-nums",
        bold && "font-semibold",
        has && n < 0.6 && "text-red-600 dark:text-red-400",
        has && n >= 0.9 && "text-emerald-600 dark:text-emerald-400",
      )}
    >
      {fmtMetric(v)}
    </span>
  )
}

/**
 * One segment dimension for a candidate, with the champion beside it when a
 * baseline is given. A drop larger than the gate's margin on a gated segment
 * is what EVAL_GATE fails on, so those rows are highlighted.
 */
export function SegmentCompareTable({
  rows,
  candidateEvalId,
  baselineEvalId,
  maxRegression,
  loading,
}: {
  rows: Row[]
  candidateEvalId: string
  baselineEvalId?: string | null
  maxRegression?: number | null
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-24" />
  const cand = rows.filter((r) => r.EVAL_ID === candidateEvalId)
  if (cand.length === 0)
    return <p className="text-xs text-muted-foreground py-4 text-center">No data.</p>
  const base = new Map(
    rows
      .filter((r) => baselineEvalId && r.EVAL_ID === baselineEvalId)
      .map((r) => [r.SEGMENT_VALUE, r]),
  )
  const margin = Number(maxRegression ?? 0.1)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Segment</TableHead>
          <TableHead className="w-12">n</TableHead>
          {baselineEvalId && <TableHead className="w-20">Champion</TableHead>}
          <TableHead className="w-20">Candidate</TableHead>
          {baselineEvalId && <TableHead className="w-16">Delta</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {cand.map((s) => {
          const b = base.get(s.SEGMENT_VALUE)
          const delta =
            b && b.SUBTHEME_ACCURACY != null && s.SUBTHEME_ACCURACY != null
              ? Number(s.SUBTHEME_ACCURACY) - Number(b.SUBTHEME_ACCURACY)
              : null
          const gated = s.GATED && (b ? b.GATED : true)
          const regressed = gated && delta !== null && delta < -margin
          return (
            <TableRow
              key={s.SEGMENT_VALUE}
              className={cn(regressed && "bg-red-50 dark:bg-red-950/30")}
            >
              <TableCell className="text-xs">
                <span className={s.SEGMENT_VALUE === "NO_GOOD_MATCH" ? "font-mono" : ""}>
                  {s.SEGMENT_VALUE}
                </span>
                {!gated && (
                  <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0">
                    reported only
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {s.N}
                {b && b.N !== s.N && (
                  <span className="text-[10px]"> (was {b.N})</span>
                )}
              </TableCell>
              {baselineEvalId && (
                <TableCell className="text-xs">
                  <AccCell v={b?.SUBTHEME_ACCURACY} bold={false} />
                </TableCell>
              )}
              <TableCell className="text-xs">
                <AccCell v={s.SUBTHEME_ACCURACY} />
              </TableCell>
              {baselineEvalId && (
                <TableCell
                  className={cn(
                    "text-xs tabular-nums",
                    delta !== null && delta > 0 && "text-emerald-600 dark:text-emerald-400",
                    delta !== null && delta < 0 && "text-red-600 dark:text-red-400",
                  )}
                >
                  {delta === null ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`}
                </TableCell>
              )}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

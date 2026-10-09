"use client"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react"
import type { ActionResult } from "@/components/use-action"

/**
 * Renders the outcome of a procedure call.
 *
 * Three distinct states, deliberately styled apart:
 *  - accepted: the procedure completed the request
 *  - REFUSED:  a guard rail blocked it. This is a feature of the pipeline, so
 *              it gets its own treatment rather than looking like a crash.
 *  - error:    the call actually failed
 */
export function ActionResultBanner({
  result,
}: {
  result: (ActionResult & { ok: boolean; proc: string }) | null
}) {
  if (!result) return null

  if (result.refused) {
    return (
      <Alert className="border-amber-500/50 text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/30">
        <ShieldAlert className="h-4 w-4 !text-amber-600" />
        <AlertDescription className="text-xs leading-relaxed">
          <span className="font-semibold">Guard rail fired.</span>{" "}
          {result.message}
        </AlertDescription>
      </Alert>
    )
  }

  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs leading-relaxed">
          {result.message}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert className="border-emerald-500/50 text-emerald-900 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-950/30">
      <CheckCircle2 className="h-4 w-4 !text-emerald-600" />
      <AlertDescription className="text-xs leading-relaxed font-mono">
        {result.message}
      </AlertDescription>
    </Alert>
  )
}

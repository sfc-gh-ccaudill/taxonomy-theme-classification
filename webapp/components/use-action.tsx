"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

export type ActionResult = {
  refused: boolean
  message: string
  rows?: Record<string, unknown>[]
}

/**
 * Calls an allowlisted procedure via /api/action.
 *
 * A REFUSED response (HTTP 409) is surfaced as a normal result rather than an
 * error, because a guard rail firing is an expected outcome to show the user,
 * not a stack trace.
 */
export function useAction(opts?: { invalidate?: string[][] }) {
  const qc = useQueryClient()
  const [last, setLast] = useState<
    (ActionResult & { ok: boolean; proc: string }) | null
  >(null)

  const mutation = useMutation({
    mutationFn: async (vars: {
      proc: string
      params: Record<string, unknown>
    }) => {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      })
      const body = await res.json()
      if (res.status === 409) {
        return { ok: false, refused: true, message: body.message, proc: vars.proc }
      }
      if (!res.ok) {
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      return {
        ok: true,
        refused: false,
        message: body.message as string,
        rows: body.rows as Record<string, unknown>[],
        proc: vars.proc,
      }
    },
    onSuccess: (data) => {
      setLast(data)
      for (const key of opts?.invalidate ?? []) {
        qc.invalidateQueries({ queryKey: key })
      }
    },
    onError: (err: Error) => {
      setLast({
        ok: false,
        refused: false,
        message: err.message,
        proc: "",
      })
    },
  })

  return {
    run: mutation.mutate,
    runAsync: mutation.mutateAsync,
    pending: mutation.isPending,
    last,
    clear: () => setLast(null),
  }
}

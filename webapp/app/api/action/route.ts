import { callProc, isRefusal, ArgumentError } from "@/lib/data"
import { procs, type ProcName } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * The only write endpoint in the app.
 *
 * Takes { proc, params } and refuses anything not in the `procs` allowlist, so
 * the UI cannot reach an arbitrary statement even if a request is forged. All
 * behaviour stays in the Snowflake procedures.
 *
 * Status codes:
 *   200  procedure ran and accepted the request
 *   409  procedure ran and REFUSED it (a guard rail fired; not an error)
 *   400  unknown procedure or bad arguments
 *   500  the call itself failed
 */
export async function POST(req: Request) {
  let proc: string | undefined
  try {
    const body = (await req.json()) as {
      proc?: string
      params?: Record<string, unknown>
    }
    proc = body.proc

    if (!proc || !(proc in procs)) {
      return Response.json(
        {
          error: `Unknown procedure '${proc ?? ""}'. Allowed: ${Object.keys(procs).join(", ")}`,
        },
        { status: 400 },
      )
    }

    const { message, rows } = await callProc(
      proc as ProcName,
      body.params ?? {},
    )

    if (isRefusal(message)) {
      return Response.json({ refused: true, message }, { status: 409 })
    }

    return Response.json({ refused: false, message, rows })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Procedure call failed"
    // A bad or missing argument is the caller's fault, not a server fault.
    if (e instanceof ArgumentError) {
      return Response.json({ error: msg }, { status: 400 })
    }
    console.error(new Date().toISOString(), `[api/action] ${proc} failed`, e)
    return Response.json({ error: msg }, { status: 500 })
  }
}

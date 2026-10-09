import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * Run history and live progress.
 *
 *   (no params)      -> the last 50 runs, production and evaluation
 *   ?runId=run_x     -> one run
 *   ?production=1    -> the champion and its backlog
 *
 * PIPELINE_RUN gets its row INSERTed at the start of RUN_CLASSIFIER, before
 * the AI_COMPLETE statement runs. So polling this while a run is in flight
 * shows it with run_status = RUNNING and a climbing duration, which is what
 * the progress panel reads.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runId = url.searchParams.get("runId")
    if (runId) {
      const rows = await read(reads.run(runId))
      return Response.json(rows[0] ?? null)
    }
    if (url.searchParams.get("production")) {
      const rows = await read(reads.productionStatus())
      return Response.json(rows[0] ?? null)
    }
    return Response.json(await read(reads.runs()))
  } catch (e) {
    console.error(new Date().toISOString(), "[api/runs] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load runs" },
      { status: 500 },
    )
  }
}

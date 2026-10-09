import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/** Labels for one run, plus its errored encounters and theme volume. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runId = url.searchParams.get("runId")
    if (!runId) {
      return Response.json({ error: "runId is required" }, { status: 400 })
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? 100)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
      : 100

    const [labels, errors] = await Promise.all([
      read(reads.classifications(runId, limit)),
      read(reads.runErrors(runId)),
    ])
    return Response.json({ labels, errors })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/classifications] failed", e)
    return Response.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to load classifications",
      },
      { status: 500 },
    )
  }
}

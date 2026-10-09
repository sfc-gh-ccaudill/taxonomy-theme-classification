import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/** Encounter browser. ?filter=ALL|GOLD|UNLABELED|<test scenario>&search=...&limit=50 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const filter = url.searchParams.get("filter") ?? "ALL"
    const search = url.searchParams.get("search") ?? ""
    const limitRaw = Number(url.searchParams.get("limit") ?? 40)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 40

    const rows = await read(reads.notes({ filter, search, limit }))
    return Response.json(rows)
  } catch (e) {
    console.error(new Date().toISOString(), "[api/notes] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load notes" },
      { status: 500 },
    )
  }
}

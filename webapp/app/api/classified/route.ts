import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

const CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW"])

/**
 * The production output for the Explore page's "after classification" view.
 *
 *   ?summary=1   -> headline totals and the category > theme > subtheme counts
 *   otherwise    -> the encounter browser, filtered by
 *                   category, theme, subtheme, confidence, multi=1, search, limit
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const p = url.searchParams

    if (p.get("summary")) {
      const [totals, distribution] = await Promise.all([
        read(reads.classifiedTotals()),
        read(reads.classifiedDistribution()),
      ])
      return Response.json({ totals: totals[0] ?? {}, distribution })
    }

    const confidence = p.get("confidence") ?? ""
    if (confidence && !CONFIDENCE.has(confidence)) {
      return Response.json(
        { error: "confidence must be HIGH, MEDIUM or LOW" },
        { status: 400 },
      )
    }
    const limitRaw = Number(p.get("limit") ?? 40)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 40

    const rows = await read(
      reads.classifiedEncounters({
        category: p.get("category") ?? "",
        theme: p.get("theme") ?? "",
        subtheme: p.get("subtheme") ?? "",
        confidence,
        multiLabel: p.get("multi") === "1",
        search: p.get("search") ?? "",
        limit,
      }),
    )
    return Response.json(rows)
  } catch (e) {
    console.error(new Date().toISOString(), "[api/classified] failed", e)
    return Response.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to load classified encounters",
      },
      { status: 500 },
    )
  }
}

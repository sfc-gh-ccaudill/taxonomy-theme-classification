import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * Corpus composition for the Explore page: headline totals from the pipeline
 * schema, plus the TEST DATA scenario mix.
 */
export async function GET() {
  try {
    const [totals, scenarios] = await Promise.all([
      read(reads.corpusTotals()),
      read(reads.testScenarioMix()),
    ])
    return Response.json({ totals: totals[0] ?? {}, scenarios })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/corpus] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load corpus" },
      { status: 500 },
    )
  }
}

import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * Classifier config registry.
 *
 *   (no params)            -> all configs with the runs and scores they produced
 *   ?configName=haiku_...  -> one config including its full prompt_template
 */
export async function GET(req: Request) {
  try {
    const configName = new URL(req.url).searchParams.get("configName")
    if (configName) {
      const rows = await read(reads.configDetail(configName))
      return Response.json(rows[0] ?? null)
    }
    return Response.json(await read(reads.configs()))
  } catch (e) {
    console.error(new Date().toISOString(), "[api/configs] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load configs" },
      { status: 500 },
    )
  }
}

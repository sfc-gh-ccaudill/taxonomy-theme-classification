import { read } from "@/lib/data"
import { reads } from "@/lib/queries"

export const dynamic = "force-dynamic"

/**
 * Taxonomy registry.
 *
 *   (no params)                -> versions (with dependent configs, gold, latest
 *                                 eval) + the production contract
 *   ?versionId=v001            -> nodes for one version
 *   ?rendered=v002             -> rubric size + enum response_format for any
 *                                 version, drafts included
 *   ?from=v001&to=v002         -> diff between two versions
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const versionId = url.searchParams.get("versionId")
    const rendered = url.searchParams.get("rendered")
    const from = url.searchParams.get("from")
    const to = url.searchParams.get("to")

    if (from && to) {
      return Response.json({ diff: await read(reads.taxonomyDiff(from, to)) })
    }

    if (rendered) {
      const rows = await read(reads.taxonomyRendered(rendered))
      return Response.json({ rendered: rows[0] ?? null })
    }

    if (versionId) {
      return Response.json({ nodes: await read(reads.taxonomyNodes(versionId)) })
    }

    const [versions, active] = await Promise.all([
      read(reads.taxonomyVersions()),
      read(reads.taxonomyActive()),
    ])
    return Response.json({ versions, active: active[0] ?? null })
  } catch (e) {
    console.error(new Date().toISOString(), "[api/taxonomy] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load taxonomy" },
      { status: 500 },
    )
  }
}

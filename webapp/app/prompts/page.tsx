"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useEffect, useState } from "react"
import { PageHeader } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt } from "@/components/stat"
import { SOURCES } from "@/lib/queries"
import { MODELS } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import { AccCell, GateBadge } from "@/components/eval-widgets"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ArrowRight, Loader2, Save, FlaskConical, CircleAlert } from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

const field =
  "h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"

export default function PromptsPage() {
  const [selected, setSelected] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editModel, setEditModel] = useState("claude-haiku-4-5")
  const [editMaxLabels, setEditMaxLabels] = useState(2)
  const [editTaxonomy, setEditTaxonomy] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editTemplate, setEditTemplate] = useState("")
  const [previewLimit, setPreviewLimit] = useState(5)
  const [previewTaxonomy, setPreviewTaxonomy] = useState("")
  const [preview, setPreview] = useState<Row[] | null>(null)

  const configs = useQuery<Row[]>({
    queryKey: ["configs"],
    queryFn: () => fetch("/api/configs").then((r) => r.json()),
  })
  const tax = useQuery<{ versions: Row[]; active: Row | null }>({
    queryKey: ["taxonomy"],
    queryFn: () => fetch("/api/taxonomy").then((r) => r.json()),
  })

  const list = Array.isArray(configs.data) ? configs.data : []
  const champion = list.find((c) => c.IS_ACTIVE)
  const currentName = selected ?? champion?.CONFIG_NAME ?? list[0]?.CONFIG_NAME
  const versions = (tax.data?.versions ?? []).filter((v) => v.STATUS !== "REJECTED")

  const detail = useQuery<Row | null>({
    queryKey: ["config-detail", currentName],
    queryFn: () =>
      fetch(`/api/configs?configName=${encodeURIComponent(currentName)}`).then((r) => r.json()),
    enabled: !!currentName,
  })

  // Seed the editor from the selected config, as a starting point to fork.
  useEffect(() => {
    if (!detail.data) return
    setEditTemplate(String(detail.data.PROMPT_TEMPLATE ?? ""))
    setEditModel(String(detail.data.MODEL ?? "claude-haiku-4-5"))
    setEditMaxLabels(Math.min(Number(detail.data.MAX_LABELS ?? 2), 2))
    setEditTaxonomy(
      String(detail.data.TAXONOMY_VERSION_ID ?? tax.data?.active?.VERSION_ID ?? ""),
    )
    setEditName("")
    setEditNotes("")
    setPreview(null)
    setPreviewTaxonomy("")
  }, [detail.data, tax.data?.active?.VERSION_ID])

  const action = useAction({
    invalidate: [["configs"], ["config-detail"], ["eval"], ["taxonomy"]],
  })

  const hasTaxonomyPlaceholder = editTemplate.includes("{{TAXONOMY}}")
  const hasNotePlaceholder = editTemplate.includes("{{NOTE}}")
  const placeholdersOk = hasTaxonomyPlaceholder && hasNotePlaceholder
  const promptEdited = editTemplate !== String(detail.data?.PROMPT_TEMPLATE ?? "")
  const taxonomyChanged =
    editTaxonomy !== String(detail.data?.TAXONOMY_VERSION_ID ?? "")
  const editTaxStatus = versions.find((v) => v.VERSION_ID === editTaxonomy)?.STATUS

  async function runPreview() {
    const res = await action.runAsync({
      proc: "previewPrompt",
      params: {
        configName: currentName,
        taxonomyVersionId: previewTaxonomy,
        limit: previewLimit,
      },
    })
    if (res.ok && res.rows) setPreview(res.rows)
  }

  return (
    <div>
      <PageHeader
        title="Prompts and configs"
        description="A config is the complete recipe for a label: prompt template, model, and the taxonomy version it classifies against. That bundle is what gets evaluated and promoted, so every score belongs to one exact prompt and taxonomy combination. Configs are immutable: a change is a new config, forked from an existing one."
        objects={SOURCES.prompts}
      >
        <Link href="/evaluate">
          <Button size="sm" variant="outline">
            Evaluate candidates <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </Link>
      </PageHeader>

      <div className="space-y-4">
        <ActionResultBanner result={action.last} />

        {champion && (
          <StatGrid>
            <Stat
              label="Champion (in production)"
              value={<span className="text-base font-mono">{champion.CONFIG_NAME}</span>}
              tone="good"
              sub={`${champion.MODEL} on taxonomy ${champion.TAXONOMY_VERSION_ID}`}
            />
            <Stat
              label="Rubric size"
              value={`${fmtInt(champion.RUBRIC_CHARS)} chars`}
              sub="plus the taxonomy text, on every call"
            />
            <Stat
              label="Candidates"
              value={fmtInt(list.filter((c) => !c.IS_ACTIVE && !c.IS_TEMPLATE).length)}
              sub={`${list.filter((c) => c.IS_TEMPLATE).length} template(s) to fork from`}
            />
            <Stat
              label="Champion latest eval"
              value={<AccCell v={champion.LATEST_SUBTHEME_ACCURACY} />}
              sub={champion.GATE_RESULT ?? "not evaluated yet"}
            />
          </StatGrid>
        )}

        {/* Registry */}
        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Config registry</CardTitle>
            <p className="text-xs text-muted-foreground">
              Click a row to fork it in the editor below. Existing labels keep the
              config that produced them, so nothing here ever rewrites history.
            </p>
          </CardHeader>
          <CardContent>
            {configs.isLoading ? (
              <Skeleton className="h-28" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Config</TableHead>
                    <TableHead className="w-36">Model</TableHead>
                    <TableHead className="w-32">Taxonomy</TableHead>
                    <TableHead className="w-20">Rubric</TableHead>
                    <TableHead className="w-20">Latest acc.</TableHead>
                    <TableHead className="w-40">Gate</TableHead>
                    <TableHead className="w-24">Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((c) => (
                    <TableRow
                      key={c.CONFIG_NAME}
                      className={cn(
                        "cursor-pointer",
                        currentName === c.CONFIG_NAME && "bg-primary/5",
                      )}
                      onClick={() => setSelected(c.CONFIG_NAME)}
                    >
                      <TableCell className="text-xs font-mono font-semibold">
                        {c.CONFIG_NAME}
                        {c.NOTES && (
                          <div className="font-sans font-normal text-[10px] text-muted-foreground mt-0.5 max-w-sm leading-snug">
                            {c.NOTES}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono">{c.MODEL}</TableCell>
                      <TableCell className="text-xs font-mono">
                        {c.TAXONOMY_VERSION_ID ?? "-"}
                        {c.TAXONOMY_STATUS && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {c.TAXONOMY_STATUS.toLowerCase()}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {fmtInt(c.RUBRIC_CHARS)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <AccCell v={c.LATEST_SUBTHEME_ACCURACY} />
                      </TableCell>
                      <TableCell>
                        {!c.IS_TEMPLATE && <GateBadge result={c.GATE_RESULT} />}
                      </TableCell>
                      <TableCell>
                        {c.IS_ACTIVE ? (
                          <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600">
                            champion
                          </Badge>
                        ) : c.IS_TEMPLATE ? (
                          <Badge variant="secondary" className="text-[10px]">
                            template
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            candidate
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Editor + preview */}
        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Fork <span className="font-mono">{currentName}</span>
                {promptEdited && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    prompt modified
                  </Badge>
                )}
                {taxonomyChanged && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    taxonomy changed
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Change the prompt, the model, the taxonomy, or any mix, then
                register it as a new candidate. Registering never changes
                production. A prompt-only change reuses the gold labels its
                taxonomy already has, so evaluating it costs one gold run; a new
                taxonomy pays for one gold-labeling pass first.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="new config name, e.g. haiku_v2_tax_v002"
                  className={cn(field, "flex-1 min-w-48 font-mono")}
                />
                <select
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  className={cn(field, "font-mono")}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  value={editTaxonomy}
                  onChange={(e) => setEditTaxonomy(e.target.value)}
                  className={cn(field, "font-mono")}
                  title="The taxonomy version this config classifies against"
                >
                  {versions.map((v) => (
                    <option key={v.VERSION_ID} value={v.VERSION_ID}>
                      {v.VERSION_ID} ({v.STATUS.toLowerCase()})
                    </option>
                  ))}
                </select>
                <select
                  value={editMaxLabels}
                  onChange={(e) => setEditMaxLabels(Number(e.target.value))}
                  className={field}
                >
                  <option value={1}>1 label</option>
                  <option value={2}>2 labels</option>
                </select>
              </div>

              <input
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="what changed and why (stored with the config)"
                className={cn(field, "w-full")}
              />

              <textarea
                value={editTemplate}
                onChange={(e) => setEditTemplate(e.target.value)}
                spellCheck={false}
                className="w-full h-72 rounded-md border border-input bg-background p-2.5 text-[11px] font-mono leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1.5 text-[11px]">
                  <Badge
                    variant={hasTaxonomyPlaceholder ? "secondary" : "destructive"}
                    className="font-mono text-[10px]"
                  >
                    {hasTaxonomyPlaceholder ? "✓" : "✗"} {"{{TAXONOMY}}"}
                  </Badge>
                  <Badge
                    variant={hasNotePlaceholder ? "secondary" : "destructive"}
                    className="font-mono text-[10px]"
                  >
                    {hasNotePlaceholder ? "✓" : "✗"} {"{{NOTE}}"}
                  </Badge>
                  <span className="text-muted-foreground self-center">
                    {fmtInt(editTemplate.length)} chars
                  </span>
                </div>
                <Button
                  size="sm"
                  className="h-7 text-[11px] ml-auto"
                  disabled={action.pending || !editName.trim() || !placeholdersOk || !editTaxonomy}
                  onClick={() =>
                    action.run({
                      proc: "registerConfig",
                      params: {
                        configName: editName.trim(),
                        baseConfig: currentName,
                        model: editModel,
                        promptTemplate: editTemplate,
                        maxLabels: editMaxLabels,
                        taxonomyVersionId: editTaxonomy,
                        notes: editNotes.trim() || `Forked from ${currentName} in the app.`,
                      },
                    })
                  }
                >
                  {action.pending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3 mr-1" />
                  )}
                  Register candidate
                </Button>
              </div>

              {editTaxStatus === "DRAFT" && (
                <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/30">
                  <AlertDescription className="text-xs text-amber-900 dark:text-amber-200">
                    {editTaxonomy} is still a DRAFT. You can register and preview
                    against it, but EVALUATE_CONFIG will refuse until it is locked
                    on the Taxonomy page, because an evaluation of something that
                    can still change is not evidence for shipping it.
                  </AlertDescription>
                </Alert>
              )}

              {!placeholdersOk && (
                <Alert variant="destructive">
                  <CircleAlert className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Both placeholders are required. Without {"{{TAXONOMY}}"} the
                    model never sees the taxonomy; without {"{{NOTE}}"} every
                    encounter gets an identical prompt. REGISTER_CONFIG enforces
                    this too, so this check is a convenience rather than the
                    guard rail.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Preview</CardTitle>
              <p className="text-xs text-muted-foreground">
                Runs the saved <span className="font-mono">{currentName}</span> on a
                handful of encounters and writes nothing. Point it at any
                taxonomy, drafts included, to sanity-check an edit before locking
                or paying for an evaluation.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <select
                  value={previewTaxonomy}
                  onChange={(e) => setPreviewTaxonomy(e.target.value)}
                  className={cn(field, "flex-1 h-7 font-mono")}
                >
                  <option value="">
                    {detail.data?.TAXONOMY_VERSION_ID
                      ? `its own taxonomy (${detail.data.TAXONOMY_VERSION_ID})`
                      : "pick a taxonomy (template)"}
                  </option>
                  {versions.map((v) => (
                    <option key={v.VERSION_ID} value={v.VERSION_ID}>
                      {v.VERSION_ID} ({v.STATUS.toLowerCase()})
                    </option>
                  ))}
                </select>
                <select
                  value={previewLimit}
                  onChange={(e) => setPreviewLimit(Number(e.target.value))}
                  className={cn(field, "h-7")}
                >
                  {[3, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] w-full"
                disabled={action.pending || !currentName}
                onClick={runPreview}
              >
                {action.pending ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <FlaskConical className="h-3 w-3 mr-1" />
                )}
                Preview on {previewLimit} encounters
              </Button>

              {preview && (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {preview.map((p, i) =>
                    p.MESSAGE ? (
                      <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
                        {String(p.MESSAGE)}
                      </p>
                    ) : (
                      <div key={i} className="rounded-md border border-border p-2 text-xs">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-mono text-[10px]">
                            {String(p.ENCOUNTER_ID ?? "")}
                          </span>
                          <span className="font-mono text-[9px] text-muted-foreground">
                            {String(p.TAXONOMY_VERSION_ID ?? "")}
                          </span>
                          {p.IS_GOLD === true && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
                              GOLD
                            </Badge>
                          )}
                          {p.CONFIDENCE && (
                            <Badge className="text-[9px] px-1 py-0">{String(p.CONFIDENCE)}</Badge>
                          )}
                        </div>
                        {p.ERROR ? (
                          <p className="text-red-600 dark:text-red-400 text-[10px] font-mono">
                            {String(p.ERROR)}
                          </p>
                        ) : (
                          <>
                            <p className="font-mono text-[10px]">
                              {String(p.PRIMARY_SUBTHEME ?? "")}
                              {p.SECONDARY_SUBTHEME && p.SECONDARY_SUBTHEME !== "NONE" && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  + {String(p.SECONDARY_SUBTHEME)}
                                </span>
                              )}
                            </p>
                            <p className="text-[10px] text-muted-foreground italic mt-0.5 leading-snug">
                              {String(p.EVIDENCE ?? "")}
                            </p>
                          </>
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}

              <p className="border-t border-border pt-2.5 text-[11px] text-muted-foreground leading-snug">
                A smaller, lower-cost model under a strict enum is a sensible
                default, because the rubric does most of the work: a clearly
                written decision policy usually moves accuracy far more than
                switching models.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

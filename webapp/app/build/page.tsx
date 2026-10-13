"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { PageHeader } from "@/components/sql-source"
import { fmtInt } from "@/components/stat"
import { SOURCES } from "@/lib/queries"
import { DEMO_USER, MODELS, TAXONOMY_MODEL } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AccCell } from "@/components/eval-widgets"
import {
  ArrowRight,
  ChevronRight,
  FlaskConical,
  GitFork,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { TaxonomyEditor } from "./_components/taxonomy-editor"

type Row = Record<string, any>

const STATUS_STYLE: Record<string, string> = {
  APPROVED: "bg-emerald-600 hover:bg-emerald-600 text-white",
  LOCKED: "bg-blue-600 hover:bg-blue-600 text-white",
  DRAFT: "bg-amber-500 hover:bg-amber-500 text-white",
  REJECTED: "bg-red-600 hover:bg-red-600 text-white",
  SUPERSEDED: "bg-muted text-muted-foreground",
}

const STATUS_BLURB: Record<string, string> = {
  DRAFT: "Editable. Lock it when you're done so a config on it can be evaluated.",
  LOCKED: "Frozen and ready to evaluate. Fork it to make further changes.",
  APPROVED: "In production through the champion config. Fork it to make changes.",
  SUPERSEDED: "Was in production. Fork it to build on it.",
}

/** Statuses EVALUATE_CONFIG accepts. A DRAFT can still change, so it can't be scored. */
const EVALUABLE = ["LOCKED", "APPROVED", "SUPERSEDED"]

/** Same rule REGISTER_CONFIG enforces. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

const field =
  "h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"

/** "claude-haiku-4-5" -> "haiku", "openai-gpt-5.2" -> "openai": a short tag for suggested names. */
function modelTag(model: string) {
  return model.replace(/^claude-/, "").split("-")[0].replace(/[^A-Za-z0-9_.]/g, "")
}

/**
 * Config builder, page 2. The taxonomy is the main workspace; the prompt and
 * model sit in a collapsed section underneath; the bottom panel saves the
 * combination as a new config in the registry and hands it to evaluation.
 * Every write is one of the allowlisted procedures, so the same guard rails
 * apply as when they're called from SQL.
 */
export default function BuildConfigPage() {
  const [baseName, setBaseName] = useState<string | null>(null)
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [taxVersion, setTaxVersion] = useState("")
  const [model, setModel] = useState("claude-haiku-4-5")
  const [maxLabels, setMaxLabels] = useState(2)
  const [template, setTemplate] = useState("")
  const [promptOpen, setPromptOpen] = useState(false)
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)
  const [notes, setNotes] = useState("")
  const [registered, setRegistered] = useState<string | null>(null)
  const [preview, setPreview] = useState<Row[] | null>(null)
  const [showContract, setShowContract] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

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
  const base = baseName ?? champion?.CONFIG_NAME ?? list[0]?.CONFIG_NAME ?? null
  const versions = (tax.data?.versions ?? []).filter((v) => v.STATUS !== "REJECTED")

  const detail = useQuery<Row | null>({
    queryKey: ["config-detail", base],
    queryFn: () => fetch(`/api/configs?configName=${encodeURIComponent(base!)}`).then((r) => r.json()),
    enabled: !!base,
  })
  const baseDetail = detail.data ?? null

  // Seed from the starting config, once per pick. Later refetches (after a
  // register, say) must not overwrite the user's edits.
  useEffect(() => {
    if (!baseDetail || baseDetail.CONFIG_NAME === seededFor) return
    setSeededFor(baseDetail.CONFIG_NAME)
    setTaxVersion(String(baseDetail.TAXONOMY_VERSION_ID ?? tax.data?.active?.VERSION_ID ?? ""))
    setModel(String(baseDetail.MODEL ?? "claude-haiku-4-5"))
    setMaxLabels(Math.min(Number(baseDetail.MAX_LABELS ?? 2), 2))
    setTemplate(String(baseDetail.PROMPT_TEMPLATE ?? ""))
  }, [baseDetail, seededFor, tax.data?.active?.VERSION_ID])

  const taxRow = versions.find((v) => v.VERSION_ID === taxVersion)
  const taxStatus: string | undefined = taxRow?.STATUS
  const taxReady = !!taxStatus && EVALUABLE.includes(taxStatus)
  const isDraft = taxStatus === "DRAFT"

  const diff = useQuery<{ diff: Row[] }>({
    queryKey: ["taxonomy-diff", taxRow?.PARENT_VERSION_ID, taxVersion],
    queryFn: () =>
      fetch(
        `/api/taxonomy?from=${encodeURIComponent(taxRow!.PARENT_VERSION_ID)}&to=${encodeURIComponent(taxVersion)}`,
      ).then((r) => r.json()),
    enabled: !!taxRow?.PARENT_VERSION_ID,
  })
  const changes = diff.data?.diff ?? []

  const rendered = useQuery<{ rendered: Row | null }>({
    queryKey: ["taxonomy-rendered", taxVersion],
    queryFn: () =>
      fetch(`/api/taxonomy?rendered=${encodeURIComponent(taxVersion)}`).then((r) => r.json()),
    enabled: !!taxVersion && showContract,
  })
  const contract = rendered.data?.rendered?.RESPONSE_FORMAT

  // Separate so the taxonomy and save panels each show their own outcome.
  const taxAction = useAction({
    invalidate: [["taxonomy"], ["taxonomy-nodes"], ["taxonomy-diff"], ["configs"]],
  })
  const saveAction = useAction({
    invalidate: [["configs"], ["config-detail"], ["taxonomy"], ["eval"]],
  })

  const hasTax = template.includes("{{TAXONOMY}}")
  // Until the starting config has been copied in, every comparison below is meaningless.
  const seeded = !!baseDetail && seededFor === baseDetail.CONFIG_NAME
  const hasNote = template.includes("{{NOTE}}")
  const placeholdersOk = hasTax && hasNote
  const baseTemplate = String(baseDetail?.PROMPT_TEMPLATE ?? "")
  const baseLabels = Math.min(Number(baseDetail?.MAX_LABELS ?? 2), 2)
  const promptEdited = template !== baseTemplate
  const taxChanged = taxVersion !== String(baseDetail?.TAXONOMY_VERSION_ID ?? "")
  const modelChanged = model !== String(baseDetail?.MODEL ?? "")
  const labelsChanged = maxLabels !== baseLabels
  const anyChange = promptEdited || taxChanged || modelChanged || labelsChanged
  const charDelta = template.length - baseTemplate.length

  const existingNames = useMemo(() => new Set(list.map((c) => String(c.CONFIG_NAME))), [list])
  const suggested = useMemo(() => {
    const stem = `${modelTag(model)}_${taxVersion || "tax"}`
    let k = 1
    while (existingNames.has(`${stem}_${k}`)) k++
    return `${stem}_${k}`
  }, [model, taxVersion, existingNames])
  // Track the suggestion until the user types their own name.
  const configName = (nameTouched ? name : suggested).trim()
  const nameTaken = existingNames.has(configName)
  const nameOk = NAME_RE.test(configName) && !nameTaken
  const canRegister = !registered && taxReady && placeholdersOk && anyChange && nameOk
  const goldLabeled = Number(taxRow?.GOLD_LABELED ?? 0)

  /** What still blocks saving, in the order a user would fix it. */
  const blockers: string[] = []
  if (isDraft) blockers.push(`Lock ${taxVersion} so the config can be evaluated`)
  if (!placeholdersOk) blockers.push("The prompt needs both {{TAXONOMY}} and {{NOTE}}")
  if (!anyChange) blockers.push(`Change the taxonomy, prompt or model; right now it matches ${base}`)
  if (configName && !nameOk)
    blockers.push(nameTaken ? `${configName} already exists` : "Use 1-64 letters, digits, _ . or -")

  function pickBase(cfg: string) {
    if (cfg === base) return
    setBaseName(cfg)
    setSeededFor(null)
    setRegistered(null)
    setPreview(null)
    saveAction.clear()
  }

  async function fork() {
    const res = await taxAction.runAsync({
      proc: "forkTaxonomy",
      params: { sourceVersionId: taxVersion, createdBy: DEMO_USER, notes: "Forked in the config builder." },
    })
    const m = res.ok ? /DRAFT (v\d+)/.exec(res.message) : null
    if (m) setTaxVersion(m[1])
  }

  function lock() {
    taxAction.run({ proc: "lockTaxonomy", params: { versionId: taxVersion, lockedBy: DEMO_USER } })
  }

  /** An LLM drafts a whole new taxonomy from DISCOVERY_SAMPLE; it lands as a DRAFT. */
  async function propose() {
    const res = await taxAction.runAsync({
      proc: "proposeTaxonomy",
      params: { serviceLine: "READMISSIONS", model: TAXONOMY_MODEL, createdBy: DEMO_USER },
    })
    const m = res.ok ? /DRAFT (v\d+)/.exec(res.message) : null
    if (m) setTaxVersion(m[1])
  }

  async function reject() {
    if (!window.confirm(`Reject ${taxVersion}? It stays in the registry for the record but can't be edited, locked or evaluated.`))
      return
    const res = await taxAction.runAsync({
      proc: "rejectTaxonomy",
      params: { versionId: taxVersion, reviewer: DEMO_USER, reason: "Rejected in the config builder." },
    })
    // Rejected versions drop out of the tabs, so fall back to the starting config's.
    if (res.ok) setTaxVersion(String(baseDetail?.TAXONOMY_VERSION_ID ?? tax.data?.active?.VERSION_ID ?? ""))
  }

  async function register() {
    const res = await saveAction.runAsync({
      proc: "registerConfig",
      params: {
        configName,
        baseConfig: base ?? "",
        model,
        promptTemplate: template,
        maxLabels,
        taxonomyVersionId: taxVersion,
        notes: notes.trim() || `Built from ${base} in the config builder.`,
      },
    })
    if (res.ok) setRegistered(configName)
  }

  async function runPreview() {
    if (!registered) return
    const res = await saveAction.runAsync({
      proc: "previewPrompt",
      params: { configName: registered, taxonomyVersionId: "", limit: 5 },
    })
    if (res.ok && res.rows) setPreview(res.rows)
  }

  function startOver() {
    setRegistered(null)
    setPreview(null)
    setName("")
    setNameTouched(false)
    setNotes("")
    setSeededFor(null)
    saveAction.clear()
    taxAction.clear()
  }

  return (
    <div>
      <PageHeader
        title="Config Builder"
        description="Propose or edit a taxonomy, adjust the prompt if you need to, then save the combination as a new config and take it to evaluation. Nothing on this page changes production."
        objects={SOURCES.build}
      >
        <label className="text-xs text-muted-foreground">Start from</label>
        <select
          value={base ?? ""}
          onChange={(e) => pickBase(e.target.value)}
          className={cn(field, "font-mono")}
          title="Copies this config's taxonomy, prompt and model as the starting point"
        >
          {list.map((c) => (
            <option key={c.CONFIG_NAME} value={c.CONFIG_NAME}>
              {c.CONFIG_NAME}
              {c.IS_ACTIVE ? " (champion)" : c.IS_TEMPLATE ? " (template)" : ""}
            </option>
          ))}
        </select>
      </PageHeader>

      <div className="space-y-4">
        {/* Taxonomy workspace */}
        <Card className="shadow-none">
          <CardHeader className="pb-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Taxonomy</CardTitle>
              <div className="flex flex-wrap gap-1 ml-2" role="tablist" aria-label="Taxonomy version">
                {tax.isLoading ? (
                  <Skeleton className="h-7 w-40" />
                ) : (
                  versions.map((v) => (
                    <button
                      key={v.VERSION_ID}
                      role="tab"
                      aria-selected={taxVersion === v.VERSION_ID}
                      onClick={() => setTaxVersion(v.VERSION_ID)}
                      title={versionSummary(v)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-mono transition-colors",
                        taxVersion === v.VERSION_ID
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      {v.VERSION_ID}
                      <StatusBadge status={v.STATUS} />
                    </button>
                  ))
                )}
              </div>
              <div className="ml-auto flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={taxAction.pending}
                  onClick={propose}
                  title={`${TAXONOMY_MODEL} drafts a whole new taxonomy from DISCOVERY_SAMPLE (about a minute)`}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                  Propose from sample
                </Button>
                {(isDraft || taxStatus === "LOCKED") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={taxAction.pending}
                    onClick={reject}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                )}
                {isDraft ? (
                  <Button size="sm" className="h-8 text-xs" disabled={taxAction.pending} onClick={lock}>
                    <Lock className="h-3.5 w-3.5 mr-1" />
                    Lock {taxVersion}
                  </Button>
                ) : (
                  taxRow && (
                    <Button
                      size="sm"
                      className="h-8 text-xs"
                      disabled={taxAction.pending}
                      onClick={fork}
                      title="Copy this version into a new DRAFT you can edit"
                    >
                      <GitFork className="h-3.5 w-3.5 mr-1" />
                      Fork {taxVersion} to edit
                    </Button>
                  )
                )}
              </div>
            </div>

            {taxRow && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{STATUS_BLURB[taxRow.STATUS]}</span>
                <span>
                  {fmtInt(taxRow.SUBTHEMES)} subthemes, {fmtInt(taxRow.THEMES)} themes,{" "}
                  {fmtInt(taxRow.CATEGORIES)} categories
                </span>
                <span>{goldLabeled > 0 ? `${fmtInt(goldLabeled)} gold labels` : "no gold labels yet"}</span>
                {taxRow.LATEST_ACCURACY != null && (
                  <span>
                    latest eval <AccCell v={taxRow.LATEST_ACCURACY} />
                  </span>
                )}
                <button
                  className="text-primary hover:underline"
                  onClick={() => setShowContract((s) => !s)}
                  aria-expanded={showContract}
                >
                  {showContract ? "Hide" : "Show"} enum contract
                </button>
              </div>
            )}

            {showContract && (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                  The <code className="font-mono">response_format</code> passed to AI_COMPLETE for{" "}
                  {taxVersion}. The subtheme list is an <code className="font-mono">enum</code>, so the
                  model can only return a subtheme from it. Every version is rendered, so a candidate is
                  scored with exactly the enum it would ship with.
                </p>
                {rendered.isLoading ? (
                  <Skeleton className="h-24" />
                ) : contract ? (
                  <pre className="text-[10px] font-mono overflow-x-auto max-h-48 overflow-y-auto bg-background rounded p-2 border border-border">
                    {JSON.stringify(typeof contract === "string" ? JSON.parse(contract) : contract, null, 1)}
                  </pre>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No nodes yet.</p>
                )}
              </div>
            )}

            {taxRow?.PARENT_VERSION_ID && (
              <div className="text-xs">
                <span className="font-medium">Changes vs {taxRow.PARENT_VERSION_ID}:</span>{" "}
                {diff.isLoading ? (
                  <span className="text-muted-foreground">checking…</span>
                ) : changes.length === 0 ? (
                  <span className="text-muted-foreground">none yet</span>
                ) : (
                  <span className="inline-flex flex-wrap gap-1 align-middle">
                    {changes.slice(0, 10).map((d, i) => (
                      <Badge
                        key={i}
                        variant={d.CHANGE_TYPE === "ADDED" ? "default" : "outline"}
                        className="text-[10px] font-normal"
                        title={d.DETAIL}
                      >
                        {String(d.CHANGE_TYPE).toLowerCase()}: {d.SUBTHEME}
                      </Badge>
                    ))}
                    {changes.length > 10 && (
                      <span className="text-muted-foreground">+{changes.length - 10} more</span>
                    )}
                    <button
                      className="text-primary hover:underline ml-1"
                      onClick={() => setShowDiff((s) => !s)}
                      aria-expanded={showDiff}
                    >
                      {showDiff ? "Hide details" : "Show details"}
                    </button>
                  </span>
                )}
              </div>
            )}

            {showDiff && changes.length > 0 && (
              <div className="rounded-md border border-border max-h-72 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Change</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Theme</TableHead>
                      <TableHead>Subtheme</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changes.map((d, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Badge
                            variant={d.CHANGE_TYPE === "ADDED" ? "default" : "outline"}
                            className="text-[10px]"
                          >
                            {d.CHANGE_TYPE}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{d.CATEGORY}</TableCell>
                        <TableCell className="text-xs">{d.THEME}</TableCell>
                        <TableCell className="text-xs font-mono">
                          {d.SUBTHEME === "" ? "(blank)" : d.SUBTHEME}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-md">{d.DETAIL}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <ActionResultBanner result={taxAction.last} />
          </CardHeader>
          <CardContent>
            {taxVersion ? (
              <TaxonomyEditor versionId={taxVersion} editable={isDraft} maxHeight="max-h-[560px]" />
            ) : (
              <Skeleton className="h-64" />
            )}
          </CardContent>
        </Card>

        {/* Prompt and model, collapsed by default */}
        <Card className="shadow-none">
          <button
            onClick={() => setPromptOpen((o) => !o)}
            aria-expanded={promptOpen}
            className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-4 text-left rounded-lg hover:bg-muted/40"
          >
            <ChevronRight
              className={cn("h-4 w-4 text-muted-foreground transition-transform", promptOpen && "rotate-90")}
            />
            <span className="text-base font-semibold">Prompt and model</span>
            <span className="text-xs text-muted-foreground">
              <span className="font-mono">{model}</span>, {maxLabels} label{maxLabels > 1 ? "s" : ""},{" "}
              {promptEdited
                ? `prompt edited (${charDelta >= 0 ? "+" : ""}${fmtInt(charDelta)} chars)`
                : `prompt from ${base ?? "-"}`}
            </span>
            {seeded && !placeholdersOk && (
              <Badge variant="destructive" className="text-[10px]">
                missing placeholder
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {promptOpen ? "Hide" : "View or edit"}
            </span>
          </button>
          {promptOpen && (
            <CardContent className="pt-0 space-y-3">
              <p className="text-xs text-muted-foreground">
                <code className="font-mono">{"{{TAXONOMY}}"}</code> is replaced with the rendered
                taxonomy above and <code className="font-mono">{"{{NOTE}}"}</code> with each
                encounter&apos;s notes. Edits here are saved with the new config below, so the
                prompt is versioned together with the taxonomy it was written for.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-muted-foreground">Model</label>
                <select value={model} onChange={(e) => setModel(e.target.value)} className={cn(field, "font-mono")}>
                  {Array.from(new Set([...MODELS, model])).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <label className="text-[11px] text-muted-foreground ml-2">Labels per encounter</label>
                <select value={maxLabels} onChange={(e) => setMaxLabels(Number(e.target.value))} className={field}>
                  <option value={1}>1 (primary only)</option>
                  <option value={2}>2 (primary + secondary)</option>
                </select>
                {promptEdited && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] ml-auto"
                    onClick={() => setTemplate(baseTemplate)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset to {base}&apos;s prompt
                  </Button>
                )}
              </div>
              <textarea
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                spellCheck={false}
                className="w-full h-80 rounded-md border border-input bg-background p-2.5 text-[11px] font-mono leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Badge variant={hasTax ? "secondary" : "destructive"} className="font-mono text-[10px]">
                  {hasTax ? "✓" : "✗"} {"{{TAXONOMY}}"}
                </Badge>
                <Badge variant={hasNote ? "secondary" : "destructive"} className="font-mono text-[10px]">
                  {hasNote ? "✓" : "✗"} {"{{NOTE}}"}
                </Badge>
                <span className="text-muted-foreground">{fmtInt(template.length)} chars</span>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Save as a new config */}
        <Card
          className={cn(
            "shadow-none",
            registered ? "border-emerald-500/50" : canRegister ? "border-primary/60" : "",
          )}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Save as a new config</CardTitle>
            <p className="text-xs text-muted-foreground">
              Adds a candidate to the config registry: this taxonomy, prompt and model, bound
              together. It doesn&apos;t change production. A candidate goes live only after
              it&apos;s evaluated and promoted.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <ActionResultBanner result={saveAction.last} />

            {!seeded ? (
              <Skeleton className="h-20" />
            ) : !registered ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground mr-1">vs {base}:</span>
                  <ChangeChip label="taxonomy" from={baseDetail?.TAXONOMY_VERSION_ID} to={taxVersion} changed={taxChanged} />
                  <ChangeChip label="model" from={baseDetail?.MODEL} to={model} changed={modelChanged} />
                  <ChangeChip label="labels" from={String(baseLabels)} to={String(maxLabels)} changed={labelsChanged} />
                  <ChangeChip
                    label="prompt"
                    to={promptEdited ? `edited, ${charDelta >= 0 ? "+" : ""}${fmtInt(charDelta)} chars` : "same"}
                    changed={promptEdited}
                  />
                </div>

                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                  <input
                    value={nameTouched ? name : suggested}
                    onChange={(e) => {
                      setNameTouched(true)
                      setName(e.target.value)
                    }}
                    placeholder="config name"
                    aria-label="Config name"
                    className={cn(field, "font-mono w-full", configName && !nameOk && "border-red-500")}
                  />
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="What changed and why (stored with the config)"
                    aria-label="Notes"
                    className={cn(field, "w-full")}
                  />
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    disabled={!canRegister || saveAction.pending}
                    onClick={register}
                  >
                    {saveAction.pending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5 mr-1" />
                    )}
                    Save config
                  </Button>
                </div>

                {blockers.length > 0 ? (
                  <ul className="text-[11px] text-amber-700 dark:text-amber-400 space-y-0.5">
                    {blockers.map((b) => (
                      <li key={b} className="flex items-center gap-1.5">
                        <span className="h-1 w-1 rounded-full bg-current" />
                        {b}
                        {b.startsWith("Lock") && (
                          <button className="underline hover:no-underline ml-1" onClick={lock}>
                            Lock now
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {goldLabeled > 0
                      ? `Evaluating it reuses the ${fmtInt(goldLabeled)} gold labels ${taxVersion} already has.`
                      : `${taxVersion} has no gold labels yet, so the first evaluation labels the gold set first (about 200 frontier-model calls, a couple of minutes).`}
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">
                    <span className="font-mono font-semibold">{registered}</span> is in the registry.
                    Next, evaluate it against the champion.
                  </p>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      disabled={saveAction.pending}
                      onClick={runPreview}
                      title="Classifies 5 encounters with the new config and writes nothing"
                    >
                      {saveAction.pending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <FlaskConical className="h-3.5 w-3.5 mr-1" />
                      )}
                      Try it on 5 encounters
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={startOver}>
                      Build another
                    </Button>
                    <Link href={`/evaluate?config=${encodeURIComponent(registered)}`}>
                      <Button size="sm" className="h-8 text-xs">
                        Continue to evaluation <ArrowRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    </Link>
                  </div>
                </div>
                {preview && <PreviewList rows={preview} />}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <Badge className={cn("text-[10px] px-1.5 py-0", STATUS_STYLE[status] ?? "")}>{status}</Badge>
}

/** Hover text for a version tab: lineage, who made it, bound configs and notes. */
function versionSummary(v: Row) {
  return [
    `${v.VERSION_ID} ${v.STATUS}${v.PARENT_VERSION_ID ? `, forked from ${v.PARENT_VERSION_ID}` : ""}`,
    `${v.GENERATED_BY_MODEL ? `drafted by ${v.GENERATED_BY_MODEL}` : `created by ${v.CREATED_BY ?? "-"}`}, ${String(v.CREATED_AT ?? "").slice(0, 10)}`,
    v.CONFIGS ? `configs: ${v.CONFIGS}` : "no configs yet",
    v.REVIEW_NOTES ?? v.GENERATION_RATIONALE ?? "",
  ]
    .filter(Boolean)
    .join("\n")
}

function ChangeChip({
  label,
  from,
  to,
  changed,
}: {
  label: string
  from?: string
  to?: string
  changed: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        changed ? "border-primary/50 bg-primary/10" : "border-border text-muted-foreground",
      )}
    >
      <span className="font-sans text-muted-foreground">{label}</span>
      {changed && from ? (
        <>
          <span className="line-through text-muted-foreground">{from}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-semibold">{to}</span>
        </>
      ) : (
        <span className={changed ? "font-semibold" : ""}>{changed ? to : `${to ?? "-"}`}</span>
      )}
    </span>
  )
}

function PreviewList({ rows }: { rows: Row[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">Preview (nothing was written):</p>
      <div className="grid gap-1.5 md:grid-cols-2">
        {rows.map((p, i) =>
          p.MESSAGE ? (
            <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
              {String(p.MESSAGE)}
            </p>
          ) : (
            <div key={i} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-mono text-[10px]">{String(p.ENCOUNTER_ID ?? "")}</span>
                {p.CONFIDENCE && <Badge className="text-[9px] px-1 py-0">{String(p.CONFIDENCE)}</Badge>}
              </div>
              {p.ERROR ? (
                <p className="text-red-600 dark:text-red-400 text-[10px] font-mono">{String(p.ERROR)}</p>
              ) : (
                <>
                  <p className="font-mono text-[11px]">
                    {String(p.PRIMARY_SUBTHEME ?? "")}
                    {p.SECONDARY_SUBTHEME && p.SECONDARY_SUBTHEME !== "NONE" && (
                      <span className="text-muted-foreground"> + {String(p.SECONDARY_SUBTHEME)}</span>
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
    </div>
  )
}

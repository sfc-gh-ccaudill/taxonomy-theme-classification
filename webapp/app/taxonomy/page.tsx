"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useMemo, useState } from "react"
import { PageHeader } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt } from "@/components/stat"
import { SOURCES } from "@/lib/queries"
import { DEMO_USER, TAXONOMY_MODEL } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import { AccCell } from "@/components/eval-widgets"
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
import {
  ChevronRight,
  GitFork,
  Lock,
  Plus,
  X,
  Pencil,
  Trash2,
  Save,
  ArrowRight,
  AlertTriangle,
  Search,
  Signpost,
  ChevronsUpDown,
  ChevronsDownUp,
} from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

const STATUS_STYLE: Record<string, string> = {
  APPROVED: "bg-emerald-600 hover:bg-emerald-600 text-white",
  LOCKED: "bg-blue-600 hover:bg-blue-600 text-white",
  DRAFT: "bg-amber-500 hover:bg-amber-500 text-white",
  REJECTED: "bg-red-600 hover:bg-red-600 text-white",
  SUPERSEDED: "bg-muted text-muted-foreground",
}

const STATUS_BLURB: Record<string, string> = {
  DRAFT: "Editable. Nothing can be evaluated against it until it is locked.",
  LOCKED: "Frozen. Bind it into a config on page 3 and evaluate it on page 4.",
  APPROVED: "In production, through the champion config. Fork it to change it.",
  SUPERSEDED: "Was in production. Promoting a config bound to it again is a rollback.",
  REJECTED: "A recorded no. Kept for the history.",
}

type NodeForm = {
  category: string
  theme: string
  subtheme: string
  description: string
  routingNote: string
}

const EMPTY_NODE: NodeForm = {
  category: "",
  theme: "",
  subtheme: "",
  description: "",
  routingNote: "",
}

const input =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"

export default function TaxonomyPage() {
  const [selected, setSelected] = useState<string | null>(null)
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})
  const [diffPair, setDiffPair] = useState<{ from: string; to: string } | null>(null)
  const [showContract, setShowContract] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<NodeForm>(EMPTY_NODE)
  const [addForm, setAddForm] = useState<NodeForm>(EMPTY_NODE)
  const [showAdd, setShowAdd] = useState(false)
  const [filter, setFilter] = useState("")
  // One expanded subtheme at a time; names are unique across a version.
  const [openSub, setOpenSub] = useState<string | null>(null)

  const tax = useQuery<{ versions: Row[]; active: Row | null }>({
    queryKey: ["taxonomy"],
    queryFn: () => fetch("/api/taxonomy").then((r) => r.json()),
  })

  const versions = tax.data?.versions ?? []
  const active = tax.data?.active ?? null
  const currentVersion = selected ?? active?.VERSION_ID ?? versions[0]?.VERSION_ID
  const current = versions.find((v) => v.VERSION_ID === currentVersion)
  const isDraft = current?.STATUS === "DRAFT"

  const nodes = useQuery<{ nodes: Row[] }>({
    queryKey: ["taxonomy-nodes", currentVersion],
    queryFn: () =>
      fetch(`/api/taxonomy?versionId=${encodeURIComponent(currentVersion)}`).then((r) =>
        r.json(),
      ),
    enabled: !!currentVersion,
  })

  const rendered = useQuery<{ rendered: Row | null }>({
    queryKey: ["taxonomy-rendered", currentVersion],
    queryFn: () =>
      fetch(`/api/taxonomy?rendered=${encodeURIComponent(currentVersion)}`).then((r) =>
        r.json(),
      ),
    enabled: !!currentVersion && showContract,
  })

  const diff = useQuery<{ diff: Row[] }>({
    queryKey: ["taxonomy-diff", diffPair?.from, diffPair?.to],
    queryFn: () =>
      fetch(
        `/api/taxonomy?from=${encodeURIComponent(diffPair!.from)}&to=${encodeURIComponent(diffPair!.to)}`,
      ).then((r) => r.json()),
    enabled: !!diffPair,
  })

  const action = useAction({
    invalidate: [
      ["taxonomy"],
      ["taxonomy-nodes"],
      ["taxonomy-rendered"],
      ["taxonomy-diff"],
      ["configs"],
    ],
  })

  /** Group nodes into category > theme > subtheme for the tree. */
  const tree = useMemo(() => {
    const out: Record<string, Record<string, Row[]>> = {}
    for (const n of nodes.data?.nodes ?? []) {
      out[n.CATEGORY] ??= {}
      out[n.CATEGORY][n.THEME] ??= []
      out[n.CATEGORY][n.THEME].push(n)
    }
    return out
  }, [nodes.data])

  const categories = Object.keys(tree)

  /** The tree narrowed by the filter box. A category or theme name match keeps
      everything under it; otherwise a subtheme stays if its name, description
      or routing note matches. */
  const q = filter.trim().toLowerCase()
  const shownTree = useMemo(() => {
    if (!q) return tree
    const has = (v: unknown) => String(v ?? "").toLowerCase().includes(q)
    const out: Record<string, Record<string, Row[]>> = {}
    for (const [cat, catThemes] of Object.entries(tree)) {
      for (const [theme, subs] of Object.entries(catThemes)) {
        const keep =
          has(cat) || has(theme)
            ? subs
            : subs.filter((s) => has(s.SUBTHEME) || has(s.DESCRIPTION) || has(s.ROUTING_NOTE))
        if (keep.length) {
          out[cat] ??= {}
          out[cat][theme] = keep
        }
      }
    }
    return out
  }, [tree, q])
  const matchCount = Object.values(shownTree)
    .flatMap((t) => Object.values(t))
    .flat().length
  const themes = useMemo(
    () => Array.from(new Set((nodes.data?.nodes ?? []).map((n) => n.THEME))).sort(),
    [nodes.data],
  )
  const blankList = (nodes.data?.nodes ?? []).filter(
    (n) => String(n.SUBTHEME ?? "").trim() === "",
  )
  const blankNodes = blankList.length
  // Per-category count, so the category header can carry a warning icon.
  const blankByCat = blankList.reduce<Record<string, number>>((acc, n) => {
    acc[n.CATEGORY] = (acc[n.CATEGORY] ?? 0) + 1
    return acc
  }, {})
  const blankCats = Object.keys(blankByCat)

  async function editNode(
    nodeAction: "ADD" | "UPDATE" | "DELETE",
    originalSubtheme: string,
    f: NodeForm,
  ) {
    const res = await action.runAsync({
      proc: "editTaxonomyNode",
      params: {
        versionId: currentVersion,
        action: nodeAction,
        originalSubtheme,
        category: f.category,
        theme: f.theme,
        subtheme: f.subtheme,
        description: f.description,
        routingNote: f.routingNote,
      },
    })
    if (res.ok) {
      if (nodeAction === "ADD") {
        setAddForm(EMPTY_NODE)
        setOpenCats((s) => ({ ...s, [f.category]: true }))
      }
      setEditing(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Author the taxonomy"
        description="A versioned registry with a lifecycle. Fork any version into a DRAFT, edit it here, then LOCK it so it can be evaluated. Nothing on this page touches production: a version only goes live when a config bound to it passes the eval gate and is promoted on page 4."
        objects={SOURCES.taxonomy}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={action.pending}
          onClick={() =>
            action.run({
              proc: "proposeTaxonomy",
              params: {
                serviceLine: "READMISSIONS",
                model: TAXONOMY_MODEL,
                createdBy: DEMO_USER,
              },
            })
          }
          title="An LLM drafts a whole taxonomy from DISCOVERY_SAMPLE"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {action.pending ? "Working…" : "Propose from sample"}
        </Button>
      </PageHeader>

      <div className="space-y-4">
        <ActionResultBanner result={action.last} />

        {active ? (
          <StatGrid>
            <Stat
              label="In production"
              value={active.VERSION_ID}
              tone="good"
              sub={`promoted by ${active.REVIEWED_BY ?? "-"}`}
            />
            <Stat
              label="Subthemes"
              value={fmtInt(active.NODE_COUNT)}
              sub={`${fmtInt(active.THEME_COUNT)} themes, ${fmtInt(active.CATEGORY_COUNT)} categories`}
            />
            <Stat
              label="Rubric payload"
              value={`${fmtInt(active.TAXONOMY_CHARS)} chars`}
              sub="rides along on every classification call"
            />
            <Stat
              label="Versions"
              value={fmtInt(versions.length)}
              sub={`${versions.filter((v) => v.STATUS === "DRAFT").length} draft, ${versions.filter((v) => v.STATUS === "LOCKED").length} locked`}
            />
          </StatGrid>
        ) : (
          <Alert>
            <Lock className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No taxonomy in production. Lock a version, bind it into a config,
              evaluate it and promote it.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-5">
          {/* Version registry */}
          <Card className="lg:col-span-2 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Version registry</CardTitle>
              <p className="text-xs text-muted-foreground">
                Durable tables, never CREATE OR REPLACE. Each version shows the
                configs bound to it and its latest evaluation, so a version is
                never judged without evidence.
              </p>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {tax.isLoading ? (
                <Skeleton className="h-32" />
              ) : (
                versions.map((v) => (
                  <div
                    key={v.VERSION_ID}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelected(v.VERSION_ID)
                      setEditing(null)
                    }}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(v.VERSION_ID)}
                    className={cn(
                      "w-full text-left rounded-md border p-2.5 transition-colors cursor-pointer",
                      currentVersion === v.VERSION_ID
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{v.VERSION_ID}</span>
                      <Badge
                        className={cn("text-[10px] px-1.5 py-0", STATUS_STYLE[v.STATUS] ?? "")}
                      >
                        {v.STATUS}
                      </Badge>
                      {v.PARENT_VERSION_ID && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          from {v.PARENT_VERSION_ID}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                        {fmtInt(v.SUBTHEMES)} subthemes
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-2">
                      <span>{v.GENERATED_BY_MODEL ?? `forked by ${v.CREATED_BY}`}</span>
                      <span>{String(v.CREATED_AT).slice(0, 10)}</span>
                      <span>gold {Number(v.GOLD_LABELED) > 0 ? fmtInt(v.GOLD_LABELED) : "none"}</span>
                      {v.LATEST_ACCURACY != null && (
                        <span>
                          latest eval <AccCell v={v.LATEST_ACCURACY} />
                        </span>
                      )}
                    </div>
                    {v.CONFIGS && (
                      <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                        configs: {v.CONFIGS}
                      </div>
                    )}
                    {(v.REVIEW_NOTES || v.GENERATION_RATIONALE) && (
                      <div className="text-[11px] text-muted-foreground mt-1 italic line-clamp-2">
                        {v.REVIEW_NOTES ?? v.GENERATION_RATIONALE}
                      </div>
                    )}
                    {v.PARENT_VERSION_ID && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 text-[10px] px-1.5 mt-1"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDiffPair({ from: v.PARENT_VERSION_ID, to: v.VERSION_ID })
                        }}
                      >
                        Diff vs {v.PARENT_VERSION_ID}
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Selected version: actions + node tree / editor */}
          <Card className="lg:col-span-3 shadow-none">
            <CardHeader className="pb-2 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm">{currentVersion ?? "No version"}</CardTitle>
                  {current && (
                    <Badge
                      className={cn("text-[10px] px-1.5 py-0", STATUS_STYLE[current.STATUS] ?? "")}
                    >
                      {current.STATUS}
                    </Badge>
                  )}
                </div>
                {current && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      disabled={action.pending}
                      onClick={async () => {
                        const res = await action.runAsync({
                          proc: "forkTaxonomy",
                          params: {
                            sourceVersionId: current.VERSION_ID,
                            createdBy: DEMO_USER,
                            notes: "",
                          },
                        })
                        const m = res.ok ? /DRAFT (v\d+)/.exec(res.message) : null
                        if (m) setSelected(m[1])
                      }}
                    >
                      <GitFork className="h-3 w-3 mr-1" />
                      Fork to new draft
                    </Button>
                    {isDraft && (
                      <Button
                        size="sm"
                        className="h-7 text-[11px]"
                        disabled={action.pending}
                        onClick={() =>
                          action.run({
                            proc: "lockTaxonomy",
                            params: { versionId: current.VERSION_ID, lockedBy: DEMO_USER },
                          })
                        }
                      >
                        <Lock className="h-3 w-3 mr-1" />
                        Lock for evaluation
                      </Button>
                    )}
                    {(current.STATUS === "DRAFT" || current.STATUS === "LOCKED") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px]"
                        disabled={action.pending}
                        onClick={() =>
                          action.run({
                            proc: "rejectTaxonomy",
                            params: {
                              versionId: current.VERSION_ID,
                              reviewer: DEMO_USER,
                              reason: "Rejected from the app.",
                            },
                          })
                        }
                      >
                        <X className="h-3 w-3 mr-1" />
                        Reject
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => setShowContract((s) => !s)}
                    >
                      {showContract ? "Hide" : "Show"} enum contract
                    </Button>
                  </div>
                )}
              </div>
              {current && (
                <p className="text-xs text-muted-foreground">
                  {STATUS_BLURB[current.STATUS]}
                  {current.STATUS === "LOCKED" && (
                    <Link
                      href="/prompts"
                      className="ml-1 inline-flex items-center text-primary hover:underline"
                    >
                      Register a config on it <ArrowRight className="h-3 w-3 ml-0.5" />
                    </Link>
                  )}
                </p>
              )}
              {isDraft && blankNodes > 0 && (
                <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 py-2">
                  <AlertDescription className="text-[11px] text-amber-900 dark:text-amber-200">
                    {blankNodes} node{blankNodes > 1 ? "s have" : " has"} a blank
                    subtheme (in {blankCats.join(", ")}), which would become a legal
                    enum value. Lock will refuse until it is fixed or deleted.
                    <button
                      className="ml-1 underline hover:no-underline"
                      onClick={() =>
                        setOpenCats((s) => ({
                          ...s,
                          ...Object.fromEntries(blankCats.map((c) => [c, true])),
                        }))
                      }
                    >
                      Show {blankCats.length > 1 ? "them" : "it"}
                    </button>
                  </AlertDescription>
                </Alert>
              )}
            </CardHeader>
            <CardContent>
              {showContract && (
                <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-xs font-medium mb-1.5">
                    response_format passed to AI_COMPLETE for {currentVersion}
                  </p>
                  <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                    The subtheme list is an <code className="font-mono">enum</code>.
                    The model can only return a subtheme from this list.
                    Rendered for every version, so a candidate is scored with
                    exactly the enum it would ship with.
                  </p>
                  {rendered.isLoading ? (
                    <Skeleton className="h-24" />
                  ) : rendered.data?.rendered ? (
                    <pre className="text-[10px] font-mono overflow-x-auto max-h-48 overflow-y-auto bg-background rounded p-2 border border-border">
                      {JSON.stringify(
                        typeof rendered.data.rendered.RESPONSE_FORMAT === "string"
                          ? JSON.parse(rendered.data.rendered.RESPONSE_FORMAT)
                          : rendered.data.rendered.RESPONSE_FORMAT,
                        null,
                        1,
                      )}
                    </pre>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">No nodes yet.</p>
                  )}
                </div>
              )}

              {isDraft && (
                <div className="mb-3">
                  {!showAdd ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => setShowAdd(true)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add subtheme
                    </Button>
                  ) : (
                    <div className="rounded-md border border-primary/40 bg-primary/5 p-2.5 space-y-1.5">
                      <NodeFields
                        form={addForm}
                        setForm={setAddForm}
                        categories={categories}
                        themes={themes}
                        idPrefix="add"
                      />
                      <div className="flex gap-1.5 justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            setShowAdd(false)
                            setAddForm(EMPTY_NODE)
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-6 text-[11px]"
                          disabled={action.pending}
                          onClick={() => editNode("ADD", "", addForm)}
                        >
                          <Save className="h-3 w-3 mr-1" />
                          Add to {currentVersion}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {nodes.isLoading ? (
                <Skeleton className="h-64" />
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        className={cn(input, "h-8 pl-7 text-xs")}
                        placeholder="Filter by name, description or routing note"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                    </div>
                    {q && (
                      <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                        {matchCount} match{matchCount === 1 ? "" : "es"}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-[11px]"
                      title="Expand all categories"
                      onClick={() =>
                        setOpenCats(Object.fromEntries(categories.map((c) => [c, true])))
                      }
                    >
                      <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
                      Expand
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-[11px]"
                      title="Collapse all categories"
                      onClick={() => {
                        setOpenCats({})
                        setOpenSub(null)
                        setFilter("")
                      }}
                    >
                      <ChevronsDownUp className="h-3.5 w-3.5 mr-1" />
                      Collapse
                    </Button>
                  </div>

                  <div className="space-y-1.5 max-h-[640px] overflow-y-auto pr-1">
                    {q && matchCount === 0 && (
                      <p className="text-xs text-muted-foreground py-6 text-center">
                        Nothing matches &ldquo;{filter.trim()}&rdquo;.
                      </p>
                    )}
                    {Object.entries(shownTree).map(([cat, catThemes]) => {
                      const count = Object.values(catThemes).flat().length
                      // A filter opens every category that has a match.
                      const open = q ? true : (openCats[cat] ?? false)
                      return (
                        <div key={cat} className="rounded-md border border-border bg-card">
                          <button
                            onClick={() => setOpenCats((s) => ({ ...s, [cat]: !open }))}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/50 rounded-md"
                          >
                            <ChevronRight
                              className={cn(
                                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                                open && "rotate-90",
                              )}
                            />
                            <span className="text-[15px] font-semibold tracking-tight">{cat}</span>
                            {blankByCat[cat] && (
                              <span
                                title={`${blankByCat[cat]} blank subtheme${blankByCat[cat] > 1 ? "s" : ""} in this category`}
                                aria-label={`${blankByCat[cat]} blank subtheme${blankByCat[cat] > 1 ? "s" : ""}`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                              </span>
                            )}
                            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                              {Object.keys(catThemes).length} theme
                              {Object.keys(catThemes).length === 1 ? "" : "s"} / {count} subtheme
                              {count === 1 ? "" : "s"}
                            </span>
                          </button>
                          {open && (
                            <div className="border-t border-border px-3 pt-2.5 pb-3 space-y-3">
                              {Object.entries(catThemes).map(([theme, subs]) => (
                                <div key={theme}>
                                  <div className="flex items-baseline gap-2 mb-1 pl-1">
                                    <span className="text-[13px] font-semibold text-primary">
                                      {theme}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground tabular-nums">
                                      {subs.length}
                                    </span>
                                  </div>
                                  <div className="ml-2 border-l-2 border-primary/25 pl-1.5 space-y-0.5">
                                    {subs.map((s) => {
                                      const key = String(s.SUBTHEME ?? "")
                                      if (isDraft && editing === key) {
                                        return (
                                          <div
                                            key={`edit-${key}`}
                                            className="rounded-md border border-primary/40 bg-primary/5 p-2 space-y-1.5"
                                          >
                                            <NodeFields
                                              form={editForm}
                                              setForm={setEditForm}
                                              categories={categories}
                                              themes={themes}
                                              idPrefix="edit"
                                            />
                                            <div className="flex gap-1.5 justify-end">
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-6 text-[11px]"
                                                onClick={() => setEditing(null)}
                                              >
                                                Cancel
                                              </Button>
                                              <Button
                                                size="sm"
                                                className="h-6 text-[11px]"
                                                disabled={action.pending}
                                                onClick={() => editNode("UPDATE", key, editForm)}
                                              >
                                                <Save className="h-3 w-3 mr-1" />
                                                Save
                                              </Button>
                                            </div>
                                          </div>
                                        )
                                      }
                                      const isOpen = openSub === key
                                      return (
                                        <div
                                          key={`node-${key}`}
                                          className={cn("rounded", isOpen && "bg-muted/60")}
                                        >
                                          <button
                                            onClick={() => setOpenSub(isOpen ? null : key)}
                                            title={isOpen ? undefined : s.DESCRIPTION}
                                            aria-expanded={isOpen}
                                            className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs rounded hover:bg-muted/50"
                                          >
                                            <ChevronRight
                                              className={cn(
                                                "h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform",
                                                isOpen && "rotate-90",
                                              )}
                                            />
                                            <span className={cn("min-w-0", isOpen && "font-medium")}>
                                              {key === "" ? (
                                                <span className="text-red-600 dark:text-red-400">
                                                  (blank subtheme)
                                                </span>
                                              ) : (
                                                key
                                              )}
                                            </span>
                                            {s.ROUTING_NOTE && (
                                              <span title="Has a routing note" className="shrink-0">
                                                <Signpost className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                                              </span>
                                            )}
                                          </button>
                                          {isOpen && (
                                            <div className="pl-6 pr-2 pb-2 space-y-1.5 text-xs leading-relaxed">
                                              <p className="text-muted-foreground">
                                                {s.DESCRIPTION || <em>No description.</em>}
                                              </p>
                                              {s.ROUTING_NOTE && (
                                                <div className="flex gap-1.5 rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-amber-900 dark:text-amber-200">
                                                  <Signpost className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                                  <span>
                                                    <span className="font-semibold">Routing: </span>
                                                    {s.ROUTING_NOTE}
                                                  </span>
                                                </div>
                                              )}
                                              {isDraft && (
                                                <div className="flex gap-1.5 pt-0.5">
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-6 text-[11px]"
                                                    onClick={() => {
                                                      setEditing(key)
                                                      setEditForm({
                                                        category: s.CATEGORY ?? "",
                                                        theme: s.THEME ?? "",
                                                        subtheme: key,
                                                        description: s.DESCRIPTION ?? "",
                                                        routingNote: s.ROUTING_NOTE ?? "",
                                                      })
                                                    }}
                                                  >
                                                    <Pencil className="h-3 w-3 mr-1" />
                                                    Edit
                                                  </Button>
                                                  <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 text-[11px] text-red-600 hover:text-red-700 dark:text-red-400"
                                                    disabled={action.pending}
                                                    onClick={() => editNode("DELETE", key, EMPTY_NODE)}
                                                  >
                                                    <Trash2 className="h-3 w-3 mr-1" />
                                                    Delete
                                                  </Button>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {diffPair && (
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">
                  Diff {diffPair.from} to {diffPair.to}
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px]"
                  onClick={() => setDiffPair(null)}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {diff.isLoading ? (
                <Skeleton className="h-24" />
              ) : (diff.data?.diff ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No differences between these versions.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">Change</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Theme</TableHead>
                      <TableHead>Subtheme</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(diff.data?.diff ?? []).map((d, i) => (
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
                        <TableCell className="text-xs text-muted-foreground max-w-md">
                          {d.DETAIL}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

/** The five editable fields of a node. Category and theme suggest existing values. */
function NodeFields({
  form,
  setForm,
  categories,
  themes,
  idPrefix,
}: {
  form: NodeForm
  setForm: (f: NodeForm) => void
  categories: string[]
  themes: string[]
  idPrefix: string
}) {
  const set = (k: keyof NodeForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <input
          className={input}
          list={`${idPrefix}-cats`}
          placeholder="Category"
          value={form.category}
          onChange={set("category")}
        />
        <input
          className={input}
          list={`${idPrefix}-themes`}
          placeholder="Theme"
          value={form.theme}
          onChange={set("theme")}
        />
      </div>
      <datalist id={`${idPrefix}-cats`}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id={`${idPrefix}-themes`}>
        {themes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <input
        className={cn(input, "font-mono")}
        placeholder="Subtheme name (this is the label)"
        value={form.subtheme}
        onChange={set("subtheme")}
      />
      <input
        className={input}
        placeholder="Description: what belongs here"
        value={form.description}
        onChange={set("description")}
      />
      <input
        className={input}
        placeholder="Routing note: how it differs from its nearest neighbour (optional)"
        value={form.routingNote}
        onChange={set("routingNote")}
      />
    </>
  )
}

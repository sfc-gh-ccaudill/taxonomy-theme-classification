"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Stat, StatGrid, fmtInt, fmtPct } from "@/components/stat"
import { TestDataSource } from "@/components/sql-source"
import { TEST_DATA_SOURCES } from "@/lib/queries"
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
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts"
import { ChartTooltip } from "@/components/chart-utils"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"

type Row = Record<string, any>

const NGM = "NO_GOOD_MATCH"

const CONF_STYLE: Record<string, string> = {
  HIGH: "bg-emerald-600 hover:bg-emerald-600 text-white",
  MEDIUM: "bg-amber-500 hover:bg-amber-500 text-white",
  LOW: "bg-red-600 hover:bg-red-600 text-white",
}
const CONFIDENCES = ["ALL", "HIGH", "MEDIUM", "LOW"]

/** One encounter with its labels, grouped from the one-row-per-label result. */
type Encounter = {
  id: string
  noteCount: number
  noteChars: number
  fullText: string
  isGold: boolean
  testScenario: string | null
  labels: Row[]
}

function groupByEncounter(rows: Row[]): Encounter[] {
  const out = new Map<string, Encounter>()
  for (const r of rows) {
    let e = out.get(r.ENCOUNTER_ID)
    if (!e) {
      e = {
        id: r.ENCOUNTER_ID,
        noteCount: Number(r.NOTE_COUNT),
        noteChars: Number(r.NOTE_CHARS),
        fullText: r.FULL_TEXT ?? "",
        isGold: Boolean(r.IS_GOLD),
        testScenario: r.TEST_SCENARIO ?? null,
        labels: [],
      }
      out.set(r.ENCOUNTER_ID, e)
    }
    e.labels.push(r)
  }
  return [...out.values()]
}

/**
 * The parts of an evidence string worth looking for in the note. The
 * classifier usually paraphrases around quoted snippets ('"new onset abd pain"
 * with "dull ache..."'), so the quoted fragments are the candidates; with no
 * quotes, the whole string is.
 */
function evidenceFragments(evidence: string): string[] {
  const quoted = [...evidence.matchAll(/"([^"]{4,})"/g)].map((m) => m[1])
  return (quoted.length ? quoted : [evidence])
    .map((p) => p.trim().replace(/(\.\.\.|…)$/, "").trim())
    .filter((p) => p.length >= 4)
}

/**
 * Wraps each occurrence of an evidence fragment in <mark>. A fragment that
 * was paraphrased rather than quoted simply isn't found; the full evidence is
 * still listed under the note.
 */
function highlight(text: string, evidence: string[]): React.ReactNode {
  const lower = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const p of evidence.flatMap(evidenceFragments)) {
    const needle = p.toLowerCase()
    let i = lower.indexOf(needle)
    while (i !== -1) {
      ranges.push([i, i + needle.length])
      i = lower.indexOf(needle, i + needle.length)
    }
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  const parts: React.ReactNode[] = []
  let pos = 0
  merged.forEach(([s, e], k) => {
    if (s > pos) parts.push(text.slice(pos, s))
    parts.push(
      <mark
        key={k}
        className="bg-sky-200/70 dark:bg-sky-500/30 text-inherit rounded-sm px-0.5"
      >
        {text.slice(s, e)}
      </mark>,
    )
    pos = e
  })
  if (pos < text.length) parts.push(text.slice(pos))
  return parts
}

function LabelChip({ l }: { l: Row }) {
  const ngm = l.SUBTHEME === NGM
  return (
    <div className="flex items-start gap-1.5 leading-tight">
      <span className="text-[10px] tabular-nums text-muted-foreground w-3 pt-0.5">
        {l.LABEL_RANK}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          {ngm ? (
            <Badge className="text-[10px] bg-amber-500 hover:bg-amber-500">
              {NGM}
            </Badge>
          ) : (
            <span className="text-[11px] font-medium">{l.SUBTHEME}</span>
          )}
          {l.CONFIDENCE && (
            <Badge
              className={cn(
                "text-[9px] px-1.5 py-0",
                CONF_STYLE[l.CONFIDENCE] ?? "",
              )}
            >
              {l.CONFIDENCE}
            </Badge>
          )}
        </div>
        {!ngm && (
          <div className="text-[10px] text-muted-foreground">
            {l.CATEGORY} &rsaquo; {l.THEME}
          </div>
        )}
      </div>
    </div>
  )
}

export function ClassifiedView() {
  const [category, setCategory] = useState("")
  const [theme, setTheme] = useState("")
  const [subtheme, setSubtheme] = useState("")
  const [confidence, setConfidence] = useState("ALL")
  const [multiOnly, setMultiOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)

  const summary = useQuery<{ totals: Row; distribution: Row[] }>({
    queryKey: ["classified", "summary"],
    queryFn: () => fetch("/api/classified?summary=1").then((r) => r.json()),
  })

  const params = new URLSearchParams({ limit: "40" })
  if (category) params.set("category", category)
  if (theme) params.set("theme", theme)
  if (subtheme) params.set("subtheme", subtheme)
  if (confidence !== "ALL") params.set("confidence", confidence)
  if (multiOnly) params.set("multi", "1")
  if (search) params.set("search", search)
  const qs = params.toString()

  const encounters = useQuery<Row[]>({
    queryKey: ["classified", "encounters", qs],
    queryFn: () => fetch(`/api/classified?${qs}`).then((r) => r.json()),
    enabled: Number(summary.data?.totals?.CLASSIFIED ?? 0) > 0,
  })

  const t = summary.data?.totals ?? {}
  const dist = summary.data?.distribution ?? []
  const classified = Number(t.CLASSIFIED ?? 0)
  const labels = Number(t.LABELS ?? 0)

  // Display-only rollups of the distribution query.
  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of dist) {
      m.set(r.CATEGORY, (m.get(r.CATEGORY) ?? 0) + Number(r.ENCOUNTERS))
    }
    return [...m.entries()]
      .map(([name, encounters]) => ({ name, encounters }))
      .sort((a, b) => b.encounters - a.encounters)
  }, [dist])

  const topSubthemes = useMemo(
    () =>
      dist
        .filter(
          (r) =>
            (!category || r.CATEGORY === category) &&
            (!theme || r.THEME === theme),
        )
        .slice(0, 12),
    [dist, category, theme],
  )
  const topMax = Math.max(1, ...topSubthemes.map((r) => Number(r.ENCOUNTERS)))

  const grouped = useMemo(
    () => groupByEncounter(encounters.data ?? []),
    [encounters.data],
  )

  const clearPath = () => {
    setCategory("")
    setTheme("")
    setSubtheme("")
  }
  const pickCategory = (c: string) => {
    setCategory(c === category ? "" : c)
    setTheme("")
    setSubtheme("")
  }
  const pickSubtheme = (r: Row) => {
    if (subtheme === r.SUBTHEME) {
      setSubtheme("")
      return
    }
    setCategory(r.CATEGORY)
    setTheme(r.THEME)
    setSubtheme(r.SUBTHEME)
  }

  if (summary.isLoading) {
    return (
      <StatGrid>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </StatGrid>
    )
  }

  if (classified === 0) {
    return (
      <Card className="shadow-none">
        <CardContent className="py-12 text-center space-y-3">
          <p className="text-sm font-medium">No production output yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            This view shows the champion&apos;s labels from production runs.
            Evaluation runs on the gold set never land here. Run the champion
            on some or all of the backlog, then come back.
          </p>
          <Button asChild size="sm">
            <Link href="/run">Go to Run Production</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div>
      <StatGrid>
        <Stat
          label="Classified"
          value={`${fmtInt(classified)} / ${fmtInt(t.ENCOUNTERS)}`}
          sub={
            <>
              by <span className="font-mono">{t.CONFIGS}</span> on{" "}
              <span className="font-mono">{t.TAXONOMIES}</span>
              {t.LAST_CLASSIFIED_AT &&
                `, last ${String(t.LAST_CLASSIFIED_AT).slice(0, 16).replace("T", " ")}`}
            </>
          }
        />
        <Stat
          label="Labels"
          value={fmtInt(labels)}
          sub={`${(labels / classified).toFixed(2)} per encounter, ${fmtInt(t.MULTI_LABEL)} encounters with 2+`}
        />
        <Stat
          label="Subthemes in use"
          value={fmtInt(t.SUBTHEMES_USED)}
          sub={`${fmtPct(Number(t.HIGH_CONF) / Math.max(labels, 1))} of labels HIGH confidence`}
        />
        <Stat
          label="Low confidence / no match"
          value={`${fmtInt(t.LOW_CONF)} / ${fmtInt(t.NO_GOOD_MATCH)}`}
          tone={Number(t.LOW_CONF) + Number(t.NO_GOOD_MATCH) > 0 ? "warn" : "good"}
          sub="LOW labels / encounters with NO_GOOD_MATCH, the gap queue's inputs"
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-5 lg:items-start mt-6">
        <Card className="lg:col-span-3 shadow-none">
          <CardHeader className="pb-2 space-y-1.5">
            <CardTitle className="text-sm">Encounters by category</CardTitle>
            <p className="text-xs text-muted-foreground">
              A multi-label encounter counts under each category it was given.
              Click a bar to filter the encounters below.
            </p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={Math.max(260, byCategory.length * 30 + 30)}>
              <BarChart
                data={byCategory}
                layout="vertical"
                margin={{ left: 0, right: 16, top: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} opacity={0.3} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={220}
                  tick={{ fontSize: 10 }}
                  interval={0}
                />
                <ChartTooltip />
                <Bar
                  dataKey="encounters"
                  name="Encounters"
                  radius={[0, 2, 2, 0]}
                  className="cursor-pointer"
                  onClick={(d: any) => {
                    const name = d?.payload?.name ?? d?.name
                    if (name) pickCategory(name)
                  }}
                >
                  {byCategory.map((c) => (
                    <Cell
                      key={c.name}
                      fill={
                        c.name === NGM
                          ? "#F59E0B"
                          : !category || c.name === category
                            ? "#29B5E8"
                            : "#29B5E840"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 shadow-none">
          <CardHeader className="pb-2 space-y-1.5">
            <CardTitle className="text-sm">
              Top subthemes{category ? ` in ${category}` : ""}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Click one to see only its encounters.
            </p>
          </CardHeader>
          <CardContent className="space-y-1 max-h-[300px] overflow-y-auto">
            {topSubthemes.map((r) => (
              <button
                key={`${r.CATEGORY}|${r.THEME}|${r.SUBTHEME}`}
                type="button"
                onClick={() => pickSubtheme(r)}
                className={cn(
                  "w-full text-left rounded-md px-2 py-1 hover:bg-muted/60",
                  subtheme === r.SUBTHEME && "bg-muted",
                )}
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className={cn("font-medium truncate", r.SUBTHEME === NGM && "text-amber-600 dark:text-amber-400")}>
                    {r.SUBTHEME}
                  </span>
                  <span className="tabular-nums text-muted-foreground shrink-0">
                    {fmtInt(r.ENCOUNTERS)}
                    {Number(r.LOW_CONF) > 0 && (
                      <span className="text-red-600 dark:text-red-400"> ({r.LOW_CONF} low)</span>
                    )}
                  </span>
                </div>
                {r.SUBTHEME !== NGM && (
                  <div className="text-[10px] text-muted-foreground truncate">{r.THEME}</div>
                )}
                <div className="h-1 mt-0.5 rounded bg-muted overflow-hidden">
                  <div
                    className={cn("h-full", r.SUBTHEME === NGM ? "bg-amber-500" : "bg-sky-500")}
                    style={{ width: `${(Number(r.ENCOUNTERS) / topMax) * 100}%` }}
                  />
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-none mt-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Classified encounters</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                The champion&apos;s current labels for each encounter. An
                encounter matches a filter if any of its labels does. Click a
                row to read the full note with each label&apos;s evidence
                highlighted.
              </p>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search note, evidence or ID"
              className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {CONFIDENCES.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={confidence === c ? "default" : "outline"}
                className="h-6 text-[11px] px-2"
                onClick={() => setConfidence(c)}
              >
                {c === "ALL" ? "ALL CONFIDENCE" : c}
              </Button>
            ))}
            <Button
              size="sm"
              variant={multiOnly ? "default" : "outline"}
              className="h-6 text-[11px] px-2"
              onClick={() => setMultiOnly(!multiOnly)}
            >
              MULTI-LABEL
            </Button>
            {(category || theme || subtheme) && (
              <Badge
                variant="secondary"
                className="h-6 gap-1 text-[11px] font-normal cursor-pointer"
                onClick={clearPath}
              >
                {[category, theme, subtheme].filter(Boolean).join(" › ")}
                <X className="h-3 w-3" />
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {encounters.isLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Encounter</TableHead>
                    <TableHead className="w-80">Labels</TableHead>
                    <TableHead className="w-32 text-amber-700 dark:text-amber-400">
                      Test scenario
                    </TableHead>
                    <TableHead>Note text</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped.map((e) => {
                    const open = expanded === e.id
                    return (
                      <TableRow
                        key={e.id}
                        className="cursor-pointer align-top"
                        onClick={() => setExpanded(open ? null : e.id)}
                      >
                        <TableCell className="font-mono text-xs">
                          {e.id}
                          {e.isGold && (
                            <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0">
                              gold
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="space-y-1.5">
                          {e.labels.map((l) => (
                            <LabelChip key={l.LABEL_RANK} l={l} />
                          ))}
                        </TableCell>
                        <TableCell className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                          {e.testScenario ?? "-"}
                        </TableCell>
                        <TableCell className="text-xs max-w-xl">
                          <span className={open ? "" : "line-clamp-2"}>
                            {open
                              ? highlight(
                                  e.fullText,
                                  e.labels.map((l) => String(l.EVIDENCE ?? "")),
                                )
                              : e.fullText}
                          </span>
                          {open && (
                            <div className="mt-2 border-t border-border pt-2 space-y-1.5">
                              {e.labels.map((l) => (
                                <div key={l.LABEL_RANK} className="text-[11px] leading-snug">
                                  <span className="font-medium">
                                    {l.LABEL_RANK}. {l.SUBTHEME}:
                                  </span>{" "}
                                  <span className="text-muted-foreground italic">
                                    {l.EVIDENCE || "no evidence given"}
                                  </span>
                                </div>
                              ))}
                              <div className="text-[10px] text-muted-foreground pt-1">
                                {e.noteCount > 1
                                  ? `${e.noteCount} note rows`
                                  : "single note row"}
                                {` | ${fmtInt(e.noteChars)} characters | `}
                                <span className="font-mono">
                                  {e.labels[0]?.CONFIG_NAME} / {e.labels[0]?.TAXONOMY_VERSION_ID} / {e.labels[0]?.RUN_ID}
                                </span>
                              </div>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {grouped.length === 0 && (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  No classified encounters match those filters.
                </p>
              )}
              <div className="pt-3">
                <TestDataSource objects={TEST_DATA_SOURCES.explore} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

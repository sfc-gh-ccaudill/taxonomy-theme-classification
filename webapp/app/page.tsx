"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { PageHeader, TestDataSource } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt } from "@/components/stat"
import { SOURCES, TEST_DATA_SOURCES } from "@/lib/queries"
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
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { ChartTooltip } from "@/components/chart-utils"
import { ClassifiedView } from "./_components/classified-view"

type Row = Record<string, any>

/** Membership filters (pipeline) first, then test scenarios (test data). */
const FILTERS = [
  "ALL",
  "GOLD",
  "UNLABELED",
  "STRAIGHTFORWARD",
  "NEAR_NEIGHBOUR",
  "MULTI_LABEL",
  "GAP",
  "AMBIGUOUS",
]
const MEMBERSHIP_FILTERS = new Set(["ALL", "GOLD", "UNLABELED"])

const SCENARIO_NOTE: Record<string, string> = {
  STRAIGHTFORWARD: "One clear concern, named in the note. The base rate.",
  NEAR_NEIGHBOUR:
    "The note plants a cue for a confusable subtheme, e.g. post-op nausea written so it could read as general nausea.",
  MULTI_LABEL: "Seeded with two distinct concerns in one encounter.",
  GAP: "The concept was withheld from the design sample, so taxonomy v001 cannot contain it. The revision loop has to find it.",
  AMBIGUOUS:
    "Written to be genuinely undecidable between two subthemes. Lower scores are expected by design.",
}

const VIEWS = [
  { key: "before", label: "Before classification" },
  { key: "after", label: "After classification" },
] as const
type View = (typeof VIEWS)[number]["key"]

const DESCRIPTION: Record<View, string> = {
  before:
    "Free-text post-discharge nurse call notes, rolled up to one row per encounter. The totals and the note browser come from the pipeline's input tables: the notes, the gold-set list, and the design sample. The amber panels describe how this synthetic test data was built; production data would not have them.",
  after:
    "The same encounters after production runs: the champion's current labels per encounter, with confidence and the evidence it quoted from the note. Evaluation runs never appear here, so trying a candidate does not change what this shows.",
}

export default function ExplorePage() {
  const [view, setView] = useState<View>("before")

  return (
    <div>
      <PageHeader
        title="Explore the corpus"
        description={DESCRIPTION[view]}
        objects={view === "before" ? SOURCES.explore : SOURCES.exploreClassified}
      >
        <div className="inline-flex rounded-md border border-input p-0.5">
          {VIEWS.map((v) => (
            <Button
              key={v.key}
              size="sm"
              variant={view === v.key ? "default" : "ghost"}
              className="h-7 text-xs px-3"
              onClick={() => setView(v.key)}
            >
              {v.label}
            </Button>
          ))}
        </div>
      </PageHeader>

      {view === "before" ? <BeforeView /> : <ClassifiedView />}
    </div>
  )
}

function BeforeView() {
  const [filter, setFilter] = useState("ALL")
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)

  const corpus = useQuery<{ totals: Row; scenarios: Row[] }>({
    queryKey: ["corpus"],
    queryFn: () => fetch("/api/corpus").then((r) => r.json()),
  })

  const notes = useQuery<Row[]>({
    queryKey: ["notes", filter, search],
    queryFn: () =>
      fetch(
        `/api/notes?filter=${encodeURIComponent(filter)}&search=${encodeURIComponent(search)}&limit=40`,
      ).then((r) => r.json()),
  })

  const t = corpus.data?.totals ?? {}
  const byScenario = (corpus.data?.scenarios ?? []).map((r) => ({
    scenario: r.TEST_SCENARIO,
    gold: Number(r.GOLD),
    unlabeled: Number(r.UNLABELED),
  }))

  return (
    <div>
      {corpus.isLoading ? (
        <StatGrid>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </StatGrid>
      ) : (
        <StatGrid>
          <Stat
            label="Note rows"
            value={fmtInt(t.NOTE_ROWS)}
            sub={`roll up to ${fmtInt(t.ENCOUNTERS)} encounters`}
          />
          <Stat
            label="Gold / unlabeled"
            value={`${fmtInt(t.GOLD_ENCOUNTERS)} / ${fmtInt(t.UNLABELED_ENCOUNTERS)}`}
            sub={`${fmtInt(t.GOLD_LABELS)} gold labels, ${fmtInt(t.GOLD_VERIFIED)} SME-verified`}
          />
          <Stat
            label="Design sample"
            value={fmtInt(t.DESIGN_SAMPLE)}
            sub="the notes the taxonomy was generated from"
          />
          <Stat
            label="Not yet classified"
            value={fmtInt(t.NEVER_CLASSIFIED)}
            tone="warn"
            sub="encounters with no labels from any run"
          />
        </StatGrid>
      )}

      <div className="grid gap-6 lg:grid-cols-5 mt-6">
        <Card className="lg:col-span-3 shadow-none border-amber-500/40">
          <CardHeader className="pb-2 space-y-1.5">
            <CardTitle className="text-sm">
              How the test data was made challenging
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Synthetic notes are only a fair test if they are not all easy.
              Each note was generated from one of these test scenarios. The
              pipeline never sees this tag; it scores by segments it can derive
              from real data (category, label count, note length).
            </p>
            <TestDataSource objects={TEST_DATA_SOURCES.explore} />
          </CardHeader>
          <CardContent>
            {corpus.isLoading ? (
              <Skeleton className="h-[220px]" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byScenario} margin={{ left: 0, right: 8, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                  <XAxis
                    dataKey="scenario"
                    tick={{ fontSize: 10 }}
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fontSize: 11 }} width={44} />
                  <ChartTooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="gold" name="Gold encounters" stackId="a" fill="#11567F" />
                  <Bar dataKey="unlabeled" name="Unlabeled" stackId="a" fill="#29B5E8" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 shadow-none border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">What each test scenario is</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {Object.entries(SCENARIO_NOTE).map(([k, v]) => (
              <div key={k} className="text-xs">
                <Badge variant="outline" className="font-mono text-[10px] mb-1">
                  {k}
                </Badge>
                <p className="text-muted-foreground leading-snug">{v}</p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground border-t border-border pt-2.5 leading-snug">
              Note length was also varied (terse to rambling) as noise only.
              Every rubric-relevant fact is present at every length. The
              pipeline sees length the way it would on real data: as the
              NOTE_LENGTH segment, measured from the text.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-none mt-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Encounters</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Click a row to see the individual note rows the dynamic table
                concatenated.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search note text or ID"
                className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {FILTERS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={filter === s ? "default" : "outline"}
                className={
                  "h-6 text-[11px] px-2" +
                  (!MEMBERSHIP_FILTERS.has(s) && filter !== s
                    ? " border-amber-500/50 text-amber-700 dark:text-amber-400"
                    : "")
                }
                onClick={() => setFilter(s)}
              >
                {s}
              </Button>
            ))}
            <span className="text-[10px] text-amber-700 dark:text-amber-400 ml-1">
              amber filters are test scenarios
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {notes.isLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Encounter</TableHead>
                    <TableHead className="w-16">Notes</TableHead>
                    <TableHead className="w-20">Gold set</TableHead>
                    <TableHead className="w-36 text-amber-700 dark:text-amber-400">
                      Test scenario
                    </TableHead>
                    <TableHead>Note text</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(notes.data ?? []).map((r) => (
                    <TableRow
                      key={r.ENCOUNTER_ID}
                      className="cursor-pointer align-top"
                      onClick={() =>
                        setExpanded(
                          expanded === r.ENCOUNTER_ID ? null : r.ENCOUNTER_ID,
                        )
                      }
                    >
                      <TableCell className="font-mono text-xs">
                        {r.ENCOUNTER_ID}
                        {r.IN_DISCOVERY_SAMPLE && (
                          <Badge
                            variant="secondary"
                            className="ml-1 text-[9px] px-1 py-0"
                          >
                            design
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {r.NOTE_COUNT}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={r.IS_GOLD ? "default" : "outline"}
                          className="text-[10px] font-mono"
                        >
                          {r.IS_GOLD ? "GOLD" : "UNLABELED"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                        {r.TEST_SCENARIO ?? "-"}
                      </TableCell>
                      <TableCell className="text-xs max-w-xl">
                        <span
                          className={
                            expanded === r.ENCOUNTER_ID ? "" : "line-clamp-2"
                          }
                        >
                          {r.FULL_TEXT}
                        </span>
                        {expanded === r.ENCOUNTER_ID && (
                          <div className="mt-2 text-[11px] text-muted-foreground space-y-0.5 border-t border-border pt-2">
                            <div>
                              Discharged: {String(r.DISCHARGE_DATE ?? "").slice(0, 10)} | Last call:{" "}
                              {String(r.LAST_CALL_DATE ?? "").slice(0, 10)} | Days post-discharge:{" "}
                              {r.DAYS_POST_DISCHARGE}
                            </div>
                            <div>
                              {r.NOTE_COUNT > 1
                                ? `${r.NOTE_COUNT} note rows concatenated by ENCOUNTER_PREP`
                                : "single note row"}
                              {` | ${fmtInt(r.NOTE_CHARS)} characters`}
                            </div>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(notes.data ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  No encounters match that filter.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

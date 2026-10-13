"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { PageHeader, TestDataSource } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt, fmtMetric, fmtPct } from "@/components/stat"
import { SOURCES, TEST_DATA_SOURCES } from "@/lib/queries"
import { DEMO_USER, LABELER_MODEL, TAXONOMY_MODEL } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import { AccCell, GateBadge } from "@/components/eval-widgets"
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
import { ArrowRight, GitBranch, Gauge, Loader2, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

const SCENARIO_ORDER = ["STRAIGHTFORWARD", "NEAR_NEIGHBOUR", "MULTI_LABEL", "GAP", "AMBIGUOUS"]

export default function MonitorPage() {
  const data = useQuery<{
    scorecards: Row[]
    gate: Row[]
    leaderboard: Row[]
    segmentSummary: Row[]
    gapReview: Row[]
    testScenarios: Row[]
  }>({
    queryKey: ["eval"],
    queryFn: () => fetch("/api/eval").then((r) => r.json()),
  })

  const action = useAction({
    invalidate: [["eval"], ["runs"], ["taxonomy"], ["production"]],
  })

  const scorecards = data.data?.scorecards ?? []
  const champion = (data.data?.leaderboard ?? []).find((c) => c.IS_ACTIVE)
  const gateById = new Map((data.data?.gate ?? []).map((g) => [g.EVAL_ID, g]))
  const championEvals = scorecards.filter((s) => s.CONFIG_NAME === champion?.CONFIG_NAME)
  const latestChampionEval = championEvals[0]
  const latestGate = latestChampionEval ? gateById.get(latestChampionEval.EVAL_ID) : null
  const gapReview = data.data?.gapReview ?? []
  const summaryByEval = new Map((data.data?.segmentSummary ?? []).map((s) => [s.EVAL_ID, s]))

  // Oldest first for the comparison tables, so the columns read as a timeline.
  const evalsAsc = [...scorecards].reverse()
  const scenarioRows = data.data?.testScenarios ?? []
  const scenarioCell = (evalId: string, scenario: string) =>
    scenarioRows.find((r) => r.EVAL_ID === evalId && r.TEST_SCENARIO === scenario)

  return (
    <div>
      <PageHeader
        title="Monitor production and revise"
        description="After promotion: is the champion still good, and what is the taxonomy missing? Drift is the champion scored against its own previous evaluation. Gaps come from production output only, flagged NO_GOOD_MATCH or LOW confidence. A revision becomes a new DRAFT, which goes back through lock, register, evaluate and promote like anything else."
        objects={SOURCES.monitor}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={action.pending || !champion}
          onClick={() =>
            action.run({
              proc: "evaluateConfig",
              params: {
                configName: champion?.CONFIG_NAME,
                labelerModel: LABELER_MODEL,
                verifiedOnly: false,
              },
            })
          }
        >
          {action.pending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Gauge className="h-3.5 w-3.5 mr-1" />
          )}
          Re-evaluate the champion
        </Button>
      </PageHeader>

      <div className="space-y-4">
        <ActionResultBanner result={action.last} />

        {champion && (
          <StatGrid>
            <Stat
              label="Champion"
              value={<span className="text-base font-mono">{champion.CONFIG_NAME}</span>}
              tone="good"
              sub={`taxonomy ${champion.TAXONOMY_VERSION_ID}, ${championEvals.length} eval(s)`}
            />
            <Stat
              label="Latest champion accuracy"
              value={fmtMetric(latestChampionEval?.SUBTHEME_ACCURACY)}
              sub={
                latestChampionEval
                  ? String(latestChampionEval.EVALUATED_AT).slice(0, 16).replace("T", " ")
                  : "not evaluated"
              }
            />
            <Stat
              label="Drift check"
              value={latestGate ? <GateBadge result={latestGate.GATE_RESULT} /> : "-"}
              sub={
                latestGate?.BASELINE_EVAL_ID
                  ? "vs the champion's previous eval"
                  : "absolute checks only until the champion has two evals"
              }
            />
            <Stat
              label="Gap signals"
              value={fmtInt(gapReview.length)}
              tone={gapReview.length > 0 ? "warn" : "default"}
              sub="production encounters, NO_GOOD_MATCH or LOW"
            />
          </StatGrid>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Gap queue */}
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Gap review queue ({gapReview.length})</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    The enum makes an invented label impossible, and NO_GOOD_MATCH
                    turns what would have been noise into a countable gap signal.
                    Gaps need volume: classify the backlog before proposing.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={action.pending || gapReview.length === 0}
                    onClick={() =>
                      action.run({
                        proc: "proposeTaxonomyRevision",
                        params: { model: TAXONOMY_MODEL, createdBy: DEMO_USER },
                      })
                    }
                  >
                    {action.pending ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <GitBranch className="h-3 w-3 mr-1" />
                    )}
                    Propose revision
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    disabled={action.pending || gapReview.length === 0}
                    onClick={() =>
                      action.run({
                        proc: "queueGapEncounters",
                        params: { reason: "gap review from the app" },
                      })
                    }
                  >
                    Queue
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    disabled={action.pending}
                    title="Production re-run of the queued encounters with the champion"
                    onClick={() =>
                      action.run({
                        proc: "runClassifier",
                        params: { scope: "RECLASSIFY", limit: 0 },
                      })
                    }
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Re-run queued
                  </Button>
                </div>
              </div>
              {action.last?.ok && action.last.proc === "proposeTaxonomyRevision" && (
                <Link
                  href="/build"
                  className="inline-flex items-center text-xs text-primary hover:underline"
                >
                  Review, edit and lock the draft in the Config Builder
                  <ArrowRight className="h-3 w-3 ml-0.5" />
                </Link>
              )}
            </CardHeader>
            <CardContent>
              {data.isLoading ? (
                <Skeleton className="h-40" />
              ) : gapReview.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  No gap signals. Either the taxonomy covers production, or the
                  champion has not classified anything yet (page 4).
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {gapReview.map((g) => (
                    <div key={g.ENCOUNTER_ID} className="rounded-md border border-border p-2 text-xs">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Badge
                          className={cn(
                            "text-[9px] px-1.5 py-0",
                            g.GAP_SIGNAL === "NO_GOOD_MATCH"
                              ? "bg-amber-500 hover:bg-amber-500"
                              : "bg-red-600 hover:bg-red-600",
                          )}
                        >
                          {g.GAP_SIGNAL}
                        </Badge>
                        <span className="font-mono text-[10px]">{g.ENCOUNTER_ID}</span>
                        {g.FORCED_LABEL !== "NO_GOOD_MATCH" && (
                          <span className="text-[10px] text-muted-foreground">
                            forced into <span className="font-mono">{g.FORCED_LABEL}</span>
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground line-clamp-2 leading-snug">
                        {g.NOTE_TEXT}
                      </p>
                      {g.EVIDENCE && (
                        <p className="text-[10px] text-foreground/70 mt-1 italic leading-snug">
                          {g.EVIDENCE}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Evaluation history */}
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Every evaluation</CardTitle>
              <p className="text-xs text-muted-foreground">
                Unplaceable gold is the gold encounters the reference labeler
                could not fit into that taxonomy. Closing a gap should take it
                toward zero without hurting the weakest gated segment.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {scorecards.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  No evaluations yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Config / taxonomy</TableHead>
                      <TableHead className="w-14">Acc.</TableHead>
                      <TableHead className="w-16">Unplaceable</TableHead>
                      <TableHead>Weakest gated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scorecards.map((s) => {
                      const sum = summaryByEval.get(s.EVAL_ID)
                      const unplaceable = Number(sum?.UNPLACEABLE_GOLD ?? 0)
                      return (
                        <TableRow key={s.EVAL_ID}>
                          <TableCell className="text-[11px] font-mono">
                            {s.CONFIG_NAME}
                            {s.IS_CHAMPION && (
                              <Badge className="ml-1 text-[9px] px-1 py-0 bg-emerald-600 hover:bg-emerald-600">
                                champ
                              </Badge>
                            )}
                            <div className="text-muted-foreground">
                              {s.TAXONOMY_VERSION_ID} | {String(s.EVALUATED_AT).slice(5, 16).replace("T", " ")}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            <AccCell v={s.SUBTHEME_ACCURACY} />
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-xs tabular-nums font-semibold",
                              unplaceable > 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {fmtInt(unplaceable)}
                          </TableCell>
                          <TableCell className="text-[10px]">
                            <span className="font-mono">{sum?.WEAKEST_SEGMENT ?? "-"}</span>{" "}
                            <span className="tabular-nums font-semibold">
                              {fmtMetric(sum?.WEAKEST_ACCURACY)}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* TEST DATA: how the engineered difficulty scored */}
        <Card className="shadow-none border-amber-500/40">
          <CardHeader className="pb-2 space-y-1.5">
            <CardTitle className="text-sm">How each test scenario scored</CardTitle>
            <p className="text-xs text-muted-foreground max-w-3xl">
              Shows that the synthetic data is challenging, and whether a
              revision fixed what it targeted. Each gold note was generated from
              one of these scenarios (see the Explore page). The tag does not
              exist on real data, so nothing above uses it and the gate never
              reads it.
            </p>
            <TestDataSource objects={TEST_DATA_SOURCES.monitor} />
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {evalsAsc.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                Needs at least one evaluation.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Test scenario</TableHead>
                    <TableHead className="w-12">n</TableHead>
                    {evalsAsc.map((c) => (
                      <TableHead key={c.EVAL_ID} className="w-28 font-mono text-[10px] leading-tight">
                        {c.CONFIG_NAME}
                        <div className="text-muted-foreground">{c.TAXONOMY_VERSION_ID}</div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SCENARIO_ORDER.map((sc) => {
                    const n = evalsAsc
                      .map((c) => scenarioCell(c.EVAL_ID, sc)?.N)
                      .find((v) => v != null)
                    return (
                      <TableRow key={sc}>
                        <TableCell className="text-xs font-mono">{sc}</TableCell>
                        <TableCell className="text-xs tabular-nums text-muted-foreground">
                          {fmtInt(n)}
                        </TableCell>
                        {evalsAsc.map((c) => (
                          <TableCell key={c.EVAL_ID} className="text-xs">
                            <AccCell v={scenarioCell(c.EVAL_ID, sc)?.SUBTHEME_ACCURACY} />
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
            <p className="text-[11px] text-muted-foreground mt-3">
              Low-confidence rate per scenario is in{" "}
              <span className="font-mono">TEST_SCENARIO_SCORECARD</span>; NO_GOOD_MATCH
              rate per eval is {fmtPct(latestChampionEval?.NO_GOOD_MATCH_RATE)} for the
              latest champion eval.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

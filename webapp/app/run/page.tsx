"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useEffect, useState } from "react"
import { PageHeader } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt, fmtMetric } from "@/components/stat"
import { SOURCES } from "@/lib/queries"
import { RUN_PRESETS } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
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
import { Play, Loader2, ShieldCheck, AlertTriangle, Gauge } from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

const CONF_STYLE: Record<string, string> = {
  HIGH: "bg-emerald-600 hover:bg-emerald-600 text-white",
  MEDIUM: "bg-amber-500 hover:bg-amber-500 text-white",
  LOW: "bg-red-600 hover:bg-red-600 text-white",
}

export default function RunPage() {
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const action = useAction({ invalidate: [["runs"], ["production"], ["eval"]] })

  // Poll run history. While a classification is in flight, poll fast so the
  // RUNNING row and its climbing duration are visible.
  const runs = useQuery<Row[]>({
    queryKey: ["runs"],
    queryFn: () => fetch("/api/runs").then((r) => r.json()),
    refetchInterval: action.pending ? 2000 : false,
  })

  // Local stopwatch, because the request itself blocks for the whole run.
  useEffect(() => {
    if (!action.pending) {
      setElapsed(0)
      return
    }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [action.pending])

  const runList = Array.isArray(runs.data) ? runs.data : []
  const latest = runList[0]
  const currentRunId = selectedRun ?? latest?.RUN_ID ?? null
  const current = runList.find((r) => r.RUN_ID === currentRunId) ?? latest

  const results = useQuery<{ labels: Row[]; errors: Row[] }>({
    queryKey: ["classifications", currentRunId],
    queryFn: () =>
      fetch(
        `/api/classifications?runId=${encodeURIComponent(currentRunId!)}&limit=200`,
      ).then((r) => r.json()),
    enabled: !!currentRunId,
  })

  const production = useQuery<Row | null>({
    queryKey: ["production"],
    queryFn: () => fetch("/api/runs?production=1").then((r) => r.json()),
    refetchInterval: action.pending ? 4000 : false,
  })
  const champ = production.data

  return (
    <div>
      <PageHeader
        title="Run production classification"
        description="Production always runs the champion config: the one promoted on page 3. Each run is one set-based AI_COMPLETE call over the whole batch; Cortex parallelises internally, so no client-side chunking is needed. Candidates never run here; their gold-set runs are evaluations and never become business output."
        objects={SOURCES.run}
      />

      <div className="space-y-4">
        {/* Launcher */}
        <Card className="shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Start a production run</CardTitle>
            {champ ? (
              <p className="text-xs text-muted-foreground">
                Champion <span className="font-mono">{champ.CHAMPION}</span> (
                {champ.MODEL}, taxonomy{" "}
                <span className="font-mono">{champ.CHAMPION_TAXONOMY}</span>).{" "}
                <span className="font-semibold text-foreground">
                  {fmtInt(champ.BACKLOG)} of {fmtInt(champ.ENCOUNTERS)}
                </span>{" "}
                encounters have no production label from it yet. BACKLOG means
                exactly that, so a promotion resets it to the whole corpus and
                re-running picks up where it stopped.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No champion yet.{" "}
                <Link href="/evaluate" className="text-primary hover:underline">
                  Evaluate and promote a config
                </Link>{" "}
                first.
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {RUN_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant={p.key === "sample" ? "default" : "outline"}
                  disabled={action.pending || !champ || Number(champ.BACKLOG) === 0}
                  onClick={() =>
                    action.run({
                      proc: "runClassifier",
                      params: { scope: p.scope, limit: p.limit },
                    })
                  }
                  className="h-auto flex-col items-start py-1.5 px-3 gap-0.5"
                >
                  <span className="flex items-center gap-1.5 text-xs font-semibold">
                    {action.pending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    {p.label}
                  </span>
                  <span className="text-[10px] font-normal opacity-80">
                    {p.blurb}
                  </span>
                </Button>
              ))}
            </div>

            {action.pending && (
              <Alert>
                <Loader2 className="h-4 w-4 animate-spin" />
                <AlertDescription className="text-xs">
                  Classifying. {elapsed}s elapsed. The run row appears in the
                  history below as soon as the procedure starts, before the
                  model call returns.
                </AlertDescription>
              </Alert>
            )}

            <ActionResultBanner result={action.last} />
          </CardContent>
        </Card>

        {/* Headline tiles for the selected run */}
        {current && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Selected run <span className="font-mono">{current.RUN_ID}</span>
            </span>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                current.PURPOSE === "EVALUATION" && "border-blue-500 text-blue-600",
              )}
            >
              {current.PURPOSE}
            </Badge>
            {current.PURPOSE === "PRODUCTION" && current.RUN_STATUS === "COMPLETE" && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px] ml-auto"
                disabled={action.pending}
                title="RUN_EVAL refuses runs that did not attempt every gold encounter, because the rest would score as wrong"
                onClick={() =>
                  action.run({
                    proc: "runEval",
                    params: { runId: current.RUN_ID, verifiedOnly: false },
                  })
                }
              >
                <Gauge className="h-3 w-3 mr-1" />
                Score this run on gold
              </Button>
            )}
          </div>
        )}
        {current && (
          <StatGrid>
            <Stat
              label="Out-of-taxonomy labels"
              value={fmtInt(current.OUT_OF_TAXONOMY_LABELS ?? 0)}
              tone={
                Number(current.OUT_OF_TAXONOMY_LABELS ?? 0) === 0
                  ? "good"
                  : "bad"
              }
              sub="computed live against the run's own taxonomy version"
            />
            <Stat
              label="Encounters / labels"
              value={`${fmtInt(current.ENCOUNTERS_IN)} / ${fmtInt(current.LABELS_OUT)}`}
              sub={`${fmtMetric(current.LABELS_PER_ENCOUNTER)} labels per encounter`}
            />
            <Stat
              label="Wall clock"
              value={`${fmtInt(current.DURATION_SEC)}s`}
              sub={
                current.RUN_STATUS === "RUNNING"
                  ? "still running"
                  : `${current.MODE} mode, ${current.MODEL}`
              }
            />
            <Stat
              label="Credits"
              value={
                current.COST_PENDING
                  ? "pending"
                  : fmtMetric(current.TOKEN_CREDITS)
              }
              tone={current.COST_PENDING ? "default" : "default"}
              sub={
                current.COST_PENDING
                  ? "ACCOUNT_USAGE lags a few minutes, then backfills"
                  : `${fmtInt(current.TOKENS_PER_ENCOUNTER)} tokens/encounter, ${fmtMetric(current.CREDITS_PER_1K_ENCOUNTERS)} per 1k`
              }
            />
          </StatGrid>
        )}

        {current && Number(current.OUT_OF_TAXONOMY_LABELS ?? 0) === 0 && (
          <Alert className="border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/30">
            <ShieldCheck className="h-4 w-4 !text-emerald-600" />
            <AlertDescription className="text-xs text-emerald-900 dark:text-emerald-200 leading-relaxed">
              <span className="font-semibold">Zero out-of-taxonomy labels.</span>{" "}
              Not a quality result, a structural one: the subtheme list is an
              enum in the response_format, so an invented label cannot be
              returned and no post-processing is needed to map labels back onto
              the taxonomy.
              {Number(current.NO_GOOD_MATCH_LABELS ?? 0) > 0 && (
                <>
                  {" "}
                  {fmtInt(current.NO_GOOD_MATCH_LABELS)} encounters returned
                  NO_GOOD_MATCH, the intended fallback: a countable taxonomy-gap
                  signal rather than unusable noise.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {current && Number(current.ERROR_COUNT ?? 0) > 0 && (
          <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/30">
            <AlertTriangle className="h-4 w-4 !text-amber-600" />
            <AlertDescription className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              <span className="font-semibold">
                {fmtInt(current.ERROR_COUNT)} encounters errored.
              </span>{" "}
              Shown rather than hidden: these are the API guardrail rejecting a
              malformed label, not a silent data-quality problem. There is no
              retry in this build; errored encounters stay in the backlog, so
              the next BACKLOG run picks them up.
              {(results.data?.errors ?? []).length > 0 && (
                <div className="mt-1.5 font-mono text-[10px] space-y-0.5">
                  {(results.data?.errors ?? []).slice(0, 3).map((e) => (
                    <div key={e.ENCOUNTER_ID}>
                      {e.ENCOUNTER_ID}: {String(e.ERROR).slice(0, 160)}
                    </div>
                  ))}
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-5">
          {/* Run history */}
          <Card className="lg:col-span-2 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Run history</CardTitle>
              <p className="text-xs text-muted-foreground">
                Production and evaluation runs, each stamped with the config and
                taxonomy version that produced it.
              </p>
            </CardHeader>
            <CardContent className="space-y-1.5 max-h-[520px] overflow-y-auto">
              {runs.isLoading ? (
                <Skeleton className="h-24" />
              ) : runList.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  No runs yet. Start one above.
                </p>
              ) : (
                runList.map((r) => (
                  <button
                    key={r.RUN_ID}
                    onClick={() => setSelectedRun(r.RUN_ID)}
                    className={cn(
                      "w-full text-left rounded-md border p-2 transition-colors",
                      currentRunId === r.RUN_ID
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {r.MODE}
                      </Badge>
                      {r.PURPOSE === "EVALUATION" && (
                        <Badge
                          variant="outline"
                          className="text-[10px] border-blue-500 text-blue-600"
                        >
                          eval
                        </Badge>
                      )}
                      {r.RUN_STATUS === "RUNNING" && (
                        <Badge className="text-[10px] bg-blue-600 hover:bg-blue-600">
                          running
                        </Badge>
                      )}
                      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                        {fmtInt(r.ENCOUNTERS_IN)} enc / {fmtInt(r.DURATION_SEC)}s
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
                      {r.RUN_ID}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 flex gap-2">
                      <span>{r.TAXONOMY_VERSION_ID}</span>
                      <span>{r.CONFIG_NAME}</span>
                      {Number(r.ERROR_COUNT ?? 0) > 0 && (
                        <span className="text-amber-600">
                          {r.ERROR_COUNT} err
                        </span>
                      )}
                      {r.GATE_RESULT && (
                        <span
                          className={
                            r.GATE_RESULT === "PASS"
                              ? "text-emerald-600"
                              : "text-red-600"
                          }
                        >
                          {r.GATE_RESULT.split(":")[0]}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          {/* Labels */}
          <Card className="lg:col-span-3 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Labels{currentRunId ? "" : " (select a run)"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                The model picks a subtheme only. Theme and category are derived
                deterministically from a lookup, which removes theme/subtheme
                mismatch as a failure mode. Evidence is required, which is what
                makes review possible.
              </p>
            </CardHeader>
            <CardContent>
              {!currentRunId ? (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  No run selected.
                </p>
              ) : results.isLoading ? (
                <Skeleton className="h-64" />
              ) : (
                <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Encounter</TableHead>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead className="w-48">Subtheme</TableHead>
                        <TableHead className="w-40">Theme (derived)</TableHead>
                        <TableHead className="w-20">Conf.</TableHead>
                        <TableHead>Evidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(results.data?.labels ?? []).map((l, i) => (
                        <TableRow key={`${l.ENCOUNTER_ID}-${l.LABEL_RANK}-${i}`} className="align-top">
                          <TableCell className="font-mono text-[11px]">
                            {l.ENCOUNTER_ID}
                            {l.IS_GOLD && (
                              <Badge
                                variant="secondary"
                                className="ml-1 text-[9px] px-1 py-0"
                              >
                                gold
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-[11px] tabular-nums text-muted-foreground">
                            {l.LABEL_RANK}
                          </TableCell>
                          <TableCell className="text-[11px] font-mono">
                            {l.SUBTHEME === "NO_GOOD_MATCH" ? (
                              <Badge className="text-[10px] bg-amber-500 hover:bg-amber-500">
                                NO_GOOD_MATCH
                              </Badge>
                            ) : (
                              l.SUBTHEME
                            )}
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {l.THEME ?? "-"}
                          </TableCell>
                          <TableCell>
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
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground max-w-md leading-snug">
                            {l.EVIDENCE}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {(results.data?.labels ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground py-8 text-center">
                      This run produced no labels.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

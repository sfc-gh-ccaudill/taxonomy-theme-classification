"use client"

import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { PageHeader } from "@/components/sql-source"
import { Stat, StatGrid, fmtInt, fmtMetric, fmtPct } from "@/components/stat"
import { SOURCES } from "@/lib/queries"
import { DEMO_USER, LABELER_MODEL } from "@/lib/constants"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import {
  AccCell,
  GateBadge,
  SEGMENT_GROUPS,
  SegmentCompareTable,
} from "@/components/eval-widgets"
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
import { CheckCircle2, XCircle, Gauge, Loader2, Rocket, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

export default function EvaluatePage() {
  const [selected, setSelected] = useState<string | null>(null)
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [promotedBy, setPromotedBy] = useState(DEMO_USER)
  const [overrideReason, setOverrideReason] = useState("")
  const [elapsed, setElapsed] = useState(0)

  const data = useQuery<{
    leaderboard: Row[]
    gate: Row[]
    gateConfig: Row | null
    promotionLog: Row[]
  }>({
    queryKey: ["eval"],
    queryFn: () => fetch("/api/eval").then((r) => r.json()),
  })

  const action = useAction({
    invalidate: [["eval"], ["configs"], ["taxonomy"], ["runs"], ["production"]],
  })

  // /evaluate?config=NAME (from the config builder) preselects that config.
  // Read once on mount; useSearchParams would need a Suspense boundary.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("config")
    if (c) setSelected(c)
  }, [])

  useEffect(() => {
    if (!action.pending) {
      setElapsed(0)
      return
    }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [action.pending])

  const board = data.data?.leaderboard ?? []
  const champion = board.find((c) => c.IS_ACTIVE)
  const defaultPick = board.find((c) => !c.IS_ACTIVE) ?? board[0]
  const currentName = selected ?? defaultPick?.CONFIG_NAME
  const current = board.find((c) => c.CONFIG_NAME === currentName)
  const gateCfg = data.data?.gateConfig
  const passed = current?.GATE_RESULT === "PASS"
  const needsGold = current && Number(current.GOLD_LABELED ?? 0) === 0
  const taxonomyDraft = current?.TAXONOMY_STATUS === "DRAFT"

  const evalIds = [current?.EVAL_ID, current?.BASELINE_EVAL_ID].filter(Boolean) as string[]
  const segments = useQuery<{ segments: Row[] }>({
    queryKey: ["eval-segments", ...evalIds],
    queryFn: () =>
      fetch(`/api/eval?evalIds=${encodeURIComponent(evalIds.join(","))}`).then((r) => r.json()),
    enabled: evalIds.length > 0,
  })
  const segmentRows = segments.data?.segments ?? []

  useEffect(() => setOverrideReason(""), [currentName])

  return (
    <div>
      <PageHeader
        title="Evaluate and promote"
        description="The register, evaluate, promote loop of an ML model registry. Each candidate config is scored on the gold set with exactly the prompt, model and taxonomy it would ship with, then gated against the champion: an absolute floor plus a per-segment regression check. Promotion is the only way into production. A failing gate can be overridden, but only with a recorded reason."
        objects={SOURCES.evaluate}
      >
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(e) => setVerifiedOnly(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          SME-verified gold only
        </label>
      </PageHeader>

      <div className="space-y-4">
        {action.pending && (
          <Alert>
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription className="text-xs">
              Working. {elapsed}s elapsed.
              {needsGold &&
                " This taxonomy has no gold labels yet, so the gold set is labeled first (~200 frontier-model calls, a couple of minutes), then classified and scored."}
            </AlertDescription>
          </Alert>
        )}
        <ActionResultBanner result={action.last} />

        {verifiedOnly && (
          <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/30">
            <AlertDescription className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              <span className="font-semibold">Verified-only is on.</span> Gold
              labels in this build are bootstrapped by a frontier model from a
              different family than the classifier, not adjudicated by a nurse
              SME. With no rows marked HUMAN_VERIFIED yet, evaluation will refuse,
              which is the correct outcome.
            </AlertDescription>
          </Alert>
        )}

        {/* Leaderboard */}
        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Candidates vs the champion</CardTitle>
            <p className="text-xs text-muted-foreground">
              Every runnable config with its latest evaluation and that
              evaluation&apos;s verdict against the current champion. Click one to
              evaluate or promote it.
            </p>
          </CardHeader>
          <CardContent>
            {data.isLoading ? (
              <Skeleton className="h-28" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Config</TableHead>
                    <TableHead className="w-28">Taxonomy</TableHead>
                    <TableHead className="w-20">Subtheme</TableHead>
                    <TableHead className="w-20">Theme</TableHead>
                    <TableHead className="w-16">F1</TableHead>
                    <TableHead className="w-16">NGM</TableHead>
                    <TableHead className="w-44">Gate vs champion</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.map((c) => (
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
                        {c.IS_ACTIVE && (
                          <Badge className="ml-1.5 text-[9px] px-1 py-0 bg-emerald-600 hover:bg-emerald-600">
                            champion
                          </Badge>
                        )}
                        <div className="font-sans font-normal text-[10px] text-muted-foreground">
                          {c.MODEL}
                          {c.EVAL_COUNT > 0 && `, ${c.EVAL_COUNT} eval${c.EVAL_COUNT > 1 ? "s" : ""}`}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {c.TAXONOMY_VERSION_ID}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {String(c.TAXONOMY_STATUS ?? "").toLowerCase()}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <AccCell v={c.SUBTHEME_ACCURACY} />
                      </TableCell>
                      <TableCell className="text-xs">
                        <AccCell v={c.THEME_ACCURACY} bold={false} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {fmtMetric(c.LABEL_SET_F1)}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {fmtPct(c.NO_GOOD_MATCH_RATE)}
                      </TableCell>
                      <TableCell>
                        {c.IS_ACTIVE && c.EVAL_ID ? (
                          <span className="text-[10px] text-muted-foreground">
                            the baseline
                          </span>
                        ) : (
                          <GateBadge result={c.GATE_RESULT} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {current && (
          <>
            {/* Selected candidate: evaluate + verdict + promote */}
            <div className="grid gap-6 lg:grid-cols-5">
              <Card
                className={cn(
                  "lg:col-span-3 shadow-none border-l-4",
                  !current.EVAL_ID
                    ? "border-l-border"
                    : passed
                      ? "border-l-emerald-600"
                      : "border-l-red-600",
                )}
              >
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-sm font-mono">{current.CONFIG_NAME}</CardTitle>
                    <Button
                      size="sm"
                      variant={current.EVAL_ID ? "outline" : "default"}
                      className="h-7 text-[11px]"
                      disabled={action.pending || taxonomyDraft}
                      onClick={() =>
                        action.run({
                          proc: "evaluateConfig",
                          params: {
                            configName: current.CONFIG_NAME,
                            labelerModel: LABELER_MODEL,
                            verifiedOnly,
                          },
                        })
                      }
                    >
                      {action.pending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Gauge className="h-3 w-3 mr-1" />
                      )}
                      {current.EVAL_ID ? "Re-evaluate" : "Evaluate on gold"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {current.MODEL} on taxonomy{" "}
                    <span className="font-mono">{current.TAXONOMY_VERSION_ID}</span> (
                    {String(current.TAXONOMY_STATUS).toLowerCase()}).{" "}
                    {taxonomyDraft
                      ? "Its taxonomy is still a DRAFT: lock it in the Config Builder before evaluating."
                      : needsGold
                        ? `No gold labels for ${current.TAXONOMY_VERSION_ID} yet: the first evaluation labels them with ${LABELER_MODEL}, then scores.`
                        : `Gold labels for ${current.TAXONOMY_VERSION_ID} exist (${fmtInt(current.GOLD_LABELED)} encounters), so an evaluation is one gold classification run.`}
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!current.EVAL_ID ? (
                    <p className="text-xs text-muted-foreground py-4">
                      Not evaluated yet.
                    </p>
                  ) : (
                    <>
                      <div className="flex items-start gap-3">
                        {passed ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                        )}
                        <div className="space-y-1 min-w-0">
                          <div className="text-sm font-semibold">{current.GATE_RESULT}</div>
                          {current.GATE_NOTE && (
                            <p className="text-xs text-muted-foreground">{current.GATE_NOTE}</p>
                          )}
                          {current.REGRESSED_DETAIL && (
                            <p className="text-xs text-red-600 dark:text-red-400 font-mono leading-relaxed">
                              Regressed: {current.REGRESSED_DETAIL}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            Absolute: subtheme accuracy at least{" "}
                            {fmtMetric(gateCfg?.MIN_PRIMARY_ACCURACY)}, error rate under{" "}
                            {fmtPct(gateCfg?.MAX_ERROR_RATE)}, zero out-of-taxonomy
                            labels. Regression: no segment with n of at least{" "}
                            {fmtInt(gateCfg?.MIN_SEGMENT_N)} drops more than{" "}
                            {fmtMetric(gateCfg?.MAX_SEGMENT_REGRESSION)} below the
                            champion.
                          </p>
                        </div>
                      </div>
                      <StatGrid>
                        <Stat
                          label="Candidate"
                          value={fmtMetric(current.SUBTHEME_ACCURACY)}
                          tone={passed ? "good" : "warn"}
                          sub="primary subtheme accuracy"
                        />
                        <Stat
                          label="Champion"
                          value={fmtMetric(current.BASELINE_SUBTHEME_ACCURACY)}
                          sub={current.BASELINE_CONFIG_NAME ?? "no champion eval"}
                        />
                        <Stat
                          label="Out-of-taxonomy"
                          value={fmtInt(current.OUT_OF_TAXONOMY_LABELS ?? 0)}
                          tone={Number(current.OUT_OF_TAXONOMY_LABELS ?? 0) === 0 ? "good" : "bad"}
                          sub="structurally zero"
                        />
                        <Stat
                          label="Segments regressed"
                          value={fmtInt(current.SEGMENTS_REGRESSED ?? 0)}
                          tone={Number(current.SEGMENTS_REGRESSED ?? 0) === 0 ? "good" : "bad"}
                          sub="gated segments only"
                        />
                      </StatGrid>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card className="lg:col-span-2 shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Promote to production</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Makes this config the champion and its taxonomy the approved
                    one, in one transaction. It does not re-classify anything:
                    backfilling with the new champion is an explicit run on page 4.
                  </p>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  {current.IS_ACTIVE ? (
                    <Badge className="bg-emerald-600 hover:bg-emerald-600">
                      This is the champion
                    </Badge>
                  ) : (
                    <>
                      <input
                        value={promotedBy}
                        onChange={(e) => setPromotedBy(e.target.value)}
                        placeholder="promoted by"
                        className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      {current.EVAL_ID && !passed && (
                        <>
                          <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 py-2">
                            <ShieldAlert className="h-4 w-4 !text-amber-600" />
                            <AlertDescription className="text-[11px] text-amber-900 dark:text-amber-200">
                              The gate did not pass. Promoting anyway needs a
                              reason, and it is recorded in PROMOTION_LOG with
                              the verdict it overrode.
                            </AlertDescription>
                          </Alert>
                          <textarea
                            value={overrideReason}
                            onChange={(e) => setOverrideReason(e.target.value)}
                            placeholder="reason for overriding the gate"
                            className="w-full h-16 rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                          />
                        </>
                      )}
                      <Button
                        size="sm"
                        className={cn(
                          "w-full h-8 text-xs",
                          current.EVAL_ID && !passed && "bg-amber-600 hover:bg-amber-700",
                        )}
                        disabled={
                          action.pending ||
                          !current.EVAL_ID ||
                          !promotedBy.trim() ||
                          (!passed && !overrideReason.trim())
                        }
                        onClick={() =>
                          action.run({
                            proc: "promoteConfig",
                            params: {
                              configName: current.CONFIG_NAME,
                              promotedBy: promotedBy.trim(),
                              overrideReason: passed ? "" : overrideReason.trim(),
                            },
                          })
                        }
                      >
                        <Rocket className="h-3.5 w-3.5 mr-1" />
                        {!current.EVAL_ID
                          ? "Evaluate first"
                          : passed
                            ? "Promote to production"
                            : "Promote with override"}
                      </Button>
                      {champion && (
                        <p className="text-[11px] text-muted-foreground">
                          Replaces{" "}
                          <span className="font-mono">{champion.CONFIG_NAME}</span> on{" "}
                          <span className="font-mono">{champion.TAXONOMY_VERSION_ID}</span>.
                          The previous champion stays registered, so rolling back
                          is a promotion too.
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Segment comparison */}
            {current.EVAL_ID && (
              <div className="grid gap-6 lg:grid-cols-5">
                <Card className="lg:col-span-3 shadow-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">{SEGMENT_GROUPS[0].label}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Where failures tend to concentrate, side by side with the
                      champion. {SEGMENT_GROUPS[0].blurb} Across a taxonomy change
                      segment membership can shift, which the n column shows.
                    </p>
                  </CardHeader>
                  <CardContent>
                    <SegmentCompareTable
                      rows={segmentRows.filter((s) => s.SEGMENT_NAME === "CATEGORY")}
                      candidateEvalId={current.EVAL_ID}
                      baselineEvalId={current.BASELINE_EVAL_ID}
                      maxRegression={gateCfg?.MAX_SEGMENT_REGRESSION}
                      loading={segments.isLoading}
                    />
                  </CardContent>
                </Card>
                <div className="lg:col-span-2 space-y-6">
                  {SEGMENT_GROUPS.slice(1).map((g) => (
                    <Card key={g.name} className="shadow-none">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">{g.label}</CardTitle>
                        <p className="text-xs text-muted-foreground">{g.blurb}</p>
                      </CardHeader>
                      <CardContent>
                        <SegmentCompareTable
                          rows={segmentRows.filter((s) => s.SEGMENT_NAME === g.name)}
                          candidateEvalId={current.EVAL_ID}
                          baselineEvalId={current.BASELINE_EVAL_ID}
                          maxRegression={gateCfg?.MAX_SEGMENT_REGRESSION}
                          loading={segments.isLoading}
                        />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Promotion log */}
        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Promotion log</CardTitle>
            <p className="text-xs text-muted-foreground">
              Every change to production, with the evaluation it was judged on
              and the champion it was judged against, frozen at the time. Override
              rows deserve the closest review.
            </p>
          </CardHeader>
          <CardContent>
            {(data.data?.promotionLog ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No promotions yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">When</TableHead>
                    <TableHead>Promoted</TableHead>
                    <TableHead>Replaced</TableHead>
                    <TableHead className="w-28">Acc. vs champ.</TableHead>
                    <TableHead className="w-40">Gate</TableHead>
                    <TableHead>Override</TableHead>
                    <TableHead className="w-24">By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data.data?.promotionLog ?? []).map((p) => (
                    <TableRow key={p.PROMOTION_ID}>
                      <TableCell className="text-[11px] font-mono text-muted-foreground">
                        {String(p.PROMOTED_AT).slice(0, 16).replace("T", " ")}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {p.CONFIG_NAME}
                        <span className="text-muted-foreground"> / {p.TAXONOMY_VERSION_ID}</span>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {p.PREVIOUS_CONFIG_NAME ?? "-"}
                        {p.PREVIOUS_TAXONOMY_VERSION_ID && ` / ${p.PREVIOUS_TAXONOMY_VERSION_ID}`}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {fmtMetric(p.SUBTHEME_ACCURACY)} vs{" "}
                        {fmtMetric(p.BASELINE_SUBTHEME_ACCURACY)}
                      </TableCell>
                      <TableCell>
                        <GateBadge result={p.GATE_RESULT} />
                      </TableCell>
                      <TableCell className="text-[11px] text-amber-700 dark:text-amber-400 min-w-[16rem] max-w-md">
                        {p.OVERRIDE_REASON ?? ""}
                      </TableCell>
                      <TableCell className="text-[11px]">{p.PROMOTED_BY}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

import { Badge } from "@/components/ui/badge"
import { Database, FlaskConical } from "lucide-react"

/**
 * Names the SQL objects a page reads from, so every panel shows which governed
 * Snowflake objects back it and where to look to change its behaviour.
 */
export function SqlSource({ objects }: { objects: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Database className="h-3 w-3 shrink-0" />
      <span className="mr-0.5">Backed by</span>
      {objects.map((o) => (
        <Badge
          key={o}
          variant="secondary"
          className="font-mono text-[10px] font-normal px-1.5 py-0"
        >
          {o}
        </Badge>
      ))}
    </div>
  )
}

/**
 * Marks a panel that reads the synthetic-data schema. Used on every such
 * panel so it is never confused with something the pipeline computes.
 */
export function TestDataSource({ objects }: { objects: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
      <FlaskConical className="h-3 w-3 shrink-0" />
      <span className="mr-0.5">Test data only, not part of the pipeline:</span>
      {objects.map((o) => (
        <Badge
          key={o}
          variant="outline"
          className="font-mono text-[10px] font-normal px-1.5 py-0 border-amber-500/50 text-amber-700 dark:text-amber-400"
        >
          {o}
        </Badge>
      ))}
    </div>
  )
}

/** Page title block with the source list underneath. */
export function PageHeader({
  title,
  description,
  objects,
  children,
}: {
  title: string
  description: string
  objects: readonly string[]
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4 mb-6">
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">{description}</p>
        <SqlSource objects={objects} />
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

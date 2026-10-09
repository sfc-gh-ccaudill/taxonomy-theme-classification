/**
 * Server-side data access. The only module that pairs a named query from
 * lib/queries.ts with the Snowflake connection.
 *
 * Why this exists rather than calling querySnowflake directly in each route:
 *  - one place to pin the warehouse
 *  - one place to normalise TIMESTAMP columns (the SDK returns Date objects,
 *    which serialise to locale strings and then sort wrongly)
 *  - one place that decides long-running vs normal, driven by the proc registry
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import { PAN_WAREHOUSE } from "@/lib/constants"
import {
  procs,
  type ProcName,
  type Sql,
  type BindValue,
} from "@/lib/queries"

/** Snowflake returns UPPER_CASE column names; rows are plain objects. */
export type Row = Record<string, unknown>

/**
 * The Snowflake Node SDK hands back TIMESTAMP_* columns as JS Date objects.
 * String(date) gives "Tue Oct 06 2026 ..." which breaks both display slicing
 * and chronological sorting, so every Date becomes an ISO string here.
 */
function normalise(rows: Row[]): Row[] {
  return rows.map((row) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(row)) {
      out[k] = v instanceof Date ? v.toISOString() : v
    }
    return out
  })
}

/** Run a named read query. */
export async function read(q: Sql): Promise<Row[]> {
  const rows = (await querySnowflake(q.sql, {
    warehouse: PAN_WAREHOUSE,
    ...(q.binds ? { binds: q.binds } : {}),
  })) as Row[]
  return normalise(rows ?? [])
}

/** Run a read that may be slow (heavy aggregation, warehouse resume). */
export async function readLong(q: Sql): Promise<Row[]> {
  const rows = (await querySnowflakeLongRunning(q.sql, {
    warehouse: PAN_WAREHOUSE,
    ...(q.binds ? { binds: q.binds } : {}),
  })) as Row[]
  return normalise(rows ?? [])
}

/** Raised when a caller supplies a bad or missing procedure argument (maps to HTTP 400). */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArgumentError"
  }
}

/**
 * Coerce a param to something the SDK can bind.
 *
 * `Bind` is `string | number`, so a JS boolean would be rejected. Booleans
 * become 'TRUE'/'FALSE' strings, which the procedure SQL wraps in
 * TO_BOOLEAN(). Null and undefined are not bindable here: every allowlisted
 * procedure takes required arguments, so a missing one is a caller bug and is
 * raised as such.
 */
function toBind(name: string, v: unknown): BindValue {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  if (typeof v === "string" || typeof v === "number") return v
  throw new ArgumentError(
    `Argument '${name}' must be a string, number or boolean (got ${v === null ? "null" : typeof v})`,
  )
}

/**
 * Call an allowlisted procedure.
 *
 * Arguments are supplied as a name->value map and ordered here according to the
 * registry, so a caller cannot reorder or inject them. Anything not in `procs`
 * throws before touching Snowflake.
 */
export async function callProc(
  name: ProcName,
  params: Record<string, unknown>,
): Promise<{ message: string; rows: Row[] }> {
  const def = procs[name]
  if (!def) throw new Error(`Unknown procedure: ${name}`)

  const binds: BindValue[] = def.args.map((argName) => {
    const v = params[argName]
    if (v === undefined) {
      throw new ArgumentError(`Missing argument '${argName}' for ${name}`)
    }
    return toBind(argName, v)
  })

  const runner = def.long ? querySnowflakeLongRunning : querySnowflake
  const rows = normalise(
    ((await runner(def.sql, { warehouse: PAN_WAREHOUSE, binds })) as Row[]) ?? [],
  )

  // A SQL procedure returning VARCHAR comes back as one row, one column.
  const first = rows[0] ?? {}
  const values = Object.values(first)
  const message =
    values.length === 1 && typeof values[0] === "string" ? values[0] : ""

  return { message, rows }
}

/**
 * Procedures in this project return a string beginning "REFUSED:" when a guard
 * rail blocks them. That is a successful call with a rejected request, not an
 * error, so it maps to 409 rather than 500.
 */
export function isRefusal(message: string): boolean {
  return message.trim().toUpperCase().startsWith("REFUSED")
}

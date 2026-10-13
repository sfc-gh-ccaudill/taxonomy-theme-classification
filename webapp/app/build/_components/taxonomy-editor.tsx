"use client"

import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { useAction } from "@/components/use-action"
import { ActionResultBanner } from "@/components/action-result"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Pencil,
  Plus,
  Save,
  Search,
  Signpost,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"

type Row = Record<string, any>

type NodeForm = {
  category: string
  theme: string
  subtheme: string
  description: string
  routingNote: string
}

const EMPTY: NodeForm = { category: "", theme: "", subtheme: "", description: "", routingNote: "" }

const input =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"

/**
 * Compact category > theme > subtheme browser for one taxonomy version.
 * With `editable` (a DRAFT), each subtheme can be edited or deleted and new
 * ones added. Every write goes through EDIT_TAXONOMY_NODE, so the procedure's
 * rules apply here exactly as they do from SQL.
 */
export function TaxonomyEditor({
  versionId,
  editable,
  maxHeight = "max-h-[420px]",
}: {
  versionId: string
  editable: boolean
  /** Tailwind max-height class for the scrolling tree. */
  maxHeight?: string
}) {
  const [filter, setFilter] = useState("")
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<NodeForm>(EMPTY)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<NodeForm>(EMPTY)

  const nodes = useQuery<{ nodes: Row[] }>({
    queryKey: ["taxonomy-nodes", versionId],
    queryFn: () =>
      fetch(`/api/taxonomy?versionId=${encodeURIComponent(versionId)}`).then((r) => r.json()),
    enabled: !!versionId,
  })

  const action = useAction({
    invalidate: [["taxonomy"], ["taxonomy-nodes"], ["taxonomy-diff"], ["taxonomy-rendered"]],
  })

  const all = nodes.data?.nodes ?? []
  const categories = useMemo(() => Array.from(new Set(all.map((n) => n.CATEGORY))).sort(), [all])
  const themes = useMemo(() => Array.from(new Set(all.map((n) => n.THEME))).sort(), [all])

  const q = filter.trim().toLowerCase()
  const tree = useMemo(() => {
    const has = (v: unknown) => String(v ?? "").toLowerCase().includes(q)
    const out: Record<string, Record<string, Row[]>> = {}
    for (const n of all) {
      const keep =
        !q || has(n.CATEGORY) || has(n.THEME) || has(n.SUBTHEME) || has(n.DESCRIPTION) || has(n.ROUTING_NOTE)
      if (!keep) continue
      out[n.CATEGORY] ??= {}
      out[n.CATEGORY][n.THEME] ??= []
      out[n.CATEGORY][n.THEME].push(n)
    }
    return out
  }, [all, q])
  const shown = Object.values(tree).flatMap((t) => Object.values(t)).flat().length
  // A blank subtheme would become a legal enum value, so LOCK_TAXONOMY refuses it.
  const blankCats = Array.from(
    new Set(all.filter((n) => String(n.SUBTHEME ?? "").trim() === "").map((n) => String(n.CATEGORY))),
  )
  const blankCount = all.filter((n) => String(n.SUBTHEME ?? "").trim() === "").length

  async function edit(kind: "ADD" | "UPDATE" | "DELETE", original: string, f: NodeForm) {
    const res = await action.runAsync({
      proc: "editTaxonomyNode",
      params: {
        versionId,
        action: kind,
        originalSubtheme: original,
        category: f.category,
        theme: f.theme,
        subtheme: f.subtheme,
        description: f.description,
        routingNote: f.routingNote,
      },
    })
    if (res.ok) {
      if (kind === "ADD") {
        setAddForm(EMPTY)
        setShowAdd(false)
        setOpenCats((s) => ({ ...s, [f.category]: true }))
        setOpenSub(f.subtheme)
      }
      setEditing(null)
    }
  }

  if (nodes.isLoading) return <Skeleton className="h-48" />

  return (
    <div className="space-y-2">
      <ActionResultBanner result={action.last} />

      {editable && blankCount > 0 && (
        <p className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
          {blankCount} node{blankCount > 1 ? "s have" : " has"} a blank subtheme (in {blankCats.join(", ")}).
          Lock will refuse until it&apos;s named or deleted.
          <button
            className="ml-1 underline hover:no-underline"
            onClick={() =>
              setOpenCats((s) => ({ ...s, ...Object.fromEntries(blankCats.map((c) => [c, true])) }))
            }
          >
            Show {blankCats.length > 1 ? "them" : "it"}
          </button>
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            className={cn(input, "h-8 pl-7 text-xs")}
            placeholder="Find a subtheme by name, description or routing note"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
          {q ? `${shown} of ${all.length}` : `${all.length} subthemes`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-[11px]"
          title="Expand all categories"
          onClick={() => setOpenCats(Object.fromEntries(categories.map((c) => [c, true])))}
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-[11px]"
          title="Collapse all categories"
          onClick={() => {
            setOpenCats({})
            setOpenSub(null)
          }}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" />
        </Button>
        {editable && (
          <Button
            size="sm"
            variant={showAdd ? "secondary" : "outline"}
            className="h-8 text-[11px]"
            onClick={() => setShowAdd((s) => !s)}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add subtheme
          </Button>
        )}
      </div>

      {editable && showAdd && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-2.5 space-y-1.5">
          <NodeFields form={addForm} setForm={setAddForm} categories={categories} themes={themes} id="b-add" />
          <div className="flex gap-1.5 justify-end">
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 text-[11px]"
              disabled={action.pending}
              onClick={() => edit("ADD", "", addForm)}
            >
              <Save className="h-3 w-3 mr-1" />
              Add to {versionId}
            </Button>
          </div>
        </div>
      )}

      <div className={cn("space-y-1 overflow-y-auto pr-1", maxHeight)}>
        {q && shown === 0 && (
          <p className="text-xs text-muted-foreground py-6 text-center">
            Nothing matches &ldquo;{filter.trim()}&rdquo;.
          </p>
        )}
        {Object.entries(tree).map(([cat, catThemes]) => {
          const open = q ? true : (openCats[cat] ?? false)
          const count = Object.values(catThemes).flat().length
          return (
            <div key={cat} className="rounded-md border border-border bg-card">
              <button
                onClick={() => setOpenCats((s) => ({ ...s, [cat]: !open }))}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50 rounded-md"
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                />
                <span className="text-[13px] font-semibold">{cat}</span>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{count}</span>
              </button>
              {open && (
                <div className="border-t border-border px-2.5 py-2 space-y-2">
                  {Object.entries(catThemes).map(([theme, subs]) => (
                    <div key={theme}>
                      <div className="text-[12px] font-semibold text-primary pl-1 mb-0.5">{theme}</div>
                      <div className="ml-1.5 border-l-2 border-primary/25 pl-1.5 space-y-0.5">
                        {subs.map((s) => {
                          const key = String(s.SUBTHEME ?? "")
                          if (editable && editing === key) {
                            return (
                              <div key={`e-${key}`} className="rounded-md border border-primary/40 bg-primary/5 p-2 space-y-1.5">
                                <NodeFields form={editForm} setForm={setEditForm} categories={categories} themes={themes} id="b-edit" />
                                <div className="flex gap-1.5 justify-end">
                                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setEditing(null)}>
                                    Cancel
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-6 text-[11px]"
                                    disabled={action.pending}
                                    onClick={() => edit("UPDATE", key, editForm)}
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
                            <div key={`n-${key}`} className={cn("rounded", isOpen && "bg-muted/60")}>
                              <button
                                onClick={() => setOpenSub(isOpen ? null : key)}
                                title={isOpen ? undefined : s.DESCRIPTION}
                                aria-expanded={isOpen}
                                className="w-full flex items-center gap-1.5 px-1.5 py-0.5 text-left text-xs rounded hover:bg-muted/50"
                              >
                                <ChevronRight
                                  className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", isOpen && "rotate-90")}
                                />
                                <span className={cn("min-w-0", isOpen && "font-medium")}>{key}</span>
                                {s.ROUTING_NOTE && (
                                  <Signpost className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                                )}
                              </button>
                              {isOpen && (
                                <div className="pl-6 pr-2 pb-2 space-y-1.5 text-xs leading-relaxed">
                                  <p className="text-muted-foreground">{s.DESCRIPTION || <em>No description.</em>}</p>
                                  {s.ROUTING_NOTE && (
                                    <p className="rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-amber-900 dark:text-amber-200">
                                      <span className="font-semibold">Routing: </span>
                                      {s.ROUTING_NOTE}
                                    </p>
                                  )}
                                  {editable && (
                                    <div className="flex gap-1.5">
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
                                        onClick={() => edit("DELETE", key, EMPTY)}
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
    </div>
  )
}

/** The five fields of a node. Category and theme suggest existing values. */
function NodeFields({
  form,
  setForm,
  categories,
  themes,
  id,
}: {
  form: NodeForm
  setForm: (f: NodeForm) => void
  categories: string[]
  themes: string[]
  id: string
}) {
  const set = (k: keyof NodeForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <input className={input} list={`${id}-cats`} placeholder="Category" value={form.category} onChange={set("category")} />
        <input className={input} list={`${id}-themes`} placeholder="Theme" value={form.theme} onChange={set("theme")} />
      </div>
      <datalist id={`${id}-cats`}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id={`${id}-themes`}>
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
      <input className={input} placeholder="Description: what belongs here" value={form.description} onChange={set("description")} />
      <input
        className={input}
        placeholder="Routing note: how it differs from its nearest neighbour (optional)"
        value={form.routingNote}
        onChange={set("routingNote")}
      />
    </>
  )
}

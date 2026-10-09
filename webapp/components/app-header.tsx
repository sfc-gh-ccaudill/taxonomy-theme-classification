"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import Image from "next/image"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"

/**
 * The six pages, in workflow order: data -> author a taxonomy -> author a
 * prompt -> evaluate and promote -> run production -> monitor and revise,
 * which loops back to page 2.
 */
const NAV = [
  { href: "/", label: "Explore Data", step: "1" },
  { href: "/taxonomy", label: "Taxonomy", step: "2" },
  { href: "/prompts", label: "Prompts & Configs", step: "3" },
  { href: "/evaluate", label: "Evaluate & Promote", step: "4" },
  { href: "/run", label: "Run Production", step: "5" },
  { href: "/monitor", label: "Monitor & Revise", step: "6" },
]

export function AppHeader() {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background text-foreground">
      <div className="w-full px-4 h-14 flex items-center gap-4">
        {LOGO_SRC && (
          <Image
            src={LOGO_SRC}
            alt={`${APP_TITLE} logo`}
            width={26}
            height={26}
            className="shrink-0"
          />
        )}
        {/* Six pages need the width on laptop screens; the logo carries the brand. */}
        <span className="hidden 2xl:inline text-sm font-semibold tracking-tight shrink-0">
          {APP_TITLE}
        </span>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {NAV.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {item.step}
                </span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto shrink-0">
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}

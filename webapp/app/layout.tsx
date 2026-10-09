import type { Metadata } from "next"
import type React from "react"
import { AppHeader } from "@/components/app-header"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import "./globals.css"

export const metadata: Metadata = {
  title: APP_TITLE,
  description:
    "Free-text post-discharge nurse call notes classified into a governed taxonomy on Snowflake: versioned taxonomy, enum-constrained classification, segment-level evaluation, and a revision loop.",
  icons: { icon: LOGO_SRC },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <QueryProvider>
            <AppHeader />
            <main className="w-full px-6 py-6 max-w-[1600px] mx-auto">
              {children}
            </main>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

import type { Metadata, Viewport } from 'next'
import { ConvexClientProvider } from './ConvexClientProvider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Season One — Claude Leaderboard',
  description: 'Live Claude Code token usage leaderboard',
}

// Without this a phone renders the page at desktop width and shrinks it,
// which is the one thing the narrow layout exists to avoid.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>): React.ReactElement {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  )
}

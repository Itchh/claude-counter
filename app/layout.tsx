import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Season One — Claude Leaderboard',
  description: 'Live Claude Code token usage leaderboard',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>): React.ReactElement {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  )
}

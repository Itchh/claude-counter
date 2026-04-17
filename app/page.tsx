'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import type { LeaderboardEntry } from '@/types'
import { fmtTokens, fmtTokensShort, fmtTime } from '@/lib/formatters'

const FLASH_DURATION = 800
const REFRESH_FLASH_DURATION = 1000
const BAR_LENGTH = 30

function useClockTime(): string {
  const [time, setTime] = useState('')

  useEffect(() => {
    const update = (): void => {
      setTime(
        new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  return time
}

function buildBar(ratio: number): { filled: string; empty: string } {
  const filledCount = Math.round(ratio * BAR_LENGTH)
  return {
    filled: '\u2593'.repeat(filledCount),
    empty: '\u2591'.repeat(BAR_LENGTH - filledCount),
  }
}

function rankColor(rank: number): string {
  if (rank === 1) return '#EF9F27'
  if (rank <= 3) return '#888'
  return '#555'
}

function tokenColor(rank: number): string {
  if (rank === 1) return '#EF9F27'
  if (rank <= 3) return '#BA7517'
  return '#555'
}

function barColor(rank: number): string {
  if (rank === 1) return '#EF9F27'
  if (rank <= 3) return '#BA7517'
  return '#333'
}

function rankNumberColor(rank: number): string {
  if (rank <= 3) return '#EF9F27'
  return '#555'
}

export default function LeaderboardPage(): React.ReactElement {
  const data = useQuery(api.leaderboard.get)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down'>>({})
  const [loaded, setLoaded] = useState(false)
  const prevRanks = useRef<Map<string, number>>(new Map())
  const prevUpdatedAt = useRef<string>('')
  const clock = useClockTime()

  useEffect(() => {
    if (!data) return

    if (prevUpdatedAt.current && data.updatedAt !== prevUpdatedAt.current) {
      setJustRefreshed(true)
      setTimeout(() => setJustRefreshed(false), REFRESH_FLASH_DURATION)
    }
    prevUpdatedAt.current = data.updatedAt

    if (prevRanks.current.size > 0) {
      const flashes: Record<string, 'up' | 'down'> = {}
      for (const entry of data.leaderboard) {
        const key = entry.name.toLowerCase()
        const prev = prevRanks.current.get(key)
        if (prev !== undefined && prev !== entry.rank) {
          flashes[key] = entry.rank < prev ? 'up' : 'down'
        }
      }
      if (Object.keys(flashes).length > 0) {
        setFlashMap(flashes)
        setTimeout(() => setFlashMap({}), FLASH_DURATION)
      }
    }

    const newRanks = new Map<string, number>()
    for (const entry of data.leaderboard) {
      newRanks.set(entry.name.toLowerCase(), entry.rank)
    }
    prevRanks.current = newRanks

    if (!loaded) setLoaded(true)
  }, [data, loaded])

  const maxTokens = data?.leaderboard[0]?.totalTokens ?? 1

  return (
    <div
      style={{
        fontFamily:
          "ui-monospace, 'Cascadia Code', 'Courier New', Courier, monospace",
        background: '#0c0c0c',
        color: '#EF9F27',
        height: '100vh',
        width: '100vw',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes flashUp {
          0% { background: #1D9E75; }
          100% { background: transparent; }
        }
        @keyframes flashDown {
          0% { background: #D85A30; }
          100% { background: transparent; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .flash-up { animation: flashUp 0.8s ease-out; }
        .flash-down { animation: flashDown 0.8s ease-out; }
      `}</style>

      {/* TOP BAR */}
      <div
        style={{
          padding: '20px 36px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: 'clamp(10px, 1.2vw, 14px)',
            letterSpacing: '0.25em',
            color: '#555',
          }}
        >
          SEASON ONE / CLAUDE LEADERBOARD
        </span>
        <span
          style={{
            fontSize: 'clamp(10px, 1.2vw, 14px)',
            color: '#555',
          }}
        >
          {clock}
        </span>
      </div>

      {/* LEADERBOARD */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 'clamp(10px, 1.8vh, 22px)',
          padding: '0 36px',
        }}
      >
        {!data || data.leaderboard.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              fontSize: 'clamp(16px, 2.2vw, 28px)',
              color: '#EF9F27',
            }}
          >
            <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span>{' '}
            AWAITING REPORTERS...
          </div>
        ) : (
          data.leaderboard.map((entry: LeaderboardEntry, i: number) => {
            const key = entry.name.toLowerCase()
            const flash = flashMap[key]
            const bar = buildBar(entry.totalTokens / maxTokens)

            return (
              <div
                key={key}
                className={
                  flash === 'up'
                    ? 'flash-up'
                    : flash === 'down'
                      ? 'flash-down'
                      : ''
                }
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '20px',
                  animation: loaded
                    ? undefined
                    : `fadeIn 0.3s ease-out ${i * 0.08}s both`,
                }}
              >
                {/* RANK */}
                <span
                  style={{
                    width: '2.5ch',
                    textAlign: 'right',
                    color: rankNumberColor(entry.rank),
                    fontSize: 'clamp(13px, 1.6vw, 20px)',
                  }}
                >
                  {String(entry.rank).padStart(2, '0')}
                </span>

                {/* ONLINE DOT */}
                <span
                  style={{
                    width: '1ch',
                    color: entry.isOnline ? '#EF9F27' : '#333',
                    fontSize: 'clamp(10px, 1.2vw, 15px)',
                    verticalAlign: 'middle',
                  }}
                >
                  {entry.isOnline ? '\u25A0' : '\u25A1'}
                </span>

                {/* NAME */}
                <span
                  style={{
                    flex: '0 0 auto',
                    minWidth: '8ch',
                    color: rankColor(entry.rank),
                    fontSize: 'clamp(16px, 2.2vw, 28px)',
                    fontWeight: 500,
                  }}
                >
                  {entry.name.toUpperCase()}
                </span>

                {/* TOKEN COUNT */}
                <span
                  style={{
                    flex: '0 0 auto',
                    minWidth: '6ch',
                    textAlign: 'right',
                    color: tokenColor(entry.rank),
                    fontSize: 'clamp(13px, 1.6vw, 20px)',
                  }}
                >
                  {fmtTokens(entry.totalTokens)}
                </span>

                {/* BLOCK BAR */}
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    color: barColor(entry.rank),
                    fontSize: 'clamp(9px, 1vw, 13px)',
                    letterSpacing: '-1px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {bar.filled}
                  <span style={{ color: '#1a1a1a' }}>{bar.empty}</span>
                </span>

                {/* TODAY DELTA */}
                <span
                  style={{
                    flex: '0 0 auto',
                    textAlign: 'right',
                    color: '#555',
                    fontSize: 'clamp(10px, 1.2vw, 14px)',
                  }}
                >
                  +{fmtTokensShort(entry.tokensToday)} TODAY
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* BOTTOM BAR */}
      <div
        style={{
          padding: '16px 36px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid #1a1a1a',
        }}
      >
        <span
          style={{
            color: '#555',
            fontSize: 'clamp(11px, 1.3vw, 15px)',
          }}
        >
          TOTAL: {fmtTokens(data?.totalTokens ?? 0)} TOKENS
        </span>

        <span
          style={{
            color: '#333',
            fontSize: 'clamp(11px, 1.3vw, 15px)',
          }}
        >
          {!data ? (
            'CONNECTING...'
          ) : (
            <>
              <span style={{ animation: 'blink 1.2s step-end infinite' }}>
                _
              </span>{' '}
              SYNCING LIVE
            </>
          )}
        </span>

        <span
          style={{
            color: justRefreshed ? '#EF9F27' : '#555',
            fontSize: 'clamp(11px, 1.3vw, 15px)',
            transition: 'color 1s',
          }}
        >
          UPDATED {data ? fmtTime(data.updatedAt) : '--:--:--'}
        </span>
      </div>
    </div>
  )
}

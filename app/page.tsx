'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import type { LeaderboardEntry } from '@/types'
import { fmtTokens, fmtTokensShort, fmtTime } from '@/lib/formatters'
import { Timeline } from './Timeline'

const FLASH_DURATION = 800
const REFRESH_FLASH_DURATION = 1000

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

function rankColor(rank: number): string {
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00f0ff'
  return '#7a7a9e'
}

function tokenColor(rank: number): string {
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00d4e0'
  return '#5e5e7e'
}

function barColor(rank: number): string {
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00f0ff'
  return '#2a2a4a'
}

function barTrackColor(rank: number): string {
  if (rank === 1) return 'rgba(255, 45, 149, 0.12)'
  if (rank <= 3) return 'rgba(0, 240, 255, 0.08)'
  return 'rgba(42, 42, 74, 0.3)'
}

function rankNumberColor(rank: number): string {
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00f0ff'
  return '#5e5e7e'
}

const STYLES = `
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes flashUp {
    0% { background: rgba(0, 255, 136, 0.3); }
    100% { background: transparent; }
  }
  @keyframes flashDown {
    0% { background: rgba(255, 50, 50, 0.3); }
    100% { background: transparent; }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  @keyframes crownPulse {
    0%, 100% { text-shadow: 0 0 8px #ff2d95, 0 0 20px #ff2d9580; }
    50% { text-shadow: 0 0 16px #ff2d95, 0 0 40px #ff2d95aa, 0 0 60px #ff2d9544; }
  }
  @keyframes namePulse {
    0%, 100% {
      text-shadow: 0 0 10px #ff2d95, 0 0 30px #ff2d9580, 0 0 50px #ff2d9540;
    }
    50% {
      text-shadow: 0 0 20px #ff2d95, 0 0 50px #ff2d95aa, 0 0 80px #ff2d9566;
    }
  }
  @keyframes glitch {
    0%, 90%, 100% { transform: translate(0); filter: none; }
    92% { transform: translate(-2px, 1px); filter: hue-rotate(90deg); }
    94% { transform: translate(2px, -1px); filter: hue-rotate(-90deg); }
    96% { transform: translate(-1px, -1px); filter: hue-rotate(45deg); }
    98% { transform: translate(1px, 1px); filter: none; }
  }
  @keyframes scanline {
    0% { transform: translateY(-100%); }
    100% { transform: translateY(100vh); }
  }
  @keyframes screenFlicker {
    0%, 97%, 100% { opacity: 1; }
    98% { opacity: 0.97; }
    99% { opacity: 0.99; }
  }
  @keyframes barGlow {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.3); }
  }
  .flash-up { animation: flashUp 0.8s ease-out; }
  .flash-down { animation: flashDown 0.8s ease-out; }

  .crt-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
  }
  .crt-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.15) 0px,
      rgba(0, 0, 0, 0.15) 1px,
      transparent 1px,
      transparent 3px
    );
  }
  .crt-overlay::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(
      ellipse at center,
      transparent 60%,
      rgba(0, 0, 0, 0.4) 100%
    );
  }
  .scanline-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: rgba(255, 255, 255, 0.04);
    z-index: 101;
    pointer-events: none;
    animation: scanline 8s linear infinite;
  }

  .bar-block {
    height: clamp(10px, 1.2vw, 16px);
    transition: width 1s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    image-rendering: pixelated;
  }
  .bar-track {
    height: clamp(10px, 1.2vw, 16px);
    position: relative;
    overflow: hidden;
  }

  .rank-1-bar {
    animation: barGlow 2s ease-in-out infinite;
  }

  .online-dot {
    display: inline-block;
    width: clamp(6px, 0.7vw, 9px);
    height: clamp(6px, 0.7vw, 9px);
    border-radius: 50%;
  }
  .online-dot-active {
    background: #00ff88;
    box-shadow: 0 0 6px #00ff88, 0 0 12px #00ff8866;
  }
  .online-dot-inactive {
    background: #2a2a4a;
  }
`

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
        background: '#08080f',
        color: '#c0c0e0',
        height: '100vh',
        width: '100vw',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto auto',
        overflow: 'hidden',
        animation: 'screenFlicker 4s infinite',
      }}
    >
      <style>{STYLES}</style>
      <div className="crt-overlay" />
      <div className="scanline-bar" />

      {/* TOP BAR */}
      <div
        style={{
          padding: '20px 36px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid #1a1a3a',
        }}
      >
        <span
          style={{
            fontSize: 'clamp(10px, 1.2vw, 14px)',
            letterSpacing: '0.25em',
            color: '#5e5e7e',
            animation: 'glitch 8s infinite',
          }}
        >
          SEASON ONE / CLAUDE LEADERBOARD
        </span>
        <span
          style={{
            fontSize: 'clamp(10px, 1.2vw, 14px)',
            color: '#5e5e7e',
            fontVariantNumeric: 'tabular-nums',
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
              color: '#ff2d95',
              textShadow: '0 0 20px #ff2d9580',
            }}
          >
            <span style={{ animation: 'blink 1.2s step-end infinite' }}>
              _
            </span>{' '}
            AWAITING REPORTERS...
          </div>
        ) : (
          data.leaderboard.map((entry: LeaderboardEntry, i: number) => {
            const key = entry.name.toLowerCase()
            const flash = flashMap[key]
            const ratio = entry.totalTokens / maxTokens
            const isFirst = entry.rank === 1

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
                  alignItems: 'center',
                  gap: '20px',
                  animation: loaded
                    ? undefined
                    : `fadeIn 0.4s ease-out ${i * 0.1}s both`,
                }}
              >
                {/* RANK */}
                <span
                  style={{
                    width: '2.5ch',
                    textAlign: 'right',
                    color: rankNumberColor(entry.rank),
                    fontSize: 'clamp(13px, 1.6vw, 20px)',
                    ...(isFirst
                      ? {
                          textShadow: '0 0 10px #ff2d9580',
                        }
                      : {}),
                  }}
                >
                  {String(entry.rank).padStart(2, '0')}
                </span>

                {/* ONLINE DOT */}
                <span
                  className={`online-dot ${entry.isOnline ? 'online-dot-active' : 'online-dot-inactive'}`}
                />

                {/* NAME */}
                <span
                  style={{
                    flex: '0 0 auto',
                    minWidth: '8ch',
                    color: rankColor(entry.rank),
                    fontSize: 'clamp(16px, 2.2vw, 28px)',
                    fontWeight: 700,
                    ...(isFirst
                      ? {
                          animation: 'namePulse 3s ease-in-out infinite',
                        }
                      : entry.rank <= 3
                        ? {
                            textShadow: '0 0 8px rgba(0, 240, 255, 0.4)',
                          }
                        : {}),
                  }}
                >
                  {isFirst ? '\u2666 ' : ''}
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
                    fontVariantNumeric: 'tabular-nums',
                    ...(isFirst
                      ? { textShadow: '0 0 8px #ff2d9560' }
                      : {}),
                  }}
                >
                  {fmtTokens(entry.totalTokens)}
                </span>

                {/* BLOCKY BAR */}
                <div
                  className="bar-track"
                  style={{
                    flex: 1,
                    background: barTrackColor(entry.rank),
                  }}
                >
                  <div
                    className={`bar-block ${isFirst ? 'rank-1-bar' : ''}`}
                    style={{
                      width: `${ratio * 100}%`,
                      background: isFirst
                        ? `repeating-linear-gradient(
                            90deg,
                            #ff2d95 0px,
                            #ff2d95 4px,
                            #cc1a75 4px,
                            #cc1a75 6px
                          )`
                        : entry.rank <= 3
                          ? `repeating-linear-gradient(
                              90deg,
                              #00f0ff 0px,
                              #00f0ff 4px,
                              #00b8c4 4px,
                              #00b8c4 6px
                            )`
                          : `repeating-linear-gradient(
                              90deg,
                              #2a2a4a 0px,
                              #2a2a4a 4px,
                              #1e1e3a 4px,
                              #1e1e3a 6px
                            )`,
                      boxShadow: isFirst
                        ? '0 0 8px #ff2d9560, 0 0 16px #ff2d9530'
                        : entry.rank <= 3
                          ? '0 0 6px rgba(0, 240, 255, 0.2)'
                          : 'none',
                    }}
                  />
                </div>

                {/* TODAY DELTA */}
                <span
                  style={{
                    flex: '0 0 auto',
                    textAlign: 'right',
                    color: '#5e5e7e',
                    fontSize: 'clamp(10px, 1.2vw, 14px)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  +{fmtTokensShort(entry.tokensToday)} TODAY
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* TIMELINE */}
      <div
        style={{
          height: 'clamp(120px, 20vh, 200px)',
          borderTop: '1px solid #1a1a3a',
          padding: '8px 24px',
        }}
      >
        <Timeline />
      </div>

      {/* BOTTOM BAR */}
      <div
        style={{
          padding: '16px 36px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid #1a1a3a',
        }}
      >
        <span
          style={{
            color: '#5e5e7e',
            fontSize: 'clamp(11px, 1.3vw, 15px)',
          }}
        >
          TOTAL: {fmtTokens(data?.totalTokens ?? 0)} TOKENS
        </span>

        <span
          style={{
            color: '#3a3a5a',
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
            color: justRefreshed ? '#ff2d95' : '#5e5e7e',
            fontSize: 'clamp(11px, 1.3vw, 15px)',
            transition: 'color 1s',
            textShadow: justRefreshed ? '0 0 10px #ff2d9580' : 'none',
          }}
        >
          UPDATED {data ? fmtTime(data.updatedAt) : '--:--:--'}
        </span>
      </div>
    </div>
  )
}

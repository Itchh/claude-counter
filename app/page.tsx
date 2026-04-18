'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
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

function fallbackColor(rank: number): string {
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00f0ff'
  return '#7a7a9e'
}

function rankColor(rank: number, userColor: string | null): string {
  return userColor ?? fallbackColor(rank)
}

function tokenColor(rank: number, userColor: string | null): string {
  if (userColor) return userColor
  if (rank === 1) return '#ff2d95'
  if (rank <= 3) return '#00d4e0'
  return '#5e5e7e'
}

function barTrackColor(rank: number, userColor: string | null): string {
  if (userColor) return `${userColor}1f`
  if (rank === 1) return 'rgba(255, 45, 149, 0.12)'
  if (rank <= 3) return 'rgba(0, 240, 255, 0.08)'
  return 'rgba(42, 42, 74, 0.3)'
}

function rankNumberColor(rank: number, userColor: string | null): string {
  return userColor ?? fallbackColor(rank)
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount)
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount)
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function barGradient(rank: number, userColor: string | null): string {
  if (userColor) {
    const dark = darkenHex(userColor, 40)
    return `repeating-linear-gradient(90deg, ${userColor} 0px, ${userColor} 4px, ${dark} 4px, ${dark} 6px)`
  }
  if (rank === 1) return 'repeating-linear-gradient(90deg, #ff2d95 0px, #ff2d95 4px, #cc1a75 4px, #cc1a75 6px)'
  if (rank <= 3) return 'repeating-linear-gradient(90deg, #00f0ff 0px, #00f0ff 4px, #00b8c4 4px, #00b8c4 6px)'
  return 'repeating-linear-gradient(90deg, #2a2a4a 0px, #2a2a4a 4px, #1e1e3a 4px, #1e1e3a 6px)'
}

function barShadow(rank: number, userColor: string | null): string {
  if (userColor) return `0 0 8px ${userColor}60, 0 0 16px ${userColor}30`
  if (rank === 1) return '0 0 8px #ff2d9560, 0 0 16px #ff2d9530'
  if (rank <= 3) return '0 0 6px rgba(0, 240, 255, 0.2)'
  return 'none'
}

function glowShadow(rank: number, userColor: string | null): string {
  const c = userColor ?? (rank === 1 ? '#ff2d95' : '#00f0ff')
  return `0 0 8px ${c}66`
}

function AnimatedTokens({ value, formatter }: { value: number; formatter: (n: number) => string }): React.ReactElement {
  const spring = useSpring(0, { stiffness: 120, damping: 20 })
  const display = useTransform(spring, (v) => formatter(Math.round(v)))
  const [text, setText] = useState(formatter(0))

  useEffect(() => {
    spring.set(value)
  }, [spring, value])

  useEffect(() => {
    const unsubscribe = display.on('change', (v) => setText(v))
    return unsubscribe
  }, [display])

  return <>{text}</>
}

const STYLES = `
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
    0%, 100% { text-shadow: 0 0 8px var(--uc, #ff2d95), 0 0 20px color-mix(in srgb, var(--uc, #ff2d95) 50%, transparent); }
    50% { text-shadow: 0 0 16px var(--uc, #ff2d95), 0 0 40px color-mix(in srgb, var(--uc, #ff2d95) 67%, transparent), 0 0 60px color-mix(in srgb, var(--uc, #ff2d95) 27%, transparent); }
  }
  @keyframes namePulse {
    0%, 100% {
      text-shadow: 0 0 10px var(--uc, #ff2d95), 0 0 30px color-mix(in srgb, var(--uc, #ff2d95) 50%, transparent), 0 0 50px color-mix(in srgb, var(--uc, #ff2d95) 25%, transparent);
    }
    50% {
      text-shadow: 0 0 20px var(--uc, #ff2d95), 0 0 50px color-mix(in srgb, var(--uc, #ff2d95) 67%, transparent), 0 0 80px color-mix(in srgb, var(--uc, #ff2d95) 40%, transparent);
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
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
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
      </motion.div>

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
        <AnimatePresence mode="popLayout">
          {!data || data.leaderboard.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
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
            </motion.div>
          ) : (
            data.leaderboard.map((entry: LeaderboardEntry, i: number) => {
              const key = entry.name.toLowerCase()
              const flash = flashMap[key]
              const ratio = entry.totalTokens / maxTokens
              const isFirst = entry.rank === 1

              return (
                <motion.div
                  key={key}
                  layout
                  initial={{ opacity: 0, y: 20, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  transition={{
                    layout: { type: 'spring', stiffness: 300, damping: 30 },
                    opacity: { duration: 0.3, delay: loaded ? 0 : i * 0.08 },
                    y: { type: 'spring', stiffness: 200, damping: 25, delay: loaded ? 0 : i * 0.08 },
                    scale: { duration: 0.2, delay: loaded ? 0 : i * 0.08 },
                  }}
                  whileHover={{ scale: 1.01, transition: { duration: 0.15 } }}
                  className={
                    flash === 'up'
                      ? 'flash-up'
                      : flash === 'down'
                        ? 'flash-down'
                        : ''
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: '20px',
                  }}
                >
                  {/* RANK */}
                  <motion.span
                    layout="position"
                    style={{
                      width: '2.5ch',
                      textAlign: 'right',
                      color: rankNumberColor(entry.rank, entry.color),
                      fontSize: 'clamp(13px, 1.6vw, 20px)',
                      ...(isFirst || entry.color
                        ? {
                            textShadow: `0 0 10px ${rankNumberColor(entry.rank, entry.color)}80`,
                          }
                        : {}),
                    }}
                  >
                    {String(entry.rank).padStart(2, '0')}
                  </motion.span>

                  {/* ONLINE DOT */}
                  <motion.span
                    className={`online-dot ${entry.isOnline ? 'online-dot-active' : 'online-dot-inactive'}`}
                    animate={{
                      scale: entry.isOnline ? [1, 1.3, 1] : 1,
                    }}
                    transition={{
                      scale: { duration: 0.3 },
                    }}
                  />

                  {/* BAR COLUMN: name above, bar below */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {/* NAME + TOKEN ROW */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span
                        style={{
                          color: rankColor(entry.rank, entry.color),
                          fontSize: 'clamp(16px, 2.2vw, 28px)',
                          fontWeight: 700,
                          lineHeight: 1,
                          ...(entry.color ? { '--uc': entry.color } as React.CSSProperties : {}),
                          ...(isFirst
                            ? { animation: 'namePulse 3s ease-in-out infinite' }
                            : entry.color || entry.rank <= 3
                              ? { textShadow: glowShadow(entry.rank, entry.color) }
                              : {}),
                        }}
                      >
                        {isFirst ? '\u2666 ' : ''}
                        {entry.name.toUpperCase()}
                      </span>
                      <span
                        style={{
                          color: tokenColor(entry.rank, entry.color),
                          fontSize: 'clamp(13px, 1.6vw, 20px)',
                          fontVariantNumeric: 'tabular-nums',
                          lineHeight: 1,
                          ...(isFirst || entry.color
                            ? { textShadow: `0 0 8px ${tokenColor(entry.rank, entry.color)}60` }
                            : {}),
                        }}
                      >
                        <AnimatedTokens value={entry.totalTokens} formatter={fmtTokens} />
                      </span>
                    </div>
                    {/* BLOCKY BAR */}
                    <div
                      className="bar-track"
                      style={{ background: barTrackColor(entry.rank, entry.color) }}
                    >
                      <motion.div
                        className={`bar-block ${isFirst ? 'rank-1-bar' : ''}`}
                        animate={{ width: `${ratio * 100}%` }}
                        transition={{ type: 'spring', stiffness: 60, damping: 15 }}
                        style={{
                          background: barGradient(entry.rank, entry.color),
                          boxShadow: barShadow(entry.rank, entry.color),
                        }}
                      />
                    </div>
                  </div>

                  {/* TODAY DELTA */}
                  <span
                    style={{
                      flex: '0 0 clamp(100px, 12vw, 160px)',
                      textAlign: 'right',
                      color: '#5e5e7e',
                      fontSize: 'clamp(10px, 1.2vw, 14px)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    +<AnimatedTokens value={entry.tokensToday} formatter={fmtTokensShort} /> TODAY
                  </span>
                </motion.div>
              )
            })
          )}
        </AnimatePresence>
      </div>

      {/* TIMELINE */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        style={{
          height: 'clamp(120px, 20vh, 200px)',
          borderTop: '1px solid #1a1a3a',
          padding: '8px 24px',
        }}
      >
        <Timeline />
      </motion.div>

      {/* BOTTOM BAR */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
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
          TOTAL: <AnimatedTokens value={data?.totalTokens ?? 0} formatter={fmtTokens} /> TOKENS
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

        <motion.span
          animate={{
            color: justRefreshed ? '#ff2d95' : '#5e5e7e',
            textShadow: justRefreshed ? '0 0 10px #ff2d9580' : '0 0 0px transparent',
          }}
          transition={{ duration: 0.5 }}
          style={{
            fontSize: 'clamp(11px, 1.3vw, 15px)',
          }}
        >
          UPDATED {data ? fmtTime(data.updatedAt) : '--:--:--'}
        </motion.span>
      </motion.div>
    </div>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
import type { LeaderboardEntry } from '@/types'
import { fmtTokens, fmtTokensShort, fmtTime } from '@/lib/formatters'
import { useBurnRates } from '@/lib/useBurnRates'
import { buildTokenAxis } from '@/lib/tokenTicks'
import { MODEL_FAMILIES, toModelSegments, type ModelFamily } from '@/lib/models'
import { Timeline } from './Timeline'
import { Ticker } from './Ticker'
import { Toasts } from './Toasts'
import { ReporterPanel } from './ReporterPanel'
import { ModeToggle } from '../ModeToggle'
import { PS1, toPowerStats } from './ps1/theme'
import { PS1_STYLES } from './ps1/styles'
import { Ps1Avatar } from './ps1/Ps1Avatar'
import { RaceStrip } from './ps1/RaceStrip'
import { BootSplash } from './ps1/BootSplash'

const FLASH_DURATION = 800
const REFRESH_FLASH_DURATION = 1000
const FANFARE_DURATION = 1600
const HOT_TOKENS_PER_MIN = 30_000
const GRIDLINE_COLOR = 'rgba(255, 255, 255, 0.06)'
/** Spin speed of the bust maxes out at this burn rate. */
const INTENSITY_CEILING_TOKENS_PER_MIN = 60_000

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
  if (rank === 1) return PS1.hot
  if (rank <= 3) return PS1.cyan
  return '#7a7a9e'
}

function rankColor(rank: number, userColor: string | null): string {
  return userColor ?? fallbackColor(rank)
}

function tokenColor(rank: number, userColor: string | null): string {
  if (userColor) return userColor
  if (rank === 1) return PS1.hot
  if (rank <= 3) return '#00d4e0'
  return '#5e5e7e'
}

function barTrackColor(rank: number, userColor: string | null): string {
  if (userColor) return `${userColor}1f`
  if (rank === 1) return 'rgba(255, 45, 149, 0.12)'
  if (rank <= 3) return 'rgba(0, 240, 255, 0.08)'
  return 'rgba(42, 42, 74, 0.3)'
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount)
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount)
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function barGradient(rank: number, userColor: string | null): string {
  const base = userColor ?? fallbackColor(rank)
  const dark = darkenHex(base, 40)
  return `repeating-linear-gradient(90deg, ${base} 0px, ${base} 4px, ${dark} 4px, ${dark} 6px)`
}

/**
 * Candy-bar segment fill. Same 4px/2px retro hatch as the solid bars so a
 * stacked bar still reads as the same object, just striped by model.
 */
function segmentGradient(color: string): string {
  const dark = darkenHex(color, 40)
  return `repeating-linear-gradient(90deg, ${color} 0px, ${color} 4px, ${dark} 4px, ${dark} 6px)`
}

function barShadow(rank: number, userColor: string | null): string {
  if (userColor) return `0 0 8px ${userColor}60, 0 0 16px ${userColor}30`
  if (rank === 1) return '0 0 8px #ff2d9560, 0 0 16px #ff2d9530'
  if (rank <= 3) return '0 0 6px rgba(0, 240, 255, 0.2)'
  return 'none'
}

function glowShadow(rank: number, userColor: string | null): string {
  const c = userColor ?? (rank === 1 ? PS1.hot : PS1.cyan)
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

/** LV / PWR / SPD readout, the character-select stat block. */
function StatPlate({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}): React.ReactElement {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        lineHeight: 1,
        gap: '2px',
      }}
    >
      <span
        className="ps1-plate"
        style={{ fontSize: 'clamp(6px, 0.7vw, 9px)', color: PS1.textFaint }}
      >
        {label}
      </span>
      <span
        style={{ fontSize: 'clamp(10px, 1.2vw, 15px)', fontVariantNumeric: 'tabular-nums', color }}
      >
        {value}
      </span>
    </span>
  )
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
  @keyframes namePulse {
    0%, 100% {
      text-shadow: 0 0 10px var(--uc, #ff2d95), 0 0 30px color-mix(in srgb, var(--uc, #ff2d95) 50%, transparent);
    }
    50% {
      text-shadow: 0 0 20px var(--uc, #ff2d95), 0 0 50px color-mix(in srgb, var(--uc, #ff2d95) 67%, transparent);
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
      transparent 55%,
      rgba(0, 0, 0, 0.55) 100%
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
    height: clamp(9px, 1vw, 13px);
    image-rendering: pixelated;
  }
  .bar-track {
    height: clamp(9px, 1vw, 13px);
    position: relative;
    overflow: hidden;
  }

  .bar-segment {
    height: 100%;
    /* Hairline gap so touching segments stay legible without a border box. */
    box-shadow: inset -1px 0 0 rgba(8, 8, 15, 0.85);
  }
  .bar-segment:last-child {
    box-shadow: none;
  }
  .legend-swatch {
    display: inline-block;
    width: clamp(14px, 1.6vw, 22px);
    height: clamp(7px, 0.8vw, 10px);
    image-rendering: pixelated;
  }

  .rank-1-bar {
    animation: barGlow 2s ease-in-out infinite;
  }

  .online-dot {
    display: inline-block;
    width: clamp(6px, 0.7vw, 9px);
    height: clamp(6px, 0.7vw, 9px);
  }
  .online-dot-active {
    background: #00ff88;
    box-shadow: 0 0 6px #00ff88, 0 0 12px #00ff8866;
  }
  .online-dot-inactive {
    background: #2a2a4a;
  }
`

export function LeonLeaderboard(): React.ReactElement {
  const data = useQuery(api.leaderboard.get)
  const events = useQuery(api.leaderboard.getEvents)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down'>>({})
  const [loaded, setLoaded] = useState(false)
  const [fanfareColor, setFanfareColor] = useState<string | null>(null)
  const prevRanks = useRef<Map<string, number>>(new Map())
  const prevUpdatedAt = useRef<string>('')
  const prevLeaderKey = useRef<string | null>(null)
  const clock = useClockTime()
  const burnRates = useBurnRates(data?.leaderboard, data?.updatedAt)

  useEffect(() => {
    if (!data) return

    const leader = data.leaderboard[0]
    if (leader) {
      const leaderKey = leader.name.toLowerCase()
      if (prevLeaderKey.current && prevLeaderKey.current !== leaderKey) {
        setFanfareColor(leader.color ?? PS1.hot)
        setTimeout(() => setFanfareColor(null), FANFARE_DURATION)
      }
      prevLeaderKey.current = leaderKey
    }

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
  const axis = buildTokenAxis(maxTokens)

  // Only legend the families anyone has actually used, so the key never lists
  // a colour that appears nowhere on screen.
  const presentFamilies = new Set<ModelFamily>()
  for (const entry of data?.leaderboard ?? []) {
    for (const segment of toModelSegments(entry.tokensByModel)) {
      presentFamilies.add(segment.family)
    }
  }
  const legend = MODEL_FAMILIES.filter((meta) => presentFamilies.has(meta.family))

  return (
    <div
      style={{
        animation: fanfareColor
          ? 'screenShake 0.6s ease-in-out'
          : 'screenFlicker 4s infinite',
        fontFamily:
          "ui-monospace, 'Cascadia Code', 'Courier New', Courier, monospace",
        background: PS1.void,
        color: PS1.text,
        height: '100vh',
        width: '100vw',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto auto auto',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <style>{STYLES}</style>
      <style>{PS1_STYLES}</style>
      <div className="ps1-floor" />
      <div className="crt-overlay" />
      <div className="scanline-bar" />
      <BootSplash />
      <Toasts events={events} />

      {/* NEW #1 FANFARE BURST */}
      <AnimatePresence>
        {fanfareColor && (
          <motion.div
            key="fanfare-burst"
            initial={{ opacity: 0.9, scale: 0 }}
            animate={{ opacity: 0, scale: 3 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FANFARE_DURATION / 1000, ease: 'easeOut' }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99,
              pointerEvents: 'none',
              transformOrigin: 'center',
              background: `radial-gradient(circle at center, ${fanfareColor}66 0%, ${fanfareColor}22 30%, transparent 60%)`,
            }}
          />
        )}
      </AnimatePresence>

      {/* TOP BAR */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="ps1-panel ps1-dither"
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '12px 28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <ModeToggle />
          <span
            className="ps1-plate ps1-warp"
            style={{
              fontSize: 'clamp(10px, 1.2vw, 14px)',
              color: PS1.gold,
              animation: 'glitch 8s infinite',
            }}
          >
            Season One / Claude Leaderboard
          </span>
        </div>
        <span
          className="ps1-plate"
          style={{
            fontSize: 'clamp(10px, 1.2vw, 14px)',
            color: PS1.textDim,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {clock}
        </span>
      </motion.div>

      {/* LEADERBOARD */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 'clamp(4px, 0.9vh, 12px)',
          padding: '10px 28px 0',
          overflow: 'hidden',
        }}
      >
        <AnimatePresence mode="popLayout">
          {!data || data.leaderboard.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="ps1-plate"
              style={{
                textAlign: 'center',
                fontSize: 'clamp(14px, 2vw, 24px)',
                color: PS1.hot,
                textShadow: `0 0 20px ${PS1.hot}80`,
              }}
            >
              <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span>{' '}
              Insert player one
            </motion.div>
          ) : (
            data.leaderboard.map((entry: LeaderboardEntry, i: number) => {
              const key = entry.name.toLowerCase()
              const flash = flashMap[key]
              const ratio = entry.totalTokens / maxTokens
              const segments = toModelSegments(entry.tokensByModel)
              const isFirst = entry.rank === 1
              const burnRate = entry.isOnline ? (burnRates.get(key) ?? 0) : 0
              const isHot = burnRate >= HOT_TOKENS_PER_MIN
              const stats = toPowerStats(entry.totalTokens, burnRate)
              const accent = rankColor(entry.rank, entry.color)

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
                  whileHover={{ scale: 1.005, transition: { duration: 0.15 } }}
                  className={`ps1-panel relative ${
                    flash === 'up' ? 'flash-up' : flash === 'down' ? 'flash-down' : ''
                  }`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'clamp(10px, 1.4vw, 18px)',
                    padding: 'clamp(6px, 0.9vh, 12px) clamp(10px, 1.2vw, 16px)',
                  }}
                >
                  {/* CHARACTER PORTRAIT */}
                  <div
                    className="ps1-panel-inset"
                    style={{
                      position: 'relative',
                      flex: '0 0 auto',
                      padding: '3px',
                      lineHeight: 0,
                    }}
                  >
                    <Ps1Avatar
                      color={accent}
                      size={48}
                      label={entry.name}
                      intensity={Math.min(1, burnRate / INTENSITY_CEILING_TOKENS_PER_MIN)}
                    />
                    <span
                      className="ps1-plate"
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        textAlign: 'center',
                        fontSize: '8px',
                        lineHeight: 1.4,
                        fontVariantNumeric: 'tabular-nums',
                        background: PS1.void,
                        color: PS1.gold,
                      }}
                    >
                      LV{stats.level}
                    </span>
                  </div>

                  {/* RANK */}
                  <motion.span
                    layout="position"
                    style={{
                      flex: '0 0 auto',
                      fontVariantNumeric: 'tabular-nums',
                      width: '2.5ch',
                      textAlign: 'right',
                      color: accent,
                      fontSize: 'clamp(13px, 1.6vw, 20px)',
                      ...(isFirst || entry.color
                        ? { textShadow: `0 0 10px ${accent}80` }
                        : {}),
                    }}
                  >
                    {String(entry.rank).padStart(2, '0')}
                  </motion.span>

                  {/* ONLINE DOT */}
                  <motion.span
                    className={`online-dot ${entry.isOnline ? 'online-dot-active' : 'online-dot-inactive'}`}
                    style={{ flex: '0 0 auto' }}
                    animate={{ scale: entry.isOnline ? [1, 1.3, 1] : 1 }}
                    transition={{ scale: { duration: 0.3 } }}
                  />

                  {/* BAR COLUMN: name above, gauge below */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span
                        className="ps1-plate"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: accent,
                          fontSize: 'clamp(14px, 1.9vw, 24px)',
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
                        {isFirst ? '♦ ' : ''}
                        {entry.name}
                        {isHot && (
                          <span
                            style={{
                              color: '#ff5e2d',
                              textShadow: '0 0 8px #ff5e2d, 0 0 20px #ff5e2d60',
                              animation: 'hotFlicker 1.4s infinite',
                              fontSize: '0.5em',
                              letterSpacing: '0.2em',
                              verticalAlign: 'middle',
                              marginLeft: '12px',
                            }}
                          >
                            [BURNING]
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          flex: '0 0 auto',
                          paddingLeft: '12px',
                          fontVariantNumeric: 'tabular-nums',
                          color: tokenColor(entry.rank, entry.color),
                          fontSize: 'clamp(12px, 1.5vw, 18px)',
                          lineHeight: 1,
                          ...(isFirst || entry.color
                            ? { textShadow: `0 0 8px ${tokenColor(entry.rank, entry.color)}60` }
                            : {}),
                        }}
                      >
                        <AnimatedTokens value={entry.totalTokens} formatter={fmtTokens} />
                      </span>
                    </div>

                    {/* POWER GAUGE */}
                    <div
                      className="bar-track"
                      style={{
                        background: `repeating-linear-gradient(to right, ${GRIDLINE_COLOR} 0 1px, transparent 1px ${axis.stepPercent}%), ${barTrackColor(entry.rank, entry.color)}`,
                        boxShadow: 'inset 1px 1px 0 0 #0a0a18, inset -1px -1px 0 0 #34346b',
                      }}
                    >
                      <motion.div
                        className={`bar-block ${isFirst ? 'rank-1-bar' : ''}`}
                        animate={{ width: `${ratio * 100}%` }}
                        transition={{ type: 'spring', stiffness: 60, damping: 15 }}
                        style={{
                          display: 'flex',
                          boxShadow: barShadow(entry.rank, entry.color),
                          // Reporters older than v3 send no model split. Until
                          // theirs lands we keep the original solid bar rather
                          // than showing a misleading single-model stack.
                          ...(segments.length === 0
                            ? { background: barGradient(entry.rank, entry.color) }
                            : {}),
                        }}
                      >
                        {segments.map((segment) => (
                          <motion.span
                            key={segment.family}
                            className="bar-segment"
                            title={`${segment.label} — ${fmtTokens(segment.tokens)} (${Math.round(segment.share * 100)}%)`}
                            initial={false}
                            animate={{ width: `${segment.share * 100}%` }}
                            transition={{ type: 'spring', stiffness: 60, damping: 15 }}
                            style={{ background: segmentGradient(segment.color) }}
                          />
                        ))}
                      </motion.div>
                    </div>
                  </div>

                  {/* STAT BLOCK */}
                  <div
                    className="ps1-panel-inset"
                    style={{
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'clamp(8px, 1.1vw, 16px)',
                      padding: '6px 10px',
                      minWidth: 'clamp(150px, 17vw, 210px)',
                    }}
                  >
                    <StatPlate label="PWR" value={String(stats.power)} color={accent} />
                    <StatPlate
                      label="SPD"
                      value={String(stats.speed)}
                      color={isHot ? '#ff5e2d' : burnRate > 0 ? PS1.green : PS1.textFaint}
                    />
                    <StatPlate
                      label="TODAY"
                      value={fmtTokensShort(entry.tokensToday)}
                      color={PS1.textDim}
                    />
                  </div>
                </motion.div>
              )
            })
          )}
        </AnimatePresence>

        {/* TOKEN AXIS + MODEL LEGEND */}
        {data && data.leaderboard.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="ps1-plate"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 'clamp(12px, 2vw, 28px)',
              color: PS1.textFaint,
              fontSize: 'clamp(8px, 0.9vw, 11px)',
            }}
          >
            <span>Scale {fmtTokensShort(axis.ticks[axis.ticks.length - 1]?.value ?? 0)}</span>
            {legend.map((meta) => (
              <span
                key={meta.family}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
              >
                <span
                  className="legend-swatch"
                  style={{ background: segmentGradient(meta.color) }}
                />
                {meta.label}
              </span>
            ))}
          </motion.div>
        )}
      </div>

      {/* TIMELINE + SELF-PLAYING RACE */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'grid',
          gap: '10px',
          padding: '10px 28px 0',
          height: 'clamp(140px, 21vh, 200px)',
          gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)',
        }}
      >
        <div
          className="ps1-panel"
          style={{ minWidth: 0, height: '100%', padding: '6px 10px', overflow: 'hidden' }}
        >
          <Timeline />
        </div>
        <RaceStrip entries={data?.leaderboard} burnRates={burnRates} />
      </motion.div>

      {/* EVENT TICKER */}
      <Ticker events={events} />

      {/* REPORTER MAINTENANCE */}
      <ReporterPanel />

      {/* BOTTOM BAR */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="ps1-panel ps1-dither ps1-plate"
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '10px 28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 'clamp(10px, 1.2vw, 14px)',
        }}
      >
        <span style={{ color: PS1.textDim }}>
          Pot: <AnimatedTokens value={data?.totalTokens ?? 0} formatter={fmtTokens} /> tokens
        </span>

        <span style={{ color: PS1.textFaint }}>
          {!data ? (
            'Linking…'
          ) : (
            <>
              <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span>{' '}
              Syncing live
            </>
          )}
        </span>

        <motion.span
          animate={{
            color: justRefreshed ? PS1.hot : PS1.textDim,
            textShadow: justRefreshed ? `0 0 10px ${PS1.hot}80` : '0 0 0px transparent',
          }}
          transition={{ duration: 0.5 }}
        >
          Saved {data ? fmtTime(data.updatedAt) : '--:--:--'}
        </motion.span>
      </motion.div>
    </div>
  )
}

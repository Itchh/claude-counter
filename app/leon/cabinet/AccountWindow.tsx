'use client'

import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { api } from '@/convex/_generated/api'
import { fmtTokensShort } from '@/lib/formatters'
import { formatLapMs } from '@/lib/eventText'
import { LOGIN_CODE_LENGTH, normaliseLoginCode } from '@/lib/loginCode'
import { NITRO_MAX_SECONDS } from '@/lib/nitro'
import type { PaintShopDriver } from '../channels/race/PaintShop'
import { chassisOf } from '../channels/race/cars'
import { TRACKS } from '../channels/race/tracks/registry'
import { ARCADE, FONTS, GT, PS1, UI_TYPE } from '../ps1/theme'
import { useMe } from '../control/useMe'
import { REPORTER_COMMANDS } from './reporterCommands'
import { CommandRow } from './MenuWindow'

// The account window: the one place on the wall that is about you rather
// than the room.
//
// Signed out, it is the way in — the command the reporter prints a code
// from, and a field to type that code into, because the wall screen has no
// terminal of its own. Signed in, it is your day at bucket resolution, your
// machines, your laps, and the door to the paint shop for your own car.

const PROSE: React.CSSProperties = {
  display: 'block',
  fontFamily: FONTS.body,
  fontSize: `${UI_TYPE.prose}px`,
  lineHeight: 1.6,
  letterSpacing: '0.03em',
  color: GT.valueDim,
  textTransform: 'none',
  whiteSpace: 'normal',
  margin: 0,
}

const SECTION: React.CSSProperties = {
  background: ARCADE.groundDeep,
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

const HEADING: React.CSSProperties = {
  fontFamily: FONTS.body,
  fontSize: `${UI_TYPE.heading}px`,
  color: ARCADE.label,
}

/** The bevelled button every option in the cabinet wears. */
const BUTTON: React.CSSProperties = {
  border: 'none',
  padding: '10px 14px',
  background: '#2c2c34',
  fontSize: `${UI_TYPE.body}px`,
  boxShadow: `inset 2px 2px 0 0 ${GT.metalHi}, inset -2px -2px 0 0 ${GT.metalLo}`,
}

const FIELD: React.CSSProperties = {
  fontFamily: FONTS.hud,
  fontSize: `${UI_TYPE.title}px`,
  letterSpacing: '0.3em',
  textTransform: 'uppercase',
  color: ARCADE.telemetry,
  background: ARCADE.telemetryBed,
  border: 'none',
  padding: '10px 12px',
  width: '12ch',
  outline: 'none',
}

/** Hours of bars in the day strip. One bar per hour of the last day. */
const DAY_HOURS = 24
const BAR_STRIP_HEIGHT_PX = 64
const HOUR_MS = 60 * 60_000

function trackTitle(slug: string): string {
  return TRACKS.find((track) => track.slug === slug)?.title ?? slug
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '96px' }}>
      <span className="arc-caption" style={{ fontSize: `${UI_TYPE.caption}px`, color: ARCADE.grey }}>
        {label}
      </span>
      <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.title}px`, color: ARCADE.value, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

/**
 * The last day as twenty-four bars. Five-minute buckets folded into hours,
 * drawn as LCD segments rather than a chart — the cabinet has no charts, and
 * a strip of lit bars is what a day of work looks like on its instruments.
 */
function DayStrip({ series }: { readonly series: ReadonlyArray<{ t: number; tokens: number }> }): React.ReactElement {
  const bars = useMemo(() => {
    const now = Date.now()
    const start = now - DAY_HOURS * HOUR_MS
    const hours = new Array<number>(DAY_HOURS).fill(0)
    for (const point of series) {
      const index = Math.floor((point.t - start) / HOUR_MS)
      if (index >= 0 && index < DAY_HOURS) hours[index] += point.tokens
    }
    const peak = Math.max(1, ...hours)
    return hours.map((tokens) => ({ tokens, fraction: tokens / peak }))
  }, [series])

  return (
    <div
      role="img"
      aria-label="Tokens per hour over the last day"
      style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: `${BAR_STRIP_HEIGHT_PX}px`, background: ARCADE.telemetryBed, padding: '6px' }}
    >
      {bars.map((bar, index) => (
        <span
          key={`${index}-${bar.tokens}`}
          title={`${fmtTokensShort(bar.tokens)} tokens`}
          style={{
            flex: 1,
            height: `${Math.max(2, bar.fraction * (BAR_STRIP_HEIGHT_PX - 12))}px`,
            background: bar.tokens > 0 ? ARCADE.telemetry : '#1a4a18',
          }}
        />
      ))}
    </div>
  )
}

function SignedOut(): React.ReactElement {
  const { signIn } = useAuthActions()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loginCommand = REPORTER_COMMANDS.find((entry) => entry.id === 'login')

  const submit = useCallback(async (): Promise<void> => {
    const clean = normaliseLoginCode(code)
    if (clean.length !== LOGIN_CODE_LENGTH || busy) return
    setBusy(true)
    setError(null)
    try {
      // A refused code resolves with `signingIn: false` rather than throwing,
      // so the catch below only ever sees the network going wrong. Without
      // this the field would clear on a bad code and say nothing at all.
      const result = await signIn('device-link', { code: clean })
      if (!result.signingIn) {
        setError('That code is not right, or it has expired. Codes work once, for ten minutes.')
        return
      }
      setCode('')
    } catch (cause) {
      console.error('Code sign-in failed', cause)
      setError('That code is not right, or it has expired. Codes work once, for ten minutes.')
    } finally {
      setBusy(false)
    }
  }, [code, busy, signIn])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px', background: ARCADE.rule }} className="cab-menu-grid">
      <section style={SECTION}>
        <span className="gt-label" style={HEADING}>On your Mac</span>
        <span style={PROSE}>
          The reporter on your own machine signs you in. It knows which Claude account is there, so there is
          no password: it prints a one-time code and opens the page for you.
        </span>
        {loginCommand !== undefined && <CommandRow entry={loginCommand} />}
      </section>
      <section style={SECTION}>
        <span className="gt-label" style={HEADING}>Or type the code here</span>
        <span style={PROSE}>For this screen, when the terminal is on another machine.</span>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            value={code}
            onChange={(event) => setCode(normaliseLoginCode(event.target.value))}
            placeholder="ABCD2345"
            aria-label="Sign-in code"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={LOGIN_CODE_LENGTH}
            style={FIELD}
          />
          <button type="submit" disabled={busy || code.length !== LOGIN_CODE_LENGTH} className="gt-label arc-button" style={{ ...BUTTON, opacity: code.length === LOGIN_CODE_LENGTH ? 1 : 0.5 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error !== null && <span style={{ ...PROSE, color: PS1.red }}>{error}</span>}
      </section>
    </div>
  )
}

function DeviceRow({
  device,
}: {
  readonly device: { deviceId: string; label: string | null; totalTokens: number; tokensToday: number; lastSeen: string }
}): React.ReactElement {
  const rename = useMutation(api.me.renameDevice)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(device.label ?? '')
  const name = device.label ?? `Mac · ${device.deviceId.slice(0, 8)}`

  const save = useCallback(async (): Promise<void> => {
    setEditing(false)
    if (draft.trim() === (device.label ?? '')) return
    try {
      await rename({ deviceId: device.deviceId, label: draft })
    } catch (cause) {
      console.error('Rename failed', cause)
      setDraft(device.label ?? '')
    }
  }, [draft, device.deviceId, device.label, rename])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' }}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') {
              setDraft(device.label ?? '')
              setEditing(false)
            }
          }}
          maxLength={24}
          aria-label="Device name"
          style={{ ...FIELD, letterSpacing: '0.06em', textTransform: 'none', fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, width: '18ch' }}
        />
      ) : (
        <button type="button" onClick={() => setEditing(true)} title="Rename" className="gt-label arc-button" style={{ ...BUTTON, padding: '6px 10px', textAlign: 'left' }}>
          {name}
        </button>
      )}
      <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.silver, fontVariantNumeric: 'tabular-nums' }}>
        {fmtTokensShort(device.totalTokens)}
      </span>
      <span className="arc-caption" style={{ fontSize: `${UI_TYPE.caption}px`, color: ARCADE.grey, minWidth: '7ch', textAlign: 'right' }}>
        {relativeTime(device.lastSeen)}
      </span>
    </div>
  )
}

function SignedIn({
  onSelectDriver,
}: {
  readonly onSelectDriver: (driver: PaintShopDriver) => void
}): React.ReactElement {
  const stats = useQuery(api.me.myStats)
  const race = useQuery(api.scoring.getRace, { period: 'day' })
  const me = useMe()
  const { signOut } = useAuthActions()

  const openPaintShop = useCallback((): void => {
    if (!me) return
    const racer = race?.racers.find((candidate) => candidate.key === me.key)
    onSelectDriver({
      key: me.key,
      name: me.name,
      index: chassisOf(me.key, me.chassis),
      chassis: me.chassis,
      color: me.color ?? PS1.cyan,
      paint: me.paint,
      livery: me.livery,
      score: racer?.score ?? 0,
      velocity: racer?.velocityTokensPerMin ?? 0,
    })
  }, [me, race, onSelectDriver])

  if (!stats || !me) return <Skeleton />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', background: ARCADE.rule }}>
      <section style={{ ...SECTION, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.title}px`, color: me.color ?? ARCADE.value }}>
            {me.name}
          </span>
          <span style={PROSE}>
            {stats.key}
            {stats.claudeAccountId ? ' · Claude account linked' : ' · Claude account not seen yet'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button type="button" onClick={openPaintShop} className="gt-label arc-button" style={BUTTON}>
            Paint shop
          </button>
          <button type="button" onClick={() => void signOut()} className="gt-label arc-button" style={BUTTON}>
            Sign out
          </button>
        </div>
      </section>

      <section style={SECTION}>
        <span className="gt-label" style={HEADING}>Your day</span>
        <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap' }}>
          <Stat label="Today" value={fmtTokensShort(stats.tokensToday)} />
          <Stat label="All time" value={fmtTokensShort(stats.totalTokens)} />
          <Stat label="Sessions" value={String(stats.sessionCount)} />
          <Stat label="Nitro bank" value={`${stats.nitroCharge.toFixed(0)}s / ${NITRO_MAX_SECONDS}s`} />
        </div>
        <DayStrip series={stats.series} />
        <span style={PROSE}>Tokens per hour, last 24 hours. Every token burned while you are not driving banks nitro.</span>
      </section>

      <div className="cab-menu-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px', background: ARCADE.rule }}>
        <section style={SECTION}>
          <span className="gt-label" style={HEADING}>Devices</span>
          {stats.devices.length === 0 ? (
            <span style={PROSE}>No reporter has checked in yet.</span>
          ) : (
            stats.devices.map((device) => <DeviceRow key={device.deviceId} device={device} />)
          )}
          <span style={PROSE}>Click a name to rename it. Totals merge across all of them.</span>
        </section>

        <section style={SECTION}>
          <span className="gt-label" style={HEADING}>Hot laps</span>
          {stats.laps.length === 0 ? (
            <span style={PROSE}>None yet. Take the wheel on the circuit and cross the line.</span>
          ) : (
            stats.laps.map((lap) => (
              <div key={`${lap.trackSlug}-${lap.at}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.value }}>
                  {trackTitle(lap.trackSlug)}
                </span>
                <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: `${UI_TYPE.body}px`, color: ARCADE.telemetry, fontVariantNumeric: 'tabular-nums' }}>
                  {formatLapMs(lap.lapMs)}
                </span>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  )
}

/** The signed-in layout's dimensions, empty, so the window does not jump. */
function Skeleton(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', background: ARCADE.rule }} aria-busy>
      <section style={{ ...SECTION, height: '84px' }} />
      <section style={{ ...SECTION, height: '212px' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px', background: ARCADE.rule }}>
        <section style={{ ...SECTION, height: '160px' }} />
        <section style={{ ...SECTION, height: '160px' }} />
      </div>
    </div>
  )
}

export function AccountWindow({
  onSelectDriver,
}: {
  readonly onSelectDriver: (driver: PaintShopDriver) => void
}): React.ReactElement {
  const me = useMe()
  if (me === undefined) return <Skeleton />
  if (me === null) return <SignedOut />
  return <SignedIn onSelectDriver={onSelectDriver} />
}

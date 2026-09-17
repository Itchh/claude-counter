'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { ARCADE, FONTS, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import type { FightEventLine, FightPhase } from './useFightSim'

// CH 02's furniture, laid out to the reference frames: health bars angled in
// from the top corners, names on blue plates under their outer ends, the
// round clock dead centre, stage ident top-left, FREE PLAY top-right — and
// the big announcements in the middle of the picture, in the franchise's
// orange chrome. Nothing sits in a box; outlines and hard offsets only.

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const INK_LARGE = { textShadow: `${OUTLINE}, 3px 3px 0 rgba(0,0,0,0.92)` } as const

/** Tekken's announcement chrome: gold into red, cut hard at the waist. */
const ANNOUNCE_RAMP =
  'linear-gradient(#ffe9a8 0%, #ffb020 44%, #ff5a1a 46%, #d21f1f 100%)'

const BAR_HEIGHT = 20
const BAR_SKEW_DEG = 8

export interface HudFighter {
  readonly key: string
  readonly name: string
  readonly color: string
  readonly hpFrac: number
  readonly trailFrac: number
  readonly burnRate: number
  readonly wins: number
  readonly rank: number
}

export interface HudSnapshot {
  readonly phase: FightPhase
  readonly phaseT: number
  readonly clock: number
  readonly left: HudFighter | null
  readonly right: HudFighter | null
  readonly winnerName: string | null
  readonly nextPair: string | null
  readonly stageNumber: number
  /** Wall-clock ms the crit flash burns until. The scene expires it itself. */
  readonly critFlashUntil: number
  readonly events: ReadonlyArray<FightEventLine>
}

interface FightHudProps {
  readonly snapshot: HudSnapshot | null
  readonly paused: boolean
}

/** The centre card for the moment: the genre announces everything. */
function announcement(snapshot: HudSnapshot): string | null {
  switch (snapshot.phase) {
    case 'waiting':
      return 'WAITING FOR CHALLENGERS'
    case 'intro':
      return null // The VS card carries the intro.
    case 'round-card':
      return snapshot.phaseT < 1.1 ? 'ROUND 1' : 'READY?'
    case 'fight':
      return snapshot.phaseT < 0.8 ? 'FIGHT!' : null
    case 'ko':
      return snapshot.clock <= 0 ? 'TIME OVER' : 'K.O.!'
    case 'victory':
      return snapshot.winnerName ? `${snapshot.winnerName.toUpperCase()} WINS!` : null
  }
}

function HealthBar({
  fighter,
  side,
}: {
  readonly fighter: HudFighter
  readonly side: 'left' | 'right'
}): React.ReactElement {
  const mirror = side === 'right'
  const skew = mirror ? BAR_SKEW_DEG : -BAR_SKEW_DEG
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <div
        style={{
          height: `${BAR_HEIGHT}px`,
          transform: `skewX(${skew}deg)`,
          background: '#101018',
          border: '2px solid #e8e8f0',
          borderBottomColor: '#7a7a8a',
          boxShadow: '2px 3px 0 rgba(0,0,0,0.8)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Damage trail first, remaining health painted over it: a hit shows
            as a red chunk bleeding down to the new level. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [mirror ? 'right' : 'left']: 0,
            width: `${Math.min(1, Math.max(0, fighter.trailFrac)) * 100}%`,
            background: ARCADE.label,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [mirror ? 'right' : 'left']: 0,
            width: `${Math.min(1, Math.max(0, fighter.hpFrac)) * 100}%`,
            background: `linear-gradient(#c8fff6 0%, ${PS1.cyan} 45%, #00897a 100%)`,
          }}
        />
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: mirror ? 'flex-end' : 'flex-start',
          alignItems: 'center',
          gap: '10px',
          flexDirection: mirror ? 'row-reverse' : 'row',
        }}
      >
        <span
          className="gt-label"
          style={{
            fontFamily: FONTS.hud,
            fontSize: `${PS1_TYPE.body}px`,
            color: ARCADE.value,
            background: ARCADE.menuBlue,
            padding: '2px 12px',
            boxShadow: `2px 2px 0 ${ARCADE.outline}`,
            borderLeft: mirror ? undefined : `4px solid ${fighter.color}`,
            borderRight: mirror ? `4px solid ${fighter.color}` : undefined,
          }}
        >
          {fighter.name}
        </span>
        {/* Round tallies: the day's KOs, the genre's little win pips. */}
        <span style={{ display: 'flex', gap: '4px' }}>
          {Array.from({ length: Math.min(5, fighter.wins) }, (_, index) => (
            <span
              key={index}
              style={{
                width: '9px',
                height: '9px',
                background: ARCADE.amber,
                boxShadow: `1px 1px 0 ${ARCADE.outline}`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  )
}

export function FightHud({ snapshot, paused }: FightHudProps): React.ReactElement {
  const card = snapshot ? announcement(snapshot) : null
  const showVs = snapshot?.phase === 'intro' && snapshot.left && snapshot.right

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        pointerEvents: 'none',
        fontFamily: FONTS.hud,
        ...SCALED_SURFACE,
      }}
    >
      {/* --- Top strip: stage / clock / free play, then the bars --- */}
      <div style={{ position: 'absolute', top: '14px', left: '18px', right: '18px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <span
            className="gt-label"
            style={{
              fontSize: `${PS1_TYPE.label}px`,
              color: ARCADE.label,
              ...INK_SMALL,
            }}
          >
            Stage {snapshot?.stageNumber ?? 1}
          </span>
          <span
            className="gt-label"
            style={{
              fontSize: `${PS1_TYPE.label}px`,
              color: GT.label,
              ...INK_SMALL,
            }}
          >
            Free play
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px' }}>
          {snapshot?.left ? (
            <HealthBar fighter={snapshot.left} side="left" />
          ) : (
            <div style={{ flex: 1 }} />
          )}

          {/* The round clock: the one number visible from across the room. */}
          <span
            className="gt-label"
            style={{
              fontSize: `${PS1_TYPE.display}px`,
              lineHeight: 0.9,
              color: ARCADE.value,
              minWidth: '2.2ch',
              textAlign: 'center',
              ...INK_LARGE,
            }}
          >
            {snapshot && snapshot.phase !== 'waiting' ? Math.ceil(snapshot.clock) : '--'}
          </span>

          {snapshot?.right ? (
            <HealthBar fighter={snapshot.right} side="right" />
          ) : (
            <div style={{ flex: 1 }} />
          )}
        </div>
      </div>

      {/* --- Centre announcements --- */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '18px',
        }}
      >
        <AnimatePresence>
          {showVs && snapshot?.left && snapshot?.right && (
            <motion.div
              key="vs"
              initial={{ opacity: 0, scale: 1.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.24 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '26px',
              }}
            >
              <span
                className="gt-label"
                style={{ fontSize: `${PS1_TYPE.title + 8}px`, color: ARCADE.value, ...INK_LARGE }}
              >
                {snapshot.left.name}
              </span>
              <span
                className="gt-label"
                style={{
                  fontSize: `${PS1_TYPE.display}px`,
                  backgroundImage: ANNOUNCE_RAMP,
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  color: 'transparent',
                  filter: `drop-shadow(2px 2px 0 ${ARCADE.outline}) drop-shadow(-1px -1px 0 ${ARCADE.outline})`,
                }}
              >
                VS
              </span>
              <span
                className="gt-label"
                style={{ fontSize: `${PS1_TYPE.title + 8}px`, color: ARCADE.value, ...INK_LARGE }}
              >
                {snapshot.right.name}
              </span>
            </motion.div>
          )}

          {card !== null && (
            <motion.span
              key={card}
              className="gt-label"
              initial={{ opacity: 0, scale: 1.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.18 }}
              style={{
                fontSize: `${PS1_TYPE.display + 10}px`,
                letterSpacing: '0.12em',
                textAlign: 'center',
                backgroundImage: ANNOUNCE_RAMP,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
                filter: `drop-shadow(2px 2px 0 ${ARCADE.outline}) drop-shadow(-2px -2px 0 ${ARCADE.outline}) drop-shadow(4px 5px 0 rgba(0,0,0,0.85))`,
              }}
            >
              {card}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* --- Foot: live offence readouts, the event feed, and what's next --- */}
      <div
        style={{
          position: 'absolute',
          left: '18px',
          right: '18px',
          bottom: '16px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '20px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '220px' }}>
          {snapshot?.left && snapshot?.right && (
            <>
              <FootRate fighter={snapshot.left} />
              <FootRate fighter={snapshot.right} />
            </>
          )}
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
          }}
        >
          {(snapshot?.events ?? []).slice(0, 2).map((line) => (
            <span
              key={line.id}
              className="gt-label"
              style={{
                fontSize: `${PS1_TYPE.micro}px`,
                color:
                  line.tone === 'crit'
                    ? ARCADE.amber
                    : line.tone === 'ko'
                      ? ARCADE.label
                      : GT.valueDim,
                ...INK_SMALL,
              }}
            >
              {line.text}
            </span>
          ))}
        </div>

        <div style={{ minWidth: '220px', textAlign: 'right' }}>
          {snapshot?.nextPair !== null && snapshot?.nextPair !== undefined && (
            <span
              className="gt-label"
              style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
            >
              <span style={{ color: GT.label }}>Next</span> {snapshot.nextPair}
            </span>
          )}
        </div>
      </div>

      {paused && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(4, 4, 10, 0.35)',
          }}
        />
      )}
    </div>
  )
}

/** One fighter's live offence: burn is attack speed, said plainly. */
function FootRate({ fighter }: { readonly fighter: HudFighter }): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
    >
      <span style={{ color: fighter.color }}>■</span>{' '}
      <span style={{ color: ARCADE.value }}>{fighter.name}</span>{' '}
      <span style={{ color: ARCADE.telemetry }}>
        {fmtTokensShort(Math.round(fighter.burnRate))}/min
      </span>
    </span>
  )
}

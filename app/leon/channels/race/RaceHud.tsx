'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { PS1 } from '../../ps1/theme'
import type { SimRacer } from './useRaceSim'
import type { ActiveShot } from './CameraDirector'

// Position tower, lap counter, and — deliberately — the real token numbers
// underneath. The game is a way of *reading* the work, not a replacement for
// it: the moment the numbers disappear the thing becomes decoration.

interface RaceHudProps {
  readonly racers: ReadonlyArray<SimRacer>
  readonly isEmpty: boolean
  readonly activeShot: ActiveShot | null
}

/**
 * "JACK'S RACER", but "CHRIS' RACER" — a trailing s takes a bare apostrophe.
 * Cheap to get right and conspicuous when wrong on a wall-sized screen.
 */
function possessive(name: string): string {
  const upper = name.toUpperCase()
  return upper.endsWith('S') ? `${upper}'` : `${upper}'S`
}

export function RaceHud({ racers, isEmpty, activeShot }: RaceHudProps): React.ReactElement {
  const leader = racers[0]
  const povName = activeShot?.kind === 'onboard' ? activeShot.name : null
  const povColor = activeShot?.color ?? PS1.cyan

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Stage title */}
      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="ps1-plate ps1-warp"
          style={{
            fontSize: 'clamp(9px, 1.1vw, 13px)',
            color: PS1.gold,
            textShadow: `0 0 10px ${PS1.gold}60`,
          }}
        >
          Stage 01 — Token Grand Prix
        </span>
      </div>

      {isEmpty ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            className="ps1-plate"
            style={{ color: PS1.hot, fontSize: 'clamp(12px, 1.6vw, 18px)' }}
          >
            <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Grid empty —
            waiting for entrants
          </span>
        </div>
      ) : (
        <>
          {/* Position tower */}
          <div
            className="ps1-panel"
            style={{
              position: 'absolute',
              left: '18px',
              top: '46px',
              minWidth: 'clamp(190px, 21vw, 260px)',
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
            }}
          >
            {racers.map((racer, index) => {
              const isPov = activeShot?.racerKey === racer.key
              return (
              <div
                key={racer.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  opacity: isPov || index === 0 ? 1 : 0.86,
                  // Ties the tower row to the POV ident, so the name on the
                  // lower-third is findable in the standings at a glance.
                  ...(isPov
                    ? {
                        background: `${racer.color}1f`,
                        boxShadow: `inset 2px 0 0 0 ${racer.color}`,
                        marginInline: '-4px',
                        paddingInline: '4px',
                      }
                    : {}),
                }}
              >
                <span
                  className="ps1-plate"
                  style={{
                    width: '3ch',
                    fontSize: 'clamp(8px, 0.9vw, 11px)',
                    fontVariantNumeric: 'tabular-nums',
                    color: index === 0 ? PS1.gold : PS1.textFaint,
                  }}
                >
                  P{index + 1}
                </span>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    flex: '0 0 auto',
                    background: racer.color,
                    boxShadow: racer.isActive ? `0 0 6px ${racer.color}` : 'none',
                  }}
                />
                <span
                  className="ps1-plate"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 'clamp(9px, 1vw, 12px)',
                    color: index === 0 ? PS1.text : PS1.textDim,
                  }}
                  title={racer.name}
                >
                  {racer.name}
                </span>
                <span
                  style={{
                    fontSize: 'clamp(8px, 0.9vw, 11px)',
                    fontVariantNumeric: 'tabular-nums',
                    color: racer.isActive ? PS1.green : PS1.textFaint,
                  }}
                >
                  {fmtTokensShort(racer.score)}
                </span>
              </div>
              )
            })}
          </div>

          {/* POV ident. Only present during an onboard shot, and keyed on the
              name so switching subject replays the entrance rather than
              silently swapping the text. */}
          <AnimatePresence mode="wait">
            {povName && (
              <motion.div
                key={povName}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                className="ps1-panel"
                style={{
                  position: 'absolute',
                  left: '18px',
                  bottom: '68px',
                  padding: '6px 12px 6px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  borderLeft: `3px solid ${povColor}`,
                }}
              >
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    background: povColor,
                    boxShadow: `0 0 8px ${povColor}`,
                    animation: 'blink 1.6s step-end infinite',
                  }}
                />
                <span
                  className="ps1-plate"
                  style={{
                    fontSize: 'clamp(10px, 1.15vw, 14px)',
                    color: povColor,
                    textShadow: `0 0 10px ${povColor}70`,
                  }}
                >
                  {possessive(povName)} Racer
                </span>
                <span
                  className="ps1-plate"
                  style={{ fontSize: 'clamp(7px, 0.75vw, 9px)', color: PS1.textFaint }}
                >
                  Onboard
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Lap + leader readout */}
          {leader && (
            <div
              className="ps1-panel"
              style={{
                position: 'absolute',
                left: '18px',
                bottom: '18px',
                padding: '7px 12px',
                display: 'flex',
                alignItems: 'baseline',
                gap: '14px',
              }}
            >
              <span
                className="ps1-plate"
                style={{ fontSize: 'clamp(8px, 0.85vw, 10px)', color: PS1.textFaint }}
              >
                Lap
              </span>
              <span
                style={{
                  fontSize: 'clamp(16px, 2vw, 26px)',
                  color: PS1.gold,
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1,
                  textShadow: `0 0 12px ${PS1.gold}60`,
                }}
              >
                {leader.lap}
              </span>
              <span
                className="ps1-plate"
                style={{ fontSize: 'clamp(8px, 0.85vw, 10px)', color: PS1.textFaint }}
              >
                {leader.name} leads
              </span>
            </div>
          )}

          {/* The honest bit. */}
          <div
            style={{
              position: 'absolute',
              right: '18px',
              bottom: '18px',
              textAlign: 'right',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            <span
              className="ps1-plate"
              style={{ fontSize: 'clamp(7px, 0.8vw, 9px)', color: PS1.textFaint }}
            >
              Speed = live tokens/min · today
            </span>
            <span
              style={{
                fontSize: 'clamp(10px, 1.2vw, 14px)',
                color: PS1.textDim,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {fmtTokensShort(racers.reduce((sum, racer) => sum + racer.score, 0))} tokens
            </span>
          </div>
        </>
      )}
    </div>
  )
}

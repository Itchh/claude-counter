'use client'

import { useEffect, useState } from 'react'
import { Ps1Car } from './Ps1Car'
import { SPRITE_FRAMES } from './carSprite'
import { bakeFighterSprite, bakePlaneSprite } from './rigSprite'
import type { CabinetGame } from '../cabinet/games'

// A driver's rig for whichever game is on screen: their car on the circuit,
// their plane over Kent, their fighter in the ring. The board compares
// people, and the era's select screens showed the machine you were being
// compared in — so a board opened over the dogfight is a row of aircraft,
// not a row of cars nobody is driving.
//
// The car keeps its drawn stand-in for the seconds before the bake lands;
// the other two have no forty-triangle equivalent, so they hold their space
// blank and then appear. A blank of the right size is a placeholder; a car
// against a pilot's name would be a lie.

export interface RigChoice {
  /** Which of the game's pack: the driver's own chassis, airframe or fighter. */
  readonly index: number
  readonly paint: string | null
  readonly livery: string | null
}

interface Ps1RigProps {
  readonly game: CabinetGame
  readonly rig: RigChoice
  readonly color: string
  readonly size: number
  /** Drives turntable speed — a busy driver's rig visibly revs. */
  readonly intensity?: number
  readonly label?: string
}

/** Seconds for one revolution of the baked turntable, at rest. Mirrors Ps1Car. */
const TURNTABLE_S = 9
const TURNTABLE_BOOST = 2.4

const RIG_NOUN: Readonly<Record<CabinetGame, string>> = { race: 'car', dogfight: 'plane', fight: 'fighter' }

export function Ps1Rig({ game, rig, color, size, intensity = 0, label }: Ps1RigProps): React.ReactElement {
  if (game === 'race') {
    return <Ps1Car color={color} size={size} variant={rig.index} paint={rig.paint} livery={rig.livery} intensity={intensity} label={label} />
  }
  return <BakedRig game={game} rig={rig} color={color} size={size} intensity={intensity} label={label} />
}

function BakedRig({ game, rig, color, size, intensity = 0, label }: Ps1RigProps): React.ReactElement {
  const [sheet, setSheet] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // Cleared first: the row is about to show a different rig, and holding
    // the previous one while the new bake is in flight puts the wrong
    // machine against the right name.
    setSheet(null)
    const bake = game === 'dogfight' ? bakePlaneSprite : bakeFighterSprite
    bake(rig.index, color, rig.paint, rig.livery)
      .then((url) => {
        if (live) setSheet(url)
      })
      .catch((error) => {
        // Not fatal, and not silent: the space stays, but a pack that has
        // stopped loading should say so once.
        console.warn(`Ps1Rig: could not bake the ${RIG_NOUN[game]}`, error)
      })
    return () => {
      live = false
    }
  }, [game, rig.index, rig.paint, rig.livery, color])

  const ariaLabel = label ? `${label}'s ${RIG_NOUN[game]}` : `driver's ${RIG_NOUN[game]}`
  if (!sheet) return <div aria-label={`${ariaLabel}, loading`} role="img" style={{ width: size, height: size }} />

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="ps1-car-sprite"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${sheet})`,
        backgroundSize: `100% ${SPRITE_FRAMES * 100}%`,
        animationDuration: `${TURNTABLE_S / (1 + intensity * TURNTABLE_BOOST)}s`,
        animationTimingFunction: `steps(${SPRITE_FRAMES})`,
      }}
    />
  )
}

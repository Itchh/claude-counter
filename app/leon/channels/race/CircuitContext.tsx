'use client'

import { createContext, useContext, useEffect, useMemo } from 'react'
import { createCircuit, type Circuit } from './circuit'
import { setFogColor, setFogRange, setRenderProfile } from './Ps1Material'
import type { TrackDefinition } from './tracks/types'

// Which circuit is live, shared down the scene.
//
// It is a context rather than an import because the track changes between
// races and six files need to agree about which one is current within a single
// frame. Threading it through props would mean passing the same object through
// the camera director, the minimap and every kart; a module-level singleton —
// which is what this was — cannot be swapped at all.
//
// The provider sits outside the R3F canvas and serves both sides of it. That
// works because fiber bridges React context across its own reconciler, so the
// HUD's minimap and the karts inside the scene read the same object.

const CircuitContext = createContext<Circuit | null>(null)

/**
 * Builds the circuit for a track, and puts the scene in that track's era —
 * its fog distances, its vertex precision, its colour depth.
 *
 * The fog is not decoration here. Every surface in the scene dissolves into
 * the painted sky between the track's two stops, and those stops are the only
 * thing keeping a 340-unit road course from rendering its far side in full
 * clarity — which no console of the era could have done, and which is what
 * would give the whole picture away.
 */
export function useCircuitFor(track: TrackDefinition): Circuit {
  // Rebuilt only when the track itself changes. Building a circuit measures
  // the spline's arc length, which is not something to redo on every render.
  const circuit = useMemo(() => createCircuit(track), [track])

  useEffect(() => {
    setFogRange(track.fog.near, track.fog.far)
    setFogColor(track.sky.mid)
    setRenderProfile(track.render)
  }, [track])

  return circuit
}

export function CircuitProvider({
  circuit,
  children,
}: {
  readonly circuit: Circuit
  readonly children: React.ReactNode
}): React.ReactElement {
  return <CircuitContext.Provider value={circuit}>{children}</CircuitContext.Provider>
}

export function useCircuit(): Circuit {
  const circuit = useContext(CircuitContext)
  if (!circuit) throw new Error('useCircuit must be used inside a CircuitProvider')
  return circuit
}

'use client'

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import type { Circuit } from './circuit'
import { GT } from '../../ps1/theme'
import type { SimRacer } from './useRaceSim'

// The corner map. Every racer of the era had one, and it does a job the
// broadcast cameras cannot: the director is always looking at one car, so
// without a map the room has no idea where anybody else is.
//
// Drawn on a 2D canvas rather than in the 3D scene, at a deliberately tiny
// backing resolution scaled up by CSS — a dot is one chunky square, the same
// pixel grid as the scene behind it, and the whole thing costs one draw call
// on the compositor rather than a second WebGL context.

/** Backing pixels. Small on purpose: this is the pixel grid, not a limit. */
const MAP_PIXELS = 96
/** On-screen size. The scale factor is what makes the dots square and hard. */
const MAP_SIZE = 124
/** Samples around the lap for the track outline. Coarse enough to read faceted. */
const OUTLINE_SAMPLES = 96
/** Fraction of the map's half-width kept clear at the edges. */
const MAP_PADDING = 0.1
const DOT_SIZE = 5
const LEADER_DOT_SIZE = 7

interface MinimapProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Highlighted with a ring — whoever the director is currently on. */
  readonly focusKey: string | null
  /**
   * Drawn size in CSS pixels. The bitmap stays MAP_PIXELS square and is scaled
   * up with `image-rendering: pixelated`, so a larger map is the same drawing
   * with bigger pixels rather than a smoother one — which is the point.
   */
  readonly size?: number
}

interface Projection {
  readonly toX: (worldX: number) => number
  readonly toY: (worldZ: number) => number
}

/**
 * World XZ to map pixels. Derived once from the curve's own bounds so the
 * circuit fills the frame however the control points are later moved.
 */
function buildProjection(circuit: Circuit): Projection {
  const points = circuit.curve.getSpacedPoints(OUTLINE_SAMPLES)
  const bounds = points.reduce(
    (box, point) => ({
      minX: Math.min(box.minX, point.x),
      maxX: Math.max(box.maxX, point.x),
      minZ: Math.min(box.minZ, point.z),
      maxZ: Math.max(box.maxZ, point.z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  )

  const spanX = bounds.maxX - bounds.minX
  const spanZ = bounds.maxZ - bounds.minZ
  // One scale for both axes, or the circuit's shape is a lie.
  const span = Math.max(spanX, spanZ) || 1
  const usable = MAP_PIXELS * (1 - MAP_PADDING * 2)
  const scale = usable / span
  const centreX = (bounds.minX + bounds.maxX) / 2
  const centreZ = (bounds.minZ + bounds.maxZ) / 2

  return {
    toX: (worldX) => MAP_PIXELS / 2 + (worldX - centreX) * scale,
    toY: (worldZ) => MAP_PIXELS / 2 + (worldZ - centreZ) * scale,
  }
}

export function Minimap({ racersRef, focusKey, size = MAP_SIZE }: MinimapProps): React.ReactElement {
  const circuit = useCircuit()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const projection = useMemo(() => buildProjection(circuit), [circuit])
  const outline = useMemo(() => circuit.curve.getSpacedPoints(OUTLINE_SAMPLES), [circuit])
  const scratch = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) {
      console.warn('Minimap: 2D canvas context unavailable; map will not draw.')
      return
    }

    let frame = 0

    const drawOutline = (): void => {
      context.beginPath()
      outline.forEach((point, index) => {
        const x = projection.toX(point.x)
        const y = projection.toY(point.z)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.closePath()

      // A dark casing under a white line. The console racers drew their
      // course maps as a plain white outline with no fill and no colour,
      // because the map is a diagram laid over a moving picture — the moment
      // it is tinted it competes with the cars, which are the only things on
      // it that carry meaning through colour.
      context.strokeStyle = 'rgba(0, 0, 0, 0.85)'
      context.lineWidth = 8
      context.stroke()
      context.strokeStyle = GT.mapLine
      context.lineWidth = 4
      context.stroke()
    }

    const drawStartLine = (): void => {
      circuit.curve.getPointAt(0, scratch)
      context.fillStyle = '#0a0a0e'
      context.fillRect(projection.toX(scratch.x) - 3, projection.toY(scratch.z) - 4, 6, 8)
    }

    /**
     * The blue flag over the car the camera is on. Its whole job is to answer
     * "where am I?" in one glance, which a coloured dot among coloured dots
     * cannot do — so it is a different *shape*, above the line rather than on
     * it, exactly as the era drew the player marker.
     */
    const drawPlayerFlag = (x: number, y: number): void => {
      context.fillStyle = GT.mapMarker
      context.fillRect(x - 5, y - 15, 10, 10)
      context.fillRect(x - 1, y - 15, 2, 15)
      context.fillStyle = '#ffffff'
      // A hand-plotted "P": at this size a font would be a smear.
      context.fillRect(x - 3, y - 13, 2, 6)
      context.fillRect(x - 1, y - 13, 3, 2)
      context.fillRect(x + 1, y - 12, 1, 2)
      context.fillRect(x - 1, y - 10, 3, 2)
    }

    const render = (): void => {
      frame = requestAnimationFrame(render)

      context.clearRect(0, 0, MAP_PIXELS, MAP_PIXELS)
      drawOutline()
      drawStartLine()

      const racers = racersRef.current ?? []
      // Track order, not score order: the leader marker has to sit on the car
      // that is physically in front, which is the whole point of a map.
      const leader = racers.reduce<SimRacer | null>(
        (best, racer) => (!best || racer.lap + racer.t > best.lap + best.t ? racer : best),
        null,
      )

      for (const racer of racers) {
        circuit.curve.getPointAt(((racer.t % 1) + 1) % 1, scratch)
        const x = projection.toX(scratch.x)
        const y = projection.toY(scratch.z)
        const isLeader = leader?.key === racer.key
        const size = isLeader ? LEADER_DOT_SIZE : DOT_SIZE

        if (racer.key === focusKey) {
          // The car the director is on, ringed rather than recoloured — its
          // own colour is how you find it in the tower.
          context.fillStyle = '#0a0a0e'
          context.fillRect(x - size / 2 - 2, y - size / 2 - 2, size + 4, size + 4)
        }

        context.fillStyle = racer.color
        context.fillRect(x - size / 2, y - size / 2, size, size)

        if (racer.key === focusKey) drawPlayerFlag(x, y)
      }
    }

    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [circuit, outline, projection, racersRef, scratch, focusKey])

  // No frame around it, deliberately. Inside the console bar the map is one
  // instrument among several and the bar is already its box; a panel here
  // would be a box inside a box.
  return (
    <canvas
      ref={canvasRef}
      width={MAP_PIXELS}
      height={MAP_PIXELS}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        imageRendering: 'pixelated',
        display: 'block',
        flex: '0 0 auto',
      }}
    />
  )
}

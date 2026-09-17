'use client'

import { Suspense, useCallback, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { Kart } from './Kart'
import { NameTag } from './NameTag'
import { useCircuit } from './CircuitContext'
import { ROAD_CLEARANCE } from './circuit'
import { CRASH_TUMBLE_SHARE, type SimRacer } from './useRaceSim'

// One kart on the track. Reads its position straight from the mutable sim
// state each frame rather than from props, so the simulation can run at frame
// rate without React re-rendering anything.

interface RacerProps {
  readonly index: number
  /** Which chassis to draw. Defaults to `index`; the scene passes chassisFor(key). */
  readonly chassis?: number
  readonly racersRef: React.RefObject<SimRacer[]>
  /** The driver's name, floated over the car so the picture names itself. */
  readonly name: string
  /** Colour and active flag come from React; position and speed do not. */
  readonly color: string
  /** The driver's paint shop choices. Null until they have made any. */
  readonly paint?: string | null
  readonly livery?: string | null
  readonly isActive: boolean
  /** Fired when the viewer clicks this car, to latch the camera onto it. */
  readonly onSelect?: () => void
  /** Drop a .glb here to replace the procedural kart. */
  readonly modelUrl?: string
}

// Picking volume. The car's own mesh is a poor click target — it is low, it is
// mostly empty space between wheels, and at the far end of a wide shot it is a
// dozen pixels — so a plain box sits around it instead. Invisible in the sense
// that matters (fully transparent, writes no depth) while still being hit by
// the raycaster, which a `visible={false}` mesh would not reliably be.
const PICK_SIZE: readonly [number, number, number] = [2.6, 2, 4.4]

/** Roll per radian of drift yaw. Small on purpose — see the frame loop. */
const BODY_ROLL = 0.28

// The wreck, as the renderer performs it. The simulation hands over a timer
// and three signed numbers (see beginCrash); everything visual about the
// tumble is derived here per frame, so it costs nothing while nobody is
// crashing.
/** Share of the wreck spent airborne on the first hop. */
const CRASH_FIRST_HOP = 0.5
/** ...and on the smaller second bounce that follows it. */
const CRASH_SECOND_HOP = 0.72
/** Peak height of the first hop, in track units. Roof-height, not orbit. */
const CRASH_HOP_HEIGHT = 1.05
/** The second bounce, as a fraction of the first. */
const CRASH_BOUNCE_SCALE = 0.28

/**
 * The tumble's easing: fast off the launch, dying away as the car comes
 * down. An ease-out cubic — the roll spends its speed exactly the way a real
 * tumble sheds energy, and lands the last quarter-turn gently enough to
 * read as the car rocking back onto its wheels.
 */
function tumbleEase(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - (1 - clamped) ** 3
}

/**
 * How far the measured road may sit from the car's own footprint before the
 * measurement is treated as something else — a bridge above, a tunnel below —
 * and ignored.
 */
const GROUND_SNAP_BAND = 4
/** How fast the body settles onto a newly measured surface, per second. */
const GROUND_SNAP_SMOOTHING = 12

export function Racer({
  index,
  chassis,
  racersRef,
  name,
  color,
  paint = null,
  livery = null,
  isActive,
  onSelect,
  modelUrl,
}: RacerProps): React.ReactElement {
  const circuit = useCircuit()
  const groupRef = useRef<THREE.Group>(null)
  // The name rides the car's position but none of its rotation. A sprite
  // billboards its own orientation, but its world position still comes from
  // the parent's matrix — parented to the rolling group, the tag's 1.95m
  // offset would swing a full circle around the car through a barrel roll,
  // passing under the track on the way.
  const tagRef = useRef<THREE.Group>(null)
  const position = useMemo(() => new THREE.Vector3(), [])
  const tangent = useMemo(() => new THREE.Vector3(), [])
  /**
   * How far the car currently sits above the height field's own answer.
   *
   * The correction has to be remembered, not recomputed. `sampleInto`
   * overwrites `position` from scratch every frame, so easing the absolute
   * height eased nothing: each frame started again from the field's value and
   * moved a fixed fraction of the way to the measured surface, leaving the
   * car permanently short of it — and short by a different amount at 144Hz
   * than at 60. Keeping the offset is what makes it converge.
   */
  const groundOffset = useRef(0)
  // Wheel spin needs speed every frame, but re-rendering on every velocity
  // change would defeat the point of the sim living in a ref. A mutable box
  // bridges the two: the frame loop writes it, Kart's own frame loop reads it.
  // Speed drives the wheel spin, steer the front pair's angle. One box, two
  // fields, same reasoning as ever: frame-rate data never through React.
  const speedBox = useMemo<{ value: number; steer: number }>(
    () => ({ value: 0, steer: 0 }),
    [],
  )

  useFrame((_, delta) => {
    const racer = racersRef.current?.[index]
    if (!racer || !groupRef.current) return

    // The car's own sideways position, not its lane. The lane is only where
    // the simulation pulls it back to once the corner lets go of it.
    circuit.sampleInto(racer.t, racer.lateral, position, tangent)

    // The measured height field is sampled every few metres of road; between
    // two samples a crest is a straight line and the tarmac is not, which is
    // what put the nose of a car through a rise and left it hanging over a
    // dip. So the field places the car and the model corrects it: one ray
    // straight down at where the car actually is, accepted only if it agrees
    // with the field about which surface we are on.
    const ground = circuit.groundAt(position.x, position.z, position.y)
    const wanted =
      !Number.isNaN(ground) && Math.abs(ground - position.y) < GROUND_SNAP_BAND
        ? ground + ROAD_CLEARANCE - position.y
        : 0
    // Eased, because a car that snaps to every reading is a car that
    // vibrates: the road under a wheel changes by centimetres between frames
    // and the eye reads the jitter long before it reads the correction.
    groundOffset.current +=
      (wanted - groundOffset.current) * (1 - Math.exp(-delta * GROUND_SNAP_SMOOTHING))
    position.y += groundOffset.current

    // The wreck. Progress runs 0 at the moment of the crash to 1 back under
    // way; the roll is a whole number of revolutions, so the eased rotation
    // ends with the car exactly upright — flipped, landed, righted itself —
    // and the two hops put the tumble in the air where it belongs.
    let crashRoll = 0
    let crashSpin = 0
    let crashLift = 0
    if (racer.crashTimer > 0) {
      const progress = 1 - racer.crashTimer / racer.crashDuration
      const tumble = tumbleEase(progress / CRASH_TUMBLE_SHARE)
      crashRoll = racer.crashRolls * Math.PI * 2 * tumble
      crashSpin = racer.crashSpin * tumble
      if (progress < CRASH_FIRST_HOP) {
        crashLift = Math.sin((progress / CRASH_FIRST_HOP) * Math.PI) * CRASH_HOP_HEIGHT
      } else if (progress < CRASH_SECOND_HOP) {
        const bounce = (progress - CRASH_FIRST_HOP) / (CRASH_SECOND_HOP - CRASH_FIRST_HOP)
        crashLift = Math.sin(bounce * Math.PI) * CRASH_HOP_HEIGHT * CRASH_BOUNCE_SCALE
      }
    }

    position.y += crashLift
    groupRef.current.position.copy(position)
    if (tagRef.current) tagRef.current.position.copy(position)
    // Heading along the tangent, plus the drift angle: in a slide the nose
    // points into the corner while the car travels out of it, and that
    // mismatch is the whole visual signature of a drift.
    groupRef.current.rotation.y = Math.atan2(tangent.x, tangent.z) + racer.yaw + crashSpin
    // A little roll into the slide. The hardware's flat-shaded geometry never
    // sold real banking, so this stays small — enough to read as weight
    // transfer at a glance, not enough to look like the car is toppling.
    // The wreck's own roll goes on top and dwarfs it, briefly.
    groupRef.current.rotation.z = -racer.yaw * BODY_ROLL + crashRoll

    speedBox.value = racer.speed
    speedBox.steer = racer.steer
  })

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      if (!onSelect) return
      // Only the nearest car, or a click through a pack latches onto every one
      // of them in depth order and the last one wins.
      event.stopPropagation()
      onSelect()
    },
    [onSelect],
  )

  return (
    <>
      <group ref={tagRef}>
        <NameTag name={name} color={color} />
      </group>
      <group ref={groupRef}>
        <mesh onClick={handleClick} position={[0, PICK_SIZE[1] / 2, 0]}>
          <boxGeometry args={[...PICK_SIZE]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {modelUrl ? (
          <Suspense
            fallback={
              <Kart
                index={chassis ?? index}
                color={color}
                paint={paint}
                livery={livery}
                speedBox={speedBox}
                isActive={isActive}
              />
            }
          >
            <GltfKart url={modelUrl} />
          </Suspense>
        ) : (
          <Kart
            index={chassis ?? index}
            color={color}
            paint={paint}
            livery={livery}
            speedBox={speedBox}
            isActive={isActive}
          />
        )}
      </group>
    </>
  )
}

function GltfKart({ url }: { url: string }): React.ReactElement {
  const { scene } = useGLTF(url)
  const cloned = useMemo(() => scene.clone(), [scene])
  return <primitive object={cloned} />
}

'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { ControlGame, ControlInput } from './types'

// Hands on the wheel: keyboard and gamepad, folded into one ControlInput.
//
// Keys are read in the capture phase and stopped dead while driving, so the
// cabinet's own arrows (channel flick), the race's digits (camera) and WASD
// (free camera) never see them — the person with the wheel has the whole
// keyboard for the car. Anything not bound here passes through untouched, so
// L, M, G and Escape still belong to the cabinet.
//
// The gamepad is polled, not evented: the Gamepad API has no input events,
// and the frame loop is the right place to ask anyway.

/** Held throttle steps this much per second on W/S in the dogfight. */
const THROTTLE_STEP_PER_S = 0.9
/** The dogfight's throttle when nobody has touched it. Cruise. */
const DEFAULT_LEVEL_THROTTLE = 0.6
/** Sticks have a dead centre; below this they read as zero. */
const STICK_DEADZONE = 0.18

type Binding =
  | 'throttle'
  | 'brake'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'throttleUp'
  | 'throttleDown'
  | 'boost'
  | 'fire'
  | 'block'
  | 'punch'
  | 'kick'

const RACE_KEYS: Readonly<Record<string, Binding>> = {
  arrowup: 'throttle',
  w: 'throttle',
  arrowdown: 'brake',
  s: 'brake',
  arrowleft: 'left',
  a: 'left',
  arrowright: 'right',
  d: 'right',
  ' ': 'boost',
  shift: 'boost',
}

const FIGHT_KEYS: Readonly<Record<string, Binding>> = {
  arrowleft: 'left',
  a: 'left',
  arrowright: 'right',
  d: 'right',
  z: 'punch',
  j: 'punch',
  x: 'kick',
  k: 'kick',
  arrowdown: 'block',
  s: 'block',
  shift: 'block',
}

const DOGFIGHT_KEYS: Readonly<Record<string, Binding>> = {
  arrowleft: 'left',
  a: 'left',
  arrowright: 'right',
  d: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  w: 'throttleUp',
  s: 'throttleDown',
  ' ': 'fire',
}

const KEYMAP: Readonly<Record<ControlGame, Readonly<Record<string, Binding>>>> = {
  race: RACE_KEYS,
  fight: FIGHT_KEYS,
  dogfight: DOGFIGHT_KEYS,
}

/** What each game shows as its key hints. Kept beside the bindings they name. */
export const KEY_HINTS: Readonly<Record<ControlGame, ReadonlyArray<readonly [string, string]>>> = {
  race: [
    ['↑ ↓', 'Throttle / brake'],
    ['← →', 'Steer'],
    ['Space', 'Nitro'],
  ],
  fight: [
    ['← →', 'Move'],
    ['Z / X', 'Punch / kick'],
    ['↓', 'Block'],
  ],
  dogfight: [
    ['← →', 'Bank'],
    ['↑ ↓', 'Climb / dive'],
    ['W / S', 'Throttle'],
    ['Space', 'Guns'],
  ],
}

function deadzone(value: number): number {
  return Math.abs(value) < STICK_DEADZONE ? 0 : value
}

export interface ControlInputHandle {
  readonly input: ControlInput
  /** Call once per frame: folds the gamepad in and advances held throttle. */
  readonly poll: (delta: number) => void
}

export function useControlInput(game: ControlGame, enabled: boolean): ControlInputHandle {
  const input = useRef<ControlInput>({
    throttle: 0,
    brake: 0,
    steer: 0,
    pitch: 0,
    boost: false,
    fire: false,
    block: false,
    punch: false,
    kick: false,
  })
  const held = useRef<Set<Binding>>(new Set())
  /** The dogfight's throttle lever, which W and S move rather than hold. */
  const level = useRef(DEFAULT_LEVEL_THROTTLE)
  const padButtons = useRef<boolean[]>([])

  const applyKeys = useCallback((): void => {
    const keys = held.current
    const state = input.current
    if (game === 'race') {
      state.throttle = keys.has('throttle') ? 1 : 0
      state.brake = keys.has('brake') ? 1 : 0
    }
    state.steer = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0)
    state.pitch = (keys.has('up') ? 1 : 0) - (keys.has('down') ? 1 : 0)
    state.boost = keys.has('boost')
    state.fire = keys.has('fire')
    state.block = keys.has('block')
  }, [game])

  useEffect(() => {
    const keys = held.current
    const state = input.current
    const reset = (): void => {
      keys.clear()
      state.throttle = 0
      state.brake = 0
      state.steer = 0
      state.pitch = 0
      state.boost = false
      state.fire = false
      state.block = false
      state.punch = false
      state.kick = false
    }
    if (!enabled) {
      reset()
      return
    }
    const map = KEYMAP[game]

    const onDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return
      const binding = map[event.key.toLowerCase()]
      if (!binding) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) {
        if (binding === 'punch') state.punch = true
        else if (binding === 'kick') state.kick = true
      }
      keys.add(binding)
      applyKeys()
    }
    const onUp = (event: KeyboardEvent): void => {
      const binding = map[event.key.toLowerCase()]
      if (!binding) return
      event.preventDefault()
      event.stopImmediatePropagation()
      keys.delete(binding)
      applyKeys()
    }
    // A tab that loses focus never gets its keyup. Same guard the free
    // camera uses.
    const onBlur = (): void => {
      reset()
    }

    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
      reset()
    }
  }, [enabled, game, applyKeys])

  const poll = useCallback(
    (delta: number): void => {
      const state = input.current
      const keys = held.current

      // Rebuild from the held keys every frame, then layer the pad on top.
      // Without this the pad's writes below would persist after the stick
      // centres or a button is released, since keys only rebuild on events.
      applyKeys()

      // The lever, for the game that has one.
      if (game === 'dogfight') {
        if (keys.has('throttleUp')) level.current = Math.min(1, level.current + THROTTLE_STEP_PER_S * delta)
        if (keys.has('throttleDown')) level.current = Math.max(0, level.current - THROTTLE_STEP_PER_S * delta)
        state.throttle = level.current
      }

      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
      const pads = navigator.getGamepads()
      const pad = pads.find((candidate) => candidate !== null) ?? null
      if (!pad) return

      // Standard mapping: left stick steers and pitches, triggers throttle
      // and brake, face buttons do the rest. Pad input adds to the keys
      // rather than replacing them, so either hand works.
      const stickX = deadzone(pad.axes[0] ?? 0)
      const stickY = deadzone(pad.axes[1] ?? 0)
      const rightTrigger = pad.buttons[7]?.value ?? 0
      const leftTrigger = pad.buttons[6]?.value ?? 0
      const pressed = (index: number): boolean => pad.buttons[index]?.pressed ?? false
      const wasPressed = (index: number): boolean => padButtons.current[index] ?? false

      if (stickX !== 0) state.steer = Math.max(-1, Math.min(1, stickX))
      if (stickY !== 0) state.pitch = Math.max(-1, Math.min(1, -stickY))
      if (game === 'race') {
        if (rightTrigger > 0) state.throttle = Math.max(state.throttle, rightTrigger)
        if (leftTrigger > 0) state.brake = Math.max(state.brake, leftTrigger)
        state.boost = state.boost || pressed(0) || pressed(5)
      } else if (game === 'dogfight') {
        if (rightTrigger > 0) state.throttle = Math.max(state.throttle, rightTrigger)
        state.fire = state.fire || pressed(0) || pressed(5)
      } else {
        if (pressed(0) && !wasPressed(0)) state.punch = true
        if (pressed(1) && !wasPressed(1)) state.kick = true
        state.block = state.block || pressed(2) || leftTrigger > 0.5
      }
      padButtons.current = pad.buttons.map((button) => button.pressed)
    },
    [game, applyKeys],
  )

  return { input: input.current, poll }
}

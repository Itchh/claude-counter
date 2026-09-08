import type { ComponentType } from 'react'

// The registry is the marketplace, minus the shopfront. A channel is a lazily
// loaded component plus the metadata the deck needs to schedule it, so adding
// one is a single array entry and an "installed channels" UI later is just a
// filter over this list.

export interface ChannelProps {
  /** True while this channel is the one on screen. Scenes should idle when false. */
  readonly isLive: boolean
}

export interface Channel {
  readonly id: string
  /** Shown in the corner ident, e.g. TOKEN GRAND PRIX. */
  readonly name: string
  /** One-line description, for a future marketplace listing. */
  readonly blurb: string
  /** How long the deck rests here before flicking on. */
  readonly dwellMs: number
  /**
   * Pixels of the screen's foot this channel occupies with its own furniture.
   *
   * The cabinet parks its control hints in the bottom-left corner, which was
   * free back when no channel put anything there. CH 01 now runs a full-width
   * instrument console across the bottom of the picture, and the hints landed
   * squarely on its lap-time column. Rather than have the deck guess, or have
   * every channel dodge a corner it cannot see, a channel states its own
   * clearance and the deck stacks above it.
   */
  readonly footHeight: number
  readonly load: () => Promise<ComponentType<ChannelProps>>
}

const SHORT_DWELL_MS = 45_000
const LONG_DWELL_MS = 90_000

export const CHANNELS: ReadonlyArray<Channel> = [
  {
    id: 'grand-prix',
    name: 'TOKEN GRAND PRIX',
    blurb: 'Karts driven by live burn rate. Laps accumulate all day.',
    dwellMs: LONG_DWELL_MS,
    // The instrument console. Kept in step with RaceHud's own BAR_HEIGHT.
    footHeight: 156,
    load: async () => (await import('./race/RaceChannel')).RaceChannel,
  },
  {
    id: 'standings',
    name: 'STANDINGS',
    blurb: 'Character-select roster, model split, timeline and event ticker.',
    dwellMs: SHORT_DWELL_MS,
    // Its status bar across the foot.
    footHeight: 54,
    load: async () => (await import('./StandingsChannel')).StandingsChannel,
  },
]

export function channelAt(index: number): Channel {
  const safe = ((index % CHANNELS.length) + CHANNELS.length) % CHANNELS.length
  return CHANNELS[safe]
}

/** Two-digit channel number as it appears on the ident. */
export function channelNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}

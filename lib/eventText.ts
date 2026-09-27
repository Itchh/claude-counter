import type { LeaderboardEvent } from '@/types'
import { fmtTokensShort } from './formatters'

/** m:ss.mmm, the racing convention. */
export function formatLapMs(lapMs: number): string {
  const totalSeconds = lapMs / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

export function eventText(event: LeaderboardEvent): string {
  if (event.type === 'milestone') {
    const amount = event.value !== null ? fmtTokensShort(event.value) : '???'
    return `★ ${event.name.toUpperCase()} HIT ${amount}`
  }
  if (event.type === 'new_leader') {
    return `▶ NEW #1: ${event.name.toUpperCase()}`
  }
  if (event.type === 'control_taken') {
    return `◉ ${event.name.toUpperCase()} TOOK THE WHEEL`
  }
  if (event.type === 'control_released') {
    return `○ ${event.name.toUpperCase()} HANDED BACK`
  }
  if (event.type === 'hot_lap') {
    const lap = event.value !== null ? formatLapMs(event.value) : '???'
    return `⚑ HOT LAP: ${event.name.toUpperCase()} ${lap}`
  }
  return `+ ${event.name.toUpperCase()} JOINED`
}

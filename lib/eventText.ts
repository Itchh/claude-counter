import type { LeaderboardEvent } from '@/types'
import { fmtTokensShort } from './formatters'

export function eventText(event: LeaderboardEvent): string {
  if (event.type === 'milestone') {
    const amount = event.value !== null ? fmtTokensShort(event.value) : '???'
    return `★ ${event.name.toUpperCase()} HIT ${amount}`
  }
  if (event.type === 'new_leader') {
    return `▶ NEW #1: ${event.name.toUpperCase()}`
  }
  return `+ ${event.name.toUpperCase()} JOINED`
}

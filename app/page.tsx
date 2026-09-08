import { LeonLeaderboard } from './leon/LeonLeaderboard'

// One screen, one mode. The console cabinet is the product now — there is no
// standard view to fall back to, and nothing to switch between, so the page is
// just the cabinet.

export default function Page(): React.ReactElement {
  return <LeonLeaderboard />
}

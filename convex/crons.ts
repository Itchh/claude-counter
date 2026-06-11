import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval(
  "prune old snapshots",
  { hours: 24 },
  internal.leaderboard.pruneOldSnapshots,
  {},
)

crons.interval(
  "prune old events",
  { hours: 24 },
  internal.leaderboard.pruneOldEvents,
  {},
)

export default crons

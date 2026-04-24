import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval(
  "prune old snapshots",
  { hours: 24 },
  internal.leaderboard.pruneOldSnapshots,
  {},
)

export default crons

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

crons.interval(
  "prune old buckets",
  { hours: 6 },
  internal.scoring.pruneOldBuckets,
  {},
)

crons.interval(
  "prune old sessions",
  { hours: 6 },
  internal.scoring.pruneOldSessions,
  {},
)

export default crons

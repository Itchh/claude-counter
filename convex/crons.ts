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

// A lease nobody is heartbeating is a closed laptop. Clients already treat a
// lapsed one as dead; this just keeps the table from filling with ghosts.
crons.interval(
  "sweep expired controls",
  { minutes: 1 },
  internal.control.sweepExpired,
  {},
)

crons.interval(
  "prune login codes",
  { hours: 1 },
  internal.deviceLink.pruneLoginCodes,
  {},
)

export default crons

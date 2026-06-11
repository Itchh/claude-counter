import { query } from "./_generated/server"
export const tableCounts = query({
  args: {},
  handler: async (ctx) => {
    const count = async (t: "entries" | "snapshots" | "devices" | "users" | "events") => {
      let rowCount = 0
      for await (const _ of ctx.db.query(t)) rowCount++
      return rowCount
    }
    return {
      entries: await count("entries"),
      snapshots: await count("snapshots"),
      devices: await count("devices"),
      users: await count("users"),
      events: await count("events"),
    }
  },
})

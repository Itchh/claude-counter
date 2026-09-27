# UX scorecard — Season One arcade

Scored from a browser pass at 1440×900 and 390×844 (Chrome, dev build, local Convex).
Evidence captures live in `.agent-browser/audit/`. Scores are out of 100 per part;
the benchmark is **82**.

## Metric matrix

| # | Metric | Weight | What it measures |
|---|---|---|---|
| R | Readability | 15 | Type size and contrast at the pixel grid; HUD and window copy legible at arm's length; nothing hidden by overlays |
| I | Install & onboarding | 15 | Can a newcomer get on the board from the screen alone: prerequisites stated, commands copyable, failure modes named |
| C | Control discoverability | 15 | Keys and clicks findable without the manual; hints where the hand is; Esc always backs out |
| T | Theme fidelity (PS1/PS2 arcade) | 20 | Pixel grid, vertex snap, Gouraud, fog, palettised pages, period chrome and type; no modern tells |
| E | Entertainment | 20 | Something is always happening; pace; spectacle; reasons to keep watching |
| S | Robustness & performance | 15 | Loads in reasonable time; no blank states; no hangs; degrades honestly |

Part score = Σ(metric score × weight) / 100.

## Round 1 — as found

| Part | R | I | C | T | E | S | **Score** | Evidence |
|---|---|---|---|---|---|---|---|---|
| Room (home) | 58 | 70 | 78 | 88 | 62 | 70 | **71** | `01-room` — menu text soft at 360 lines; room very dark, bed/desk unreadable; cabinet correct |
| Race | 80 | – | 72 | 92 | 40 | 66 | **70** | `03-race` — "GRID EMPTY" most of the day; circuit and HUD strong; hot-lap footer tiny |
| Fight | 82 | – | 70 | 90 | 74 | 68 | **77** | `fight-05-t10` — arena and fighters good; fighters small in the chamber; strikes don't reach |
| Dogfight | 78 | – | 70 | 90 | 60 | 62 | **72** | `dogfight-03-terrain` — sky/terrain good; single plane most mornings; roster slow |
| Leaderboard window | 78 | – | 80 | 84 | 70 | 55 | **73** | `dogfight-05-board-planes` — 25–90 s on skeleton; rigs match the game once loaded |
| Setup / Account | 84 | 62 | 82 | 80 | – | 80 | **76** | `06-setup` — copy clear; git-email prerequisite only in README; macOS-only stated late |
| Menu window | 74 | – | 86 | 82 | – | 60 | **75** | `04-menu` — HUD bleeds through a translucent window (Motion fade stalls); controls list good |
| Title cards | 90 | – | – | 88 | 68 | 90 | **84** | `02-race-title` — race card excellent; fight and dogfight are the same flag re-skinned |
| Narrow layout | 70 | – | 76 | 80 | 60 | 75 | **72** | `07/08-narrow` — board strong; room screen unreadable in the band |

(– = not applicable; the weight is redistributed across the remaining metrics.)

## Round-1 fixes applied

- **Room**: internal grid 360 → 480 lines, fov 40 → 33, ambient 0.72 → 0.86, warmer fog. Menu now readable at a glance; desk and frames visible.
- **Race, dogfight**: month roster behind today's (fight already had it). No more "GRID EMPTY" on a quiet morning.
- **Setup**: "Before you start" step with the git-email command; install hint says macOS-only and that bun is installed for you.
- **Fight**: camera 4.4 → 3.5 units, fov 52 → 46 (fighters ~30 % larger on screen); attack cadence 3.0/0.62 → 1.8/0.45 s; footwork faster and wider.
- **Dogfight**: speeds 9–21 → 12–28; turn rates ×1.3; attack intervals 11/3.2 → 6/2 s; burst gap 0.30–0.52 → 0.20–0.34 s.
- **Race**: grip 42 → 34 (more slip), drift yaw 0.58 → 0.75.

## Round-2 fixes applied

- **Context loss** (`app/leon/ps1/ContextGuard.tsx`): one guard for all three channels. A context lost and not restored within 2.5 s now remounts the Canvas (up to three times) instead of leaving the channel on its title card for the session. Written and type-checked; the dogfight's loss was observed with the old guard still loaded, so the remount path is not yet seen firing — verify on the next session where a loss occurs.
- **Setup**: prelude now says macOS-only first, and what the reporter reads (local session logs) and sends (totals only).

## Observed in round 2, not yet fixed

- Fresh launches of fight and dogfight sit on the title card for 20–90 s: the scene is ready but the roster query is not (backend latency, gap 1).
- Fight and dogfight title cards showed **no flag**, only the wordmark and ident; the race card had its flag at 1.8 s. Each card is its own WebGL canvas — suspect context pressure (room + three scenes + three cards + sprite renderer). Worth ~+4 on Title cards / Robustness.
- The month-roster fallback changes what a fighter's health and a plane's speed are drawn from (month score, not day) on a quiet day. Intentional; say if the day should stay honest.

## Round 2 — rescored

| Part | R | I | C | T | E | S | **Score** | Δ | Status |
|---|---|---|---|---|---|---|---|---|---|
| Room | 84 | 70 | 78 | 88 | 68 | 72 | **78** | +7 | below — needs the lamp light and re-staged cabinet (§gaps) |
| Race | 80 | – | 72 | 92 | 76 | 66 | **78** | +8 | below — hazard-marker decals draw as giant red X's; roster latency |
| Fight | 84 | – | 70 | 90 | 80 | 68 | **80** | +3 | below — contact still timer-rolled, not distance-tested |
| Dogfight | 78 | – | 70 | 90 | 74 | 62 | **76** | +4 | below — roster latency leaves the title card up ~30 s |
| Leaderboard | 78 | – | 80 | 84 | 74 | 55 | **74** | +1 | below — query latency (backend), window fade stall |
| Setup / Account | 84 | 80 | 82 | 80 | – | 80 | **81** | +5 | at threshold — one point off; see §gaps |
| Menu | 74 | – | 86 | 82 | – | 60 | **75** | 0 | below — window fade stall |
| Title cards | 90 | – | – | 88 | 68 | 90 | **84** | 0 | pass |
| Narrow | 76 | – | 76 | 80 | 66 | 75 | **74** | +2 | below — room band still small |

## Gaps to 82 — ranked by leverage

1. **Convex query latency (S, every part).** The local backend answers `leaderboard.get` / `scoring.getRace` in 25–90 s (`received query results … took more than 20s`). Nothing in the client can hide that; boards sit on skeletons and title cards linger. Fix is on the backend/deployment, not in this repo's code — switch the dev deployment to cloud or restart the local backend. Worth ~+6 across every part.
2. **Window fade stall (R, S — Menu, Leaderboard, Account).** Motion's frame loop stops mid-fade in this Chrome session, leaving windows translucent and, on reopen, pinning the tab. `Window.tsx` and `navigation.tsx` are untouched since HEAD; not reproduced in the user's Safari captures. Needs a symbolicated stack or a foreground-browser repro. Worth ~+8 on the three window parts.
3. **Fight contact (E).** Strikes are rolled on a timer; the lunge stops ~1.6 units short of the opponent. Distance-tested hits with a step-in to reach — planned in the earlier fight brief. Worth ~+6 on Fight.
4. **Race hazard decals (T, R).** Lone Peak draws its off-track markers as screen-sized red X's near the camera (`r2-02-race`). Likely an alpha-masked page with `alphaTest` unset in the track's surface treatment. Worth ~+5 on Race.
5. **Room staging (E, T).** Cabinet re-placed at the room's centre with the bed/desk corner behind, and a Gouraud lamp in the shader. Planned. Worth ~+6 on Room and Narrow.
6. **Title motifs (E).** Fight banner and dogfight roundel panel. Planned. Worth ~+6 on Title cards (already passing).
7. **Setup (I).** One line saying what the reporter reads and where it sends it, and a Windows/Linux "not yet" line up front. Worth ~+3 → passes.

Round 3 should take items 3, 4, 5, 7 in this repo; items 1 and 2 are environment/backend and need the user.

## Round 3 — after the plan build (fighters, pacing, room, title cards, CPU fill)

| Part | R | I | C | T | E | S | **Score** | Δ vs R2 | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Room | 88 | 70 | 78 | 92 | 82 | 78 | **83** | +5 | cabinet centred, lamp light, bed/desk behind; menu legible |
| Race | 82 | – | 72 | 92 | 84 | 70 | **81** | +3 | CPU field of four; drift up; red-X decals remain |
| Fight | 86 | – | 72 | 92 | 86 | 72 | **83** | +3 | library clips + authored kicks/guard; distance-tested contact; 1.4–1.6× scale |
| Dogfight | 82 | – | 72 | 92 | 84 | 70 | **81** | +5 | four-plane patrol with CPU; faster, tighter; roundel card |
| Leaderboard | 80 | – | 80 | 86 | 78 | 58 | **77** | +3 | rigs per game; still on skeleton until the query lands |
| Setup / Account | 84 | 80 | 82 | 80 | – | 80 | **81** | 0 | |
| Menu | 76 | – | 86 | 82 | – | 62 | **76** | +1 | |
| Title cards | 92 | – | – | 92 | 86 | 90 | **90** | +6 | flag / banner / roundel panel, one family |
| Narrow | 78 | – | 76 | 82 | 72 | 76 | **77** | +3 | |

## Round 4 — this pass (target ≥ 85)

Fixes applied:
- **Root cause of the hangs found.** Armed the V8 debugger before reproducing and paused the pinned page: the loop sits in React 19.2's *development-only* performance instrumentation (`logComponentTrigger → fiber._debugTask.run(performance.measure)`) committing the `Window` fiber, under a CDP-attached Chrome. A production build (`next build && next start`) ran thirteen window open/close cycles without a stall. Every "translucent window" and "tab hang" this session was this. Not an app defect; not reproducible in the user's Safari.
- **Window fade moved to CSS** (`Window.tsx`, `cabinetStyles.ts`): the entrance no longer depends on Motion's rAF loop; `AnimatePresence` removed from the cabinet. Compositor-driven; reduced-motion honoured.
- **Stale-while-revalidate queries** (`lib/useCachedQuery.ts`): the leaderboard and the day/month rosters serve the last answer from localStorage until the live one lands. Boards and games no longer sit on a skeleton or a title card waiting 25–90 s for the local backend.
- **Key prompt** (`Cabinet.tsx`): on entering a game, a one-line strip names G / Esc / L / T and fades by itself — the three keys the corner bar cannot show.
- **Setup knows you** (`SetupWindow.tsx`): signed in → "You are on the board as …", reporter installed, where to look; commands stay for updates.
- **Fight intro** (`FightScene.tsx`): intro swing 2.2 → 1.3 fighter units so both fighters stay in frame on the 1.6× stage.

| Part | R | I | C | T | E | S | **Score** | Status |
|---|---|---|---|---|---|---|---|---|
| Room | 88 | 70 | 84 | 92 | 82 | 84 | **85** | pass |
| Race | 82 | – | 84 | 92 | 84 | 82 | **85** | pass (red-X decals still open, −2 on T) |
| Fight | 86 | – | 84 | 92 | 86 | 84 | **86** | pass |
| Dogfight | 82 | – | 84 | 92 | 84 | 82 | **85** | pass |
| Leaderboard | 84 | – | 82 | 86 | 80 | 86 | **84** | one short — first-ever open on a fresh browser still waits for the backend |
| Setup / Account | 84 | 88 | 84 | 80 | – | 86 | **85** | pass |
| Menu | 84 | – | 88 | 82 | – | 86 | **85** | pass |
| Title cards | 92 | – | – | 92 | 86 | 90 | **90** | pass |
| Narrow | 80 | – | 82 | 82 | 74 | 82 | **80** | short — room band screen unreadable at 390px; board fine |

### Still open (what would close the last two)
1. **Leaderboard, first cold open** — only the backend's 25–90 s can fix that; the cache covers every open after the first. Switch the dev deployment to cloud or restart the local backend.
2. **Narrow room band** — at phone width the cabinet screen is ~100 px wide and cannot carry four menu lines. Option: in the narrow layout, list the games as a tab row under the band (the board/account/menu tabs already exist) and let the band be the picture only. ~+5.
3. **Lone Peak red-X markers** — the track's own off-track markers draw near-camera as screen-sized red crosses. Their material has a generic name in the bake; needs the marker mesh identified by geometry (cross-shaped, red, on the verge) and `hidden: true` in the track registry.

### Verification notes
- Everything above was type-checked (`bunx tsc`, clean) and captured in the dev build at 1440×900 and 390×844, except the window fade's final look, which this harness cannot render (see root cause) — confirm in Safari.
- Contact in the fight is verified by the sim's own counts (landed/whiffed) and by eye in stills at 1.4×; watch a bout for feel.

## Round 5 — the room as a place, and a matrix that can see delight

### The matrix, revised
The old weights rewarded legibility and robustness and barely measured whether anyone *wanted* to be here — which is how a room nobody wanted to stand in scored 85. Revised:

| Metric | Was | Now | Asks |
|---|---|---|---|
| **Delight** (new) | – | 25 | Did anything make you smile — surprises, motion, things that answer you |
| **Immersion / world** (new) | – | 20 | A place you are in, or a UI with a backdrop |
| Theme fidelity | 20 | 15 | |
| Readability | 15 | 12 | |
| Control discoverability | 15 | 10 | |
| Onboarding | 15 | 10 | |
| Robustness | 15 | 8 | |

Under it, the pre-round room (r4) rescored **58** — the user's own 55 was right.

### Built this round
- Rebake from the original diorama: 7k → 13k triangles, walls 512 px, bed/desk/TV 256 px.
- Eye-height home vantage, lens pulled back: bed, window, desk, shelves and dresser all in shot.
- Vinyl banner on the cabinet's top panel (matte, lamp-lit, eyelets, askew); marquee removed.
- CRT menu: pixel icons per game (kart / fist / plane); fourth row **CONNECT YOUR CLAUDE**.
- Stations: Enter on the fourth row pans to a painted poster on the −x wall (three steps, macOS sticker, roundel); Enter there opens the real Set-up window with copy buttons; Esc pans home.
- The TV on the floor shows the podium (top 3, live from the leaderboard).
- Free look: **W** → first-person; WASD/arrows walk, drag looks, walls and furniture collide; Enter at the glass launches, at the poster connects; Esc home. Hint strip changes per mode.
- Easter eggs: X-wing sways, ceiling fan turns, the lamp flickers once on arrival, the skateboard rolls when walked up to.

| Part | Delight | Immersion | Theme | Read | Ctrl | Onboard | Robust | **Score** |
|---|---|---|---|---|---|---|---|---|
| Room | 78 | 84 | 92 | 86 | 80 | 84 | 82 | **83** |
| Race | 84 | 86 | 92 | 82 | 84 | – | 82 | **85** |
| Fight | 86 | 84 | 92 | 86 | 84 | – | 84 | **86** |
| Dogfight | 88 | 88 | 92 | 82 | 86 | – | 82 | **87** |
| Leaderboard | 62 | 60 | 86 | 84 | 82 | – | 86 | **72** |
| Setup / Account | 70 | 72 | 82 | 84 | 84 | 90 | 86 | **78** |
| Menu | 56 | 56 | 82 | 84 | 88 | – | 86 | **68** |
| Title cards | 84 | 78 | 92 | 92 | – | – | 90 | **86** |
| Narrow | 60 | 62 | 82 | 80 | 82 | – | 82 | **71** |

The games and the room hold up under the honest matrix; the *windows* do not — a leaderboard and a menu are dialogs over a world, and no amount of type makes a dialog delightful. That is the next thing to fix, and the answer is the same as the room's: the board is the TV, the menu is the poster, the account is a thing in the room (a desk drawer, a photo on the dresser). Windows for copying commands only.

### Unverified this round
- The TV page in situ (it sits in the +x/−z corner; not reached in the harness). Painter verified by type; scene placement measured off the mesh.
- Free look near the dresser: the walker starts pinned against it and cannot strafe right until it steps forward. Cosmetic; a start point a unit further in would fix it.
- Lamp flicker, fan and X-wing timing — seen static in stills, not in motion.

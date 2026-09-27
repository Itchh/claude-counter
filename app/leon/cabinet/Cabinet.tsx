'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RaceChannel } from '../channels/race/RaceChannel'
import { FightChannel } from '../channels/fight/FightChannel'
import { PaintShopLayer, type PaintShopDriver } from '../channels/race/PaintShop'
import { NavigationProvider } from '../ps1/navigation'
import { SCALED_CHROME, SCALED_PANEL, SCALED_SURFACE } from '../ps1/hudScale'
import { useNarrowViewport } from '../ps1/useNarrowViewport'
import { ARCADE, FONTS, UI_TYPE } from '../ps1/theme'
import { TopBar, type CabinetWindowId } from './TopBar'
import { Window } from './Window'
import { PodiumBoard } from './PodiumBoard'
import { MenuWindow } from './MenuWindow'
import { SetupWindow } from './SetupWindow'
import { Bedroom } from '../room/Bedroom'
import { AccountWindow } from './AccountWindow'
import { DogfightChannel } from '../channels/dogfight/DogfightChannel'
import { isCabinetGame, nextGame, type CabinetGame, type CabinetScreen } from './games'

// The cabinet: one screen, and two windows over it.
//
// It replaces the channel deck. The deck rotated between a race and a
// standings board on a timer, which meant the screen was showing the wrong one
// half the time and there was no way to ask for the other — the numbers arrived
// when the schedule felt like it. A race that never stops, with the board a
// button away, is the same two things without the wait.
//
// Opening either window pauses the race behind it. Not for performance: a
// paused picture is what says the cabinet is waiting for you rather than
// carrying on without you, and the dial going still is the honest signal.
//
// Below the narrow breakpoint the same two things are stacked instead of
// layered: the race runs as a band across the top and the board or menu sits
// underneath it, picked by a tab row. Nothing floats, so nothing pauses — on
// a phone the race is never behind anything.

// The paint shop opens from here as well as from the circuit. A driver
// clicked on the board is the same gesture as a car clicked on the track, so
// it opens the same window — held above the board's own layer rather than
// inside it, because that layer is zoomed and the shop carries its own zoom.

/** Height of the race band in the stacked layout. */
const RACE_BAND_HEIGHT = 'clamp(240px, 46vh, 520px)'
/** Above the windows and the corner bar, below the CRT glass at 100. */
const PAINT_SHOP_Z = 96

/** The tab that is showing when nothing has been asked for. */
const DEFAULT_NARROW_WINDOW: CabinetWindowId = 'board'

// Which game the screen is running — or the room the machine stands in,
// which is where every visit starts. The last game picked is remembered
// locally so the arcade's cursor lands on it; the library itself lives in
// games.ts.
const GAME_STORAGE_KEY = 'claude-counter:game'

interface WindowCopy {
  readonly title: string
  readonly subtitle: string
}

const WINDOW_COPY: Readonly<Record<CabinetWindowId, WindowCopy>> = {
  board: { title: 'Leaderboard', subtitle: 'Every driver, all time' },
  account: { title: 'Account', subtitle: 'Your car, your devices, your day' },
  menu: { title: 'Paused', subtitle: 'Broadcast held · reporting never stops' },
  setup: { title: 'Set up', subtitle: 'Install the reporter, sign in, get on the board' },
}

/** The menu's title in the stacked layout, where the race is not held. */
const NARROW_MENU_COPY: WindowCopy = { title: 'Menu', subtitle: 'Controls and how to get on the board' }

function WindowBody({
  id,
  onSelectDriver,
  screen,
  lastGame,
  onBackToRoom,
  audioOn,
  onToggleAudio,
}: {
  readonly id: CabinetWindowId
  readonly onSelectDriver: (driver: PaintShopDriver) => void
  readonly screen: CabinetScreen
  readonly lastGame: CabinetGame | null
  readonly onBackToRoom: () => void
  readonly audioOn: boolean
  readonly onToggleAudio: () => void
}): React.ReactElement {
  // The board over a game shows that game's rigs; over the room, the last
  // game's — the one the screen would return to.
  if (id === 'board') return <PodiumBoard onSelectDriver={onSelectDriver} game={screen === 'room' ? (lastGame ?? 'race') : screen} />
  if (id === 'account') return <AccountWindow onSelectDriver={onSelectDriver} />
  if (id === 'setup') return <SetupWindow />
  return <MenuWindow screen={screen} onBackToRoom={onBackToRoom} audioOn={audioOn} onToggleAudio={onToggleAudio} />
}

/** One key and what it does, in the prompt's own type. */
const KEY_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ['G', 'next game'],
  ['Esc', 'the room'],
  ['L', 'board'],
  ['T', 'take control'],
  ['1–9', 'ride along'],
]

function KeyPrompt(): React.ReactElement {
  return (
    <div
      className="cab-key-prompt"
      aria-hidden
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '22px',
        transform: 'translateX(-50%)',
        zIndex: 94,
        pointerEvents: 'none',
        display: 'flex',
        gap: '18px',
        padding: '8px 14px',
        background: 'rgba(4, 4, 8, 0.72)',
        boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`,
        ...SCALED_CHROME,
      }}
    >
      {KEY_PROMPTS.map(([key, label]) => (
        <span key={key} className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.caption}px`, color: ARCADE.grey, letterSpacing: '0.12em' }}>
          <span style={{ color: ARCADE.amber, marginRight: '6px' }}>{key}</span>
          {label.toUpperCase()}
        </span>
      ))}
    </div>
  )
}

/**
 * The picture itself: whichever cartridge is in the machine, or the room.
 *
 * A visited game is HIDDEN, never unmounted. Unmounting a channel tears its
 * WebGL context down (fiber's teardown force-loses it, on a 500ms delay) at
 * exactly the moment the next channel is creating its own — and that
 * create/destroy collision is capable of hanging the GPU channel so hard the
 * whole tab freezes mid-switch. Keeping the canvases alive removes the
 * teardown from the switch entirely, and makes flicking back to a game
 * instant. Scenes idle when `isLive` is false, so a hidden channel costs a
 * static frame, not a running simulation.
 */
function GameScreen({
  screen,
  lastGame,
  paused,
  audioOn,
  onPick,
  onSetup,
  inputEnabled,
}: {
  readonly screen: CabinetScreen
  /** The cartridge most recently in the machine — the arcade's cursor starts on it. */
  readonly lastGame: CabinetGame | null
  readonly paused: boolean
  readonly audioOn: boolean
  readonly onPick: (game: CabinetGame) => void
  readonly onSetup: () => void
  /** False while a window is open over the picture and the keys belong to it. */
  readonly inputEnabled: boolean
}): React.ReactElement {
  // Which surfaces have ever been asked for. Mount-on-first-visit keeps the
  // initial load to one channel; after that a surface never leaves the tree.
  const visited = useRef<Set<CabinetScreen>>(new Set())
  visited.current.add(screen)

  // visibility rather than display: a display:none canvas measures 0x0 and
  // fiber would resize it to nothing and back on every flick.
  const layer = (visible: boolean): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
  })

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {visited.current.has('race') && (
        <div style={layer(screen === 'race')}>
          <RaceChannel isLive={screen === 'race'} paused={paused} audioOn={audioOn && screen === 'race'} />
        </div>
      )}
      {visited.current.has('fight') && (
        <div style={layer(screen === 'fight')}>
          <FightChannel isLive={screen === 'fight'} paused={paused} />
        </div>
      )}
      {visited.current.has('dogfight') && (
        <div style={layer(screen === 'dogfight')}>
          <DogfightChannel isLive={screen === 'dogfight'} paused={paused} />
        </div>
      )}
      {visited.current.has('room') && (
        <div style={layer(screen === 'room')}>
          <Bedroom
            lastGame={lastGame}
            onPick={onPick}
            onSetup={onSetup}
            isLive={screen === 'room'}
            inputEnabled={inputEnabled}
          />
        </div>
      )}
    </div>
  )
}

export function Cabinet(): React.ReactElement {
  const [open, setOpen] = useState<CabinetWindowId | null>(null)
  const [setupDriver, setSetupDriver] = useState<PaintShopDriver | null>(null)
  const [screen, setScreen] = useState<CabinetScreen>('room')
  // Sound is opt-in and session-only: it has to start from a click, and a
  // remembered "on" would try to play before anyone had clicked anything.
  const [audioOn, setAudioOn] = useState(false)
  const toggleAudio = useCallback((): void => setAudioOn((current) => !current), [])
  const isNarrow = useNarrowViewport()

  const close = useCallback((): void => setOpen(null), [])
  const closeSetup = useCallback((): void => setSetupDriver(null), [])

  // The last game picked, so the arcade's cursor starts on it. Read after
  // mount rather than during render, so the server and the first client
  // frame agree; the room is drawn either way, so nothing visibly swaps.
  const [lastGame, setLastGame] = useState<CabinetGame | null>(null)
  useEffect(() => {
    const stored = window.localStorage.getItem(GAME_STORAGE_KEY)
    if (isCabinetGame(stored)) setLastGame(stored)
  }, [])

  const selectScreen = useCallback((next: CabinetScreen): void => {
    setScreen(next)
    if (!isCabinetGame(next)) return
    setLastGame(next)
    try {
      window.localStorage.setItem(GAME_STORAGE_KEY, next)
    } catch (error) {
      // Private mode refuses storage; the choice still holds for the session.
      console.error('Could not remember game selection', error)
    }
  }, [])

  // Picking a game is the same move whether it comes from the arcade's
  // screen or the menu's button — but the menu should also close behind it,
  // so the screen it just changed is actually visible.
  const pickGame = useCallback(
    (game: CabinetGame): void => {
      selectScreen(game)
      setOpen(null)
    },
    [selectScreen],
  )
  const backToRoom = useCallback((): void => {
    selectScreen('room')
    setOpen(null)
  }, [selectScreen])
  const openSetup = useCallback((): void => setOpen('setup'), [])

  // A held G must not machine-gun the cabinet through its library. Keyboards
  // auto-repeat at ~30Hz and each flick mounts a WebGL scene, so an unguarded
  // repeat is dozens of scene mounts a second — enough to take the whole tab
  // down. `event.repeat` catches a real held key; the wall-clock cooldown
  // catches synthetic input that does not set it.
  const lastFlickAt = useRef(0)
  const FLICK_COOLDOWN_MS = 350

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.repeat) return

      // Escape closes a window before anything else can claim it — while one
      // is open it is the way out, and the race's own Escape (release the
      // camera) would otherwise fire in the same keystroke.
      if (event.key === 'Escape') {
        // The paint shop is the topmost surface, and it closes itself. Letting
        // the cabinet act on the same keystroke would take the board out from
        // under it and leave the room looking at the race.
        if (setupDriver !== null) return
        if (open === null) return
        event.preventDefault()
        event.stopPropagation()
        setOpen(null)
        return
      }

      // Everything below this line acts on the cabinet underneath the paint
      // shop — swapping the cartridge or pulling a window out from under it —
      // and the shop only stops Escape from reaching us. While it is the
      // topmost surface, the cabinet takes no shortcuts at all.
      if (setupDriver !== null) return

      // Typing into a field somewhere should never flick the cabinet.
      const target = event.target
      if (target instanceof HTMLElement && target.isContentEditable) return

      const key = event.key.toLowerCase()
      if (key === 'l') setOpen((current) => (current === 'board' ? null : 'board'))
      else if (key === 'u') setOpen((current) => (current === 'account' ? null : 'account'))
      else if (key === 'm') setOpen((current) => (current === 'menu' ? null : 'menu'))
      else if (key === 'g') {
        const now = Date.now()
        if (now - lastFlickAt.current < FLICK_COOLDOWN_MS) return
        lastFlickAt.current = now
        selectScreen(nextGame(screen))
      }
    }

    // Escape with nothing open steps back from the game to the room. Bubble
    // phase, deliberately: taking the wheel claims Escape in capture and
    // stops it there, so a driver handing back never leaves the game.
    const onBackKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (open !== null || setupDriver !== null || screen === 'room') return
      event.preventDefault()
      selectScreen('room')
    }

    // Capture phase, so the shortcut is decided here before the race channel's
    // own window listeners see the same key.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onBackKey)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onBackKey)
    }
  }, [open, setupDriver, screen, selectScreen])

  if (isNarrow) {
    const active = open ?? DEFAULT_NARROW_WINDOW
    const copy = active === 'menu' ? NARROW_MENU_COPY : WINDOW_COPY[active]
    return (
      <NavigationProvider resetKey="cabinet">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
          <div style={{ position: 'relative', flex: '0 0 auto', height: RACE_BAND_HEIGHT, overflow: 'hidden' }}>
            <GameScreen
              screen={screen}
              lastGame={lastGame}
              paused={false}
              audioOn={audioOn}
              onPick={pickGame}
              onSetup={openSetup}
              inputEnabled={setupDriver === null}
            />
          </div>

          <div
            style={{
              position: 'relative',
              flex: 1,
              minHeight: 0,
              background: ARCADE.ground,
              borderTop: `2px solid ${ARCADE.rule}`,
            }}
          >
            <div style={{ ...SCALED_PANEL, display: 'flex', flexDirection: 'column' }}>
              <TopBar layout="tabs" open={active} onOpen={(next) => setOpen(next ?? active)} />
              <Window key={active} inline title={copy.title} subtitle={copy.subtitle} onClose={close}>
                <WindowBody id={active} onSelectDriver={setSetupDriver} screen={screen} lastGame={lastGame} onBackToRoom={backToRoom} audioOn={audioOn} onToggleAudio={toggleAudio} />
              </Window>
            </div>
          </div>

          <div style={{ position: 'relative', zIndex: PAINT_SHOP_Z }}>
            <PaintShopLayer driver={setupDriver} onClose={closeSetup} />
          </div>
        </div>
      </NavigationProvider>
    )
  }

  return (
    <NavigationProvider resetKey="cabinet">
      <div style={{ position: 'relative', height: '100%', width: '100%', overflow: 'hidden' }}>
        <GameScreen
          screen={screen}
          lastGame={lastGame}
          paused={open !== null}
          audioOn={audioOn}
          onPick={pickGame}
          onSetup={openSetup}
          inputEnabled={open === null && setupDriver === null}
        />

        {/* The keys, said once on the way into a game. The corner bar names
            the windows; this names what the corner bar cannot — the flick,
            the way back, and taking the wheel. It fades by itself. */}
        {screen !== 'room' && open === null && <KeyPrompt key={screen} />}

        {/* The corner bar belongs to a running game. In the room the machine's
            own screen is the chrome, and the keys still open the windows. */}
        {screen !== 'room' && (
          <div
            style={{
              position: 'absolute',
              top: '14px',
              right: '18px',
              zIndex: 95,
              pointerEvents: 'none',
              ...SCALED_CHROME,
            }}
          >
            <TopBar layout="corner" open={open} onOpen={setOpen} />
          </div>
        )}

        {/* The windows sit in their own zoomed layer, the same one the HUD
            uses, so a menu reads at the same size as the instruments beside
            it. Pointer events are off while nothing is open so the race
            underneath still takes the click. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 90,
            pointerEvents: open === null ? 'none' : 'auto',
            ...SCALED_SURFACE,
          }}
        >
          {open !== null && (
            <Window
              key={open}
              title={WINDOW_COPY[open].title}
              subtitle={WINDOW_COPY[open].subtitle}
              onClose={close}
            >
              <WindowBody id={open} onSelectDriver={setSetupDriver} screen={screen} lastGame={lastGame} onBackToRoom={backToRoom} audioOn={audioOn} onToggleAudio={toggleAudio} />
            </Window>
          )}
        </div>

        <div style={{ position: 'relative', zIndex: PAINT_SHOP_Z }}>
          <PaintShopLayer driver={setupDriver} onClose={closeSetup} />
        </div>
      </div>
    </NavigationProvider>
  )
}

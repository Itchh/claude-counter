'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { RaceChannel } from '../channels/race/RaceChannel'
import { FightChannel } from '../channels/fight/FightChannel'
import { PaintShopLayer, type PaintShopDriver } from '../channels/race/PaintShop'
import { NavigationProvider } from '../ps1/navigation'
import { SCALED_CHROME, SCALED_PANEL, SCALED_SURFACE } from '../ps1/hudScale'
import { useNarrowViewport } from '../ps1/useNarrowViewport'
import { ARCADE } from '../ps1/theme'
import { TopBar, type CabinetWindowId } from './TopBar'
import { Window } from './Window'
import { PodiumBoard } from './PodiumBoard'
import { MenuWindow } from './MenuWindow'
import { Shelf } from './Shelf'
import { DogfightChannel } from '../channels/dogfight/DogfightChannel'
import { isCabinetScreen, nextGame, type CabinetGame, type CabinetScreen } from './games'

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

// Which game the screen is running — or the shelf they all live on. Picked
// by taking a cartridge off the shelf, remembered locally; the library
// itself lives in games.ts.
const GAME_STORAGE_KEY = 'claude-counter:game'

interface WindowCopy {
  readonly title: string
  readonly subtitle: string
}

const WINDOW_COPY: Readonly<Record<CabinetWindowId, WindowCopy>> = {
  board: { title: 'Leaderboard', subtitle: 'Every driver, all time' },
  menu: { title: 'Paused', subtitle: 'Broadcast held · reporting never stops' },
}

/** The menu's title in the stacked layout, where the race is not held. */
const NARROW_MENU_COPY: WindowCopy = { title: 'Menu', subtitle: 'Controls and how to get on the board' }

function WindowBody({
  id,
  onSelectDriver,
  screen,
  onBackToShelf,
  audioOn,
  onToggleAudio,
}: {
  readonly id: CabinetWindowId
  readonly onSelectDriver: (driver: PaintShopDriver) => void
  readonly screen: CabinetScreen
  readonly onBackToShelf: () => void
  readonly audioOn: boolean
  readonly onToggleAudio: () => void
}): React.ReactElement {
  return id === 'board' ? (
    <PodiumBoard onSelectDriver={onSelectDriver} />
  ) : (
    <MenuWindow screen={screen} onBackToShelf={onBackToShelf} audioOn={audioOn} onToggleAudio={onToggleAudio} />
  )
}

/**
 * The picture itself: whichever cartridge is in the machine, or the shelf.
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
}: {
  readonly screen: CabinetScreen
  /** The cartridge most recently in the machine — the shelf lights its lamp. */
  readonly lastGame: CabinetGame | null
  readonly paused: boolean
  readonly audioOn: boolean
  readonly onPick: (game: CabinetGame) => void
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
      {visited.current.has('shelf') && (
        <div style={layer(screen === 'shelf')}>
          <Shelf currentGame={lastGame} onPick={onPick} isLive={screen === 'shelf'} />
        </div>
      )}
    </div>
  )
}

export function Cabinet(): React.ReactElement {
  const [open, setOpen] = useState<CabinetWindowId | null>(null)
  const [setupDriver, setSetupDriver] = useState<PaintShopDriver | null>(null)
  const [screen, setScreen] = useState<CabinetScreen>('race')
  // Sound is opt-in and session-only: it has to start from a click, and a
  // remembered "on" would try to play before anyone had clicked anything.
  const [audioOn, setAudioOn] = useState(false)
  const toggleAudio = useCallback((): void => setAudioOn((current) => !current), [])
  const isNarrow = useNarrowViewport()

  const close = useCallback((): void => setOpen(null), [])
  const closeSetup = useCallback((): void => setSetupDriver(null), [])

  // Restored after mount rather than read during render, so the server and
  // the first client frame agree; the swap is behind the boot screen anyway.
  useEffect(() => {
    const stored = window.localStorage.getItem(GAME_STORAGE_KEY)
    if (isCabinetScreen(stored)) setScreen(stored)
  }, [])

  const selectScreen = useCallback((next: CabinetScreen): void => {
    setScreen(next)
    try {
      window.localStorage.setItem(GAME_STORAGE_KEY, next)
    } catch (error) {
      // Private mode refuses storage; the choice still holds for the session.
      console.error('Could not remember game selection', error)
    }
  }, [])

  // Picking a cartridge is the same move whether it comes from the shelf's
  // click or the menu's button — but the menu should also close behind it,
  // so the screen it just changed is actually visible.
  const pickGame = useCallback(
    (game: CabinetGame): void => {
      selectScreen(game)
      setOpen(null)
    },
    [selectScreen],
  )
  const backToShelf = useCallback((): void => {
    selectScreen('shelf')
    setOpen(null)
  }, [selectScreen])

  // The shelf lights a lamp on whichever cartridge was last in the machine.
  const lastGameRef = useRef<CabinetGame | null>(null)
  if (screen !== 'shelf') lastGameRef.current = screen

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
      else if (key === 'm') setOpen((current) => (current === 'menu' ? null : 'menu'))
      else if (key === 'g') {
        const now = Date.now()
        if (now - lastFlickAt.current < FLICK_COOLDOWN_MS) return
        lastFlickAt.current = now
        selectScreen(nextGame(screen))
      }
    }

    // Capture phase, so the shortcut is decided here before the race channel's
    // own window listeners see the same key.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setupDriver, screen, selectScreen])

  if (isNarrow) {
    const active = open ?? DEFAULT_NARROW_WINDOW
    const copy = active === 'menu' ? NARROW_MENU_COPY : WINDOW_COPY.board
    return (
      <NavigationProvider resetKey="cabinet">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
          <div style={{ position: 'relative', flex: '0 0 auto', height: RACE_BAND_HEIGHT, overflow: 'hidden' }}>
            <GameScreen
              screen={screen}
              lastGame={lastGameRef.current}
              paused={false}
              audioOn={audioOn}
              onPick={pickGame}
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
                <WindowBody id={active} onSelectDriver={setSetupDriver} screen={screen} onBackToShelf={backToShelf} audioOn={audioOn} onToggleAudio={toggleAudio} />
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
          lastGame={lastGameRef.current}
          paused={open !== null}
          audioOn={audioOn}
          onPick={pickGame}
        />

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
          <AnimatePresence>
            {open !== null && (
              <Window
                key={open}
                title={WINDOW_COPY[open].title}
                subtitle={WINDOW_COPY[open].subtitle}
                onClose={close}
              >
                <WindowBody id={open} onSelectDriver={setSetupDriver} screen={screen} onBackToShelf={backToShelf} audioOn={audioOn} onToggleAudio={toggleAudio} />
              </Window>
            )}
          </AnimatePresence>
        </div>

        <div style={{ position: 'relative', zIndex: PAINT_SHOP_Z }}>
          <PaintShopLayer driver={setupDriver} onClose={closeSetup} />
        </div>
      </div>
    </NavigationProvider>
  )
}

'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

// Keyboard navigation for a screen that was never meant to be clicked.
//
// The split of keys is the whole design, and it is the console's own:
//
//   ◄ ►   change channel      — owned by the deck, not by this file
//   ▲ ▼   move the cursor     — within the live channel
//   ENTER open / close        — the focused item expands in place
//   ESC   back out            — collapse, then drop the cursor entirely
//
// Left/right never moves the cursor and up/down never changes channel. A key
// that means two things depending on where you are is how you lose people.
//
// Order is not declared anywhere. It is read from the DOM at the moment a key
// is pressed, via compareDocumentPosition, so a channel that reorders its rows
// (and this one reorders constantly — it is a leaderboard) never has to tell
// the navigator anything. There is no registration order to keep in sync,
// because there is no registration order.

interface NavigationValue {
  readonly focusId: string | null
  readonly expandedId: string | null
  readonly register: (id: string, element: HTMLElement | null) => void
  readonly focus: (id: string) => void
}

const NavigationContext = createContext<NavigationValue | null>(null)

export function NavigationProvider({
  children,
  resetKey,
  onInteract,
}: {
  readonly children: React.ReactNode
  /** Changing this drops the cursor — used to clear focus on a channel flick. */
  readonly resetKey: string
  /** Fired on any navigation keypress, so the deck can defer auto-rotation. */
  readonly onInteract?: () => void
}): React.ReactElement {
  const [focusId, setFocusId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const elements = useRef<Map<string, HTMLElement>>(new Map())

  const register = useCallback((id: string, element: HTMLElement | null): void => {
    if (element) elements.current.set(id, element)
    else elements.current.delete(id)
  }, [])

  const focus = useCallback((id: string): void => setFocusId(id), [])

  useEffect(() => {
    setFocusId(null)
    setExpandedId(null)
  }, [resetKey])

  // Latest focus/expansion without making them dependencies of the listener:
  // rebinding a window listener on every cursor move is needless churn, and
  // worse, it is a class of bug where a stale handler survives a render.
  const state = useRef({ focusId, expandedId })
  state.current = { focusId, expandedId }

  useEffect(() => {
    const ordered = (): ReadonlyArray<string> =>
      [...elements.current.entries()]
        .filter(([, element]) => element.isConnected)
        .sort(([, a], [, b]) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map(([id]) => id)

    const step = (delta: number): void => {
      const ids = ordered()
      if (ids.length === 0) return
      const current = state.current.focusId
      const index = current ? ids.indexOf(current) : -1
      // No cursor yet: ▼ takes the top, ▲ takes the bottom. Entering a list
      // from the direction you pressed is what every console menu did.
      const next =
        index === -1
          ? delta > 0
            ? 0
            : ids.length - 1
          : (index + delta + ids.length) % ids.length
      setFocusId(ids[next])
      elements.current.get(ids[next])?.scrollIntoView({ block: 'nearest' })
    }

    const onKey = (event: KeyboardEvent): void => {
      const { focusId: currentFocus, expandedId: currentExpanded } = state.current

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        onInteract?.()
        step(event.key === 'ArrowDown' ? 1 : -1)
        return
      }

      if (event.key === 'Enter') {
        if (!currentFocus) return
        event.preventDefault()
        onInteract?.()
        setExpandedId(currentExpanded === currentFocus ? null : currentFocus)
        return
      }

      if (event.key === 'Escape') {
        if (!currentFocus && !currentExpanded) return
        event.preventDefault()
        onInteract?.()
        // One step back per press: close the panel first, drop the cursor
        // second. Escape that does both at once loses you your place.
        if (currentExpanded) setExpandedId(null)
        else setFocusId(null)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onInteract])

  const value = useMemo(
    () => ({ focusId, expandedId, register, focus }),
    [focusId, expandedId, register, focus],
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export interface NavItem {
  /** Attach to the element that should be treated as one cursor stop. */
  readonly ref: (element: HTMLElement | null) => void
  readonly isFocused: boolean
  readonly isExpanded: boolean
  /** For pointer users: clicking a row should move the cursor to it. */
  readonly focus: () => void
}

/** Makes the calling component one stop on the cursor's path. */
export function useNavItem(id: string): NavItem {
  const context = useContext(NavigationContext)
  const register = context?.register

  const ref = useCallback(
    (element: HTMLElement | null): void => {
      register?.(id, element)
    },
    [register, id],
  )

  const focus = useCallback((): void => context?.focus(id), [context, id])

  return {
    ref,
    isFocused: context?.focusId === id,
    isExpanded: context?.expandedId === id,
    focus,
  }
}

/** True when the cursor is somewhere — the cabinet uses it to offer BACK. */
export function useNavigationState(): { readonly hasFocus: boolean; readonly hasExpanded: boolean } {
  const context = useContext(NavigationContext)
  return {
    hasFocus: context?.focusId != null,
    hasExpanded: context?.expandedId != null,
  }
}

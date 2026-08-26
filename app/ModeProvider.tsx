'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'claude-counter:leon-mode'

export type AppMode = 'standard' | 'leon'

interface ModeContextValue {
  readonly mode: AppMode
  readonly setMode: (mode: AppMode) => void
  readonly toggleMode: () => void
}

const ModeContext = createContext<ModeContextValue | null>(null)

export function ModeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [mode, setModeState] = useState<AppMode>('standard')

  // Read the persisted choice after mount so server and client markup match.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'leon' || stored === 'standard') setModeState(stored)
  }, [])

  const setMode = useCallback((next: AppMode): void => {
    setModeState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }, [])

  const toggleMode = useCallback((): void => {
    setModeState((current) => {
      const next: AppMode = current === 'leon' ? 'standard' : 'leon'
      window.localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  return (
    <ModeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ModeContext.Provider>
  )
}

export function useMode(): ModeContextValue {
  const value = useContext(ModeContext)
  if (value === null) throw new Error('useMode must be used inside a ModeProvider')
  return value
}

import { useEffect, useState } from 'react'
import type { DesktopUpdateState } from '../../../shared/desktopUpdates'

export function useDesktopUpdates(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  useEffect(() => {
    let alive = true
    let eventReceived = false
    const off = window.ds.onUpdatesState((next: DesktopUpdateState) => { eventReceived = true; if (alive) setState(next) })
    void window.ds.updatesGet().then((next: DesktopUpdateState | null) => { if (alive && !eventReceived) setState(next) }).catch(() => {})
    return () => { alive = false; off() }
  }, [])
  return state
}

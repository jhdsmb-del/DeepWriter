import { useEffect, useState } from 'react'

/** Keep a closing surface mounted briefly so its exit animation can finish. */
export function usePresence(open: boolean, duration = 160): boolean {
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) { setPresent(true); return }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setPresent(false); return }
    const timer = window.setTimeout(() => setPresent(false), duration)
    return () => window.clearTimeout(timer)
  }, [open, duration])
  // Opening is part of the click commit, not a second effect-driven render.
  return open || present
}

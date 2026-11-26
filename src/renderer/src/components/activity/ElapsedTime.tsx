import { useEffect, useState } from 'react'

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export default function ElapsedTime({ startedAt, running }: { startedAt: number; running: boolean }): React.ReactNode {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const tick = (): void => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1)
    }
    const iv = window.setInterval(tick, 100)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(iv)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [running])
  return <span className="elapsed-time">{format(Date.now() - startedAt)}</span>
}

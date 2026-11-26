import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { registerChildProcess } from './childRegistry'
import type { CommandResult } from '../shared/types'

const MAX_OUTPUT = 200_000

export function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now()
  if (signal?.aborted) {
    return Promise.resolve({ exitCode: null, stdout: '', stderr: '已取消', timedOut: false, cancelled: true, durationMs: 0 })
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    const outputDecoder = new StringDecoder('utf8')
    const errorDecoder = new StringDecoder('utf8')
    const child = spawn(command, args, {
      shell: false,
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    registerChildProcess(child)
    const killTree = (): void => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => { child.kill('SIGKILL') })
        killer.once('exit', (code) => { if (code !== 0) child.kill('SIGKILL') })
        return
      }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const onAbort = (): void => {
      if (settled || timedOut || cancelled) return
      cancelled = true
      clearTimeout(timer)
      killTree()
    }
    const timer = setTimeout(() => {
      if (settled || cancelled) return
      timedOut = true
      killTree()
    }, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 90_000))
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.stdout.on('data', (data: Buffer) => { stdout = (stdout + outputDecoder.write(data)).slice(-MAX_OUTPUT) })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + errorDecoder.write(data)).slice(-MAX_OUTPUT) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        exitCode: code,
        stdout: (stdout + outputDecoder.end()).slice(-MAX_OUTPUT),
        stderr: (stderr + errorDecoder.end()).slice(-MAX_OUTPUT),
        timedOut,
        cancelled,
        durationMs: Date.now() - started
      })
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

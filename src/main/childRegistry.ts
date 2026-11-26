// ==================== R4.6 Gate 5：子进程树注册与终止（G5-R02/R06） ====================
// 复审退回：child_process_tree_terminated 必须绑定真实跟踪/终止/等待/结果，不能无条件字符串。
// 本模块：spawn 的子进程（Ren'Py SDK lint、run_command 工具等）注册后由 shutdown coordinator
// 统一终止（taskkill /T 树级，Windows）；trace 记录实际终止数；无子进程时记录 none。
// 纯 Node（无 electron）——galgame.ts / tools.ts 均可安全注册。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'

const children = new Set<ChildProcess>()

export function registerChildProcess(cp: ChildProcess): void {
  children.add(cp)
  cp.once('exit', () => children.delete(cp))
  cp.once('error', () => children.delete(cp))
}

export function activeChildProcesses(): ChildProcess[] {
  return [...children]
}

/** R11（R10-R02）：逐 PID 真实退出结果——killed 只计"初始存活且截止前确认退出"的 PID；
 *  alreadyExited 计终止前已退出的；remaining 计截止仍存活的。 */
export interface TerminationResult {
  attempted: number
  killed: number
  alreadyExited: number
  remaining: number
  pids: number[]
  remainingPids: number[]
}

/** PID 存活检查（Windows tasklist；POSIX kill -0） */
function pidAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      return execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' }).includes(String(pid))
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等待指定 PID 退出（轮询 pidAlive；超时返回 false） */
async function waitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(pid)
}

/** 终止全部子进程树（Windows taskkill /T 树级；POSIX 进程组）。
 *  R11（R10-R02）：killed 按真实退出确认（taskkill 成功且随后 pidAlive=false）；
 *  终止前已退出的计 alreadyExited；截止仍存活的计 remaining——禁止仅凭命令退出码判 killed。 */
export async function terminateChildProcesses(timeoutMs = 2000): Promise<TerminationResult> {
  // 初始快照（registry 的 exit/error listener 会删除条目——局部快照避免丢失初始 PID 与结论）
  const initial = activeChildProcesses()
    .map((cp) => cp.pid)
    .filter((pid): pid is number => pid !== undefined)
  const attempted = initial.length
  if (attempted === 0) return { attempted: 0, killed: 0, alreadyExited: 0, remaining: 0, pids: [], remainingPids: [] }

  // 1) 分 PID 发出终止请求
  const issued: number[] = []
  for (const pid of initial) {
    if (!pidAlive(pid)) continue // 已退出：alreadyExited
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' })
      } else {
        try {
          process.kill(-pid as number, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
      }
      issued.push(pid)
    } catch {
      /* 终止请求失败：计入 remaining（见下） */
    }
  }
  // 2) 等待每个初始存活 PID 的真实退出
  const killed: number[] = []
  const remainingPids: number[] = []
  const alreadyExited: number[] = []
  for (const pid of initial) {
    if (!pidAlive(pid) && !issued.includes(pid)) {
      alreadyExited.push(pid) // 终止前已退出
      continue
    }
    if (issued.includes(pid)) {
      const exited = await waitPidExit(pid, timeoutMs)
      if (exited) killed.push(pid)
      else remainingPids.push(pid)
    } else {
      remainingPids.push(pid) // 终止请求失败或未发出
    }
  }
  return {
    attempted,
    killed: killed.length,
    alreadyExited: alreadyExited.length,
    remaining: remainingPids.length,
    pids: killed,
    remainingPids
  }
}

/** 包装 spawn：注册进 registry（生产路径统一入口） */
export function spawnTracked(command: string, args: string[], opts: Parameters<typeof spawn>[2] = {}): ChildProcess {
  const cp = spawn(command, args, opts)
  registerChildProcess(cp)
  return cp
}

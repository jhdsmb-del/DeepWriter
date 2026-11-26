// ==================== R4.5 Gate 5：不可变 credential slot/version registry ====================
// 复审 S-03：API Key 从 currentSettings 实时取——运行中切换同 origin 账号/密钥会让旧 run 换身份；
// 密钥删除后旧 run 无显式失败路径。本模块：
// - 每个 (origin, model) 一个稳定 slot；key 每次变化 version+1（不可变历史）；
// - execution snapshot 只存 CredentialRef（slotId/version/origin/model/issuedAt），不存明文 key；
// - 每轮用 ref 解析同一 version 的 key；version 缺失/删除 → fail-closed（missing），
//   绝不退回"当前任意 key"；
// - 活动 run 持有 lease；terminal 时 release。
// 纯 Node 模块（内存 registry；不落盘明文——settings 的加密持久化由主进程 settings.json 承担）。

export interface CredentialRef {
  slotId: string
  version: number
  origin: string
  model: string
  issuedAt: number
}

interface CredentialSlot {
  slotId: string
  version: number
  origin: string
  model: string
  apiKey: string
  issuedAt: number
}

/** fail-closed 错误：ref 缺失/版本不匹配（engine 检测 code 转 waiting_user/auth_required） */
export class CredentialMissingError extends Error {
  readonly code = 'credential_missing'
  readonly ref: CredentialRef | null
  constructor(ref: CredentialRef | null, message = '凭据缺失或版本不匹配：运行使用的 key 已删除或更换，请重新授权') {
    super(message)
    this.name = 'CredentialMissingError'
    this.ref = ref
  }
}

export interface CredentialRegistry {
  /** 注册/更新 (origin, model) 的 key：key 变化 → version+1（同 key 幂等）；apiKey 为空 = 删除 slot */
  register(origin: string, model: string, apiKey: string): { slotId: string; version: number; issuedAt: number }
  /** 按 ref 解析同一 version 的 key；缺失/版本不匹配 → fail-closed 抛 CredentialMissingError */
  resolve(ref: CredentialRef): { apiKey: string; origin: string; model: string }
  /** 记录 run 持有该 ref 的 lease（resolve 时自动记录；terminal 时释放） */
  acquire(runId: string, ref: CredentialRef): void
  release(runId: string): void
  /** 供测试/诊断：当前 slot 快照（不含 key 明文） */
  refs(): Array<Omit<CredentialSlot, 'apiKey'>>
}

export function createCredentialRegistry(): CredentialRegistry {
  const slots = new Map<string, CredentialSlot>()
  const leases = new Map<string, CredentialRef>() // runId → ref

  const slotKey = (origin: string, model: string): string => `${origin}\u0000${model}`

  return {
    register(origin, model, apiKey) {
      const key = slotKey(origin, model)
      const existing = slots.get(key)
      const now = Date.now()
      if (apiKey.trim() === '') {
        // 删除：slot 移除；持有旧 version 的 run 后续 resolve 必然 missing（fail-closed）
        slots.delete(key)
        return { slotId: key, version: existing ? existing.version + 1 : 1, issuedAt: now }
      }
      if (existing && existing.apiKey === apiKey) {
        return { slotId: existing.slotId, version: existing.version, issuedAt: existing.issuedAt }
      }
      const next: CredentialSlot = {
        slotId: key,
        version: existing ? existing.version + 1 : 1,
        origin,
        model,
        apiKey,
        issuedAt: now
      }
      slots.set(key, next)
      return { slotId: next.slotId, version: next.version, issuedAt: next.issuedAt }
    },

    resolve(ref) {
      const slot = slots.get(ref.slotId)
      // fail-closed：slot 不存在（key 已删除）或 version 不匹配（key 已更换）→ 拒绝，
      // 绝不退回当前任意 key
      if (!slot || slot.version !== ref.version) {
        throw new CredentialMissingError(ref)
      }
      return { apiKey: slot.apiKey, origin: slot.origin, model: slot.model }
    },

    acquire(runId, ref) {
      leases.set(runId, ref)
    },

    release(runId) {
      leases.delete(runId)
    },

    refs() {
      return [...slots.values()].map(({ apiKey: _apiKey, ...rest }) => rest)
    }
  }
}

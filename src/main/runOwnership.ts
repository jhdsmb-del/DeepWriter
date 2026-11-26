// ==================== R4.2 A4 补充：recoverDecide 窗口 owner 校验 ====================
// S-03 补全：恢复决策必须由领养该 run 的窗口发起（runs:resume 由 event.sender 领养；
// 未领养/其他窗口不得对 recovery_required 做出继续/放弃决策）。

/** kernelWins 的最小视图（宽类型便于纯 Node 测试） */
export type RunOwnerMap = ReadonlyMap<string, { webContents: { id: number } }>

export function runOwnedByWindow(kernelWins: RunOwnerMap, runId: string, webContentsId: number): boolean {
  const win = kernelWins.get(runId)
  if (!win || !win.webContents) return false
  return win.webContents.id === webContentsId
}

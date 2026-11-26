import { useRef, useState } from 'react'
import { useStore } from '../store'
import Icon from './Icon'

export default function WorkingDirectoryControl(): React.ReactNode {
  const directory = useStore((state) => state.settings?.workDir)
  const busy = useStore((state) => state.running || state.submitting)
  const updateSettings = useStore((state) => state.updateSettings)
  const showToast = useStore((state) => state.showToast)
  const [choosing, setChoosing] = useState(false)
  const choosingRef = useRef(false)
  const path = typeof directory === 'string' ? directory : ''
  const name = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path || '选择工作目录'

  const choose = async (): Promise<void> => {
    if (choosingRef.current || busy) return
    choosingRef.current = true
    setChoosing(true)
    try {
      const selected = await (window as any).ds?.chooseDir?.('settings')
      if (!selected) return
      if (!selected.view?.fileRefId) throw new Error('目录选择未返回授权')
      // Another window may have started a task while the native dialog was open.
      if (useStore.getState().running || useStore.getState().submitting) {
        showToast('任务正在运行，请结束后再切换目录', 'info')
        return
      }
      const saved = await updateSettings({ workDir: { value: selected.path, dirRefId: selected.view.fileRefId } })
      if (saved) showToast('工作目录已更新，新任务将使用此目录', 'success')
    } catch {
      showToast('工作目录选择失败，请重试', 'error')
    } finally {
      choosingRef.current = false
      setChoosing(false)
    }
  }

  return (
      <button className="modebar-btn working-directory-btn" aria-label={`工作目录：${path || '未选择'}`} title={busy ? `当前工作目录：${path}\n任务结束后可切换` : `当前工作目录：${path}\n点击选择目录`} disabled={busy || choosing || !directory} onClick={() => void choose()}>
        <Icon name="folder" size={14} /><span>{choosing ? '正在选择…' : name}</span>
      </button>
  )
}

import { memo } from 'react'
import type { ArtifactActivity } from '../../../../shared/activity'

interface ArtifactProgressProps {
  artifactsById: Record<string, ArtifactActivity>
}

function ArtifactProgressInner({ artifactsById }: ArtifactProgressProps): React.ReactNode {
  const list = Object.values(artifactsById)
  if (list.length === 0) return null
  return (
    <div className="artifact-list">
      {list.map((a) => {
        const done = a.completedChars ?? 0
        const hasTarget = a.targetChars != null && a.targetChars > 0
        const pct = hasTarget ? Math.min(100, Math.round((done / (a.targetChars ?? 1)) * 100)) : null
        const items = a.completedItems != null && a.totalItems != null ? ` · ${a.completedItems}/${a.totalItems} 项` : ''
        return (
          <div className="artifact-item" key={a.artifactId}>
            <div className="artifact-head">
              <span className="artifact-name">{a.displayName}</span>
              <span className="artifact-chars">
                {hasTarget
                  ? `${done.toLocaleString()} / ${(a.targetChars ?? 0).toLocaleString()} 字（${pct}%）${items}`
                  : `已生成 ${done.toLocaleString()} 字${items}`}
              </span>
            </div>
            {hasTarget && (
              <div className="cache-bar">
                <div className="cache-hit" style={{ width: `${pct}%` }} />
              </div>
            )}
            {a.relativePath && <div className="artifact-path">{a.relativePath}</div>}
          </div>
        )
      })}
    </div>
  )
}

export default memo(ArtifactProgressInner)

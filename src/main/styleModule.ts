import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { analyzeText, buildProfile, buildStylePrompt, checkOverlap, extractForbiddenPhrases } from '../shared/style'
import { importFile } from './fileImport'
import type { StyleProfile, StyleSourceMeta, StyleStatsRaw, StyleOverlapReport } from '../shared/style'

export interface StyleModule {
  listState(): Promise<{ profiles: StyleProfile[]; sources: StyleSourceMeta[]; activeProfileId: string }>
  addSources(filePaths: string[]): Promise<StyleSourceMeta[]>
  buildProfile(input: { name: string; sourceIds: string[] }): Promise<StyleProfile>
  updateProfile(id: string, patch: { name?: string; dimensions?: StyleProfile['dimensions'] }): Promise<StyleProfile>
  deleteProfile(id: string): Promise<void>
  checkOverlap(profileId: string, text: string): Promise<StyleOverlapReport>
  setActive(profileId: string | null): Promise<void>
  getActiveProfile(): Promise<StyleProfile | null>
}

interface SourceEntry extends StyleSourceMeta {
  stats: StyleStatsRaw
}

export function createStyleModule(baseDir: string): StyleModule {
  const sourcesFile = path.join(baseDir, 'styles', 'sources.json')
  const profilesFile = path.join(baseDir, 'styles', 'profiles.json')
  const activeFile = path.join(baseDir, 'styles', 'active.json')
  const sourcesDir = path.join(baseDir, 'styles', 'sources')

  async function readSources(): Promise<SourceEntry[]> {
    try {
      return JSON.parse(await fs.readFile(sourcesFile, 'utf-8'))
    } catch {
      return []
    }
  }
  async function writeSources(s: SourceEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(sourcesFile), { recursive: true })
    const tmp = sourcesFile + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf-8')
    await fs.rename(tmp, sourcesFile)
  }
  async function readProfiles(): Promise<StyleProfile[]> {
    try {
      return JSON.parse(await fs.readFile(profilesFile, 'utf-8'))
    } catch {
      return []
    }
  }
  async function writeProfiles(p: StyleProfile[]): Promise<void> {
    await fs.mkdir(path.dirname(profilesFile), { recursive: true })
    const tmp = profilesFile + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(p, null, 2), 'utf-8')
    await fs.rename(tmp, profilesFile)
  }
  async function readActive(): Promise<string> {
    try {
      return JSON.parse(await fs.readFile(activeFile, 'utf-8')).profileId ?? ''
    } catch {
      return ''
    }
  }
  async function writeActive(profileId: string): Promise<void> {
    await fs.mkdir(path.dirname(activeFile), { recursive: true })
    await fs.writeFile(activeFile, JSON.stringify({ profileId }), 'utf-8')
  }

  return {
    async listState() {
      const [profiles, sources, activeProfileId] = await Promise.all([readProfiles(), readSources(), readActive()])
      return { profiles, sources: sources.map(({ stats: _stats, ...meta }) => meta), activeProfileId }
    },

    async addSources(filePaths) {
      const existing = await readSources()
      const existingHashes = new Set(existing.map((s) => s.sha256))
      const added: SourceEntry[] = []
      await fs.mkdir(sourcesDir, { recursive: true })
      for (const p of filePaths) {
        const res = await importFile(p, 500000)
        if (!res.ok) continue
        const { info } = res
        if (info.source === 'image' || info.source === 'unknown') continue
        const sha = createHash('sha256').update(info.text).digest('hex')
        if (existingHashes.has(sha)) continue
        const id = `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        const stats = analyzeText(info.text)
        await fs.writeFile(path.join(sourcesDir, `${id}.txt`), info.text, 'utf-8')
        const entry: SourceEntry = {
          id,
          displayName: info.name,
          path: info.path,
          sha256: sha,
          size: info.size,
          charCount: [...info.text].length,
          weight: 1,
          status: 'analyzed',
          stats
        }
        added.push(entry)
        existingHashes.add(sha)
      }
      if (added.length > 0) await writeSources([...existing, ...added])
      return added.map(({ stats: _s, ...meta }) => meta)
    },

    async buildProfile({ name, sourceIds }) {
      const sources = await readSources()
      const chosen = sources.filter((s) => sourceIds.includes(s.id))
      if (chosen.length === 0) throw new Error('未选择有效的风格来源')
      const forbidden = new Set<string>()
      for (const s of chosen) {
        try {
          const raw = await fs.readFile(path.join(sourcesDir, `${s.id}.txt`), 'utf-8')
          for (const ph of extractForbiddenPhrases(raw)) forbidden.add(ph)
        } catch {
          /* 原文缺失则跳过该来源的防复制词表 */
        }
      }
      const profile = buildProfile({
        name: name.trim() || `风格画像 ${new Date().toLocaleDateString('zh-CN')}`,
        sources: chosen.map((s) => ({ name: s.displayName, stats: s.stats, weight: s.weight })),
        sourceHashes: chosen.map((s) => s.sha256)
      })
      profile.forbiddenPhrases = [...forbidden].slice(0, 40)
      const profiles = await readProfiles()
      profiles.unshift(profile)
      await writeProfiles(profiles.slice(0, 50))
      return profile
    },

    async updateProfile(id, patch) {
      const profiles = await readProfiles()
      const idx = profiles.findIndex((p) => p.id === id)
      if (idx < 0) throw new Error('画像不存在')
      const updated: StyleProfile = { ...profiles[idx], ...patch, version: profiles[idx].version + 1 }
      profiles[idx] = updated
      await writeProfiles(profiles)
      return updated
    },

    async deleteProfile(id) {
      const profiles = await readProfiles()
      await writeProfiles(profiles.filter((p) => p.id !== id))
      if ((await readActive()) === id) await writeActive('')
    },

    async checkOverlap(profileId, text) {
      const profiles = await readProfiles()
      const profile = profiles.find((p) => p.id === profileId)
      if (!profile) throw new Error('画像不存在')
      const sources = await readSources()
      let worst: StyleOverlapReport | null = null
      for (const s of sources) {
        if (!profile.sourceHashes.includes(s.sha256)) continue
        try {
          const raw = await fs.readFile(path.join(sourcesDir, `${s.id}.txt`), 'utf-8')
          const report = checkOverlap(text, raw)
          report.profileId = profileId
          report.sourceName = s.displayName
          if (!worst || report.longestMatch > worst.longestMatch) worst = report
        } catch {
          /* 原文缺失跳过 */
        }
      }
      return worst ?? { profileId, sourceName: '', matches: [], longestMatch: 0, similarity: 0 }
    },

    async setActive(profileId) {
      await writeActive(profileId ?? '')
    },

    async getActiveProfile() {
      const activeId = await readActive()
      if (!activeId) return null
      const profiles = await readProfiles()
      return profiles.find((p) => p.id === activeId) ?? null
    }
  }
}

export function stylePromptFor(profile: StyleProfile): string {
  return buildStylePrompt(profile)
}

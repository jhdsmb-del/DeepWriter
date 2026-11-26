import { promises as fs } from 'fs'
import * as path from 'path'
import type { StyleJobState, StylometryProfile, CorpusChunk, ExemplarPair } from '../../shared/styleV2'

const safeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id)

async function atomicWrite(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

export interface StyleJobStore {
  saveJob(job: StyleJobState): Promise<void>
  getJob(jobId: string): Promise<StyleJobState | null>
  listJobs(): Promise<StyleJobState[]>
  deleteJob(jobId: string): Promise<void>
}

export function createStyleJobStore(baseDir: string): StyleJobStore {
  const dir = path.join(baseDir, 'styles-v2', 'jobs')
  return {
    async saveJob(job) {
      if (!safeId(job.jobId)) throw new Error('非法 jobId')
      await atomicWrite(path.join(dir, `${job.jobId}.json`), job)
    },
    async getJob(jobId) {
      if (!safeId(jobId)) return null
      try {
        return JSON.parse(await fs.readFile(path.join(dir, `${jobId}.json`), 'utf-8'))
      } catch {
        return null
      }
    },
    async listJobs() {
      try {
        const files = await fs.readdir(dir)
        const jobs: StyleJobState[] = []
        for (const f of files.filter((n) => n.endsWith('.json'))) {
          try {
            jobs.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')))
          } catch {
            /* skip */
          }
        }
        return jobs
      } catch {
        return []
      }
    },
    async deleteJob(jobId) {
      if (!safeId(jobId)) return
      try {
        await fs.unlink(path.join(dir, `${jobId}.json`))
      } catch {
        /* ignore */
      }
    }
  }
}

export interface ExemplarStore {
  saveExemplars(profileId: string, pairs: ExemplarPair[]): Promise<void>
  getExemplars(profileId: string): Promise<ExemplarPair[]>
  saveCorpus(profileId: string, chunks: CorpusChunk[]): Promise<void>
  getCorpus(profileId: string): Promise<CorpusChunk[]>
  saveProfile(profileId: string, profile: StylometryProfile): Promise<void>
  getProfile(profileId: string): Promise<StylometryProfile | null>
  saveForbidden(profileId: string, phrases: string[]): Promise<void>
  getForbidden(profileId: string): Promise<string[]>
}

export function createExemplarStore(baseDir: string): ExemplarStore {
  const dir = path.join(baseDir, 'styles-v2', 'exemplars')
  const fileFor = (profileId: string, kind: string): string => {
    if (!safeId(profileId)) throw new Error('非法 profileId')
    return path.join(dir, `${profileId}.${kind}.json`)
  }
  return {
    async saveExemplars(profileId, pairs) {
      await atomicWrite(fileFor(profileId, 'exemplars'), pairs)
    },
    async getExemplars(profileId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(profileId, 'exemplars'), 'utf-8'))
      } catch {
        return []
      }
    },
    async saveCorpus(profileId, chunks) {
      await atomicWrite(fileFor(profileId, 'corpus'), chunks)
    },
    async getCorpus(profileId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(profileId, 'corpus'), 'utf-8'))
      } catch {
        return []
      }
    },
    async saveProfile(profileId, profile) {
      await atomicWrite(fileFor(profileId, 'profile'), profile)
    },
    async getProfile(profileId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(profileId, 'profile'), 'utf-8'))
      } catch {
        return null
      }
    },
    async saveForbidden(profileId, phrases) {
      await atomicWrite(fileFor(profileId, 'forbidden'), phrases)
    },
    async getForbidden(profileId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(profileId, 'forbidden'), 'utf-8'))
      } catch {
        return []
      }
    }
  }
}

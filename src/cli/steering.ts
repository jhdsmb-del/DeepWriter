import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRepository } from '../main/db/repository'
import { queueWorkSteering, workSteeringView } from '../main/workSteering'
import type { CliOptions } from './config'
import type { Emit } from './runtime'

/** This process only records human input for the already-running owner. */
export async function localSteering(command: 'steer' | 'steering', args: string[], dataDir: string, options: CliOptions, emit: Emit): Promise<void> {
  if (args.length < (command === 'steer' ? 3 : 2) || command === 'steering' && args.length !== 2) throw new Error(command === 'steer' ? '用法：steer RUN "补充指令" [--request-id ID]' : '用法：steering RUN')
  const dbPath = path.join(dataDir, 'deepwriter.sqlite')
  await fs.access(dbPath).catch(() => { throw new Error('此数据目录没有运行记录；请指定原来的 --data-dir') })
  const repo = createRepository(dbPath)
  try {
    repo.open()
    const run = repo.getRun(args[1])
    if (!run) throw new Error('运行不存在')
    const sessionId = typeof options.session === 'string' ? options.session : run.session_id
    if (command === 'steer') {
      const message = queueWorkSteering(repo, { runId: run.run_id, sessionId, requestId: typeof options['request-id'] === 'string' ? options['request-id'] : randomUUID(), text: args.slice(2).join(' ') })
      emit('steering', { ...workSteeringView(repo, run.run_id, sessionId), submittedRequestId: message.requestId })
    } else emit('steering', workSteeringView(repo, run.run_id, sessionId))
  } finally { repo.close() }
}

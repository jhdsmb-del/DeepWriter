import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

export interface PdfTextResult {
  text: string
  truncated: boolean
  pagesRead: number
  totalPages: number
}

// PDFParse's partial API cleans each page, but destroy() cannot cancel its
// pending load or a synchronous page parse. A short-lived process covers both
// and isolates the parser's native canvas (unsafe to unload in Node workers).
// Only this static program runs: no extra distribution file or user code.
const PDF_PROCESS = String.raw`
process.once('message', async (workerData) => {
  let parser, reply;
  try {
    const { PDFParse } = require(workerData.modulePath);
    parser = new PDFParse({ data: workerData.bytes, isEvalSupported: false, useWorkerFetch: false });
    process.send({ started: true });
    let text = '', readable = false, pagesRead = 0, totalPages = 0, truncated = false;
    for (let number = 1; ; number++) {
      const result = await parser.getText({ partial: [number], pageJoiner: '' });
      if (!Number.isSafeInteger(result.total) || result.total < number ||
          result.pages.length !== 1 || result.pages[0].num !== number ||
          typeof result.pages[0].text !== 'string') throw new Error('PDF 页提取结果无效，未猜测正文');
      totalPages = result.total;
      pagesRead++;
      const body = result.pages[0].text.trim();
      readable ||= Boolean(body);
      const chunk = (number > 1 ? '\n\n' : '') + '【PDF 第 ' + number + ' 页·文字层】\n' +
        (body || '（本页无可提取文字；未执行 OCR）');
      const remaining = workerData.maxChars - text.length;
      if (chunk.length > remaining) {
        text += chunk.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, '');
        truncated = true;
        break;
      }
      text += chunk;
      if (number === totalPages) break;
      if (text.length === workerData.maxChars) { truncated = true; break; }
    }
    // A bounded prefix of textless pages says nothing about unread pages.
    if (!readable && !truncated) throw new Error('PDF 未提取到文字层；已检查 ' + pagesRead + ' 页，可能为扫描件或图片，本工具不做 OCR，不能据此判断文档没有内容');
    reply = { result: { text, truncated, pagesRead, totalPages } };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
  process.send(reply, () => { process.disconnect(); process.exit(0); });
});
`

function resolvePdfModule(name: string): string {
  // Desktop is CJS; source/verification also run as ESM. Both resolve beside
  // the application module, never beside an author's selected work directory.
  const localRequire = typeof require === 'function' && typeof require.resolve === 'function'
    ? require : createRequire(import.meta.url)
  return localRequire.resolve(name)
}

/** Read only enough whole PDF pages to fill the caller's text budget. No OCR,
 * scripts or external fetches. Cancellation waits for the parser process exit. */
export async function extractPdfText(buffer: Buffer, maxChars = 300_000, signal?: AbortSignal): Promise<PdfTextResult> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error('PDF 提取字符上限必须为非负安全整数')
  if (maxChars === 0) return { text: '', truncated: true, pagesRead: 0, totalPages: 0 }
  const modulePath = resolvePdfModule('pdf-parse')
  // This bundled executable is the runtime, not a Node found through user PATH.
  // Do not inherit provider credentials, NODE_OPTIONS or ELECTRON_NO_ASAR.
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const child = spawn(process.execPath, ['--eval', PDF_PROCESS], {
    cwd: dirname(process.execPath), env, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced'
  })
  let onAbort: (() => void) | undefined
  let result: PdfTextResult | undefined, failure: Error | undefined
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      failure ??= error
      child.kill()
    }
    onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('PDF 读取已取消'))
    child.once('error', error => { failure ??= error })
    child.once('close', code => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`PDF 解析进程退出（${code}），尚未完成本次读取`))
      else if (!result) reject(new Error('PDF 解析进程未返回有效结果'))
      else resolve()
    })
    child.on('message', (reply: { result?: PdfTextResult; error?: string }) => {
      if (reply.error) failure ??= new Error(reply.error)
      else if (reply.result) result = reply.result
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else {
      try { child.send({ modulePath, bytes: buffer, maxChars }, error => { if (error) fail(error) }) }
      catch (error) { fail(error as Error) }
    }
  })
  signal?.throwIfAborted()
  return result!
}

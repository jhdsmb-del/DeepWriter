/** The standalone CLI intentionally excludes PDF.js worker/native assets.
 * This capability result is explicit; no fallback decodes PDF bytes as text. */
export const unavailableReason = '当前独立 CLI 未内置 PDF 文字层提取运行组件，尚未读取此 PDF，也不能判断它是否为扫描件。请在 DeepWriter 桌面直接添加同一个 PDF 为附件读取（无需移动文件）；图片扫描页仍需要 OCR，本工具不做 OCR。'

export async function extractPdfText(): Promise<never> {
  throw new Error(unavailableReason)
}

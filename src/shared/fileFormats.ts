/** Text is read as data only. Sharing this list keeps attachments and archive
 * entries from disagreeing about ordinary project source/configuration files. */
export const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'mdx', 'markdown', 'rst', 'log', 'json', 'jsonc', 'jsonl', 'ndjson',
  'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'properties', 'mod', 'sum', 'lock',
  'srt', 'vtt', 'lrc', 'rpy', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'swift', 'dart', 'c', 'h', 'cc', 'cpp',
  'cxx', 'hpp', 'cs', 'fs', 'fsx', 'vb', 'php', 'rb', 'r', 'lua', 'pl', 'pm',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'sql', 'graphql',
  'proto', 'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'tex', 'bib', 'cmake', 'gradle', 'gitignore', 'gitattributes', 'editorconfig', 'env'
] as const
const extensions = new Set<string>(TEXT_FILE_EXTENSIONS)
export function isProjectTextName(name: string): boolean {
  const leaf = name.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()
  return /^(readme|license|licence|notice|copying|authors|changelog|makefile|dockerfile)$/.test(leaf)
    || extensions.has(leaf.slice(leaf.lastIndexOf('.') + 1))
}

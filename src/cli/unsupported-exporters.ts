/** Desktop-only optional modules are outside the CLI tool allow-list.
 * This real module is an explicit unsupported capability, never a stub that
 * reports successful work. It removes optional GUI/exporter dependencies from
 * the standalone Node bundle. */
throw new Error('此格式的导入/导出不在 DeepWriter CLI 支持范围；CLI 可只读提取 DOCX、交付 Markdown 正文，SQLite 需要 Node 22.13+')
export {}

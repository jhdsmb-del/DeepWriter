/** Keep names identical in chat, live progress, and the task inspector. */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  list_files: '列出目录', read_file: '读取文件', search_files: '搜索文件',
  find_files: '查找文件', read_files: '批量读文件',
  write_file: '写入文件', edit_file: '编辑文件', run_command: '执行命令',
  update_work_plan: '更新任务清单', search_conversation: '查回会话历史',
  web_search: '搜索网页', read_web_page: '读取网页',
  generate_markdown_doc: 'Markdown 文档', generate_docx_doc: 'Word 文档',
  generate_xlsx_doc: 'Excel 表格', generate_pdf_doc: 'PDF 文档', mock_tool: '测试工具'
}

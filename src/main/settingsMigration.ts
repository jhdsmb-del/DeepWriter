import * as path from 'node:path'

/** Migrate only the exact shipped legacy default; never rewrite a user's custom directory. */
export function migrateLegacyDefaultDocDir(docDir: string, documentsDir: string): { value: string; migrated: boolean } {
  const normalize = (value: string): string => path.normalize(path.resolve(value)).replace(/[\\/]+$/, '').toLowerCase()
  const legacy = path.join(documentsDir, 'DeepSeek Studio')
  if (normalize(docDir) !== normalize(legacy)) return { value: docDir, migrated: false }
  return { value: path.join(documentsDir, 'DeepWriter'), migrated: true }
}

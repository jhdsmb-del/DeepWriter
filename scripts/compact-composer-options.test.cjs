const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')

// Execute the actual source function with only TypeScript types erased, not a
// reimplementation or rendered mock. No Electron/user configuration is loaded.
const root = path.resolve(__dirname, '..')
const types = transformSync(fs.readFileSync(path.join(root, 'src/shared/types.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const shared = { exports: {} }
new Function('module', 'exports', types)(shared, shared.exports)
const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/ModelReasoningControl.tsx'), 'utf8')
const fragment = source.slice(source.indexOf('function isVerifiedReasoning'), source.indexOf('\nfunction profileInput'))
const actual = transformSync(fragment, { loader: 'ts', format: 'cjs' }).code
const modelOptions = new Function('MODELS', 'DEFAULT_EFFORTS', `${actual}\nreturn modelOptions`)(shared.exports.MODELS, ['low', 'high', 'max'])

const canonical = modelOptions(null, 'deepseek-v4-pro')
assert.deepEqual(canonical.filter(option => option.label === 'DeepSeek V4.1-Flash').map(option => option.remoteModelId), ['deepseek-flash'])
const legacy = modelOptions(null, 'deepseek-v4-flash')
assert.deepEqual(legacy.filter(option => option.label === 'DeepSeek V4.1-Flash').map(option => option.remoteModelId), ['deepseek-v4-flash'])

const record = (id, remoteModelId, providerId = 'builtin', source = 'builtin') => ({ id, providerId, remoteModelId, displayName: 'DeepSeek V4.1-Flash', source, enabled: true, capabilities: { reasoning: { state: 'supported', source: 'builtin_manifest', efforts: ['low', 'high', 'max'] } } })
const snapshot = {
  providers: [{ id: 'builtin', adapterId: 'builtin.deepseek', displayName: 'DeepSeek' }, { id: 'custom', adapterId: 'custom.openai-compatible-chat', displayName: '同名真实提供方' }],
  models: [record('old-flash', 'deepseek-v4-flash'), record('official-flash', 'deepseek-flash'), record('old-vision', 'deepseek-v4-flash-vision-exp'), record('custom-flash', 'same-friendly-name', 'custom', 'manual')],
  profiles: [{ id: 'active', modelId: 'old-flash' }, { id: 'official-profile', modelId: 'official-flash' }, { id: 'custom-profile', modelId: 'custom-flash' }],
  bindings: { draftProfileId: 'active' }
}
const configured = modelOptions(snapshot, 'deepseek-v4-flash')
assert(configured.some(option => option.id === 'old-flash' && option.remoteModelId === 'deepseek-v4-flash' && option.profile.id === 'active'))
assert(configured.some(option => option.id === 'official-flash' && option.remoteModelId === 'deepseek-flash'))
assert(configured.some(option => option.id === 'custom-flash' && option.record.providerId === 'custom'))
assert(!configured.some(option => option.id === 'old-vision'))

const onlyLegacyReady = modelOptions({ ...snapshot, profiles: snapshot.profiles.filter(profile => profile.id !== 'official-profile') }, 'deepseek-v4-flash')
assert(!onlyLegacyReady.some(option => option.id === 'official-flash' || option.id === 'old-vision'))
assert(onlyLegacyReady.some(option => option.id === 'old-flash') && onlyLegacyReady.some(option => option.id === 'custom-flash'))
console.log('PASS actual modelOptions: canonical placeholders folded; active legacy remote/Profile preserved; distinct configured same-name records/Providers retained')

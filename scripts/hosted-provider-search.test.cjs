'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const built = buildSync({
  stdin: { contents: "export * from './src/main/hostedProviderSearch'; export * from './src/shared/hostedSearchModels'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text
const moduleApi = { exports: {} }
// Pure-adapter tests: any accidental network request or credential read fails immediately.
new Function('require', 'module', 'exports', built)(name => {
  if (['node:https', 'node:http'].includes(name)) return { request: () => { throw new Error('PAID NETWORK FORBIDDEN IN FIXTURE') } }
  if (['node:dns/promises', 'fs', 'node:fs'].includes(name)) return new Proxy({}, { get: () => { throw new Error('IO FORBIDDEN IN FIXTURE') } })
  return require(name)
}, moduleApi, moduleApi.exports)
const { describeHostedSearchSupport, buildHostedSearchRequest, parseHostedSearchResponse } = moduleApi.exports
function frozen(provider = 'openai', modelId) {
  const anthropic = provider === 'anthropic'
  return {
    version: 1, profileId: 'frozen-profile', fingerprint: 'frozen-identity',
    provider: { id: provider, adapterId: 'custom.openai-compatible-chat', baseUrl: anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com',
      chatPath: anthropic ? '/v1/messages' : '/v1/responses', authStyle: 'bearer', transportPolicy: { scope: 'public_https', allowNonDefaultPort: false, protocol: anthropic ? 'anthropic-messages' : 'openai-responses' } },
    model: { remoteModelId: modelId ?? (anthropic ? 'claude-sonnet-4-6' : 'gpt-5.4') },
    credential: { credentialRefId: 'frozen-ref-not-secret', providerId: provider, version: 7 },
    generation: { maxOutputTokens: 3000 }
  }
}
const oai = (extra = {}) => ({
  object: 'response', id: 'resp_fixture', status: 'completed',
  output: [{ type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://www.iana.org/help/example-domains', title: 'IANA' }] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'IANA maintains example domains.', annotations: [{ type: 'url_citation', url: 'https://www.iana.org/help/example-domains', title: 'IANA', start_index: 0, end_index: 29 }] }] }],
  usage: { input_tokens: 440, output_tokens: 60, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } }, ...extra
})
const claude = (extra = {}) => ({
  type: 'message', id: 'msg_fixture', stop_reason: 'end_turn',
  content: [{ type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: { query: 'IANA example domains' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [{ type: 'web_search_result', url: 'https://www.iana.org/help/example-domains', title: 'IANA', encrypted_content: 'not-for-forwarding' }] },
    { type: 'text', text: 'IANA maintains example domains.', citations: [{ type: 'web_search_result_location', url: 'https://www.iana.org/help/example-domains', title: 'IANA', cited_text: 'example domains' }] }],
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, server_tool_use: { web_search_requests: 1 } }, ...extra
})

test('native capability requires exact official origin, frozen protocol/path, supported model and keyed public HTTPS', () => {
  assert.equal(describeHostedSearchSupport(frozen()).service, 'openai_hosted_search')
  assert.equal(describeHostedSearchSupport(frozen('anthropic')).service, 'anthropic_hosted_search')
  assert.ok(describeHostedSearchSupport(frozen('openai', 'gpt-5.2-2025-12-11')))
  assert.ok(describeHostedSearchSupport(frozen('anthropic', 'claude-opus-5-5')))
  assert.ok(describeHostedSearchSupport(frozen('anthropic', 'claude-sonnet-4-5-20250929')))
  for (const edit of [
    f => f.provider.baseUrl = 'https://api.openai.com.evil.example', f => f.provider.baseUrl = 'https://api.openai.com:8443',
    f => f.provider.baseUrl = 'https://secret@api.openai.com', f => f.provider.baseUrl = 'https://api.openai.com/v1',
    f => f.provider.baseUrl = 'https://api.openai.com/?redirect=https://other.example', f => f.provider.baseUrl = 'http://api.openai.com',
    f => f.provider.chatPath = '/v1/chat/completions', f => f.provider.transportPolicy.protocol = 'openai-chat',
    f => f.provider.transportPolicy.scope = 'loopback_http', f => f.provider.authStyle = 'none',
    f => f.model.remoteModelId = 'gpt-5.4-user-alias', f => f.model.remoteModelId = 'gpt-5.4-nano',
    f => f.model.remoteModelId = 'deepseek-v4-flash', f => f.model.remoteModelId = 'gpt-4o-search-preview'
  ]) { const f = frozen(); edit(f); assert.equal(describeHostedSearchSupport(f), null) }
})

test('OpenAI wire enables native web research without an artificial search count, frozen model and query only; no history, Key, fallback or guessed upper quote', () => {
  const f = frozen(); f.extraPrivateHistory = 'DO NOT SEND LOCAL CONTENT'
  const before = structuredClone(f)
  const request = buildHostedSearchRequest({ frozen: f, query: 'public IANA query', maxOutputTokens: 2500 })
  assert.deepEqual(f, before)
  assert.equal(request.protocol, 'openai-responses'); assert.equal(request.endpointPath, '/v1/responses')
  assert.equal(request.maxSearchCalls, null); assert.equal(request.pricingKnownUpperBound, false)
  assert.equal(request.body.input, 'public IANA query'); assert.equal(request.body.model, f.model.remoteModelId)
  assert.equal(request.body.max_tool_calls, undefined); assert.equal(request.body.tool_choice, 'required')
  assert.equal(request.body.max_output_tokens, 2500); assert.equal(request.body.stream, false); assert.equal(request.body.store, false)
  assert.deepEqual(request.body.include, ['web_search_call.action.sources'])
  assert.deepEqual(request.body.tools, [{ type: 'web_search', external_web_access: true }])
  assert.doesNotMatch(JSON.stringify(request), /DO NOT SEND|frozen-ref|apiKey|api_key|mcp\.exa|Exa|authorization|previous_response_id|conversation/)
  assert.equal(buildHostedSearchRequest({ frozen: f, query: 'one', maxOutputTokens: 9999 }).body.max_output_tokens, 3000)
})

test('Anthropic wire leaves native search uses unlimited by default, provisions no code execution, retains frozen model', () => {
  const request = buildHostedSearchRequest({ frozen: frozen('anthropic'), query: '公开问题' })
  assert.equal(request.endpointPath, '/v1/messages'); assert.equal(request.protocol, 'anthropic-messages')
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '公开问题' }])
  assert.deepEqual(request.body.tools, [{ type: 'web_search_20250305', name: 'web_search' }])
  assert.equal(request.body.stream, false)
  assert.equal(request.body.max_tokens, 3000)
  assert.doesNotMatch(JSON.stringify(request), /code_execution|web_fetch|encrypted_content|frozen-ref|apiKey/)
})

test('bad/unsupported requests fail before IO and do not echo supplied private values', () => {
  for (const query of ['', 'x'.repeat(1501), '\u0000', 8]) assert.throws(() => buildHostedSearchRequest({ frozen: frozen(), query }))
  const f = frozen('openai', 'unknown-secret-model')
  assert.throws(() => buildHostedSearchRequest({ frozen: f, query: 'public' }), e => !e.message.includes('unknown-secret-model'))
  f.model.remoteModelId = 'gpt-5.4'; f.generation.maxOutputTokens = 0
  assert.throws(() => buildHostedSearchRequest({ frozen: f, query: 'public' }), /token/)
})

test('OpenAI requires completed native search evidence and parses actual citation URLs, token/cache usage and call count', () => {
  const parsed = parseHostedSearchResponse('openai-responses', oai())
  assert.equal(parsed.ok, true); assert.match(parsed.text, /IANA/)
  assert.deepEqual(parsed.sources, [{ url: 'https://www.iana.org/help/example-domains', title: 'IANA' }])
  assert.deepEqual(parsed.proof, [{ id: 'ws_fixture', type: 'web_search_call', action: 'search', status: 'completed' }])
  assert.deepEqual(parsed.usage, { inputTokens: 440, outputTokens: 60, cacheReadTokens: 20, cacheWriteTokens: 0, searchRequests: 1 })
  assert.equal(parsed.billable, true)
  const absent = parseHostedSearchResponse('openai-responses', oai({ output: [oai().output[1]] }))
  assert.equal(absent.ok, false); assert.deepEqual(absent.sources, []); assert.equal(absent.usage.inputTokens, 440); assert.equal(absent.billable, true)
  const failed = oai(); failed.output[0].status = 'failed'
  assert.equal(parseHostedSearchResponse('openai-responses', failed).ok, false)
  const open = oai(); open.output[0].action.type = 'open_page'
  assert.equal(parseHostedSearchResponse('openai-responses', open).ok, true)
  assert.equal(parseHostedSearchResponse('openai-responses', open).usage.searchRequests, 0)
  assert.equal(parseHostedSearchResponse('openai-responses', oai({ status: 'incomplete' })).ok, false)
})

test('Anthropic pairs server_tool_use with its result, not prose, dangling results or encrypted content', () => {
  const parsed = parseHostedSearchResponse('anthropic-messages', claude())
  assert.equal(parsed.ok, true); assert.equal(parsed.billable, true)
  assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, searchRequests: 1 })
  assert.deepEqual(parsed.proof, [{ id: 'srvtoolu_fixture', type: 'server_tool_use', status: 'completed' }])
  assert.doesNotMatch(JSON.stringify(parsed), /not-for-forwarding|encrypted_content/)
  const orphan = claude(); orphan.content.shift()
  assert.equal(parseHostedSearchResponse('anthropic-messages', orphan).ok, false)
  const mismatched = claude(); mismatched.content[1].tool_use_id = 'srvtoolu_unrelated'
  assert.equal(parseHostedSearchResponse('anthropic-messages', mismatched).ok, false)
  const claimed = claude({ content: [{ type: 'text', text: 'I searched the web. https://example.com' }] })
  assert.equal(parseHostedSearchResponse('anthropic-messages', claimed).ok, false)
  assert.equal(parseHostedSearchResponse('anthropic-messages', claude({ stop_reason: 'pause_turn' })).ok, false)
})

test('HTTP-200 search errors preserve actual usage and do not pass provider errors or secrets through', () => {
  const failed = claude(); failed.content[1].content = { type: 'web_search_tool_result_error', error_code: 'too_many_requests', message: 'PRIVATE-SENTINEL' }
  failed.usage.server_tool_use.web_search_requests = 0
  const parsed = parseHostedSearchResponse('anthropic-messages', failed)
  assert.equal(parsed.ok, false); assert.equal(parsed.usage.searchRequests, 0); assert.equal(parsed.usage.inputTokens, 100)
  assert.deepEqual(parsed.sources, []); assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE-SENTINEL/)
  const oerror = parseHostedSearchResponse('openai-responses', { status: 'failed', error: { message: 'PRIVATE-SENTINEL' }, usage: { input_tokens: 15, output_tokens: 0 } })
  assert.equal(oerror.ok, false); assert.equal(oerror.billable, true); assert.doesNotMatch(JSON.stringify(oerror), /PRIVATE-SENTINEL/)
})

test('missing/malformed usage remains unknown; native evidence with no public sources cannot produce grounded success', () => {
  const absent = parseHostedSearchResponse('openai-responses', {})
  assert.equal(absent.billable, null); assert.deepEqual(absent.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, searchRequests: null })
  const malformed = parseHostedSearchResponse('anthropic-messages', { usage: { input_tokens: -10, output_tokens: '12', server_tool_use: { web_search_requests: NaN } } })
  assert.equal(malformed.usage.inputTokens, null); assert.equal(malformed.usage.outputTokens, null); assert.equal(malformed.usage.searchRequests, null)
  for (const url of ['file:///C:/private.txt', 'http://127.0.0.1', 'http://10.0.0.1', 'https://user:secret@example.com', 'http://100.64.0.1', 'javascript:alert(1)']) {
    const data = oai(); data.output[0].action.sources[0].url = url; data.output[1].content[0].annotations[0].url = url
    assert.equal(parseHostedSearchResponse('openai-responses', data).ok, false, url)
  }
})

test('response output is bounded; multiple server searches retain real paid-unit counts without local quota failure', () => {
  const huge = oai(); huge.output[1].content[0].text = '内容😀'.repeat(20000)
  const result = parseHostedSearchResponse('openai-responses', huge)
  assert.ok(Array.from(result.text).length <= 20000); assert.doesNotMatch(result.text, /[\uD800-\uDFFF]/u)
  const extra = oai(); extra.output.push({ ...extra.output[0], id: 'ws_second' })
  const parsed = parseHostedSearchResponse('openai-responses', extra)
  assert.equal(parsed.ok, true); assert.equal(parsed.usage.searchRequests, 2); assert.equal(parsed.billable, true)
  const ant = claude(); ant.usage.server_tool_use.web_search_requests = 2
  assert.equal(parseHostedSearchResponse('anthropic-messages', ant).ok, true)
})


test('new native web output intent omits optional wire caps, uses native/context bounds for Messages, and preserves explicit limits', () => {
  for (const family of ['openai', 'anthropic']) {
    const profile = frozen(family); profile.generation.maxOutputTokens = 1024; profile.generation.outputTokenLimit = null
    profile.model.maxOutputTokens = 16000; profile.model.contextWindow = 64000
    const field = family === 'openai' ? 'max_output_tokens' : 'max_tokens'
    const automatic = buildHostedSearchRequest({ frozen: profile, query: 'public sources' })
    assert.equal(automatic.body[field], family === 'openai' ? undefined : 16000)
    profile.generation.outputTokenLimit = 2500
    assert.equal(buildHostedSearchRequest({ frozen: profile, query: 'public sources' }).body[field], 2500)
    assert.equal(buildHostedSearchRequest({ frozen: profile, query: 'public sources', maxOutputTokens: 700 }).body[field], 700)
    profile.generation.outputTokenLimit = null
    if (family === 'anthropic') {
      profile.model.contextWindow = 2048
      const continued = moduleApi.exports.applyHostedOutputLimit(profile, { ...automatic.body, messages: [{ role: 'assistant', content: '已有供应商结果'.repeat(180) }] })
      assert(continued.max_tokens > 0 && continued.max_tokens < 2048, 'actual continuation input narrows only the protocol-required output field')
    }
  }
})

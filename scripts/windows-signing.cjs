'use strict'

// Public configuration only. electron-builder reads certificate/Entra credentials
// directly from its environment; they never enter a generated configuration file.
function signingConfiguration(base, env = process.env) {
  const required = env.DW_REQUIRE_SIGNING === '1'
  const mode = env.DW_SIGNING_MODE || 'unsigned'
  const need = (name) => {
    if (!env[name]?.trim()) throw new Error(`Windows signing requires ${name}`)
    return env[name].trim()
  }
  if (mode === 'unsigned') {
    if (required) throw new Error('This build requires trusted Windows code signing; configure DW_SIGNING_MODE')
    return { ...base, forceCodeSigning: false }
  }
  const publisherName = need('DW_SIGNING_PUBLISHER')
  let signing
  if (mode === 'azure') {
    // Explicit service-principal authentication avoids depending on runner identity.
    for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) need(key)
    const endpoint = need('DW_SIGNING_ENDPOINT')
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-z0-9-]+\.codesigning\.azure\.net$/i.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid Azure Artifact Signing endpoint')
    signing = { azureSignOptions: {
      publisherName, endpoint, certificateProfileName: need('DW_SIGNING_PROFILE'),
      codeSigningAccountName: need('DW_SIGNING_ACCOUNT'), fileDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com', timestampDigest: 'SHA256'
    } }
  } else if (mode === 'certificate') {
    need('WIN_CSC_LINK')
    need('WIN_CSC_KEY_PASSWORD')
    signing = { signtoolOptions: {
      publisherName, signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: 'http://timestamp.digicert.com'
    } }
  } else throw new Error('Unknown Windows signing mode; expected azure or certificate')
  const { azureSignOptions, signtoolOptions, ...win } = base.win || {}
  return { ...base, forceCodeSigning: true, win: { ...win, ...signing, verifyUpdateCodeSignature: true } }
}

module.exports = { signingConfiguration }

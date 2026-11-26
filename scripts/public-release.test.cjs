'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { buildSync } = require('esbuild'), path = require('node:path')
const mod = { exports: {} }
new Function('module','exports', buildSync({entryPoints:[path.join(__dirname,'../src/shared/publicRelease.ts')],platform:'node',format:'cjs',write:false}).outputFiles[0].text)(mod,mod.exports)
const { getStableRelease,parsePublicRelease,isNewerVersion } = mod.exports
const origin='https://github.com/jhdsmb-del/DeepWriter',tag='v8.0.1',zip='DeepWriter-8.0.1-cli-win-x64.zip',digest='c'.repeat(64)
const asset=name=>({name,state:'uploaded',size:234,browser_download_url:origin+'/releases/download/'+tag+'/'+name,digest:'sha256:'+digest})
const release=()=>({tag_name:tag,html_url:origin+'/releases/tag/'+tag,draft:false,prerelease:false,assets:[asset(zip),asset('DeepWriter-8.0.1-x64-portable.exe'),asset('DeepWriter-8.0.1-complete.zip')]})
test('stable version order handles multi-digit components without offering downgrades',()=>{
 for(const [a,b,newer] of [['10.0.0','8.9.9',true],['8.10.0','8.2.12',true],['8.0.0','8.0.0',false],['8.0.0','8.0.1',false],['8.0.0-beta.1','6.0.0',false],['8.01.2','8.0.0',false]])assert.equal(isNewerVersion(a,b),newer)
})
test('desktop portable and terminal read the official stable feed, without account credentials',async()=>{
 let observed;const value=await getStableRelease({request:async(url,init)=>{observed=[url,init];return Response.json(release())}})
 assert.equal(observed[0],'https://api.github.com/repos/jhdsmb-del/DeepWriter/releases/latest');assert.equal(observed[1].credentials,'omit');assert.equal(observed[1].redirect,'error')
 assert.equal(value.version,'8.0.1');assert.equal(value.cliAsset.sha256,digest);assert.ok(value.portableUrl.endsWith('x64-portable.exe'));assert.ok(value.completeUrl.endsWith('complete.zip'))
 for(const change of [{draft:true},{prerelease:true},{html_url:'https://example.test/latest'},{tag_name:'v8.0.1-rc.1'}])assert.throws(()=>parsePublicRelease({...release(),...change}))
})
test('older releases can lack CLI; wrong host, duplicate, or unfinished asset never becomes a download',()=>{
 for(const arr of [[],[asset(zip),asset(zip)],[{...asset(zip),state:'new'}],[{...asset(zip),browser_download_url:'https://example.test/download.zip'}]])assert.equal(parsePublicRelease({...release(),assets:arr}).cliAsset,null)
 assert.equal(parsePublicRelease({...release(),assets:[{...asset(zip),digest:null}]}).cliAsset.sha256,null)
})
test('failed lookup does not report already current',async()=>{
 await assert.rejects(getStableRelease({request:async()=>new Response(null,{status:403})}),/限制/)
 await assert.rejects(getStableRelease({request:async()=>new Response(null,{status:503})}),/503/)
})

'use strict'
// The update channel is published alongside the NSIS installer. It must never
// point an installed copy at the portable executable, a draft, or another host.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib')
const {load} = require('js-yaml')
async function verifyUpdateFeed(dir, version, installerDir=dir) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid stable version')
  const name='DeepWriter-'+version+'-x64-setup.exe'
  const y=load(fs.readFileSync(path.join(dir,'latest.yml'),'utf8'))
  const f=y?.files?.[0]
  if(y?.version!==version || y.path!==name || !Array.isArray(y.files) || y.files.length!==1 || f.url!==name ||
    !Number.isSafeInteger(f.size) || f.size<=0 || f.sha512!==y.sha512) throw Error('latest.yml does not identify exactly the stable x64 installer')
  const exe=path.join(installerDir,name),stat=fs.statSync(exe),hash=crypto.createHash('sha512')
  if(stat.size!==f.size) throw Error('Update installer length differs from latest.yml')
  for await (const chunk of fs.createReadStream(exe)) hash.update(chunk)
  if(hash.digest('base64')!==f.sha512) throw Error('Update integrity differs from the actual NSIS installer')
  const map=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,name+'.blockmap'))))
  if(map.version!=='2' && map.version!==2) throw Error('Unsupported update block map')
  if(!Array.isArray(map.files)||map.files.length!==1) throw Error('Invalid installer block map')
  const blocks=map.files[0]
  if(blocks.offset!==0||!Array.isArray(blocks.sizes)||!Array.isArray(blocks.checksums)||blocks.sizes.length!==blocks.checksums.length||
    !blocks.sizes.every(s=>Number.isSafeInteger(s)&&s>0)||blocks.sizes.reduce((a,b)=>a+b,0)!==stat.size) throw Error('Block map does not cover this installer')
  return {version,installer:name,size:stat.size,sha512:y.sha512}
}
module.exports={verifyUpdateFeed}
if(require.main===module) verifyUpdateFeed(process.argv[2],process.argv[3],process.argv[4]).then(r=>console.log('Update channel: '+r.installer+' ('+r.size+' bytes)')).catch(e=>{console.error(e.message);process.exitCode=1})

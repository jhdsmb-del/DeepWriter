const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { buildSync } = require('esbuild')
const api = { exports: {} }
new Function('require', 'module', 'exports', buildSync({
  stdin: { resolveDir: path.resolve(__dirname, '..'), contents: "export {createRepository} from './src/main/db/repository'; export {readManuscriptReader} from './src/main/manuscriptReader'; export {runsReadManuscriptSchema} from './src/shared/ipcSchemas'" },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent'
}).outputFiles[0].text)(require, api, api.exports)
const { createRepository, readManuscriptReader, runsReadManuscriptSchema } = api.exports

test('reader identity and page schema reject mixed identities, paths, negative and noninteger pages', () => {
  for (const input of [{}, {runId:'a', sessionId:'b'}, {runId:'a', path:'x'}, {runId:'a', page:-1}, {runId:'a', page:1.5}]) assert.equal(runsReadManuscriptSchema.safeParse(input).success, false)
  assert(runsReadManuscriptSchema.safeParse({runId:'a', chapterId:'section:c1', page:1}).success)
  assert(runsReadManuscriptSchema.safeParse({sessionId:'s'}).success)
})

test('metadata-only directory, accepted-only Unicode paging, stable sources and cold-session lookup use the real SQLite reader without mutations', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-reader-unit-')), file = path.join(home, 'reader.db')
  const repo = createRepository(file); repo.open()
  const db = new DatabaseSync(file)
  try {
    const config = JSON.stringify({runMode:'longwrite', longMode:true, grillMe:{approvedOutline:{title:'河岸手记', sections:[{id:'c1',title:'潮水以前'},{id:'c2',title:'旧渡口'}]}}})
    db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run('s','手记',1,1)
    for (const [id,time,conf] of [['long',1,config],['new-agent',2,'{}']]) db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json) VALUES(?,?,?,?,?,?,?)').run(id,'s','failed','failed',time,time,conf)
    const first = '潮'.repeat(5999) + '🌊' + '回'.repeat(6), second = '船'.repeat(6100), third = '旧渡口的石阶还在。'
    const insert = db.prepare('INSERT INTO manuscript_segments(segment_id,run_id,session_id,chunk_index,revision,status,kind,content,content_hash,char_count,section_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const [id,order,status,kind,body,chapter] of [['a',0,'accepted','prose',first,'c1'], ['b',1,'accepted','prose',second,'c1'], ['draft',2,'partial','prose','不能当成收稿','c2'], ['candidate',3,'candidate','prose','候选没有接纳','c2'], ['c',4,'accepted','prose',third,'c2'], ['report',5,'accepted','meta','任务完成报告',null]]) {
      insert.run(id,'long','s',order,1,status,kind,body,'a'.repeat(64),Array.from(body).length,chapter,1,1)
    }
    const before = db.prepare('SELECT * FROM manuscript_segments ORDER BY segment_id').all()
    let bodiesRead = 0
    const tracked = {...repo, getManuscriptReaderSlices: (...args) => { bodiesRead++; return repo.getManuscriptReaderSlices(...args) }}
    const index = readManuscriptReader(tracked, {sessionId:'s'})
    assert.equal(index.runId,'long'); assert.equal(index.title,'河岸手记'); assert.equal(index.page,null); assert.equal(bodiesRead,0)
    assert.equal(index.unacceptedSegments,2); assert.equal(index.chapters.length,2); assert.equal(index.chapters[0].pages,3)
    assert.equal(index.acceptedChars,Array.from(first+second+third).length)
    assert(!JSON.stringify(index).includes('潮潮')); assert.equal(readManuscriptReader(repo,{runId:'new-agent'}),null)
    const pages = [0,1,2].map(page => readManuscriptReader(repo,{runId:'long',chapterId:'section:c1',page}).page)
    assert.equal(Array.from(pages[0].content).length,6000); assert(pages[0].content.endsWith('🌊'))
    assert.equal(Array.from(pages[1].content).length,6000); assert.equal(pages.map(page=>page.content).join(''),first+second)
    assert.deepEqual(pages[1].sourceSegmentIds,['a','b'])
    assert.equal(readManuscriptReader(repo,{runId:'long',chapterId:'section:c1',page:500}).page.number,2)
    assert.equal(readManuscriptReader(repo,{runId:'long',chapterId:'section:c2'}).page.content,third)
    assert.throws(()=>readManuscriptReader(repo,{runId:'long',chapterId:'section:missing'}),/尚无已收稿/)
    assert.deepEqual(db.prepare('SELECT * FROM manuscript_segments ORDER BY segment_id').all(),before)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_call_attempts').get().n,0)
    // A two-million-character chapter still transfers only a small directory
    // and one requested page, including a direct jump to its final page.
    insert.run('bulk','long','s',6,1,'accepted','prose','文'.repeat(2000000),'a'.repeat(64),2000000,'bulk',1,1)
    const largeIndex = readManuscriptReader(repo,{runId:'long'})
    assert(JSON.stringify(largeIndex).length<2000)
    assert.equal(largeIndex.chapters[2].pages,334)
    const tail = readManuscriptReader(repo,{runId:'long',chapterId:'section:bulk',page:333}).page
    assert.equal(tail.content.length,2000); assert.deepEqual(tail.sourceSegmentIds,['bulk'])
  } finally {
    db.close(); repo.close()
    assert.equal(path.dirname(home),os.tmpdir()); assert(path.basename(home).startsWith('dw-reader-unit-'))
    await fs.rm(home,{recursive:true,force:true})
  }
})

test('empty drafts and legacy sectionless prose remain readable without invented chapter titles or draft admission', () => {
  const repo = {getRun:()=>({run_id:'r',session_id:'s',status:'waiting_user',config_json:'{"runMode":"longwrite","longMode":true}'}), listRunsBySession:()=>[], getManuscriptReaderSegments:()=>[{segment_id:'x',section_id:null,scene_id:null,status:'partial',char_count:10}], getManuscriptReaderSlices:()=>[]}
  const empty = readManuscriptReader(repo,{runId:'r'}); assert.deepEqual(empty.chapters,[]); assert.equal(empty.unacceptedSegments,1)
  repo.getManuscriptReaderSegments=()=>[{segment_id:'x',section_id:null,scene_id:null,status:'accepted',char_count:10}]
  assert.equal(readManuscriptReader(repo,{runId:'r'}).chapters[0].title,'正文')
})

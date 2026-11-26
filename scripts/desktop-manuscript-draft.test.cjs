// QA: paused cold record / historical failure / cancel / exclusive save /
// accepted-only bytes / unchanged run, billing and completion / visible control.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { createHash } = require('node:crypto'), { DatabaseSync } = require('node:sqlite')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')

test('desktop cold paused/old failed manuscripts save accepted drafts through a native-dialog-only IPC; cancel and existing files remain untouched', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-desktop-draft-'))
  const saved = path.join(home, '另存草稿.md'), oldSaved = path.join(home, '旧失败长稿.md'), existing = path.join(home, '已有成稿.md')
  const first = '已收稿第一节。', second = '已收稿第二节。', body = first + '\n\n' + second
  let app, db
  try {
    app = await _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : path.join(root, 'out/main/index.js'), '--user-data-dir=' + home],
      env: { ...process.env, DEEPWRITER_API_KEY: '', NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    const page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    assert.equal(await app.evaluate(({app}) => app.getPath('userData')), home)
    db = new DatabaseSync(path.join(home, 'deepwriter.db')); db.exec('PRAGMA busy_timeout=3000')
    const time = Date.now()
    for (const [runId, status, title] of [['paused-draft-fixture', 'waiting_user', '中断后的长稿'], ['failed-draft-fixture', 'failed', '旧版失败长稿']]) {
      const sessionId = runId + '-session'
      db.prepare('INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run(sessionId,title,time,time)
      db.prepare('INSERT INTO runs(run_id,session_id,status,phase,started_at,updated_at,config_json,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?)').run(runId,sessionId,status,status==='failed'?'failed':'paused',time,time,
        JSON.stringify({runMode:'longwrite',longMode:true,grillMe:{writingForm:'expository'}}), status==='failed'?'model_error':'longwrite_provider_interrupted', '连接中断，已写部分保留。')
      for (const [index, content, state] of [[0,first,'accepted'],[1,second,'accepted'],[2,'尚未接纳的临时片段','partial']]) {
        db.prepare('INSERT INTO manuscript_segments(segment_id,run_id,session_id,chunk_index,revision,status,kind,content,content_hash,char_count,section_id,created_at,updated_at,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(runId+'-'+index,runId,sessionId,index,1,state,'prose',content,createHash('sha256').update(content).digest('hex'),Array.from(content).length,'s'+index,time,time,state==='accepted'?time:null)
      }
    }
    await fs.writeFile(existing, '已有成稿，不可覆盖。')
    await app.evaluate(({dialog}) => {
      globalThis.__draftSaveFixture = { mode:'cancel', path:'', dialogs:[] }
      dialog.showSaveDialog = async (_owner, options) => {
        const fixture = globalThis.__draftSaveFixture; fixture.dialogs.push(options)
        return fixture.mode === 'cancel' ? {canceled:true} : {canceled:false,filePath:fixture.path}
      }
    })
    await page.reload(); await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    await page.locator('.recover-item').filter({ hasText:'paused-d' }).getByRole('button',{name:'查看',exact:true}).click()
    const control = page.getByTestId('manuscript-draft-control'), action = page.getByRole('button',{name:'另存草稿',exact:true})
    await expect(control).toContainText('已收稿 14 字'); await expect(action).toBeVisible()
    const before = db.prepare('SELECT run_id,status,config_json FROM runs ORDER BY run_id').all()
    await action.click(); await expect(action).toBeEnabled()
    await assert.rejects(fs.stat(saved), {code:'ENOENT'})
    await app.evaluate((_electron, file) => { globalThis.__draftSaveFixture.mode='save'; globalThis.__draftSaveFixture.path=file }, existing)
    await action.click(); await expect(page.getByText(/该文件已存在，未覆盖/)).toBeVisible()
    assert.equal(await fs.readFile(existing,'utf8'), '已有成稿，不可覆盖。')
    await app.evaluate((_electron, file) => { globalThis.__draftSaveFixture.path=file }, saved)
    await action.click(); await expect(page.getByText(/草稿已另存/)).toBeVisible()
    assert.equal(await fs.readFile(saved,'utf8'), body)
    if (process.env.DW_DRAFT_SCREENSHOT) await page.screenshot({ path:process.env.DW_DRAFT_SCREENSHOT, animations:'disabled',scale:'css' })
    await page.getByRole('button',{name:'关闭任务详情',exact:true}).click()
    await page.getByRole('button',{name:'任务中心',exact:true}).click()
    await page.getByRole('button',{name:/旧版失败长稿.*查看详情/}).click()
    await expect(action).toBeVisible(); await expect(control).toContainText('已收稿 14 字')
    await app.evaluate((_electron, file) => { globalThis.__draftSaveFixture.path=file }, oldSaved)
    await action.click(); await expect(action).toBeEnabled()
    assert.equal(await fs.readFile(oldSaved,'utf8'), body)
    assert.deepEqual(db.prepare('SELECT run_id,status,config_json FROM runs ORDER BY run_id').all(), before)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_call_attempts').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0)
    const dialogs = await app.evaluate(() => globalThis.__draftSaveFixture.dialogs)
    assert.equal(dialogs.length,4); assert(dialogs.every(options => options.title==='另存已收稿部分' && options.defaultPath.includes('长文草稿-') && options.filters[0].extensions[0]==='md'))
  } finally {
    db?.close(); if (app) await app.close().catch(() => {})
    assert.equal(path.dirname(home),os.tmpdir()); assert(path.basename(home).startsWith('dw-desktop-draft-'))
    await fs.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100})
  }
})

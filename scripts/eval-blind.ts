#!/usr/bin/env node
/**
 * eval-blind.ts — DeepWriter R19 盲评流水线（subagent B: Blind Evaluation）
 *
 * 无需 API key 即可测试结构正确性的盲评工具。职责：
 *   package   — 匿名化 + 随机化 + 生成评审包（评审文件与揭盲 mapping 物理分离）
 *   detect    — 结构检测（不平衡/缺评/重复评/越界/泄漏/mapping 不对应）
 *   aggregate — 揭盲聚合并输出每 variant 原始评分 + 成对偏好统计
 *   reveal    — 打印 mapping（揭盲，仅打印不写文件）
 *   selftest  — 自测：synthetic 样本全链跑通，报告数字
 *
 * 铁律（package 子命令强制）：评审文件正文不得出现 variantId / model / provider /
 * endpoint / sampleId / 任何可泄露分组身份的信息，只能出现编号与 taskId。
 *
 * 依赖：仅 Node 内置模块（fs / path / crypto / os），不依赖 src 或任何第三方包。
 * 构建：npx esbuild scripts/eval-blind.ts --bundle --format=esm --platform=node --outfile=out/eval-blind.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

/* ============================================================================
 * 常量与类型
 * ========================================================================== */

const SCHEMA_VERSION = 1;
const ALGORITHM = 'mulberry32';

/** 7 个评分维度：key -> 中文名（key 即 ratings 文件使用的稳定标识） */
const DIMENSIONS: Array<{ key: string; name: string }> = [
  { key: 'narrative-coherence', name: '叙事连贯' },
  { key: 'character-voice', name: '人物声音' },
  { key: 'setting-adherence', name: '设定遵守' },
  { key: 'naturalness', name: '语言自然度' },
  { key: 'repetition', name: '重复度（低分=重复多）' },
  { key: 'structure-completeness', name: '结构完成度' },
  { key: 'adoptability', name: '可直接采用比例' },
];

const DIM_KEYS = DIMENSIONS.map((d) => d.key);

/** 泄漏检测词表（评审文件正文中不得出现，可扩展） */
const LEAK_TERMS: string[] = [
  // variantId（输入格式定义的三种）
  'generic_baseline',
  'deepwriter_current_product',
  'deepwriter_hardened_candidate',
  // 字段名本身
  'variantid',
  'variantid',
  'variant_id',
  'variant_identifier',
  'sampleid',
  'sample_id',
  'prompthash',
  'prompt_hash',
  'variantcontracthash',
  'variant_contract_hash',
  'promptHash',
  'variantContractHash',
  // 后端/端点相关信息
  'endpoint',
  'provider',
  'api.deepseek',
  'api_deepseek',
  'deepseek.com',
  'opencode',
  'baseurl',
  'base_url',
  'api_key',
  'apikey',
  'bearer ',
  'authorization',
  // 常见模型名（大小写不敏感扫描，见下方额外列表）
  'deepseek-v4',
  'deepseek-v3',
  'deepseek-v2',
  'deepseek-v1',
  'deepseek-coder',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-r1',
  'gpt-4',
  'gpt-3',
  'claude-',
  'anthropic',
  'openai',
  'gemini',
  'llama',
  'qwen',
  'mistral',
  'moonshot',
  'kimi',
];

/** 基础（大小写不敏感）模型名泄露词，与 LEAK_TERMS 合并扫描 */
const LEAK_TERMS_CI: string[] = [
  'deepseek',
  'deepseek-v4',
  'deepseek-v3',
  'gpt-4',
  'gpt-4o',
  'gpt-3.5',
  'claude',
  'openai',
  'anthropic',
  'gemini',
  'llama',
  'qwen',
  'mistral',
  'moonshot',
];

interface SampleRecord {
  sampleId: string;
  taskId: string;
  variantId: string;
  repeat: number;
  mode: string;
  synthetic: boolean;
  model?: string;
  promptHash?: string;
  variantContractHash?: string;
  rounds?: number;
  content: string;
  usage?: unknown;
  metrics?: unknown;
}

interface SamplesFile {
  schemaVersion: number;
  header: {
    mode: string;
    synthetic: boolean;
    model?: string;
    seed?: string;
    tasks: string[];
    variants: string[];
    [k: string]: unknown;
  };
  samples: SampleRecord[];
}

interface CodeMapping {
  code: string;
  sampleId: string;
  taskId: string;
  variantId: string;
  repeat: number;
  promptHash?: string;
  variantContractHash?: string;
}

interface MappingFile {
  schemaVersion: number;
  seed: string;
  algorithm: string;
  generatedAt: string;
  codes: CodeMapping[];
}

interface PackageManifest {
  schemaVersion: number;
  seed: string;
  algorithm: string;
  generatedAt: string;
  sampleCount: number;
  perTaskSampleCount: Record<string, number>;
  samplesSha256: string;
  pairwise: boolean;
  synthetic: boolean;
}

interface RatingsDoc {
  taskId?: string;
  ratings: Array<{
    code: string;
    scores: Record<string, number>;
  }>;
  [k: string]: unknown;
}

interface PairwiseDoc {
  entries: Array<{
    taskId: string;
    a: string;
    b: string;
    winner: 'A' | 'B' | 'tie' | 'cannot-judge';
  }>;
  [k: string]: unknown;
}

/* ============================================================================
 * 工具函数
 * ========================================================================== */

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** mulberry32 确定性 PRNG（可复算：同 seed -> 同序列） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串 seed 稳定映射为 uint32，再派生 PRNG */
function seedToUint32(seed: string): number {
  const h = crypto.createHash('sha256').update(seed, 'utf8').digest();
  return h.readUInt32LE(0);
}

function rngFromSeed(seed: string): () => number {
  return mulberry32(seedToUint32(seed));
}

/** Fisher-Yates 就地洗牌，使用给定 rng */
function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function err(msg: string, code = 1): never {
  process.stderr.write(`[eval-blind] ERROR: ${msg}\n`);
  process.exit(code);
}

function readJson<T>(p: string): T {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) err(`文件不存在: ${abs}`);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    err(`读取失败 ${abs}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    err(`JSON 解析失败 ${abs}: ${(e as Error).message}`);
  }
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

/* ============================================================================
 * CLI 解析
 * ========================================================================== */

interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] ?? '';
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      flags[a] = true;
    }
  }
  return { cmd, flags };
}

function need(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (typeof v !== 'string' || v === '') err(`缺少参数 --${key}`);
  return v;
}

/* ============================================================================
 * package 子命令
 * ========================================================================== */

function pathExists(p: string): boolean {
  return fs.existsSync(p);
}

function listDir(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => {
    try {
      return fs.statSync(path.join(p, f)).isFile();
    } catch {
      return false;
    }
  });
}

/** 列出某目录下的子目录名 */
function listSubdirs(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => {
    try {
      return fs.statSync(path.join(p, f)).isDirectory();
    } catch {
      return false;
    }
  });
}

function readSamplesFile(p: string): SamplesFile {
  const j = readJson<SamplesFile>(p);
  if (!j || !Array.isArray(j.samples)) err(`samples.json 缺少 samples 数组: ${p}`);
  return j;
}

function groupSamplesByTask(samples: SampleRecord[]): Map<string, SampleRecord[]> {
  const m = new Map<string, SampleRecord[]>();
  for (const s of samples) {
    const arr = m.get(s.taskId) ?? [];
    arr.push(s);
    m.set(s.taskId, arr);
  }
  return m;
}

/** 生成编号：按任务分组，组内打乱后按序分配 T<NN>-A/B/C... */
function assignCodes(
  groups: Map<string, SampleRecord[]>,
  seed: string,
): { codes: CodeMapping[]; codeBySample: Map<string, string> } {
  const rng = rngFromSeed(seed);
  const taskIds = Array.from(groups.keys()).sort();
  const codes: CodeMapping[] = [];
  const codeBySample = new Map<string, string>();
  // 任务编号按字母序稳定分配（不依赖 rng，保证 taskId 排序确定性）
  let tIdx = 0;
  for (const taskId of taskIds) {
    const recs = shuffleInPlace(groups.get(taskId)!, rng);
    recs.forEach((rec, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C, ...
      const code = `T${String(tIdx + 1).padStart(2, '0')}-${letter}`;
      codes.push({
        code,
        sampleId: rec.sampleId,
        taskId: rec.taskId,
        variantId: rec.variantId,
        repeat: rec.repeat,
        promptHash: rec.promptHash,
        variantContractHash: rec.variantContractHash,
      });
      codeBySample.set(rec.sampleId, code);
    });
    tIdx++;
  }
  return { codes, codeBySample };
}

/** 生成单个评审文件内容（严格不含任何泄露信息） */
function buildReviewFile(code: string, taskTitle: string, content: string, pairwise: boolean, codesAll: string[]): string {
  const dimTable = DIMENSIONS.map((d, i) => `${i + 1}. ${d.name}（${d.key}）：[ ] 分`).join('\n');
  const pairwiseSection = pairwise
    ? `\n\n## 成对偏好（pairwise）\n对下列每一对，标注 A / B / tie（平局）/ cannot-judge（无法判断）三选一：\n\n` +
      pairsOf(codesAll)
        .map(([a, b]) => `- ${a} vs ${b}：[ ] A  [ ] B  [ ] tie  [ ] cannot-judge`)
        .join('\n')
    : '';

  return `# 评审文件 ${code}

> 盲评材料，请勿修改编号。评分与本表内容对应，不要参考任何外部分组信息。

## 评分说明
- 共 ${DIMENSIONS.length} 个维度，每个维度 1–5 整数分（1=差，5=优）。
- \`repetition\` 维度：低分表示重复/啰嗦多，高分表示简洁。
- 完成后按 ratings 文件格式导出（见 README / help）。

## 正文

${content}

## 评分表

${dimTable}${pairwiseSection}
`;
}

/** 任务内所有编号的两两组合（i<j，无重复、无自对） */
function pairsOf(codes: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      out.push([codes[i], codes[j]]);
    }
  }
  return out;
}

/** 按 taskId 分组生成任务内所有两两组合（不同任务样本不比） */
function pairsPerTask(codes: CodeMapping[]): Array<{ taskId: string; a: string; b: string }> {
  const byTask = new Map<string, string[]>();
  for (const c of codes) {
    const arr = byTask.get(c.taskId) ?? [];
    arr.push(c.code);
    byTask.set(c.taskId, arr);
  }
  const out: Array<{ taskId: string; a: string; b: string }> = [];
  for (const [taskId, taskCodes] of byTask) {
    for (const [a, b] of pairsOf(taskCodes)) {
      out.push({ taskId, a, b });
    }
  }
  return out;
}

/** 任务标题：用 taskId 生成一个不泄露的人类可读标题 */
function taskTitle(taskId: string): string {
  return `任务：${taskId}`;
}

function runPackage(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const samplesPath = need(flags, 'samples');
  const outDir = need(flags, 'out');
  const seed = typeof flags.seed === 'string' ? flags.seed : `seed-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pairwise = flags.pairwise === true || flags.pairwise === 'true';

  const samples = readSamplesFile(samplesPath);
  if (!samples.samples.length) err(`samples 为空: ${samplesPath}`);
  const samplesAbs = path.resolve(samplesPath);
  const samplesBuf = fs.readFileSync(samplesAbs);
  const samplesSha = sha256Hex(samplesBuf);

  const groups = groupSamplesByTask(samples.samples);
  const { codes } = assignCodes(groups, seed);

  const reviewsDir = path.join(outDir, 'reviews');
  const usedCodes = new Set<string>();
  const perTask = new Map<string, string[]>();

  for (const c of codes) {
    usedCodes.add(c.code);
    const arr = perTask.get(c.taskId) ?? [];
    arr.push(c.code);
    perTask.set(c.taskId, arr);
  }

  // 写出评审文件
  const sampleByCode = new Map(codes.map((c) => [c.code, c]));
  const sampleBySampleId = new Map(samples.samples.map((s) => [s.sampleId, s]));

  for (const c of codes) {
    const sample = sampleBySampleId.get(c.sampleId);
    if (!sample) err(`mapping 引用了不存在的 sampleId: ${c.sampleId}`);
    const taskCodes = perTask.get(c.taskId)!;
    const file = buildReviewFile(c.code, taskTitle(c.taskId), sample.content, pairwise, taskCodes);
    const dir = path.join(reviewsDir, c.taskId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, `${c.code}.md`), file, 'utf8');
  }

  // 写出 mapping.json（物理分离，评审者只在评审包里看不到它）
  const mapping: MappingFile = {
    schemaVersion: SCHEMA_VERSION,
    seed,
    algorithm: ALGORITHM,
    generatedAt: new Date().toISOString(),
    codes: codes.map((c) => ({ ...c })),
  };
  writeJson(path.join(outDir, 'mapping.json'), mapping);

  // 写出 package-manifest.json
  const perTaskCount: Record<string, number> = {};
  for (const [taskId, arr] of perTask) perTaskCount[taskId] = arr.length;
  const manifest: PackageManifest = {
    schemaVersion: SCHEMA_VERSION,
    seed,
    algorithm: ALGORITHM,
    generatedAt: mapping.generatedAt,
    sampleCount: samples.samples.length,
    perTaskSampleCount: perTaskCount,
    samplesSha256: samplesSha,
    pairwise,
    synthetic: samples.header?.synthetic ?? false,
  };
  writeJson(path.join(outDir, 'package-manifest.json'), manifest);

  process.stdout.write(`[eval-blind] package 完成\n`);
  process.stdout.write(`  样本数: ${samples.samples.length}\n`);
  process.stdout.write(`  任务数: ${perTask.size}\n`);
  process.stdout.write(`  编号数: ${codes.length}\n`);
  process.stdout.write(`  pairwise: ${pairwise}\n`);
  process.stdout.write(`  seed: ${seed}\n`);
  process.stdout.write(`  评审目录: ${reviewsDir}\n`);
  process.stdout.write(`  mapping: ${path.join(outDir, 'mapping.json')}\n`);
  process.stdout.write(`  各任务编号: ${Array.from(perTask.entries()).map(([t, cs]) => `${t}=${cs.join(',')}`).join(' | ')}\n`);
}

/* ============================================================================
 * 泄漏检测
 * ========================================================================== */

interface LeakHit {
  term: string;
  kind: 'exact' | 'ci';
}

/** 扫描一段文本，返回泄漏命中列表（小写后匹配，兼顾大小写不敏感） */
function scanLeaks(text: string): { hits: LeakHit[]; ciHits: LeakHit[] } {
  const lower = text.toLowerCase();
  const hits: LeakHit[] = [];
  const ciHits: LeakHit[] = [];
  for (const t of LEAK_TERMS) {
    // exact 匹配（已含小写词），先做 case-sensitive 命中
    if (text.includes(t)) {
      hits.push({ term: t, kind: 'exact' });
    } else if (lower.includes(t.toLowerCase())) {
      // case-insensitive 命中（如 DeepSeek vs deepseek）
      hits.push({ term: t, kind: 'exact' });
    }
  }
  for (const t of LEAK_TERMS_CI) {
    if (lower.includes(t.toLowerCase())) {
      ciHits.push({ term: t, kind: 'ci' });
    }
  }
  return { hits, ciHits };
}

/** 合并去重后的泄漏命中 */
function uniqueLeakTerms(hits: LeakHit[], ciHits: LeakHit[]): string[] {
  const m = new Map<string, string>();
  for (const h of hits) m.set(h.term.toLowerCase(), h.term);
  for (const h of ciHits) m.set(h.term.toLowerCase(), h.term);
  return Array.from(m.values()).sort();
}

/* ============================================================================
 * detect 子命令
 * ========================================================================== */

interface DetectIssue {
  type: string;
  detail: string;
  taskId?: string;
  code?: string;
  severity: 'error' | 'warning';
}

interface DetectReport {
  ok: boolean;
  packageDir: string;
  checkedAt: string;
  synthetic: boolean;
  issueCount: number;
  issues: DetectIssue[];
  checks: Record<string, { passed: boolean; detail: string }>;
}

function runDetect(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const pkg = path.resolve(need(flags, 'pkg'));
  const ratingsPath = typeof flags.ratings === 'string' ? path.resolve(flags.ratings as string) : null;
  const pairwisePath = typeof flags['pairwise-file'] === 'string' ? path.resolve(flags['pairwise-file'] as string) : null;

  const issues: DetectIssue[] = [];
  const checks: DetectReport['checks'] = {};

  const mappingPath = path.join(pkg, 'mapping.json');
  const manifestPath = path.join(pkg, 'package-manifest.json');
  const reviewsDir = path.join(pkg, 'reviews');

  if (!fs.existsSync(mappingPath)) {
    issues.push({ type: 'missing-mapping', detail: 'mapping.json 不存在', severity: 'error' });
  }
  if (!fs.existsSync(manifestPath)) {
    issues.push({ type: 'missing-manifest', detail: 'package-manifest.json 不存在', severity: 'error' });
  }

  let mapping: MappingFile | null = null;
  if (fs.existsSync(mappingPath)) {
    mapping = readJson<MappingFile>(mappingPath);
  }
  let manifest: PackageManifest | null = null;
  if (fs.existsSync(manifestPath)) {
    manifest = readJson<PackageManifest>(manifestPath);
  }

  const synthetic = manifest?.synthetic ?? false;

  // ---- 1. 每任务样本数不平衡（变体数量不一致） ----
  let balanceOk = true;
  if (mapping) {
    const perTaskVariant = new Map<string, Set<string>>();
    for (const c of mapping.codes) {
      const s = perTaskVariant.get(c.taskId) ?? new Set<string>();
      s.add(c.variantId);
      perTaskVariant.set(c.taskId, s);
    }
    // variant 数量在任务间是否一致
    const counts = new Set<number>();
    for (const [, v] of perTaskVariant) counts.add(v.size);
    if (counts.size > 1) {
      balanceOk = false;
      const detail = Array.from(perTaskVariant.entries())
        .map(([t, v]) => `${t}=${v.size} variants`)
        .join(', ');
      issues.push({ type: 'unbalanced-variants', detail: `任务间变体数量不一致: ${detail}`, severity: 'error' });
    }
  }
  checks['balance'] = { passed: balanceOk, detail: '各任务变体数量一致' };

  // ---- 2. mapping 与评审包不对应 ----
  let mappingConsistencyOk = true;
  if (mapping) {
    const mappedCodes = new Set(mapping.codes.map((c) => c.code));
    const fileCodes = new Set<string>();
    // 遍历 reviews/<taskId>/<code>.md
    for (const taskDir of listSubdirs(reviewsDir)) {
      const full = path.join(reviewsDir, taskDir);
      for (const f of listDir(full)) {
        if (!f.endsWith('.md')) continue;
        fileCodes.add(f.replace(/\.md$/, ''));
      }
    }
    for (const c of mappedCodes) {
      if (!fileCodes.has(c)) {
        mappingConsistencyOk = false;
        issues.push({ type: 'mapping-no-file', detail: `mapping 中的 code ${c} 在评审目录无对应文件`, code: c, severity: 'error' });
      }
    }
    for (const c of fileCodes) {
      if (!mappedCodes.has(c)) {
        mappingConsistencyOk = false;
        issues.push({ type: 'file-no-mapping', detail: `评审目录存在 code ${c} 但 mapping 中无此条目`, code: c, severity: 'error' });
      }
    }
  }
  checks['mapping-consistency'] = {
    passed: mappingConsistencyOk,
    detail: mappingConsistencyOk ? 'mapping 与评审包一一对应' : 'mapping 与评审包存在不一致',
  };

  // ---- 3. 样本泄漏扫描（评审文件正文） ----
  let leakOk = true;
  const leakFoundFor: string[] = [];
  if (fs.existsSync(reviewsDir)) {
    for (const taskDir of listSubdirs(reviewsDir)) {
      const full = path.join(reviewsDir, taskDir);
      for (const f of listDir(full)) {
        if (!f.endsWith('.md')) continue;
        const text = readText(path.join(full, f));
        const { hits, ciHits } = scanLeaks(text);
        const terms = uniqueLeakTerms(hits, ciHits);
        if (terms.length > 0) {
          leakOk = false;
          const termsStr = terms.slice(0, 10).join(', ');
          leakFoundFor.push(`${f}: ${termsStr}${terms.length > 10 ? ` (+${terms.length - 10})` : ''}`);
        }
      }
    }
  }
  if (!leakOk) {
    issues.push({ type: 'sample-leak', detail: `评审文件泄漏敏感词: ${leakFoundFor.join('; ')}`, severity: 'error' });
  }
  checks['leak'] = { passed: leakOk, detail: leakOk ? '无样本泄漏' : '存在泄漏' };

  // ---- 4. ratings 校验（若提供） ----
  let ratings: RatingsDoc | null = null;
  if (ratingsPath) {
    if (!fs.existsSync(ratingsPath)) {
      issues.push({ type: 'missing-ratings-file', detail: `ratings 文件不存在: ${ratingsPath}`, severity: 'error' });
      checks['ratings'] = { passed: false, detail: 'ratings 文件不存在' };
    } else {
      ratings = readJson<RatingsDoc>(ratingsPath);
      const list = ratings?.ratings ?? [];
      const seen = new Set<string>();
      let ratingsOk = true;
      for (const r of list) {
        if (!r.code || typeof r.code !== 'string') {
          ratingsOk = false;
          issues.push({ type: 'ratings-no-code', detail: 'ratings 条目缺 code', severity: 'error' });
          continue;
        }
        // 重复评
        if (seen.has(r.code)) {
          ratingsOk = false;
          issues.push({ type: 'ratings-duplicate', detail: `code ${r.code} 重复评`, code: r.code, severity: 'error' });
        }
        seen.add(r.code);
        // 越界分数
        if (r.scores) {
          for (const dk of DIM_KEYS) {
            const v = r.scores[dk];
            if (v === undefined) continue;
            if (!Number.isInteger(v) || v < 1 || v > 5) {
              ratingsOk = false;
              issues.push({ type: 'ratings-out-of-range', detail: `code ${r.code} 维度 ${dk} 分数 ${v} 非 1-5 整数`, code: r.code, severity: 'error' });
            }
          }
        }
      }
      // 缺评：mapping 中的 code 无评分
      if (mapping) {
        for (const c of mapping.codes) {
          if (!seen.has(c.code)) {
            ratingsOk = false;
            issues.push({ type: 'ratings-missing', detail: `code ${c.code} 缺评分`, code: c.code, severity: 'error' });
          }
        }
      }
      checks['ratings'] = {
        passed: ratingsOk,
        detail: ratingsOk ? `ratings 校验通过（${list.length} 条）` : 'ratings 存在缺评/重复评/越界',
      };
    }
  } else {
    checks['ratings'] = { passed: true, detail: '未提供 ratings（跳过评分校验）' };
  }

  // ---- 5. pairwise 校验（若提供） ----
  if (pairwisePath) {
    if (!fs.existsSync(pairwisePath)) {
      issues.push({ type: 'missing-pairwise-file', detail: `pairwise 文件不存在: ${pairwisePath}`, severity: 'error' });
      checks['pairwise'] = { passed: false, detail: 'pairwise 文件不存在' };
    } else {
      const pw = readJson<PairwiseDoc>(pairwisePath);
      const entries = pw?.entries ?? [];
      const seenP = new Set<string>();
      let pwOk = true;
      for (const e of entries) {
        const key = `${e.a}|${e.b}`;
        if (seenP.has(key)) {
          pwOk = false;
          issues.push({ type: 'pairwise-duplicate', detail: `pairwise 组合 ${e.a}/${e.b} 重复`, severity: 'error' });
        }
        seenP.add(key);
        if (!['A', 'B', 'tie', 'cannot-judge'].includes(e.winner)) {
          pwOk = false;
          issues.push({ type: 'pairwise-bad-winner', detail: `pairwise ${e.a}/${e.b} 取值非法: ${e.winner}`, severity: 'error' });
        }
        // 跨任务对比检测：a/b 必须属于同一任务
        if (mapping) {
          const codeTask = new Map(mapping.codes.map((c) => [c.code, c.taskId]));
          const ta = codeTask.get(e.a);
          const tb = codeTask.get(e.b);
          if (ta && tb && ta !== tb) {
            pwOk = false;
            issues.push({ type: 'pairwise-cross-task', detail: `pairwise ${e.a}(${ta}) vs ${e.b}(${tb}) 跨任务对比，不可比`, severity: 'error' });
          }
          // taskId 字段若存在，须与 mapping 一致
          if (e.taskId && ta && e.taskId !== ta) {
            pwOk = false;
            issues.push({ type: 'pairwise-bad-task', detail: `pairwise ${e.a} 的 taskId=${e.taskId} 与 mapping(${ta}) 不一致`, severity: 'error' });
          }
        }
      }
      checks['pairwise'] = { passed: pwOk, detail: pwOk ? `pairwise 校验通过（${entries.length} 条）` : 'pairwise 校验失败' };
    }
  } else {
    checks['pairwise'] = { passed: true, detail: '未提供 pairwise（跳过校验）' };
  }

  const ok = issues.every((i) => i.severity !== 'error');
  const report: DetectReport = {
    ok,
    packageDir: pkg,
    checkedAt: new Date().toISOString(),
    synthetic,
    issueCount: issues.length,
    issues,
    checks,
  };

  // 异常（error 级）写入 stderr，报告写 stdout JSON
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!ok) {
    process.stderr.write(`[eval-blind] detect: ${issues.filter((i) => i.severity === 'error').length} 个错误级问题\n`);
    process.exit(1);
  }
  process.stdout.write(`[eval-blind] detect: 通过（${issues.filter((i) => i.severity === 'warning').length} 个 warning）\n`);
}

/* ============================================================================
 * aggregate 子命令
 * ========================================================================== */

function runAggregate(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const pkg = path.resolve(need(flags, 'pkg'));
  const ratingsPath = typeof flags.ratings === 'string' ? path.resolve(flags.ratings as string) : null;
  const pairwisePath = typeof flags['pairwise-file'] === 'string' ? path.resolve(flags['pairwise-file'] as string) : null;

  if (!ratingsPath || !fs.existsSync(ratingsPath)) {
    err(`aggregate 需 --ratings <file> 且文件存在（当前: ${ratingsPath ?? '(未提供)'}）`);
  }

  // 前置：必须跑 detect 通过
  const mappingPath = path.join(pkg, 'mapping.json');
  if (!fs.existsSync(mappingPath)) err(`缺少 mapping.json: ${mappingPath}`);
  const mapping = readJson<MappingFile>(mappingPath);

  // 复用 detect 逻辑做结构校验（但不退出，先收集）
  const detectFlags: Record<string, string | boolean> = {
    pkg,
    ratings: ratingsPath,
  };
  if (pairwisePath) detectFlags['pairwise-file'] = pairwisePath;

  // 直接内联一个轻量校验：检查 ratings 完整性与越界
  const ratings = readJson<RatingsDoc>(ratingsPath);
  const list = ratings?.ratings ?? [];
  const scoresByCode = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  for (const r of list) {
    if (!r.code) err(`ratings 存在缺 code 的条目`);
    if (seen.has(r.code)) err(`ratings 存在重复评: ${r.code}`);
    seen.add(r.code);
    scoresByCode.set(r.code, r.scores ?? {});
    for (const dk of DIM_KEYS) {
      const v = r.scores?.[dk];
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 5)) {
        err(`ratings 越界: ${r.code}.${dk}=${v}`);
      }
    }
  }
  // 缺评检查
  for (const c of mapping.codes) {
    if (!seen.has(c.code)) err(`ratings 缺评: ${c.code}`);
  }

  // 揭盲：code -> variantId
  const codeToVariant = new Map(mapping.codes.map((c) => [c.code, c.variantId]));
  const codeToTask = new Map(mapping.codes.map((c) => [c.code, c.taskId]));

  // 按 variant 聚合每维度原始分
  const agg: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    packageDir: pkg,
    aggregateAt: new Date().toISOString(),
    seed: mapping.seed,
    variants: {},
  };
  const variantsAgg = agg.variants as Record<string, unknown>;

  const variantCodes = new Map<string, string[]>();
  for (const c of mapping.codes) {
    const arr = variantCodes.get(c.variantId) ?? [];
    arr.push(c.code);
    variantCodes.set(c.variantId, arr);
  }

  const sortedVariants = Array.from(variantCodes.keys()).sort();
  for (const vid of sortedVariants) {
    const codes = variantCodes.get(vid)!;
    const dims: Record<string, { raw: number[]; mean: number; p50: number }> = {};
    for (const dk of DIM_KEYS) {
      const raw = codes.map((c) => scoresByCode.get(c)?.[dk] ?? 0).filter((v) => v > 0);
      if (raw.length === 0) {
        dims[dk] = { raw: [], mean: 0, p50: 0 };
        continue;
      }
      const sorted = raw.slice().sort((a, b) => a - b);
      const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
      const p50 = median(sorted);
      dims[dk] = { raw, mean: round2(mean), p50 };
    }
    variantsAgg[vid] = {
      n: codes.length,
      codes,
      dimensions: dims,
    };
  }

  // pairwise 统计：按 taskId 分组（不同任务样本不可比）
  // 结构：{ [taskId]: { "variantA__VS__variantB": {win,loss,tie,cannotJudge} } }
  let pairwiseStats: Record<string, unknown> | null = null;
  if (pairwisePath && fs.existsSync(pairwisePath)) {
    const pw = readJson<PairwiseDoc>(pairwisePath);
    const entries = pw?.entries ?? [];
    const mk = () => ({ win: 0, loss: 0, tie: 0, cannotJudge: 0 });
    const byTaskVariant = new Map<string, Map<string, { win: number; loss: number; tie: number; cannotJudge: number }>>();
    for (const e of entries) {
      const va = codeToVariant.get(e.a);
      const vb = codeToVariant.get(e.b);
      if (!va || !vb) continue;
      // 以条目自身 taskId 分组；缺 taskId 时从 mapping 反查 a 的任务（向后兼容）
      const tid = e.taskId ?? codeToTask.get(e.a) ?? '(unknown-task)';
      if (!byTaskVariant.has(tid)) byTaskVariant.set(tid, new Map());
      const inner = byTaskVariant.get(tid)!;
      const key = `${va}__VS__${vb}`;
      const cell = inner.get(key) ?? mk();
      if (e.winner === 'A') cell.win++;
      else if (e.winner === 'B') cell.loss++;
      else if (e.winner === 'tie') cell.tie++;
      else cell.cannotJudge++;
      inner.set(key, cell);
    }
    const pwOut: Record<string, unknown> = {};
    for (const [tid, inner] of byTaskVariant) {
      const o: Record<string, unknown> = {};
      for (const [key, cell] of inner) o[key] = cell;
      pwOut[tid] = o;
    }
    pairwiseStats = pwOut;
  }

  if (pairwiseStats) agg.pairwise = pairwiseStats;

  writeJson(path.join(pkg, 'aggregate.json'), agg);

  // stdout 表格
  printAggregateTable(agg);

  process.stdout.write(`[eval-blind] aggregate 完成 -> ${path.join(pkg, 'aggregate.json')}\n`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const m = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[m];
  return round2((sorted[m - 1] + sorted[m]) / 2);
}

function printAggregateTable(agg: any): void {
  const variants = agg.variants as Record<string, any>;
  const vids = Object.keys(variants).sort();
  const header = ['维度', ...vids].join('\t');
  const rows: string[] = [header];
  for (const dk of DIM_KEYS) {
    const cells = vids.map((vid) => {
      const d = variants[vid].dimensions[dk];
      if (!d || d.raw.length === 0) return '-';
      return `mean=${d.mean} p50=${d.p50} [${d.raw.join(',')}]`;
    });
    rows.push([dk, ...cells].join('\t'));
  }
  process.stdout.write('=== 每 variant 每维度原始分 / mean / p50 ===\n');
  process.stdout.write(rows.join('\n') + '\n');

  if (agg.pairwise) {
    process.stdout.write('=== pairwise 胜/平/负（按任务分组）===\n');
    for (const [tid, inner] of Object.entries(agg.pairwise)) {
      process.stdout.write(`--- 任务 ${tid} ---\n`);
      for (const [key, cell] of Object.entries(inner as Record<string, unknown>)) {
        process.stdout.write(`${key}\twin=${(cell as any).win} loss=${(cell as any).loss} tie=${(cell as any).tie} cannot-judge=${(cell as any).cannotJudge}\n`);
      }
    }
  }
}

/* ============================================================================
 * reveal 子命令
 * ========================================================================== */

function runReveal(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const pkg = path.resolve(need(flags, 'pkg'));
  const mappingPath = path.join(pkg, 'mapping.json');
  if (!fs.existsSync(mappingPath)) err(`mapping.json 不存在: ${mappingPath}`);
  const mapping = readJson<MappingFile>(mappingPath);
  process.stdout.write(JSON.stringify(mapping, null, 2) + '\n');
}

/* ============================================================================
 * selftest 子命令
 * ========================================================================== */

function genTaskContent(taskId: string, _variantId: string, repeat: number): string {
  // 正文明显带 synthetic 标记；注意：不得嵌入 variantId 等可泄露分组身份的信息，
  // 否则 detect 的泄漏检测会正常 FAIL（这正是泄漏检测要抓的）。
  return `[SYNTHETIC-盲评自测] 这是任务 ${taskId}（第 ${repeat} 次重复）生成的样例正文。
本段落用于验证评测流程的匿名化与揭盲，不包含任何真实模型输出。
第二段文字用于模拟长文档结构：背景设定、人物对话、情节推进。
第三段用于占位，保证 content 非空且含可扫描的 normal 文本。
在此不应出现任何可泄露分组身份的词汇（该检查由 detect 负责）。`;
}

function runSelftest(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const outDir = path.resolve(need(flags, 'out'));
  ensureDir(outDir);

  const variants = ['generic_baseline', 'deepwriter_current_product', 'deepwriter_hardened_candidate'];
  const tasks = ['longform-multichapter', 'shortform-scene'];
  const model = 'deepseek-v4-flash';

  const samples: SampleRecord[] = [];
  let n = 0;
  for (const taskId of tasks) {
    for (const variantId of variants) {
      for (const repeat of [1, 2]) {
        n++;
        const sampleId = `s-${taskId}-${variantId}-r${repeat}`;
        samples.push({
          sampleId,
          taskId,
          variantId,
          repeat,
          mode: 'mock',
          synthetic: true,
          model,
          promptHash: sha256Hex(`${taskId}:${variantId}:prompt`),
          variantContractHash: sha256Hex(`${taskId}:${variantId}:contract`),
          rounds: 3,
          content: genTaskContent(taskId, variantId, repeat),
          usage: { promptTokens: 100, completionTokens: 800 },
          metrics: {},
        });
      }
    }
  }

  const samplesFile: SamplesFile = {
    schemaVersion: SCHEMA_VERSION,
    header: {
      mode: 'mock',
      synthetic: true,
      model,
      seed: 'selftest-seed',
      tasks,
      variants,
    },
    samples,
  };
  const samplesPath = path.join(outDir, 'samples.json');
  writeJson(samplesPath, samplesFile);

  const pkgDir = path.join(outDir, 'pkg');
  const seed = 'selftest-seed-fixed';

  // 1. package
  runPackage(['package', '--samples', samplesPath, '--out', pkgDir, '--seed', seed, '--pairwise']);

  // 2. 写一份"正常评审"（全部 4 分，覆盖所有 code）
  const mapping = readJson<MappingFile>(path.join(pkgDir, 'mapping.json'));
  const ratings: RatingsDoc = {
    taskId: 'all',
    ratings: mapping.codes.map((c) => ({
      code: c.code,
      scores: Object.fromEntries(DIM_KEYS.map((dk) => [dk, 4])),
    })),
  };
  const ratingsPath = path.join(outDir, 'ratings-normal.json');
  writeJson(ratingsPath, ratings);

  // pairwise 正常文件（全 tie，仅同任务内两两组合）
  const pairs: PairwiseDoc['entries'] = [];
  for (const { taskId, a, b } of pairsPerTask(mapping.codes)) {
    pairs.push({ taskId, a, b, winner: 'tie' });
  }
  const pairwisePath = path.join(outDir, 'pairwise-normal.json');
  writeJson(pairwisePath, { entries: pairs });

  // 3. detect 正常包（应通过）
  let detectNormalExit = 0;
  try {
    // 内联调用 detect，捕获退出码
    detectNormalExit = invokeDetectForExit(pkgDir, ratingsPath, pairwisePath);
  } catch {
    detectNormalExit = 99;
  }

  // 4. 带泄漏的评审：在某个评审文件里塞入 variantId / model / endpoint / sampleId
  const leakedTaskDir = path.join(pkgDir, 'reviews', tasks[0]);
  const leakedFiles = listDir(leakedTaskDir);
  if (leakedFiles.length > 0) {
    const leakTarget = path.join(leakedTaskDir, leakedFiles[0]);
    let content = readText(leakTarget);
    content += '\n\n<!-- LEAK: variantId=generic_baseline model=deepseek-v4-flash endpoint=https://api.deepseek.com sampleId=s-xxx -->\n';
    fs.writeFileSync(leakTarget, content, 'utf8');
  }

  // 5. detect 泄漏包（应 FAIL）
  let detectLeakExit = 0;
  try {
    detectLeakExit = invokeDetectForExit(pkgDir, ratingsPath, pairwisePath);
  } catch {
    detectLeakExit = 99;
  }

  // 6. aggregate（在泄漏被修回之前，先记下聚合需要正常包）
  // 为了 aggregate 成功，把泄漏文件恢复
  if (leakedFiles.length > 0) {
    const leakTarget = path.join(leakedTaskDir, leakedFiles[0]);
    let content = readText(leakTarget);
    const idx = content.indexOf('\n\n<!-- LEAK:');
    if (idx >= 0) {
      content = content.slice(0, idx);
      fs.writeFileSync(leakTarget, content, 'utf8');
    }
  }

  // 重新跑 package 到干净目录用于 aggregate（避免被泄漏污染，且验证复算）
  const pkgDir2 = path.join(outDir, 'pkg2');
  runPackage(['package', '--samples', samplesPath, '--out', pkgDir2, '--seed', seed, '--pairwise']);

  // 同 seed 复算性检查：比较两次 mapping 的 code 序列
  const mapping2 = readJson<MappingFile>(path.join(pkgDir2, 'mapping.json'));
  const seq1 = mapping.codes.map((c) => c.code).join(',');
  const seq2 = mapping2.codes.map((c) => c.code).join(',');
  const reproducible = seq1 === seq2;

  // aggregate 用 pkg2（干净），ratings 重新针对 pkg2 的 code
  const ratings2: RatingsDoc = {
    taskId: 'all',
    ratings: mapping2.codes.map((c) => {
      // 给不同 variant 略不同分数，便于观察聚合（例如用 variantId hash）
      const h = sha256Hex(c.variantId).charCodeAt(0) % 5 + 1;
      return { code: c.code, scores: Object.fromEntries(DIM_KEYS.map((dk) => [dk, ((h + DIM_KEYS.indexOf(dk)) % 5) + 1])) };
    }),
  };
  const ratings2Path = path.join(outDir, 'ratings-agg.json');
  writeJson(ratings2Path, ratings2);

  const pairwise2Path = path.join(outDir, 'pairwise-agg.json');
  const pairs2: PairwiseDoc['entries'] = [];
  for (const { taskId, a, b } of pairsPerTask(mapping2.codes)) {
    // 用 code 顺序决定胜负，制造非平局
    const av = codePrefixIndex(a);
    const bv = codePrefixIndex(b);
    pairs2.push({ taskId, a, b, winner: av < bv ? 'A' : av > bv ? 'B' : 'tie' });
  }
  writeJson(pairwise2Path, { entries: pairs2 });

  let aggregateExit = 0;
  let aggregateExample = '';
  try {
    runAggregate(['aggregate', '--pkg', pkgDir2, '--ratings', ratings2Path, '--pairwise-file', pairwise2Path]);
    aggregateExit = 0;
    const aggOut = readJson<any>(path.join(pkgDir2, 'aggregate.json'));
    aggregateExample = JSON.stringify(aggOut.variants, null, 2);
  } catch (e) {
    aggregateExit = 99;
    aggregateExample = `aggregate 失败: ${(e as Error).message}`;
  }

  // 输出自测结论
  const reportLines = [
    `=== eval-blind selftest 结论 ===`,
    `生成样本数: ${samples.length}`,
    `编号数: ${mapping.codes.length}`,
    `每任务样本数: ${tasks.map((t) => `${t}=${mapping.codes.filter((c) => c.taskId === t).length}`).join(', ')}`,
    `detect 正常包 exit=${detectNormalExit}（应为 0=通过）`,
    `detect 泄漏包 exit=${detectLeakExit}（应为非 0=FAIL）`,
    `同 seed 复算性: ${reproducible ? 'PASS（编号顺序一致）' : 'FAIL'}`,
    `aggregate exit=${aggregateExit}（应为 0）`,
    `--- aggregate 每 variant 原始分示例 ---`,
    aggregateExample,
    `--out 目录: ${outDir}`,
  ];
  const report = reportLines.join('\n');
  process.stdout.write(report + '\n');
  fs.writeFileSync(path.join(outDir, 'selftest-report.txt'), report, 'utf8');

  // 自测整体是否通过
  const passed = detectNormalExit === 0 && detectLeakExit !== 0 && reproducible && aggregateExit === 0;
  process.stdout.write(`\n[eval-blind] selftest 整体: ${passed ? 'PASS' : 'FAIL'}\n`);
  if (!passed) process.exit(1);
}

function codePrefixIndex(code: string): number {
  const letter = code.split('-')[1] ?? '';
  return letter.charCodeAt(0) || 0;
}

/** 在子进程外复现 detect 的退出码（通过捕获 process.exit） */
function invokeDetectForExit(pkg: string, ratingsPath: string, pairwisePath: string): number {
  // 直接调用 detect 的纯逻辑，通过捕获退出码
  const origExit = process.exit;
  let captured = -1;
  (process as any).exit = (code?: number) => {
    captured = code ?? 0;
    throw new Error(`__EXIT__${captured}`);
  };
  try {
    runDetect(['detect', '--pkg', pkg, '--ratings', ratingsPath, '--pairwise-file', pairwisePath]);
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith('__EXIT__')) {
      captured = Number(m.slice('__EXIT__'.length));
    } else {
      throw e;
    }
  } finally {
    (process as any).exit = origExit;
  }
  if (captured === -1) captured = 0;
  return captured;
}

/* ============================================================================
 * help
 * ========================================================================== */

function printHelp(): void {
  const h = `eval-blind — DeepWriter R19 盲评流水线（subagent B）

用法:
  node out/eval-blind.mjs <command> [flags]

命令:
  package   生成盲评包（匿名化 + 随机化 + 评审文件与 mapping 物理分离）
      --samples <path>   输入 samples.json（subagent A runner 产物）
      --out <dir>        输出目录（reviews/ + mapping.json + package-manifest.json）
      [--seed <str>]     确定性 seed（默认随机，写入 manifest）
      [--pairwise]       生成成对偏好区

  detect    结构检测（不平衡/缺评/重复评/越界/泄漏/mapping 不对应）
      --pkg <dir>        盲评包目录
      [--ratings <file>] 评审者评分文件（可选）
      [--pairwise-file <file>] 成对偏好文件（可选）
      输出 JSON 报告到 stdout；有问题退出码非 0

  aggregate 揭盲聚合（前置：detect 通过 + ratings 存在）
      --pkg <dir>        盲评包目录
      --ratings <file>   评分文件（必填）
      [--pairwise-file <file>] 成对偏好文件（可选）
      输出 <pkg>/aggregate.json + stdout 表格

  reveal    打印 mapping（揭盲，仅打印不写文件）
      --pkg <dir>        盲评包目录

  selftest  自测（synthetic 样本全链验证，产物只放 --out）
      --out <dir>        自测输出目录

ratings 文件格式（JSON）:
  {
    "taskId": "longform-multichapter",   // 可省略；多任务可合并为一条或拆分多条
    "ratings": [
      { "code": "T01-A",
        "scores": {
          "narrative-coherence": 4,
          "character-voice": 4,
          "setting-adherence": 4,
          "naturalness": 4,
          "repetition": 4,
          "structure-completeness": 4,
          "adoptability": 4
        } }
    ]
  }
  每个维度必须为 1-5 整数。缺评/重复评/越界会被 detect 标记为 error。

pairwise 文件格式（JSON，仅同任务内两两对比）:
  {
    "entries": [
      { "taskId": "longform-multichapter", "a": "T01-A", "b": "T01-B", "winner": "A" }
      // winner 取值: "A" | "B" | "tie" | "cannot-judge"
      // taskId 为必填；不同任务的样本不可比，不会参与跨任务偏好统计
    ]
  }

评分维度（7 个）:
  narrative-coherence 叙事连贯
  character-voice 人物声音
  setting-adherence 设定遵守
  naturalness 语言自然度
  repetition 重复度（低分=重复多）
  structure-completeness 结构完成度
  adoptability 可直接采用比例

铁律: 评审文件正文不得出现 variantId / model / provider / endpoint /
sampleId / promptHash / variantContractHash 或任何可泄露分组身份的信息。
`;
  process.stdout.write(h);
}

/* ============================================================================
 * main
 * ========================================================================== */

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    return;
  }
  const cmd = argv[0];
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  const rest = argv.slice(1);
  switch (cmd) {
    case 'package':
      runPackage(rest);
      break;
    case 'detect':
      runDetect(rest);
      break;
    case 'aggregate':
      runAggregate(rest);
      break;
    case 'reveal':
      runReveal(rest);
      break;
    case 'selftest':
      runSelftest(rest);
      break;
    default:
      err(`未知命令: ${cmd}（用 --help 查看用法）`);
  }
}

main();

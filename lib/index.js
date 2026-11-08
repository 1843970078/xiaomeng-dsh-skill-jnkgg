/**
 * dsh-skill-jnkgg —— 技能库管家（宿主半边）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 来源声明（重要，请勿删除）
 * ═══════════════════════════════════════════════════════════════════════
 * 本项目站在别人肩膀上，核心机制学自以下开源项目（详见仓库根 NOTICE）：
 *
 *  · Jesse-njx/dsh-skillport (MIT)
 *      https://github.com/Jesse-njx/dsh-skillport
 *      → SkillProvider 三段式（name/list/get）注册思路
 *      → "目录限量"设计：maxIndexEntries 超出名额不删除、降级 user-invocable
 *    本文件为自行实现，未复制其源码。
 *
 *  · 宿主内置 dsh-personalized-pages provider（DeepSeek Harness 官方）
 *      → ctx.skills.registerProvider((control) => provider) 调用形状
 *      → SkillCandidate 字段（provider/source/rank/locator/invocation）
 *      → control.invalidate() 通知宿主目录缓存失效
 *
 *  · sorcerai/skill-router（理念）→ 整库只暴露极少入口、正文按需加载
 *  · legendtkl/agentic-skill-router（理念）→ 纯本地无 embedding、禁用不等于删除
 *
 * 本仓库原创：库级配置模型、关键词打分与区分度加权、中英双向别名、
 * 自动主题分析（纯统计零 LLM）、领域判定、主题分散选取（round-robin）、
 * 库入口动态描述、分组索引生成、可视化设置面、配置原子写入。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 干三件事：
 *  1. 向宿主 ctx.skills 注册一个 SkillProvider：扫描配置里的外部技能目录
 *     （例如一个放在任意目录下的技能合集），把 SKILL.md
 *     挂进技能体系。正文**按需加载**（get 时才读盘），目录里只出现摘要。
 *  2. 限量：每库 maxVisible 条进模型目录（modelInvocable），超出的**不删除**，
 *     降级为 user-invocable（/名字 仍可直接调用），并且 find_skill 永远搜得到、
 *     skill_jnkgg 随时能加载正文——省 token，但不丢、不遗忘。
 *  3. 可视化设置面：状态总览 / 库管理 / 预算 / 技能浏览，页面在 lib/page.mjs，
 *     路由挂在 /api/skill-jnkgg/*。
 *
 * 铁律（都是踩过坑换来的）：
 *  - 顶层 inject 只写 ['skills']，绝不写 'tools'/'webServer'（依赖解析会卡死宿主）。
 *    tools / webServer 一律 ctx.get 懒取 + try/catch 降级。
 *  - 任何一处扫描/解析失败都吞掉并记日志，绝不抛出——插件坏了不能连累 DSH 启动。
 *  - 配置写盘走临时文件 + 原子替换，写前自动备份。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PAGE_HTML } from './page.mjs';

export const name = 'dsh-skill-jnkgg';

/** 只声明真正硬依赖的服务；tools/webServer 懒取。 */
export const inject = ['skills'];

const HERE = dirname(fileURLToPath(import.meta.url));

// ───────────────────────── 配置 ─────────────────────────

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

const CONFIG_DIR = () => join(dshHome(), 'skill-jnkgg');
const CONFIG_FILE = () => join(CONFIG_DIR(), 'config.json');

const DEFAULTS = {
  enabled: true,
  libraries: [
    // { path: '...', name: 'gamedev', enabled: true, maxVisible: 8, keywords: ['做游戏','游戏','游戏开发'] }
  ],
  maxVisibleDefault: 8,   // 每库默认进目录的条数
  descMaxChars: 160,      // 摘要截断长度（目录 token 的主要开销）
  scanTtlSec: 10,         // 目录扫描缓存有效期
  loadBodyLimit: 200000,  // skill_jnkgg load 返回正文的字符上限
  pickMode: 'keywords',   // 'keywords' = 按关键词打分挑进目录 | 'name' = 按名字字母序
};

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'));
    const cfg = { ...DEFAULTS, ...raw };
    cfg.libraries = (Array.isArray(raw.libraries) ? raw.libraries : []).map((l) => ({
      path: String(l.path || ''),
      name: String(l.name || basename(String(l.path || '')).slice(0, 40) || 'lib'),
      enabled: l.enabled !== false,
      maxVisible: Number.isFinite(+l.maxVisible) && +l.maxVisible >= 0 ? +l.maxVisible : cfg.maxVisibleDefault,
      keywords: Array.isArray(l.keywords) ? l.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    })).filter((l) => l.path);
    return cfg;
  } catch {
    return { ...DEFAULTS, libraries: [] };
  }
}

/** 统一归一化一条库配置（读盘/接口/UI 三处共用，防止字段漂移）。 */
function normalizeLib(l) {
  return {
    path: String(l.path || ''),
    name: String(l.name || basename(String(l.path || '')) || 'lib'),
    enabled: l.enabled !== false,
    maxVisible: Number.isFinite(+l.maxVisible) && +l.maxVisible >= 0 ? +l.maxVisible : undefined,
    keywords: Array.isArray(l.keywords)
      ? l.keywords.map((k) => String(k).trim()).filter(Boolean)
      : (typeof l.keywords === 'string' ? l.keywords.split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean) : []),
  };
}

function saveConfig(cfg) {
  const dir = CONFIG_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = CONFIG_FILE();
  if (existsSync(file)) {
    try { copyFileSync(file, file + '.bak'); } catch { /* 备份失败不拦主流程 */ }
  }
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, file);
}

let config = loadConfig();

// ───────────────────────── SKILL.md 解析 ─────────────────────────

/** 极简 frontmatter 解析：只认 name / description / whenToUse，容错引号与多行折叠。 */
function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { name: '', description: '', whenToUse: '' };
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      let v = kv[2].trim();
      if (v === '|' || v === '>' || v === '') v = '';
      // 去掉成对引号
      const q = /^(["'])(.*)\1$/.exec(v);
      if (q) v = q[2];
      if (out[key] !== undefined) out[key] = v;
      continue;
    }
    if (key && /^\s+\S/.test(line)) {
      const cont = line.trim();
      if (out[key] !== undefined) out[key] = (out[key] ? out[key] + ' ' : '') + cont;
    } else {
      key = null;
    }
  }
  return out;
}

// ───────────────────────── 库扫描 ─────────────────────────

/** 缓存：libName -> { at, skills: [{name, description, whenToUse, file, dir}] } */
const scanCache = new Map();

function scanLibrary(lib) {
  const now = Date.now();
  const hit = scanCache.get(lib.name);
  if (hit && now - hit.at < config.scanTtlSec * 1000) return hit.skills;
  const skills = [];
  try {
    const root = resolve(lib.path);
    if (existsSync(root)) {
      // 根上直接有 SKILL.md → 单技能库
      const rootSkill = join(root, 'SKILL.md');
      const candidates = [];
      if (existsSync(rootSkill)) {
        candidates.push({ dir: root, file: rootSkill });
      } else {
        // 一层/两层目录里的 SKILL.md（skills/<group>/<skill>/SKILL.md）
        for (const a of safeReadDirs(root)) {
          const pa = join(root, a);
          if (existsSync(join(pa, 'SKILL.md'))) { candidates.push({ dir: pa, file: join(pa, 'SKILL.md') }); continue; }
          for (const b of safeReadDirs(pa)) {
            const pb = join(pa, b);
            if (existsSync(join(pb, 'SKILL.md'))) candidates.push({ dir: pb, file: join(pb, 'SKILL.md') });
          }
        }
      }
      for (const c of candidates) {
        try {
          const text = readFileSync(c.file, 'utf8');
          const fm = parseFrontmatter(text);
          const name = (fm.name || basename(c.dir)).replace(/[^\w.-]/g, '-').toLowerCase();
          if (!name) continue;
          let desc = fm.description || '';
          if (desc.length > config.descMaxChars) desc = desc.slice(0, config.descMaxChars - 1) + '…';
          // 正文里抓一小段（尤其中文），用于让「用户打中文」也能搜到英文技能。
          // 只取前 600 字，够用且不占内存。
          let bodyPreview = '';
          try {
            const bodyStart = text.indexOf('---', 3);
            const body = bodyStart > 0 ? text.slice(bodyStart + 3) : text;
            bodyPreview = body.slice(0, 600);
          } catch { bodyPreview = ''; }
          skills.push({ name, description: desc, whenToUse: fm.whenToUse || '', file: c.file, dir: c.dir, bodyPreview });
        } catch { /* 单个文件坏了不影响整库 */ }
      }
      skills.sort((x, y) => x.name.localeCompare(y.name));
    }
  } catch (e) {
    try { ctxLog('warn', `扫描 ${lib.name} 失败: ${e && e.message}`); } catch { /* noop */ }
  }
  scanCache.set(lib.name, { at: now, skills });
  return skills;
}

function safeReadDirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch { return []; }
}

/** 每库的有效可见上限（0 = 全隐藏但可取回）。 */
function visibleCap(lib) {
  return Number.isFinite(+lib.maxVisible) && +lib.maxVisible >= 0 ? +lib.maxVisible : config.maxVisibleDefault;
}

// ───────────────────────── 自动分析库内容 ─────────────────────────

const STOPWORDS = new Set(`a an the and or but if then than that this these those for from with without
into onto over under about above below between during before after while of to in on at by as is are was were
be been being do does did done have has had having can could should would will shall may might must not no
yes you your yours it its they them their we us our ours he she his her him i me my mine
use used using make made makes get got gets give given take taken put set sets
when where what which who whom whose why how all any both each few more most other some such only own same
so too very just also now new one two three first second next last
via per etc ie eg vs
skill skills file files code data run running runs
able need needs want wants like well good best better
build building built create creating created add adding added
implement implementing support supporting provide providing
work working works way ways thing things case cases part parts
based include includes including within across along around
small large big high low full empty true false null none
also however while using used each other via
system systems core tree trees data value values name names type types
content contents item items object objects result results output outputs
component components module modules package packages project projects
default simple basic general common main primary specific
`.split(/\s+/).filter(Boolean));

/**
 * 极简英文词干化：目标是让「单复数 / 时态 / 词性后缀」能对上，不做完整 Porter。
 *
 * 为什么需要：技能描述常写复数或动名词（"deductions"、"recitals"、"vouching"），
 * 用户查单数（"deduction"、"recital"）时如果不做词干化就永远对不上。
 * 实测案例：会计库查 "deduction" → 描述里是 "deductions"，修复前搜索 0 条。
 */
function stem(w) {
  let s = String(w).toLowerCase();
  if (s.length <= 3) return s;
  // 按长度优先匹配长的后缀，避免 "ings" 被 "s" 先吃掉
  const suffixes = [
    'izations', 'ization', 'isations', 'isation',
    'ations', 'ation', 'ments', 'ment',
    'ings', 'ing', 'ies', 'ied', 'ers', 'er',
    'ses', 'ses', 'es', 'ed', 'ly', 's',
  ];
  for (const suf of suffixes) {
    if (s.length - suf.length >= 4 && s.endsWith(suf)) {
      let base = s.slice(0, -suf.length);
      // ies → y（studies → study）
      if (suf === 'ies' || suf === 'ied') base += 'y';
      // ing/ed 的双写辅音（running → run, stopped → stop）
      if ((suf === 'ing' || suf === 'ed') && /([bcdfgklmnprstvz])\1$/.test(base)) {
        base = base.slice(0, -1);
      }
      return base;
    }
  }
  return s;
}

/** 一段文本是否包含某个词（考虑词干化后匹配）。 */
function containsStemmed(hayText, needle) {
  const h = String(hayText || '').toLowerCase();
  const n = String(needle || '').toLowerCase();
  if (!n) return false;
  // 先直接包含
  if (h.includes(n)) return true;
  // 再按词干比：把 hay 切成词，逐个 stem 后比对
  const ns = stem(n);
  if (ns.length < 3) return false;
  for (const m of h.matchAll(/[a-z][a-z0-9]+/g)) {
    if (stem(m[0]) === ns) return true;
  }
  return false;
}

/** 从一段文本抽词：英文按单词，中文抓 2-6 字连续汉字。 */
function tokenize(text) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(/[a-zA-Z][a-zA-Z0-9]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (STOPWORDS.has(w)) continue;
    out.push({ raw: w, stem: stem(w), isCn: false });
  }
  for (const m of src.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) out.push({ raw: m[0], stem: m[0], isCn: true });
  return out;
}

/** 分析结果缓存（key = 库名 + 技能条数，库变了自动失效）。 */
const analyzeCache = new Map();

const ENGINE_WORDS = new Set(['godot', 'unity', 'unreal', 'roblox', 'bevy', 'pygame', 'phaser', 'pixijs', 'three', 'threejs', 'defold', 'ebitengine', 'love', 'gamemaker', 'divinity', 'rpgmaker']);

/**
 * 实现细节词：说明"用什么技术做"，不回答"我想做什么"。
 * 这些词在技术库里出现率很高，会挤掉真正的主题词（如 audio / platformer / ui）。
 */
const IMPL_WORDS = new Set([
  'csharp', 'cs', 'gdscript', 'blueprint', 'blueprints', 'cpp', 'lua', 'python', 'javascript', 'typescript',
  'shader', 'shaders', 'tilemap', 'tilemaps', 'sprite', 'sprites', 'texture', 'textures', 'mesh', 'meshes',
  'publish', 'publishing', 'export', 'deploy', 'build', 'compile', 'packaging',
  'load', 'loading', 'script', 'scripting', 'api', 'sdk', 'plugin', 'plugins', 'extension', 'library',
  'node', 'nested', 'scene', 'scenes', 'node', 'resource', 'assets', 'asset', 'pipeline',
  'setup', 'install', 'configure', 'config', 'settings', 'option', 'options', 'parameter', 'parameters',
  'handle', 'handling', 'manage', 'management', 'control', 'controller', 'manager',
  'custom', 'advanced', 'intro', 'basics', 'guide', 'tutorial', 'example', 'examples',
]);

/**
 * 分析一个库，挖出「这个库到底讲什么」的主题词。
 * 纯统计零成本：不调 LLM、不联网。
 *
 * 关键insight：技能名多是 `<引擎>-<主题>`（godot-physics），
 * 引擎那半说明"用什么做"，主题那半才说明"做什么"。
 * 所以名字**尾段**权重最高，引擎段直接降权——这样挖出来的
 * 才是 platformer/ui/audio/save 这种真正能触发的词。
 */
function analyzeLibrary(lib) {
  const skills = scanLibrary(lib);
  const total = skills.length;
  if (!total) return { keywords: [], stats: { total: 0, tokens: 0 }, detail: [] };

  const ck = `${lib.name}::${total}::${lib.path}`;
  const cached = analyzeCache.get(ck);
  if (cached && Date.now() - cached.at < 60000) return cached.result;

  const df = new Map();       // stem -> Set(技能名)
  const nameTail = new Map(); // stem -> Set(技能名)，只在名字的"主题段"出现
  const display = new Map();  // stem -> 代表词形

  for (const s of skills) {
    const rawName = String(s.name || '');
    const parts = rawName.split(/[-_\s]+/).filter(Boolean).map((x) => x.toLowerCase());
    // 尾段（去掉第一个引擎词之后的部分）= 主题词
    const tailParts = parts.length > 1 && ENGINE_WORDS.has(parts[0]) ? parts.slice(1) : parts;

    const seen = new Set();
    for (const t of tokenize(s.description || '')) {
      if (!df.has(t.stem)) df.set(t.stem, new Set());
      if (!seen.has(t.stem)) { df.get(t.stem).add(rawName); seen.add(t.stem); }
      if (!display.has(t.stem)) display.set(t.stem, t.raw);
    }
    // 名字尾段：强信号
    for (const p of tailParts) {
      for (const t of tokenize(p)) {
        if (!df.has(t.stem)) df.set(t.stem, new Set());
        df.get(t.stem).add(rawName);
        if (!nameTail.has(t.stem)) nameTail.set(t.stem, new Set());
        nameTail.get(t.stem).add(rawName);
        if (!display.has(t.stem)) display.set(t.stem, t.raw);
      }
    }
    // 引擎段：弱信号（进 df 但不进 nameTail）
    for (const p of parts) {
      if (!ENGINE_WORDS.has(p)) continue;
      for (const t of tokenize(p)) {
        if (!df.has(t.stem)) df.set(t.stem, new Set());
        df.get(t.stem).add(rawName);
        if (!display.has(t.stem)) display.set(t.stem, t.raw);
      }
    }
  }

  const scored = [];
  // 小库豁免：技能少的时候（<12 条），每个主题词往往只出现 1 次，
  // 按"≥2 次"过滤会把主题全滤掉（实测 6 条小库只剩 selection/lures/water 这种噪音）。
  const minDf = total < 12 ? 1 : 2;
  for (const [st, set] of df) {
    const n = set.size;
    if (n < minDf) continue;                 // 出现次数太少
    const rate = n / total;
    if (total >= 12 && rate > 0.6) continue; // 泛滥词（小库不适用，容易把唯一主题判成泛滥）
    if (rate > 0.85) continue;
    const nt = nameTail.get(st)?.size || 0;   // 作为"主题词"出现几次
    if (ENGINE_WORDS.has(st) && nt === 0) continue;  // 纯引擎词，直接不要
    // 【实现细节词剔除】csharp/gdscript/shaders/tilemap/publish/load/script 这类
    // 说明"用什么技术做的"，不回答"我想做什么"。它们会挤掉真正的主题词。
    if (IMPL_WORDS.has(st)) continue;
    const balance = rate < 0.15 ? 0.65 : (rate > 0.45 ? 0.85 : 1);
    // 主题段权重远高于描述命中
    scored.push({
      stem: st, word: display.get(st) || st, n, nt, rate,
      score: (Math.log2(1 + n) * 0.8 + nt * 2.6) * balance,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // 去重：包含关系的只留高分的
  const picked = [];
  for (const c of scored) {
    if (picked.length >= 14) break;
    if (picked.some((p) => p.stem === c.stem || p.stem.startsWith(c.stem) || c.stem.startsWith(p.stem))) continue;
    picked.push(c);
  }

  const result = {
    keywords: picked.map((p) => p.word),
    stats: { total, tokens: df.size },
    detail: picked.map((p) => ({ word: p.word, inSkills: p.n, total, inName: p.nt, rate: +(p.rate).toFixed(2) })),
  };
  analyzeCache.set(ck, { at: Date.now(), result });
  return result;
}

/**
 * 判断一个库是不是"单一主题库"：绝大多数技能共享同一个领域。
 * 典型：整库都是游戏开发 → 只要提到"做游戏"就该整个库可用，不必精挑。
 */
function detectTopic(lib, skills) {
  if (lib?.topic) return { topic: lib.topic, single: true };

  const total = skills.length || 1;

  // ① 看目录分组名（skills/<group>/<skill>/SKILL.md 的 group 名最能说明主题）
  const groupCount = new Map();
  for (const s of skills) {
    const rel = String(s.dir || '').replace(/\\/g, '/');
    const root = String(lib.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rel.startsWith(root)) continue;
    const seg = rel.slice(root.length).split('/').filter(Boolean);
    const g = seg.length >= 2 ? seg[0] : '';
    if (g) groupCount.set(g, (groupCount.get(g) || 0) + 1);
  }

  // ② 领域词表：命中率超 60% 的领域直接判定为该库主题
  const DOMAINS = {
    '游戏开发': ['game', 'gamedev', 'gameplay', 'player', 'enemy', 'level', 'sprite', 'player'],
    '前端开发': ['react', 'vue', 'css', 'html', 'dom', 'component', 'browser'],
    '视频制作': ['video', 'ffmpeg', 'clip', 'subtitle', 'render', 'timeline'],
    '平面设计': ['logo', 'brand', 'poster', 'typography', 'layout'],
    '数据分析': ['dataset', 'dataframe', 'sql', 'chart', 'metric'],
  };
  const hayAll = skills.map((s) => {
    // 判定用「完整描述」：scanLibrary 里的 description 截断到 150 字（给目录省 token），
    // 拿它判领域会误判（实测 79% 掉到 58%）。这里读全文，短且准。
    let full = '';
    try {
      const txt = readFileSync(s.file, 'utf8');
      const fm = parseFrontmatter(txt);
      full = fm.description || '';
    } catch { full = s.description || ''; }
    return (s.name + ' ' + full).toLowerCase();
  });
  let best = { topic: '', rate: 0 };
  for (const [topic, words] of Object.entries(DOMAINS)) {
    let hit = 0;
    for (const hay of hayAll) if (words.some((w) => hay.includes(w))) hit++;
    const rate = hit / total;
    if (rate > best.rate) best = { topic, rate };
  }
  if (best.rate >= 0.6) return { topic: best.topic, single: true, rate: +best.rate.toFixed(2) };

  // ③ 兜底：库名像主题就用库名
  return { topic: '', single: false, groups: [...groupCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}
/** 一个库实际生效的关键词：手动设了的用手动，没设的自动分析。 */
function effectiveKeywords(lib) {
  const manual = Array.isArray(lib?.keywords) ? lib.keywords.filter(Boolean) : [];
  if (manual.length) return { source: 'manual', keywords: manual };
  const auto = analyzeLibrary(lib).keywords;
  return { source: auto.length ? 'auto' : 'none', keywords: auto };
}

/**
 * 给单条技能生成「检索标签」：英文主题词 + 中文说法。
 * 目的：用户说中文（如「设计」「音效」「存档」）时，search 和索引都能对上具体的技能。
 * 例：game-ui-ux → ['game-ui-ux', 'ui', 'interface', '界面', 'UI', 'HUD', '菜单']
 */
function skillTags(skill) {
  const tags = new Set();
  const name = String(skill.name || '').toLowerCase();
  tags.add(name);
  // 技能名分段（去掉引擎词）—— 这是最强的信号
  const nameParts = name.split(/[-_\s]+/).filter(Boolean);
  for (const p of nameParts) {
    if (ENGINE_WORDS.has(p)) continue;
    tags.add(p);
    for (const cn of (EN_TO_CN[p] || [])) tags.add(cn);
    const st = stem(p);
    if (st !== p) tags.add(st);
    for (const cn of (EN_TO_CN[st] || [])) tags.add(cn);
  }
  // 描述里的主题词：只有"作为完整单词出现"才算，避免 drafting 里的 art 这种子串误伤
  const desc = String(skill.description || '').toLowerCase();
  const head = desc.slice(0, 160);
  for (const key of Object.keys(EN_TO_CN)) {
    // 手写边界判断，不用正则（避免转义地狱）：前后必须是非字母
    const idx = head.indexOf(key);
    if (idx < 0) continue;
    const before = idx === 0 ? '' : head[idx - 1];
    const after = idx + key.length >= head.length ? '' : head[idx + key.length];
    const isWord = !/[a-z]/.test(before || '') && !/[a-z]/.test(after || '');
    if (!isWord) continue;
    tags.add(key);
    for (const cn of EN_TO_CN[key]) tags.add(cn);
  }
  // 【关键】把正文里的中文也收进来：
  // 很多技能库描述是英文、但标题或小节是中文（例如 "# 手冲咖啡"）。
  // 不抓这一块，用户打中文就永远搜不到。
  // 注意：必须支持中英混排词（X光、B超、CT扫描、AI绘图），
  // 早先用 /[\u4e00-\u9fa5]{2,8}/ 会把 "X光判读" 切成 "光判读"（丢了 X），
  // 导致用户查「X光」查不到。改成允许字母数字与汉字混排，但至少含一个汉字。
  try {
    const body = String(skill.bodyPreview || '');
    if (body) {
      for (const m of body.matchAll(/[A-Za-z0-9\u4e00-\u9fa5]{2,12}/g)) {
        const seg = m[0];
        // 必须包含至少一个汉字，纯英文/纯数字段不要
        if (!/[\u4e00-\u9fa5]/.test(seg)) continue;
        // 太长的整句切分（连续汉字超过 12 已由正则限制）
        tags.add(seg);
        // 再拆一层：把混排词里的纯汉字部分也加进去，便于部分匹配
        const cnPart = seg.replace(/[A-Za-z0-9]/g, '');
        if (cnPart.length >= 2 && cnPart !== seg) tags.add(cnPart);
      }
    }
  } catch { /* noop */ }
  return [...tags];
}

/** 技能名的主题段（去掉引擎词后的那些词）——用于判断"这条到底讲什么"。 */
function nameTopics(skill) {
  return String(skill.name || '').toLowerCase()
    .split(/[-_\s]+/).filter((p) => p && !ENGINE_WORDS.has(p));
}

/**
 * 中文关键词 → 英文同义扩展。
 * 库内容基本是英文（社区 skill 都写英文），但用户自然会说中文。
 * 命中中文词时自动带上对应英文词一起搜，用户怎么写都能用。
 */
const CN_ALIAS = {
  '做游戏': ['game', 'gameplay'],
  '游戏': ['game'],
  '游戏开发': ['game', 'gamedev'],
  '玩法': ['gameplay', 'mechanics'],
  '手感': ['game feel', 'feel', 'juice'],
  '平台跳跃': ['platformer', 'jump'],
  // ── 动作/移动类（"二段跳"这种具体玩法说法要能落到 jump/movement）──
  '二段跳': ['jump', 'double jump', 'movement', 'platformer'],
  '两段跳': ['jump', 'double jump', 'movement', 'platformer'],
  '多段跳': ['jump', 'double jump', 'movement'],
  '跳跃': ['jump', 'movement'],
  '土狼时间': ['coyote time', 'jump', 'platformer'],
  '跳跃缓冲': ['jump buffer', 'jump', 'platformer'],
  '爬墙': ['wall slide', 'wall jump', 'movement'],
  '蹬墙跳': ['wall jump', 'wall slide', 'movement'],
  '冲刺': ['dash', 'movement', 'velocity'],
  '闪避': ['dash', 'dodge', 'movement'],
  '移动': ['movement', 'move', 'velocity'],
  '角色移动': ['movement', 'character', 'move'],
  '跑动': ['run', 'movement'],
  '跑步': ['run', 'movement'],
  '行走': ['walk', 'movement'],
  '转身': ['turn', 'movement', 'facing'],
  '重力': ['gravity', 'physics'],
  '碰撞': ['collision', 'physics'],
  '关卡': ['level', 'stage'],
  '美术': ['art', 'visual'],
  '美化': ['art', 'polish', 'visual'],
  '界面': ['ui', 'interface', 'hud'],
  '用户界面': ['ui', 'interface'],
  '声音': ['audio', 'sound', 'sfx'],
  '音效': ['audio', 'sfx', 'sound'],
  '音乐': ['music', 'audio'],
  '背景音乐': ['music', 'audio'],
  '动画': ['animation', 'anim'],
  '角色': ['character'],
  '存档': ['save', 'persist'],
  '保存': ['save', 'persist'],
  '读档': ['save', 'load', 'persist'],
  '多人': ['multiplayer', 'network'],
  '联机': ['multiplayer', 'network'],
  '网络': ['network', 'multiplayer'],
  '数据': ['data', 'storage'],
  '对话': ['dialogue', 'narrative'],
  '剧情': ['narrative', 'story'],
  '故事': ['story', 'narrative'],
  '任务': ['quest', 'task'],
  '背包': ['inventory', 'item'],
  '物品栏': ['inventory', 'item'],
  '战斗': ['combat', 'attack', 'damage'],
  '攻击': ['attack', 'combat', 'damage'],
  '伤害': ['damage', 'combat', 'health'],
  '血量': ['health', 'hp', 'damage'],
  '敌人': ['ai', 'enemy', 'behavior'],
  '怪物': ['enemy', 'ai', 'behavior'],
  '寻路': ['pathfinding', 'navigation', 'ai'],
  '相机': ['camera'],
  '镜头': ['camera'],
  '输入': ['input', 'controls'],
  '按键': ['input', 'keybinding', 'controls'],
  '手柄': ['input', 'gamepad', 'controls'],
  '性能': ['performance', 'optimize'],
  '优化': ['optimize', 'performance'],
  '卡顿': ['performance', 'optimize', 'frame'],
  '渲染': ['rendering', 'shader', 'draw'],
  '着色器': ['shader', 'rendering'],
  '物理': ['physics'],
  '碰撞检测': ['collision', 'physics'],
  '特效': ['vfx', 'niagara', 'shader'],
  '粒子': ['particle', 'vfx', 'niagara'],
  '粒子特效': ['particle', 'vfx', 'niagara'],
  '伤害': ['damage', 'combat', 'health'],
  '血量': ['health', 'hp', 'stats'],
  '生命值': ['health', 'hp', 'stats'],
  '属性': ['stats', 'attribute'],
  '升级': ['level', 'exp', 'stats'],
  '等级': ['level', 'exp', 'stats'],
  '发布': ['publish', 'build', 'export'],
  '上架': ['publish', 'steam', 'itch'],
  '打包': ['build', 'export', 'package'],
  '测试': ['test', 'debug'],
  '调试': ['debug', 'test'],
  '本地化': ['localize', 'i18n', 'translation'],
  '多语言': ['localize', 'i18n'],
  '像素': ['pixel', 'sprite', 'tile'],
  '瓦片': ['tilemap', 'tile'],
  '地图': ['level', 'tilemap', 'map'],
  'AI': ['ai', 'behavior'],
};

/**
 * 通用中文→英文对照（跨领域）。和 CN_ALIAS（游戏专用）分开放：
 * CN_ALIAS 是游戏开发的高精度词表，这里是**通用兜底**，覆盖面优先。
 * 目标是"换个陌生领域的库，中文也大致能搜到"。
 */
const CN_COMMON = {
  // 通用动作/概念
  '基础': ['basic', 'basics', 'intro', 'getting'], '入门': ['basic', 'intro', 'start'],
  '进阶': ['advanced', 'intermediate'], '高级': ['advanced'],
  '技巧': ['technique', 'tips', 'trick'], '方法': ['method', 'approach', 'way'],
  '步骤': ['step', 'process'], '流程': ['process', 'workflow', 'pipeline'],
  '配置': ['config', 'setup', 'configure'], '设置': ['setting', 'config'],
  '安装': ['install', 'setup'], '部署': ['deploy', 'deployment'],
  '优化': ['optimize', 'optimization', 'performance'], '性能': ['performance', 'speed'],
  '问题': ['issue', 'problem', 'troubleshoot'], '错误': ['error', 'bug', 'fail'],
  '测试': ['test', 'testing'], '调试': ['debug', 'troubleshoot'],
  '设计': ['design'], '规划': ['plan', 'planning'], '管理': ['manage', 'management'],
  '分析': ['analysis', 'analyze'], '评估': ['evaluate', 'assess', 'score'],
  '数据': ['data'], '文件': ['file'], '文档': ['doc', 'document'],
  '工具': ['tool'], '工具链': ['toolchain', 'pipeline'],
  // 咖啡/餐饮（示例领域，验证通用性）
  '烘焙': ['roast', 'roasting', 'bake'], '烘烤': ['roast', 'bake'],
  '咖啡': ['coffee', 'cafe', 'espresso'], '豆子': ['bean', 'beans'],
  '产地': ['origin', 'region'], '手冲': ['pour', 'pour-over', 'v60', 'drip'],
  '意式': ['espresso'], '浓缩': ['espresso', 'concentrate'],
  '冷萃': ['cold brew', 'cold'], '磨豆': ['grinder', 'grind'],
  '研磨': ['grind', 'grinder', 'burr'], '咖啡机': ['machine', 'espresso machine'],
  '拉花': ['latte art', 'latte', 'milk'], '奶泡': ['milk', 'steam', 'foam'],
  '杯测': ['cupping', 'sensory', 'taste'], '风味': ['flavor', 'taste', 'sensory'],
  '成本': ['cost', 'pricing', 'economics'], '定价': ['pricing', 'price'],
  '菜单': ['menu'], '门店': ['cafe', 'shop', 'store'],
  // 设计/创作
  '配色': ['color', 'palette'], '排版': ['layout', 'typography'],
  '字体': ['font', 'typography'], '图标': ['icon'], '插画': ['illustration', 'art'],
  '海报': ['poster'], '品牌': ['brand', 'branding'], '视觉': ['visual', 'visuals'],
  // 视频/音频
  '剪辑': ['edit', 'editing', 'cut'], '转场': ['transition'],
  '字幕': ['subtitle', 'caption'], '配音': ['voice', 'dub'],
  '录音': ['record', 'recording'], '降噪': ['noise', 'denoise'],
  // 编程通用
  '函数': ['function'], '接口': ['api', 'interface'], '数据库': ['database', 'db'],
  '缓存': ['cache'], '并发': ['concurrency', 'parallel'], '安全': ['security', 'safe'],
  '权限': ['permission', 'auth'], '登录': ['login', 'auth'],
};

/** 简繁/异体常见映射（用户可能打繁体或别字） */
const CN_VARIANT = { '烘焙': ['烘培', '烘焙'], '烘培': ['烘焙', 'roast'] };
/** 英文主题词 → 中文说法（反向别名）。让 router 描述同时带中英文，用户怎么说都能命中。 */
const EN_TO_CN = {
  design: ['设计', '设计感'], ui: ['界面', 'UI'], hud: ['HUD', '抬头显示'], menu: ['菜单'],
  audio: ['音效', '声音', '音频'], sound: ['声音', '音效'], music: ['音乐'], sfx: ['音效'],
  animation: ['动画'], anim: ['动画'], physics: ['物理'], input: ['输入', '操作'],
  save: ['存档', '保存'], persist: ['存档'], level: ['关卡'], stage: ['关卡'],
  character: ['角色'], art: ['美术', '画风'], visual: ['视觉', '画面'], shader: ['着色器'],
  rendering: ['渲染'], camera: ['相机', '镜头'], gameplay: ['玩法'], feel: ['手感'],
  movement: ['移动'], jump: ['跳跃'], platformer: ['平台跳跃'], behavior: ['行为', 'AI'],
  ai: ['AI', '人工智能'], dialogue: ['对话'], narrative: ['剧情'], story: ['故事'],
  quest: ['任务'], inventory: ['背包', '物品栏'], combat: ['战斗'], rpg: ['角色扮演'],
  multiplayer: ['多人', '联机'], network: ['网络', '联机'], performance: ['性能', '优化'],
  optimize: ['优化'], asset: ['素材', '资产'], assets: ['素材'], tilemap: ['瓦片地图'],
  card: ['卡牌'], deck: ['卡组'], economy: ['经济系统'], localize: ['本地化', '多语言'],
  test: ['测试'], debug: ['调试'], publish: ['发布', '上架'],
};

/** 把英文主题词配上中文说法，返回 [英文, 中文...] */
function withChinese(word) {
  const out = [word];
  const cn = EN_TO_CN[String(word).toLowerCase()];
  if (cn) for (const c of cn) if (!out.includes(c)) out.push(c);
  return out;
}

/** 把一个关键词展开成"原文 + 英文别名"的检索词表。 */
function expandKeyword(raw) {
  const k = String(raw || '').trim();
  if (!k) return [];
  const out = [k.toLowerCase()];
  const alias = CN_ALIAS[k] || CN_ALIAS[k.replace(/\s+/g, '')];
  if (alias) for (const a of alias) if (!out.includes(a)) out.push(a);
  return out;
}

/**
 * 给一条技能按关键词打分。
 * 命中越多、越靠前的关键词越优先；名字命中权重高于摘要命中。
 * 关键词为空 / pickMode='name' 时返回 null，表示不做选择、退回名字序。
 *
 * 区分度加权（重要）：一个词如果命中全库 70% 以上的条目（比如给游戏库设"game"），
 * 它就是**噪音**——自动降到 0.15 权重。真正有区分度的是"platformer""UI"这种。
 */
function scoreByKeywords(skill, lib, dfMap, kwsIn) {
  const kws = Array.isArray(kwsIn) ? kwsIn : effectiveKeywords(lib).keywords;
  if (config.pickMode !== 'keywords' || kws.length === 0) return null;
  const name = String(skill.name || '').toLowerCase();
  const desc = String(skill.description || '').toLowerCase();
  const when = String(skill.whenToUse || '').toLowerCase();
  let score = 0;
  kws.forEach((raw, idx) => {
    // 越靠前的关键词权重越高（第一个是主诉求）
    let w = Math.max(1, kws.length - idx);
    const variants = expandKeyword(raw);
    for (const k of variants) {
      if (!k) continue;
      // 区分度：命中率越高的词越没用
      const df = dfMap ? (dfMap.get(k) ?? 0) : 0;
      const total = dfMap ? (dfMap.get('__total__') || 1) : 1;
      const rate = df / total;
      let lw = w;
      if (rate >= 0.7) lw *= 0.15;        // 全库通用词：几乎不算分
      else if (rate >= 0.4) lw *= 0.4;    // 很泛：大幅降权
      else if (rate >= 0.2) lw *= 0.75;
      if (name.includes(k)) score += 6 * lw;
      if (when.includes(k)) score += 3 * lw;
      if (desc.includes(k)) score += 2 * lw;
    }
  });
  return score;
}

/** 统计每个关键词（含英文别名）在这个库里命中多少条（用于区分度加权）。 */
function buildDfMap(skills, lib, kwsIn) {
  const kws = Array.isArray(kwsIn) ? kwsIn : effectiveKeywords(lib).keywords;
  const df = new Map();
  df.set('__total__', skills.length || 1);
  for (const raw of kws) {
    for (const k of expandKeyword(raw)) {
      if (!k || df.has(k)) continue;
      let count = 0;
      for (const s of skills) {
        const hay = (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase();
        if (hay.includes(k)) count++;
      }
      df.set(k, count);
    }
  }
  return df;
}

/**
 * 挑出这个库里"该进目录"的技能集合（返回 name 的 Set）。
 *
 * 【主题分散策略】应对混杂库：一个库里游戏/设计/视频混着放时。
 * 如果只按总分取前 N，会全被最大的那个主题占满，小主题一条都露不出来。
 * 所以：先按主题（技能名的主题段）分桶，再**按桶轮流取**——
 * 每个主题都能露一条，谁也不被大主题淹没。
 */
function pickVisible(lib, skills) {
  const cap = visibleCap(lib);
  if (cap <= 0) return new Set();
  if (cap >= skills.length) return new Set(skills.map((s) => s.name));
  const eff = effectiveKeywords(lib);
  const kws = eff.keywords;
  const dfMap = buildDfMap(skills, lib, kws);
  const scored = skills.map((s) => ({ s, score: scoreByKeywords(s, lib, dfMap, kws) }));
  if (scored.every((x) => x.score === null)) {
    return new Set(skills.slice(0, cap).map((s) => s.name));
  }
  const hit = scored.filter((x) => (x.score || 0) > 0);
  if (hit.length === 0) {
    // 关键词和内容完全对不上：退回名字序，避免库在目录里彻底隐身
    return new Set(skills.slice(0, cap).map((s) => s.name));
  }
  hit.sort((a, b) => (b.score - a.score) || a.s.name.localeCompare(b.s.name));
  // 按"主题桶"分组：桶名取技能名里第一个非引擎段
  const bucketOf = (s) => {
    const parts = String(s.name || '').split(/[-_\s]+/).filter(Boolean).map((x) => x.toLowerCase());
    const nonEngine = parts.filter((p) => !ENGINE_WORDS.has(p));
    return nonEngine[0] || parts[0] || '(other)';
  };
  const buckets = new Map();
  for (const x of hit) {
    const b = bucketOf(x.s);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(x);
  }
  // 桶按"组内最高分"排序，然后轮流取每条（round-robin），保证主题多样性
  const ordered = [...buckets.entries()].sort((a, b) => (b[1][0]?.score || 0) - (a[1][0]?.score || 0));
  const picked = [];
  let round = 0;
  while (picked.length < cap) {
    let added = false;
    for (const [, arr] of ordered) {
      if (picked.length >= cap) break;
      if (round < arr.length) { picked.push(arr[round]); added = true; }
    }
    if (!added) break;
    round++;
  }

  // 【覆盖面补位】如果手填关键词很窄（比如只写了"游戏UI"），命中可能只够 2-3 条，
  // 剩下名额空着——那说"设计""音效"时就一条相关技能都看不到。
  // 用自动分析出来的主题词兜底挑选，把名额填满，保证这座库的覆盖面在目录里是完整的。
  if (picked.length < cap && eff.source === 'manual') {
    const autoKw = analyzeLibrary(lib).keywords;
    if (autoKw.length) {
      const autoDf = buildDfMap(skills, lib, autoKw);
      const have = new Set(picked.map((x) => x.s.name));
      const extra = skills
        .filter((s) => !have.has(s.name))
        .map((s) => ({ s, score: scoreByKeywords(s, lib, autoDf, autoKw) || 0 }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
      // 补位时也用主题桶轮流，别再被单一主题占满
      const seenBucket = new Set(picked.map((x) => bucketOf(x.s)));
      for (const x of extra) {
        if (picked.length >= cap) break;
        const b = bucketOf(x.s);
        if (seenBucket.has(b)) continue;   // 优先补还没露面的主题
        seenBucket.add(b);
        picked.push(x);
      }
      // 还不够就按分数补
      for (const x of extra) {
        if (picked.length >= cap) break;
        if (!picked.includes(x)) picked.push(x);
      }
    }
  }

  return new Set(picked.map((x) => x.s.name));
}

/** 全库汇总：{ lib, skill } 对，按库顺序。 */
/**
 * 全库汇总（供 load / search / 索引使用）。
 *
 * 【重要】这里**不看 config.enabled**：总开关只控制"要不要进技能目录"，
 * 不该影响能不能取回。关掉总开关 = 目录里不显示，但用户点名 load / search
 * 仍然必须拿得到正文——这正是"省 token 不丢技能"的底线。
 * 库级的 enabled（单个库停用）也只影响目录，取回时仍可按名字找到。
 */
function allSkills() {
  const out = [];
  for (const lib of config.libraries) {
    for (const s of scanLibrary(lib)) out.push({ lib, skill: s });
  }
  return out;
}

/** 按名字找某条技能（load 用，跨库，忽略 enabled 状态）。 */
function findSkillByName(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  for (const lib of config.libraries) {
    for (const s of scanLibrary(lib)) {
      if (String(s.name).toLowerCase() === target) return { lib, skill: s };
    }
  }
  return null;
}

let ctxLog = () => {};
/** 宿主的目录缓存失效器 —— 配置一变就得调，否则宿主一直用旧目录（这是个真坑）。 */
let invalidateCatalog = () => {};

/** 配置有变化后统一调用：让宿主重新拉 list()。 */
function notifyCatalogChanged(reason) {
  try {
    scanCache.clear();
    analyzeCache.clear();
    invalidateCatalog();
    ctxLog('info', '目录已通知刷新：' + (reason || ''));
  } catch (e) {
    ctxLog('warn', '通知目录刷新失败: ' + (e && e.message));
  }
}

// ───────────────────────── 正文加载 ─────────────────────────

function readBody(file) {
  const text = readFileSync(file, 'utf8');
  // 去掉 frontmatter，正文即指令
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// ───────────────────────── 搜索 ─────────────────────────

/** 判断 needle 是否以「完整单词」形式出现在 hay 里（前后不是字母）。 */
function isWordBoundaryMatch(hay, needle) {
  const h = String(hay || '').toLowerCase();
  const n = String(needle || '').toLowerCase();
  if (!n) return false;
  let idx = h.indexOf(n);
  while (idx >= 0) {
    const before = idx === 0 ? '' : h[idx - 1];
    const after = idx + n.length >= h.length ? '' : h[idx + n.length];
    if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return true;
    idx = h.indexOf(n, idx + 1);
  }
  return false;
}

function searchSkills(q, limit = 12) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const { lib, skill } of allSkills()) {
    const tags = skillTags(skill);
    const topics = nameTopics(skill);
    const hay = (skill.name + ' ' + skill.description + ' ' + skill.whenToUse + ' ' + lib.name + ' ' + tags.join(' ')).toLowerCase();
    const nameLower = skill.name.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const tt = t.toLowerCase();
      // ① 中文说法 → 反查英文主题词（三张表一起用）
      const variants = new Set([tt]);
      for (const src of [CN_ALIAS, CN_COMMON, CN_VARIANT]) {
        for (const v of (src[tt] || [])) variants.add(String(v).toLowerCase());
        for (const v of (src[t] || [])) variants.add(String(v).toLowerCase());
      }

      // ①b 【动态学习】如果这个词在库里的中文标题/描述里出现过，
      //     把那段中文附近的英文词也加入候选——不需要预先写别名表。
      if (/[\u4e00-\u9fa5]/.test(tt)) {
        // 库里的技能若 description 或正文含这个中文词，它的英文主题也算命中
        for (const p of topics) {
          const cnOfTopic = EN_TO_CN[p] || [];
          if (cnOfTopic.some((cn) => cn.includes(tt) || tt.includes(cn))) variants.add(p);
        }
      }

      // ② 主题命中：技能名的主题段里有任一变体（含词形包含）
      const topicHit = topics.some((p) => {
        for (const v of variants) {
          if (p === v) return true;
          if (v.includes(' ') && p.includes(v.split(' ')[0])) return true;  // "double jump" → jump
          if (p.includes(v) || v.includes(p)) return true;
        }
        return (EN_TO_CN[p] || []).some((cn) => cn.toLowerCase() === tt || cn.includes(tt));
      });
      if (topicHit) score += 10;

      for (const v of variants) {
        if (nameLower.includes(v)) score += 5;
        if (tags.some((g) => g.toLowerCase() === v)) score += 3;
        // 文本命中分级：
        //   完整单词命中   → 4 分（最强）
        //   词干化后相等   → 4 分（deduction ↔ deductions，与完整单词同等）
        //   纯子串         → 1 分（不能给高，否则 art 命中 drafting 这类噪音）
        // 踩过的坑：原来写成 if (hay.includes) {...} else if (词干)，一旦 hay 含子串就
        // 永远进不到词干分支，deductions 永远匹配不上 deduction。
        if (hay.includes(v)) {
          const isWholeWord = isWordBoundaryMatch(hay, v);
          if (isWholeWord) {
            score += 4;
          } else if (/^[a-z]+$/.test(v) && v.length >= 4 && containsStemmed(hay, v)) {
            score += 4;              // 词干相等：和完整单词同权
          } else if (v.length >= 4) {
            score += 1;              // 真·子串：低分
          }
        } else if (/^[a-z]+$/.test(v) && v.length >= 4 && containsStemmed(hay, v)) {
          score += 4;                // 文本里没直接出现，但词干对得上
        }
      }

      // ③ 中文子串命中：用户打「多肉」，技能标签里有「多肉浇水」也该算数。
      //    这条是通用中文检索能work的关键（不依赖任何预置词表）。
      //
      //    ⚠️ 防误伤规则（重要）：
      //    安全起见，**单字不参与匹配**——否则用户说「阳光」，会命中标签「X光判读」
      //    里那个「光」字，把医学技能当成园艺技能。代价是「X光」「B超」这类
      //    只有两字的混排词需要靠完整标签命中（已在 skillTags 里解决）。
      if (tt.length >= 2 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(tt)) {
        for (const g of tags) {
          if (typeof g !== 'string' || g.length < 2) continue;
          if (!/[\u4e00-\u9fa5]/.test(g)) continue;   // 标签必须有汉字
          // 用户输入必须至少 2 字，且必须"完整地"出现在标签里（不是单字蹭到）
          if (g.includes(tt) && tt.length >= 2) { score += 8; break; }
          if (tt.includes(g) && g.length >= 2) { score += 5; break; }
        }
      }
    }
    if (score > 0) scored.push({ score, lib: lib.name, name: skill.name, description: skill.description, tags: tags.slice(0, 8), file: skill.file });
  }
  // 阈值：分数太低（只是描述里蹭到）的不返回，避免噪音占前排
  const max = scored.reduce((m, x) => Math.max(m, x.score), 0);
  const keep = scored.filter((x) => x.score >= Math.max(3, max * 0.25));
  keep.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return keep.slice(0, limit);
}

// ───────────────────────── 主装配 ─────────────────────────

export function apply(ctx) {
  ctxLog = (level, msg) => { try { ctx.logger[level](`[skill-jnkgg] ${msg}`); } catch { /* noop */ } };

  // 1) 技能 provider：list 交摘要（限量），get 读正文（懒加载）。
  try {
    ctx.skills.registerProvider((control) => {
      // 接住宿主的失效器：改配置/改库之后必须调它，否则目录一直是旧的
      try { if (typeof control?.invalidate === 'function') invalidateCatalog = control.invalidate } catch { /* noop */ }
      return {
      name: 'skill-jnkgg',
      async list() {
        const candidates = [];
        // 【总开关】关掉时一条都不进目录（但 load/search 仍可取回，见 allSkills 注释）
        if (!config.enabled) return candidates;
        // ① 每个库注册一条 router（库入口）：描述里带该库的关键词，
        //    这样用户说「做游戏」时，目录里这条就会命中，加载它拿到全库索引。
        for (const lib of config.libraries) {
          if (!lib.enabled) continue;
          const skills = scanLibrary(lib);
          if (!skills.length) continue;
          const eff = effectiveKeywords(lib);
          const manual = Array.isArray(lib.keywords) ? lib.keywords.filter(Boolean) : [];
          const auto = analyzeLibrary(lib).keywords;
          const det = detectTopic(lib, skills);

          // 【单一主题库】整库就一个领域（比如全是游戏开发）：
          // 不精挑、不写词表，直接把"这是做X的全套技能"讲清楚——
          // 用户说「做个游戏」就该整库可用，而不是先命中某个词再搜。
          if (det.single && det.topic) {
            candidates.push({
              name: `${lib.name}-library`,
              description: [
                `【${det.topic}全套技能库】共 ${skills.length} 条，覆盖${det.topic}的各个方面。`,
                `凡是${det.topic}相关的需求（哪怕只是其中一小块，比如界面、手感、音效、存档、关卡设计），都应该先加载这条拿全库索引，再按需取用。`,
                `索引按类别分组，加载后先看分组挑方向，再 skill_jnkgg load 取具体正文。`,
              ].join(''),
              whenToUse: `当任务涉及${det.topic}的任何方面时（${det.topic}整体、某个子系统、某个具体做法都算）`,
              provider: 'skill-jnkgg',
              source: 'library-router:' + lib.name,
              rank: 240,
              locator: `router:${lib.name}`,
              invocation: { modelInvocable: true, userInvocable: true },
            });
            continue;
          }

          // 【杂库】多个主题混放：才需要关键词精选 + 主题概览
          const seenKw = new Set();
          const allKw = [];
          for (const k of [...manual, ...auto]) {
            const t = String(k).trim();
            if (!t || seenKw.has(t.toLowerCase())) continue;
            seenKw.add(t.toLowerCase());
            allKw.push(t);
          }
          const manualText = manual.length ? `当前关注：${manual.join('、')}` : '';
          const autoCn = [];
          for (const w of auto.slice(0, 10)) for (const x of withChinese(w)) if (!autoCn.includes(x)) autoCn.push(x);
          const autoText = autoCn.length ? `库内主题：${autoCn.join('、')}` : '';
          const parts = [manualText, autoText].filter(Boolean);
          const kwText = parts.length ? parts.join('；') + '。' : '';

          const trigger = [];
          for (const w of allKw.slice(0, 8)) for (const x of withChinese(w)) if (!trigger.includes(x)) trigger.push(x);

          candidates.push({
            name: `${lib.name}-library`,
            description: `${kwText}技能库「${lib.name}」共 ${skills.length} 条，按需取用。问到${trigger.slice(0, 12).join('/') || '该库主题'}相关的事，先加载这条拿全库索引，再按名字取具体技能；索引里没有合适的就用 skill_jnkgg 的 search。`,
            whenToUse: trigger.length ? `当任务涉及 ${trigger.slice(0, 14).join('、')} 时` : undefined,
            provider: 'skill-jnkgg',
            source: 'library-router:' + lib.name,
            rank: 240,
            locator: `router:${lib.name}`,
            invocation: { modelInvocable: true, userInvocable: true },
          });
        }

        // ② 库内技能：关键词打分优先，确保露出来的是最相关的那几条
        for (const lib of config.libraries) {
          if (!lib.enabled) continue;
          const skills = scanLibrary(lib);
          if (!skills.length) continue;
          const visibleSet = pickVisible(lib, skills);
          for (const skill of skills) {
            const visible = visibleSet.has(skill.name);
            candidates.push({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse || undefined,
              provider: 'skill-jnkgg',
              source: 'library:' + lib.name,
              rank: visible ? 250 : 251,
              locator: skill.file,
              invocation: { modelInvocable: visible, userInvocable: true },
            });
          }
        }
        return candidates;
      },
      async get(candidate) {
        const loc = String(candidate.locator || '');
        // router 入口：正文 = 该库的完整索引（名字 + 一句描述 + 路径），
        // 让模型自己挑下一步要 load 哪条，不用把 77 条全塞进目录。
        if (loc.startsWith('router:')) {
          const libName = loc.slice('router:'.length);
          const lib = config.libraries.find((l) => l.name === libName);
          if (!lib) throw new Error('library not found: ' + libName);
          const skills = scanLibrary(lib);
          const kws = (lib.keywords || []).join('、') || '(未设置)';
          const det = detectTopic(lib, skills);

          // 按目录分组归类（skills/<group>/<skill>），让 77 条不是一个平铺长列表
          const root = String(lib.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
          const byGroup = new Map();
          for (const s of skills) {
            const rel = String(s.dir || '').replace(/\\/g, '/');
            let g = '';
            if (rel.startsWith(root)) {
              const seg = rel.slice(root.length).split('/').filter(Boolean);
              g = seg.length >= 2 ? seg[0] : '';
            }
            if (!g) g = '其它';
            if (!byGroup.has(g)) byGroup.set(g, []);
            byGroup.get(g).push(s);
          }

          const head = [
            `# 技能库「${lib.name}」索引`,
            '',
            det.single && det.topic ? `这是**${det.topic}**的全套技能库，共 ${skills.length} 条。` : `共 ${skills.length} 条技能。`,
            `路径根：${lib.path}`,
            '',
            '## 怎么用',
            `- 按下面的分组找方向 → 挑中哪条就 \`skill_jnkgg({ action: "load", name: "<技能名>" })\` 取完整正文（正文才是可执行的步骤）`,
            `- 不确定要哪条时：\`skill_jnkgg({ action: "search", q: "<中文或英文关键词>" })\``,
            `- 一次可以连续 load 多条（比如做游戏同时要 UI + 手感 + 存档）`,
            '',
          ];

          const body = [];
          // 分组名多是目录名（godot / disciplines / genres），给个中文说法，方便一眼挑方向
          const GROUP_CN = {
            godot: 'Godot 引擎', unity: 'Unity 引擎', unreal: '虚幻引擎', roblox: 'Roblox',
            bevy: 'Bevy (Rust)', pygame: 'pygame (Python)', phaser: 'Phaser', pixijs: 'PixiJS',
            threejs: 'three.js', defold: 'Defold', ebitengine: 'Ebitengine (Go)', love: 'LÖVE (Lua)',
            'web-engines': '网页游戏引擎', 'other-engines': '其它引擎',
            disciplines: '通用技术专题（AI/物理/音效/相机/存档/UI/手感等，跨引擎都适用）',
            genres: '游戏类型（平台跳跃/角色扮演/卡牌/视觉小说等）',
            workflows: '工作流程（美术资产/Game Jam 等）',
            '怎么用': '', '其它': '未分组',
          };
          for (const [g, arr] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
            const cn = GROUP_CN[g];
            body.push(cn ? `## ${g} — ${cn}（${arr.length} 条）` : `## ${g}（${arr.length} 条）`);
            for (const s of arr) {
              const cnTags = skillTags(s).filter((t) => /[\u4e00-\u9fa5]/.test(t) && t !== s.name).slice(0, 4);
              const tagText = cnTags.length ? `　[${cnTags.join('/')}]` : '';
              body.push(`- ${s.name} — ${s.description}${tagText}`);
            }
            body.push('');
          }

          const { rank, locator, ...summary } = candidate;
          return { ...summary, content: [...head, ...body].join('\n') };
        }
        const file = loc;
        if (!file || !existsSync(file)) throw new Error('skill file missing: ' + file);
        const { rank, locator, ...summary } = candidate;
        return { ...summary, content: readBody(file) };
      },
      };
    });
    ctxLog('info', 'provider 已注册');
  } catch (e) {
    ctxLog('warn', 'provider 注册失败（宿主 skills 接口变了？）: ' + (e && e.message));
  }

  // 2) 配置变更后让目录缓存失效
  ctx.effect(() => () => { scanCache.clear(); });

  // 3) tools：懒取，坏了不影响主体
  ctx.effect(() => {
    let tools = null;
    try { tools = ctx.get?.('tools') ?? null; } catch { tools = null; }
    if (!tools?.register) { ctxLog('info', 'tools 服务不可用，跳过工具注册'); return () => {}; }
    const dispose = tools.register({
      name: 'skill_jnkgg',
      description: [
        '技能库管家 —— 查看/搜索/加载挂在 dsh-skill-jnkgg 里的外部技能库（如 gamedev 77 条）。',
        'action:',
        '  status  库状态（每库条数、可见上限、目录占用）',
        '  search  按关键词搜全部技能（含没进目录的隐藏条目）→ 返回 name/库/描述/路径',
        '  load    按 name 加载技能正文全文（拿到即可照做；这就是"不遗忘"的取回通道）',
        '  list    列某个库的全部技能（action=list, lib=库名）',
        '  config  读配置；传 patch 则改（libraries/maxVisibleDefault/descMaxChars 等）',
        '  rescan  清缓存重扫',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['status', 'search', 'load', 'list', 'config', 'rescan', 'analyze'] },
          q: { type: 'string', description: 'search 关键词' },
          name: { type: 'string', description: 'load 的技能名' },
          lib: { type: 'string', description: 'list 的库名' },
          patch: { type: 'object', description: 'config 要改的字段' },
        },
      },
      async execute(params) {
        try {
          switch (params.action) {
            case 'rescan': notifyCatalogChanged('手动重扫'); return { ok: true, message: '已清缓存并通知宿主重扫' };
            case 'analyze': {
              const l = config.libraries.find((x) => x.name === params.lib);
              if (!l) return { ok: false, message: '没有这个库: ' + params.lib };
              analyzeCache.clear();
              return { ok: true, ...analyzeLibrary(l) };
            }
            case 'status': {
              const libs = config.libraries.map((l) => ({
                name: l.name, path: l.path, enabled: l.enabled, maxVisible: visibleCap(l),
                total: scanLibrary(l).length,
              }));
              return { ok: true, enabled: config.enabled, libraries: libs, descMaxChars: config.descMaxChars };
            }
            case 'list': {
              const l = config.libraries.find((x) => x.name === params.lib);
              if (!l) return { ok: false, message: '没有这个库: ' + params.lib };
              return { ok: true, lib: l.name, skills: scanLibrary(l).map((s) => ({ name: s.name, description: s.description.slice(0, 100) })) };
            }
            case 'search': {
              const hits = searchSkills(params.q);
              return { ok: true, count: hits.length, hits };
            }
            case 'load': {
              const found = findSkillByName(params.name);
              if (!found) return { ok: false, message: '没找到技能 ' + params.name + '，可先 search' };
              let body = readBody(found.skill.file);
              if (body.length > config.loadBodyLimit) body = body.slice(0, config.loadBodyLimit) + '\n…[截断]';
              return { ok: true, name: found.skill.name, lib: found.lib.name, file: found.skill.file, content: body };
            }
            case 'config': {
              if (params.patch) {
                const p = params.patch;
                if (p.libraries) config.libraries = p.libraries.map(normalizeLib).filter((l) => l.path);
                if (p.pickMode !== undefined) config.pickMode = p.pickMode === 'name' ? 'name' : 'keywords';
                for (const k of ['maxVisibleDefault', 'descMaxChars', 'scanTtlSec', 'loadBodyLimit']) if (p[k] !== undefined && Number.isFinite(+p[k]) && +p[k] >= 0) config[k] = +p[k];
                if (p.enabled !== undefined) config.enabled = !!p.enabled;
                saveConfig(config); notifyCatalogChanged('配置变更');
              }
              return { ok: true, config };
            }
            default: return { ok: false, message: '未知 action' };
          }
        } catch (e) {
          return { ok: false, message: 'skill_jnkgg 出错: ' + (e && e.message) };
        }
      },
    });
    return () => { try { dispose?.(); } catch { /* noop */ } };
  });

  // 4) HTTP 路由 + 设置页：懒取 webServer
  ctx.inject(['webServer'], (scoped) => scoped.effect(() => {
    let ws = null;
    try { ws = scoped.get?.('webServer') ?? scoped.webServer ?? null; } catch { ws = null; }
    if (!ws?.register) { ctxLog('info', 'webServer 不可用，跳过路由'); return () => {}; }
    const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const sendJson = (res, code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const sendHtml = (res, html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    };
    const readRequestBody = (req) => new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 4_000_000) req.destroy(); });
      req.on('end', () => resolve(buf));
      req.on('error', () => resolve(buf));
    });

    const PREFIX = '/api/skill-jnkgg';

    const dispose = ws.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        let url;
        try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return sendJson(res, 400, { ok: false }); }
        const tail = url.pathname.slice(PREFIX.length) || '/';
        const method = (req.method || 'GET').toUpperCase();
        try {
          if (tail === '/' || tail === '/page' || tail === '/page/') return sendHtml(res, PAGE_HTML);

          if (tail === '/status' && method === 'GET') {
            return sendJson(res, 200, {
              enabled: config.enabled,
              descMaxChars: config.descMaxChars,
              maxVisibleDefault: config.maxVisibleDefault,
              scanTtlSec: config.scanTtlSec,
              loadBodyLimit: config.loadBodyLimit,
              pickMode: config.pickMode,
              libraries: config.libraries.map((l) => {
                const eff = effectiveKeywords(l);
                return {
                  ...l,
                  total: scanLibrary(l).length,
                  maxVisible: visibleCap(l),
                  kwSource: eff.source,               // manual / auto / none
                  autoKeywords: l.keywords?.length ? [] : eff.keywords.slice(0, 10),
                };
              }),
            });
          }

          if (tail === '/skills' && method === 'GET') {
            const libName = url.searchParams.get('lib') || '';
            const out = [];
            for (const lib of config.libraries) {
              if (!lib.enabled) continue;
              if (libName && lib.name !== libName) continue;
              const skills = scanLibrary(lib);
              const visibleSet = pickVisible(lib, skills);
              for (const skill of skills) {
                out.push({
                  lib: lib.name, name: skill.name, description: skill.description,
                  visible: visibleSet.has(skill.name),
                  score: scoreByKeywords(skill, lib, buildDfMap(skills, lib, effectiveKeywords(lib).keywords), effectiveKeywords(lib).keywords),
                  keywords: lib.keywords || [],
                  file: skill.file,
                });
              }
            }
            return sendJson(res, 200, { count: out.length, skills: out });
          }

          if (tail === '/search' && method === 'GET') {
            return sendJson(res, 200, { hits: searchSkills(url.searchParams.get('q'), 30) });
          }

          if (tail === '/analyze' && method === 'POST') {
            const raw = await readRequestBody(req);
            let p = {};
            try { p = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { ok: false, message: 'JSON 解析失败' }); }
            const libName = p.lib;
            const lib = config.libraries.find((l) => l.name === libName);
            if (!lib) return sendJson(res, 404, { ok: false, message: '没有这个库: ' + libName });
            analyzeCache.clear();
            const r = analyzeLibrary(lib);
            return sendJson(res, 200, { ok: true, lib: libName, ...r });
          }

          if (tail === '/config' && method === 'POST') {
            const raw = await readRequestBody(req);
            let p = {};
            try { p = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { ok: false, message: 'JSON 解析失败' }); }
            if (p.libraries) {
              config.libraries = p.libraries.map(normalizeLib).filter((l) => l.path);
            }
            if (p.pickMode !== undefined) config.pickMode = p.pickMode === 'name' ? 'name' : 'keywords';
            for (const k of ['maxVisibleDefault', 'descMaxChars', 'scanTtlSec', 'loadBodyLimit']) {
              if (p[k] !== undefined && Number.isFinite(+p[k]) && +p[k] >= 0) config[k] = +p[k];
            }
            if (p.enabled !== undefined) config.enabled = !!p.enabled;
            saveConfig(config); notifyCatalogChanged('配置变更');
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 404, { ok: false, message: 'not found: ' + tail });
        } catch (e) {
          return sendJson(res, 500, { ok: false, message: String(e && e.message) });
        }
      },
    });
    return () => { try { dispose?.(); } catch { /* noop */ } };
  }));
}

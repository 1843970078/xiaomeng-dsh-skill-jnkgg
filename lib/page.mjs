/**
 * dsh-skill-jnkgg 设置页（同源 HTML，iframe 进 settings.section）。
 * 分区：① 状态总览 ② 库管理 ③ Token 预算 ④ 技能浏览/搜索 ⑤ 操作日志
 * 规矩（踩过坑）：路径反斜杠在模板串里要转义；抓页面 JS 语法要用实际下发的 HTML 验。
 */

export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技能库管家</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:18px 20px 40px; font:14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif;
         background:#f5f7fa; color:#1f2d3d; }
  h1 { font-size:19px; margin:0 0 4px; color:#0f2233; }
  .sub { color:#6b7f95; font-size:12.5px; margin-bottom:18px; }
  .card { background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;
          margin-bottom:16px; box-shadow:0 1px 2px rgba(16,42,67,.05); }
  .card h2 { font-size:15px; margin:0 0 10px; color:#1668dc; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  label { color:#4a5c70; font-size:13px; }
  input[type=text], input[type=number], select {
    background:#ffffff; color:#1f2d3d; border:1px solid #cfd8e3; border-radius:7px;
    padding:6px 9px; font-size:13px; outline:none; }
  input[type=text]:focus, input[type=number]:focus, select:focus { border-color:#1668dc; box-shadow:0 0 0 2px rgba(22,104,220,.12); }
  input[type=number] { width:90px; }
  input[type=text] { flex:1; min-width:220px; }
  button { background:#ffffff; color:#1668dc; border:1px solid #b6cdf0; border-radius:8px;
           padding:6px 14px; font-size:13px; cursor:pointer; transition:.15s; }
  button:hover { background:#eff5ff; border-color:#1668dc; }
  button.warn { background:#fff1f2; border-color:#f0b8c0; color:#c33b52; }
  button.warn:hover { background:#ffe3e7; }
  button.mini { padding:2px 9px; font-size:12px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:11.5px; }
  .pill.on  { background:#e8f8ee; color:#1a7f43; border:1px solid #b7e6c8; }
  .pill.off { background:#fdeff1; color:#b3384d; border:1px solid #f3c6cf; }
  .pill.vis { background:#eaf3ff; color:#1668dc; border:1px solid #bcd8fa; }
  .pill.hid { background:#fff8e6; color:#9a6c00; border:1px solid #f0ddaa; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#6b7f95; font-weight:normal; padding:5px 8px; border-bottom:1px solid #e2e8f0; background:#fafbfc; }
  td { padding:5px 8px; border-bottom:1px solid #f0f3f7; vertical-align:top; }
  tr:hover td { background:#fafcff; }
  td.desc { color:#54677d; max-width:520px; }
  code { background:#f1f4f8; color:#c0392b; padding:1px 5px; border-radius:4px; font-size:12.5px; }
  .muted { color:#8a9aad; font-size:12px; }
  .scorehot { color:#1668dc; font-weight:600; font-size:12.5px; }
  .stat { font-size:22px; font-weight:600; color:#0f2233; }
  .statbox { background:#f7f9fc; border:1px solid #e6ecf3; border-radius:10px; padding:8px 16px; min-width:120px; }
  .statbox .lbl { font-size:11.5px; color:#6b7f95; }
  #log { font:12px/1.5 Consolas,monospace; color:#4a5c70; background:#fafbfc;
         border:1px solid #eceff3; border-radius:8px; padding:8px 10px;
         max-height:150px; overflow:auto; white-space:pre-wrap; }
  .libitem { border:1px solid #e6ecf3; border-radius:10px; padding:10px 12px; margin:8px 0; background:#fbfcfe; }
  .libitem .path { font-family:Consolas,monospace; font-size:12px; color:#1668dc; word-break:break-all; }
  /* 总开关：真·拨动开关 */
  .switch { position:relative; display:inline-block; width:50px; height:26px; flex:0 0 auto; }
  .switch input { opacity:0; width:0; height:0; }
  .switch .slider { position:absolute; cursor:pointer; inset:0; background:#cfd8e3;
                    transition:.22s; border-radius:26px; }
  .switch .slider:before { position:absolute; content:""; height:20px; width:20px; left:3px; bottom:3px;
                           background:#fff; transition:.22s; border-radius:50%;
                           box-shadow:0 1px 3px rgba(0,0,0,.18); }
  .switch input:checked + .slider { background:#1668dc; }
  .switch input:checked + .slider:before { transform:translateX(24px); }
  .switch input:disabled + .slider { opacity:.5; cursor:not-allowed; }
</style>
</head>
<body>
  <h1>技能库管家 · dsh-skill-jnkgg</h1>
  <div class="sub">外部技能目录 → 挂进 DSH 技能体系。目录只露摘要（限量），正文用时才读盘；隐藏条目不删除，搜索/点名都能取回。</div>

  <div class="card">
    <h2>① 状态总览</h2>
    <div class="row" id="stats"></div>
    <div class="row" style="margin-top:12px; padding-top:12px; border-top:1px dashed #e2e8f0;">
      <label class="switch">
        <input type="checkbox" id="master_switch" onchange="toggleMaster(this.checked)">
        <span class="slider"></span>
      </label>
      <span id="master_label" style="font-size:14px; font-weight:600;">管家总开关</span>
      <span class="muted" id="master_hint"></span>
      <button onclick="loadAll()" style="margin-left:auto;">刷新</button>
    </div>
  </div>

  <div class="card">
    <h2>② 库管理</h2>
    <div id="libs"></div>
    <div class="row" style="margin-top:10px; border-top:1px dashed #223049; padding-top:10px;">
      <input type="text" id="newpath" placeholder="技能库路径，例如 D:\skills\my-library\skills">
      <input type="text" id="newname" placeholder="库名（留空自动取目录名）" style="flex:0 0 200px">
      <button onclick="addLib()">＋ 添加库</button>
    </div>
    <div class="muted">提示：一个库=一个含 SKILL.md 的目录树（支持 <代码>skills/分组/技能/SKILL.md</代码> 两层结构）。路径不存在时该库显示 0 条，不会报错。</div>
  </div>

  <div class="card">
    <h2>③ Token 预算</h2>
    <div class="row">
      <label>每库默认可见上限 <input type="number" id="c_maxVisible" min="0" value="8"></label>
      <label>摘要截断（字符） <input type="number" id="c_desc" min="40" value="160"></label>
      <label>扫描缓存（秒） <input type="number" id="c_ttl" min="0" value="10"></label>
      <label>挑选方式
        <select id="c_pick">
          <option value="keywords">按关键词打分</option>
          <option value="name">按名字字母序</option>
        </select>
      </label>
    </div>
    <div class="row">
      <label>load 正文上限（字符） <input type="number" id="c_body" min="10000" step="10000" value="200000"></label>
      <button onclick="saveBudget()">保存预算</button>
      <span class="muted">估算：目录每条约 (名称+摘要) ≈ 摘要长度/2 个汉字 token。上限×条数×库数 = 每轮固定开销。</span>
    </div>
  </div>

  <div class="card">
    <h2>④ 技能浏览</h2>
    <div class="row">
      <select id="libfilter" onchange="renderSkills()"><option value="">全部库</option></select>
      <input type="text" id="q" placeholder="搜索全部技能（含隐藏的）…" oninput="renderSkills()" style="flex:1">
      <span class="muted" id="skillcount"></span>
    </div>
    <div style="max-height:420px; overflow:auto;"><table id="skilltable"></table></div>
    <div class="muted" style="margin-top:6px">徽标：<span class="pill vis">进目录</span> 模型每轮看得见 · <span class="pill hid">隐藏</span> 不占目录，但 /名字、find、管家工具都能取回</div>
  </div>

  <div class="card">
    <h2>⑤ 操作日志</h2>
    <div id="log">就绪。</div>
  </div>

<script>
const API = '/api/skill-jnkgg';
let STATE = { libs: [], skills: [], budget: {} };

// 所有请求都走 /api/skill-jnkgg/<rel>，绝对路径，不看 baseURI（iframe 里 baseURI 是 page 自己）。
function url(rel){ const r = String(rel||'').replace(/^\/+/, ''); return API + (r ? '/' + r : '/'); }
function log(m){ const el=document.getElementById('log'); el.textContent = m + '\n' + el.textContent; }

async function getJSON(path){
  const r = await fetch(url(path));
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function post(payload){
  const r = await fetch(url('config'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  const j = await r.json();
  if (j.ok) log('已保存并生效（下次技能调用起）');
  else log('保存失败: ' + j.message);
  return j;
}

function renderStats(){
  const total = STATE.skills.length;
  const vis = STATE.skills.filter(s=>s.visible).length;
  const estTok = Math.round(STATE.skills.filter(s=>s.visible).reduce((a,s)=>a + (s.name.length + Math.min(s.description.length, STATE.budget.descMaxChars||160))/2, 0));
  document.getElementById('stats').innerHTML =
    '<div class="statbox"><div class="stat">' + STATE.libs.length + '</div><div class="lbl">库</div></div>' +
    '<div class="statbox"><div class="stat">' + total + '</div><div class="lbl">技能总数</div></div>' +
    '<div class="statbox"><div class="stat">' + vis + '</div><div class="lbl">进目录</div></div>' +
    '<div class="statbox"><div class="stat">≈' + estTok + '</div><div class="lbl">目录 token/轮（估）</div></div>';
  const sw = document.getElementById('master_switch');
  const on = !!STATE.budget.enabled;
  if (sw) sw.checked = on;
  const lbl = document.getElementById('master_label');
  if (lbl) { lbl.textContent = on ? '管家总开关：开' : '管家总开关：关'; lbl.style.color = on ? '#1a7f43' : '#b3384d'; }
  const hint = document.getElementById('master_hint');
  if (hint) hint.textContent = on
    ? '所有已启用的库都会进技能目录'
    : '全部隐藏：技能不进目录，但仍可用 /名字 或 skill_jnkgg load 取回';
}

function renderLibs(){
  const box = document.getElementById('libs'); box.innerHTML = '';
  STATE.libs.forEach((l, i) => {
    const div = document.createElement('div'); div.className = 'libitem';
    div.innerHTML =
      '<div class="row"><b>' + esc(l.name) + '</b> <span class="pill ' + (l.enabled?'on':'off') + '">' + (l.enabled?'启用':'停用') + '</span>' +
      '<span class="muted">' + l.total + ' 条 · 可见上限 ' + l.maxVisible + '</span></div>' +
      '<div class="path">' + esc(l.path) + '</div>' +
      '<div class="row">' +
        '<button class="mini" onclick="toggleLib(' + i + ')">' + (l.enabled?'停用':'启用') + '</button>' +
        '<label class="muted">可见上限 <input type="number" min="0" value="' + l.maxVisible + '" id="mv_' + i + '" style="width:70px"></label>' +
        '<button class="mini" onclick="renameLib(' + i + ')">改名</button>' +
        '<button class="mini warn" onclick="delLib(' + i + ')">移除</button>' +
      '</div>' +
      '<div class="row" style="margin-top:8px; align-items:flex-start;">' +
        '<span class="muted" style="white-space:nowrap; padding-top:6px;">检索关键词</span>' +
        '<input type="text" id="kw_' + i + '" value="' + esc((l.keywords||[]).join(' ')) + '" placeholder="空格分隔，越靠前权重越高；中英文都行。例：做游戏 平台跳跃 美化UI 音效">' +
        '<button class="mini" onclick="saveKeywords(' + i + ')">保存</button>' +
      '</div>' +
      '<div class="row" style="margin-top:2px">' +
        '<span class="muted" id="kwhint_' + i + '">' + kwHint(l) + '</span>' +
      '</div>' +
      '<div class="row" style="margin-top:4px">' +
        '<button class="mini" onclick="autoAnalyze(' + i + ')">🔍 自动分析本库</button>' +
        '<span class="muted" id="autobox_' + i + '">' + autoHint(l) + '</span>' +
      '</div>';
    box.appendChild(div);
  });
  if (!STATE.libs.length) box.innerHTML = '<div class="muted">还没有库。下面添加一个。</div>';
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderSkills(){
  const lib = document.getElementById('libfilter').value;
  const q = document.getElementById('q').value.toLowerCase().trim();
  const terms = q ? q.split(/\s+/) : [];
  let rows = STATE.skills.filter(s => (!lib || s.lib===lib));
  if (terms.length) rows = rows.filter(s => { const hay=(s.name+' '+s.description+' '+s.lib).toLowerCase(); return terms.every(t=>hay.includes(t)); });
  document.getElementById('skillcount').textContent = rows.length + ' 条';
  const tb = document.getElementById('skilltable');
  tb.innerHTML = '<tr><th>技能</th><th>库</th><th>状态</th><th style="width:70px">命中分</th><th class="desc">摘要</th></tr>' +
    rows.slice(0, 300).map(s => {
      const sc = (typeof s.score === 'number') ? s.score : null;
      const scTxt = sc === null ? '—' : String(sc);
      return '<tr><td><code>' + esc(s.name) + '</code></td><td class="muted">' + esc(s.lib) + '</td>' +
        '<td><span class="pill ' + (s.visible?'vis':'hid') + '">' + (s.visible?'进目录':'隐藏') + '</span></td>' +
        '<td class="' + (sc>0?'scorehot':'muted') + '">' + scTxt + '</td>' +
        '<td class="desc">' + esc(s.description) + '</td></tr>';
    }).join('');
}

async function loadAll(){
  try {
    const [st, sk] = await Promise.all([getJSON('status'), getJSON('skills')]);
    STATE.libs = st.libraries || [];
    STATE.budget = st;
    STATE.skills = sk.skills || [];
    const sel = document.getElementById('libfilter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部库</option>' + STATE.libs.map(l=>'<option>'+esc(l.name)+'</option>').join('');
    sel.value = cur;
    document.getElementById('c_maxVisible').value = st.maxVisibleDefault;
    document.getElementById('c_desc').value = st.descMaxChars;
    document.getElementById('c_ttl').value = st.scanTtlSec;
    document.getElementById('c_body').value = st.loadBodyLimit;
    document.getElementById('c_pick').value = st.pickMode || 'keywords';
    renderStats(); renderLibs(); renderSkills();
  } catch(e){ log('加载失败: ' + e.message); }
}

function currentLibs(){ return STATE.libs.map(l=>({ path:l.path, name:l.name, enabled:l.enabled, maxVisible:l.maxVisible, keywords:l.keywords||[] })); }

/** 总开关：立即生效，不用保存别的字段 */
async function toggleMaster(on){
  const lbl = document.getElementById('master_label');
  if (lbl) { lbl.textContent = on ? '管家总开关：开' : '管家总开关：关'; lbl.style.color = on ? '#1a7f43' : '#b3384d'; }
  const hint = document.getElementById('master_hint');
  if (hint) hint.textContent = '正在切换…';
  await post({ enabled: !!on });
  await loadAll();
  log(on ? '总开关已打开：所有启用库进目录' : '总开关已关闭：全部隐藏，仍可取回');
}

/** 库卡片上那行小提示：说明当前按什么规则挑进目录 */
function kwHint(l){
  const kws = l.keywords || [];
  const mode = STATE.budget.pickMode === 'name' ? '按名字序' : '按关键词';
  if (mode === '按名字序') return '当前：按名字字母序挑 ' + l.maxVisible + ' 条（可在上方「挑选方式」切回关键词）';
  if (!kws.length) return '还没设关键词 → 现在退回名字序。设了之后：命中最多的优先进目录，其余靠库入口索引/search 取回。';
  return '当前按 ' + kws.length + ' 个关键词打分挑 ' + l.maxVisible + ' 条：' + kws.join(' / ');
}

/** 库卡片上那行自动分析结果 */
function autoHint(l){
  if (l.kwSource === 'manual') return '（当前用手动关键词，点自动分析可看它自己会挖出什么）';
  if (l.kwSource === 'auto' && (l.autoKeywords||[]).length) return '自动提取：' + l.autoKeywords.slice(0,8).join(' / ');
  return '未设关键词时，会自动分析本库内容找主题词';
}

/** 一键自动分析这个库，把结果填进输入框（不自动保存，确认后再存） */
async function autoAnalyze(i){
  const lib = STATE.libs[i];
  const box = document.getElementById('autobox_' + i);
  if (box) box.textContent = '分析中…';
  try {
    const r = await fetch(url('analyze'), {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ lib: lib.name }),
    });
    const j = await r.json();
    if (!j.ok) { if (box) box.textContent = '分析失败：' + (j.message||''); return; }
    const kws = j.keywords || [];
    document.getElementById('kw_' + i).value = kws.join(' ');
    if (box) box.innerHTML = '<b>已填好 '+kws.length+' 个主题词</b>（共读 '+j.stats.total+' 条技能）—— 看看合不合适，合适就点「保存」';
    log('自动分析「'+lib.name+'」→ '+kws.join(' / '));
  } catch(e){ if (box) box.textContent = '分析出错：' + e.message; }
}

/** 保存某个库的关键词 */
async function saveKeywords(i){
  const raw = document.getElementById('kw_'+i).value || '';
  const kws = raw.split(/[,，、\s]+/).map(x=>x.trim()).filter(Boolean);
  const libs = currentLibs();
  libs[i].keywords = kws;
  await post({ libraries: libs });
  await loadAll();
}

async function addLib(){
  const p = document.getElementById('newpath').value.trim();
  const n = document.getElementById('newname').value.trim();
  if(!p){ log('路径不能为空'); return; }
  const libs = currentLibs();
  libs.push({ path:p, name:n||undefined, enabled:true });
  await post({ libraries: libs });
  document.getElementById('newpath').value=''; document.getElementById('newname').value='';
  await loadAll();
}
async function delLib(i){ const libs=currentLibs(); libs.splice(i,1); await post({libraries:libs}); await loadAll(); }
async function toggleLib(i){ const libs=currentLibs(); libs[i].enabled=!libs[i].enabled; await post({libraries:libs}); await loadAll(); }
async function renameLib(i){
  const n = prompt('新库名：', STATE.libs[i].name); if(!n) return;
  const libs=currentLibs(); libs[i].name=n; await post({libraries:libs}); await loadAll();
}
async function saveBudget(){
  const libs = currentLibs();
  libs.forEach((l,i)=>{ const el=document.getElementById('mv_'+i); if(el) l.maxVisible = parseInt(el.value)||0; });
  await post({
    libraries: libs,
    maxVisibleDefault: parseInt(document.getElementById('c_maxVisible').value)||8,
    descMaxChars: parseInt(document.getElementById('c_desc').value)||160,
    scanTtlSec: parseInt(document.getElementById('c_ttl').value)||10,
    loadBodyLimit: parseInt(document.getElementById('c_body').value)||200000,
    pickMode: document.getElementById('c_pick').value,
  });
  await loadAll();
}

loadAll();
</script>
</body>
</html>`;

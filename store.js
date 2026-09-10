/* ============================================================
   风老师·言语理解 —— 记忆 / 设置 / 错题本 / 统计（本地持久化）
   localStorage 存储；node 环境自动退化为内存（供 engine-test）。
   ============================================================ */
(function () {
  // ---- 安全存储（浏览器 localStorage / node 内存）----
  const mem_ = new Map();
  function sget(k) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k);
    } catch (e) {}
    return mem_.has(k) ? mem_.get(k) : null;
  }
  function sset(k, v) {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.setItem(k, v); return; }
    } catch (e) {}
    mem_.set(k, v);
  }

  const LS = {
    cfg: 'feng_cfg_v1',
    mem: 'feng_mem_v1',
    wb: 'feng_wrongbook_v1'
  };

  function loadJSON(k, def) {
    try { const r = sget(k); return r ? JSON.parse(r) : def; } catch (e) { return def; }
  }
  function saveJSON(k, v) { sset(k, JSON.stringify(v)); }

  // ---- 配置 ----
  const CFG_DEFAULT = {
    mode: 'online',            // online | ollama
    depth: 'normal',           // brief | normal | deep
    ctxTurns: 4,               // 携带上文的最近消息条数（0=关闭）
    theme: 'auto',             // light | dark | auto
    online: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vl: '', key: '' },
    ollama: { base: 'http://localhost:11434/v1', model: 'qwen2.5:7b', vl: 'qwen2.5-vl:7b' }
  };
  function getCfg() {
    const c = loadJSON(LS.cfg, null);
    if (!c) return JSON.parse(JSON.stringify(CFG_DEFAULT));
    const d = JSON.parse(JSON.stringify(CFG_DEFAULT));
    const m = Object.assign({}, d, c || {});
    m.online = Object.assign({}, d.online, (c && c.online) || {});
    m.ollama = Object.assign({}, d.ollama, (c && c.ollama) || {});
    return m;
  }
  function saveCfg(patch) {
    const c = getCfg();
    const merged = Object.assign({}, c, patch);
    if (patch && patch.online) merged.online = Object.assign({}, c.online, patch.online);
    if (patch && patch.ollama) merged.ollama = Object.assign({}, c.ollama, patch.ollama);
    saveJSON(LS.cfg, merged);
    return merged;
  }

  // ---- 记忆（薄弱点加权）----
  const TYPES = globalThis.FENG.TYPES;
  function freshTypes() {
    const t = {};
    TYPES.forEach((x) => (t[x.key] = { n: 0, wrong: 0, master: false, lastTs: 0 }));
    return t;
  }
  function defaultMem() {
    return { types: freshTypes(), traps: {}, log: [], lastReview: 0 };
  }
  function getMem() {
    const m = loadJSON(LS.mem, null);
    if (m && m.types) return m;
    const d = defaultMem(); saveJSON(LS.mem, d); return d;
  }
  function saveMem(m) { saveJSON(LS.mem, m); }

  let attemptSeq = 0;
  function recordAttempt(type, ok) {
    const m = getMem();
    if (!m.types[type]) type = 'center';
    const t = m.types[type];
    t.n += 1; if (!ok) t.wrong += 1; t.lastTs = Date.now();
    const id = 'a' + String(++attemptSeq) + '_' + Date.now();
    m.log.unshift({ id, type, ok: !!ok, ts: Date.now(), point: '', trap: '' });
    if (m.log.length > 300) m.log.length = 300;
    saveMem(m);
    return id;
  }
  function tagAttempt(id, tags) {
    const m = getMem();
    const it = m.log.find((x) => x.id === id);
    if (!it) return;
    if (tags.point) it.point = tags.point;
    if (tags.trap) {
      it.trap = tags.trap;
      tags.trap.split(/[、,，\/]/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
        m.traps[s] = (m.traps[s] || 0) + 1;
      });
    }
    saveMem(m);
  }
  function recentLog(type, limit) {
    const m = getMem();
    const arr = type ? m.log.filter((x) => x.type === type) : m.log;
    return arr.slice(0, limit || arr.length);
  }
  // 薄弱得分 0..1：近况错率×0.6 + 总体错率×0.4；已掌握压到 0.1；做得太少给温和底分
  function typeScore(type) {
    const m = getMem();
    const t = m.types[type];
    if (!t || t.n === 0) return 0;
    let base = t.wrong / t.n;
    const rec = m.log.filter((x) => x.type === type).slice(0, 8);
    const recErr = rec.length ? rec.filter((x) => !x.ok).length / rec.length : base;
    let s = recErr * 0.6 + base * 0.4;
    if (t.master) s *= 0.12;
    if (t.n < 2) s = Math.min(s, 0.18);   // 数据少不抬太高
    return Math.round(s * 100) / 100;
  }
  function weakOrder() {
    return TYPES
      .map((t) => ({ key: t.key, label: t.label, score: typeScore(t.key), n: getMem().types[t.key].n, wrong: getMem().types[t.key].wrong }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }
  // 供系统提示词注入的薄弱点简报
  function weakReport(limit) {
    const w = weakOrder();
    if (!w.length) return '';
    const top = w.slice(0, limit || 3).map((x) => x.label + (x.n ? '(' + x.wrong + '/' + x.n + '错)' : '')).join('、');
    return '你最近比较薄弱/易错的题型：' + top + '。讲解与出题时可优先针对这些题型与坑点。';
  }
  function markMaster(type, on) {
    const m = getMem();
    if (!m.types[type]) return;
    m.types[type].master = !!on;
    if (on) { m.types[type].wrong = Math.max(0, m.types[type].wrong); }
    saveMem(m);
  }
  function topTraps(limit) {
    const m = getMem();
    return Object.keys(m.traps).map((k) => ({ k, v: m.traps[k] })).sort((a, b) => b.v - a.v).slice(0, limit || 5);
  }
  function clearMemory() {
    const wb = getWB();
    saveJSON(LS.mem, defaultMem());
    return wb; // 调用方决定是否也清错题本
  }

  // ---- 今日小结 ----
  function dayStats() {
    const m = getMem();
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const todays = m.log.filter((x) => x.ts >= start);
    const ok = todays.filter((x) => x.ok).length;
    const wrong = m.log.filter((x) => !x.ok).length; // 累计错
    const total = m.log.filter((x) => x).length;
    return {
      todayCount: todays.length,
      todayOk: ok,
      todayWrong: todays.length - ok,
      todayRate: todays.length ? Math.round((ok / todays.length) * 100) : 0,
      total, wrong, wbCount: getWB().length
    };
  }
  function summaryText() {
    const s = dayStats();
    const w = weakOrder();
    const top = w.slice(0, 3).map((x) => x.label).join('、') || '暂无明显薄弱项';
    let t = '【学习小结】\n';
    t += '今天一共作答 ' + s.todayCount + ' 题，答对 ' + s.todayOk + ' 题，正确率 ' + s.todayRate + '%。\n';
    if (!s.todayCount) t += '今天还没做题——不妨现在来一组，破题点圈起来就好。\n';
    t += '当前最需要补的是：' + top + '。\n';
    const traps = topTraps(2);
    if (traps.length) t += '最近反复踩的坑：' + traps.map((x) => x.k).join('、') + '，下次见着多留个心眼。\n';
    t += '别盯着准确率，盯住破题点圈对没有。思多乱其志，实干出真知——今日低头是题海，他日抬头是上岸。';
    return t;
  }

  // ---- 错题本 ----
  function getWB() { return loadJSON(LS.wb, []); }
  function saveWB(arr) { saveJSON(LS.wb, arr); }
  function addWB(entry) {
    const arr = getWB();
    entry = Object.assign({ id: 'w' + Date.now() + '_' + Math.floor(Math.random() * 1e4), ts: Date.now(), master: false }, entry);
    arr.unshift(entry);
    if (arr.length > 600) arr.length = 600;
    saveWB(arr);
    return entry;
  }
  function patchWB(id, patch) {
    const arr = getWB();
    const it = arr.find((x) => x.id === id);
    if (!it) return;
    Object.assign(it, patch);
    saveWB(arr);
  }
  function delWB(id) {
    saveWB(getWB().filter((x) => x.id !== id));
  }
  function exportWB(format) {
    const arr = getWB();
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
      downloadBlob(blob, '风老师错题本_' + dateStamp() + '.json');
      return;
    }
    let md = '# 风老师·言语理解 错题本\n\n';
    if (!arr.length) md += '（暂无错题）\n';
    arr.forEach((x, i) => {
      md += '## ' + (i + 1) + '. [' + (globalThis.FENG.TYPE_OF[x.type] || x.type) + '] ' + (x.stem || '').slice(0, 40) + '\n\n';
      md += '- 题干：' + (x.stem || '') + '\n';
      md += '- 你的选择：' + (x.user || '—') + '　正确：' + (x.correct || '—') + '\n';
      md += '- 踩坑：' + (x.trap || '—') + '\n';
      md += '- 掌握：' + (x.master ? '已掌握' : '仍薄弱') + '　日期：' + (x.date || '') + '\n\n';
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, '风老师错题本_' + dateStamp() + '.md');
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function dateStamp() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  globalThis.FStore = {
    CFG_DEFAULT, getCfg, saveCfg,
    recordAttempt, tagAttempt, recentLog, typeScore, weakOrder, weakReport,
    markMaster, topTraps, clearMemory, dayStats, summaryText, getMem,
    getWB, addWB, patchWB, delWB, exportWB, fmtDate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.FStore;
})();

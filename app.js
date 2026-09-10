/* ============================================================
   风老师·言语理解 —— 应用编排（识图 / 出题 / 记忆 / 错题本 /
   速查 / 讲义RAG / 设置 / 会话持久化 / PWA）
   ============================================================ */
(function () {
  if (typeof window === 'undefined') return; // 仅供浏览器
  const $ = (s) => document.querySelector(s);
  const FUI = globalThis.FUI, FStore = globalThis.FStore, FLLM = globalThis.FLLM;
  const FENG = globalThis.FENG, BANK = globalThis.FENG_BANK || [];

  let cfg = FStore.getCfg();
  let msgs = [];                 // 当前会话消息
  let sessionId = '';
  let busy = false;
  let abort = null;
  let currentQ = null;           // {msgId, entry, letter}
  const recent = [];             // 本会话最近出过的题 id，避免立刻重复
  let rags = [];                 // [{id,name,text}]
  let deferredInstall = null;

  // ============================ IndexedDB ============================
  function openDB() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('feng_db', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  let dbP = null;
  function db() { if (!dbP) dbP = openDB(); return dbP; }
  function idbPut(k, v) { return db().then((d) => new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); })); }
  function idbGet(k) { return db().then((d) => new Promise((res) => { const t = d.transaction('kv'); const rq = t.objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(undefined); })); }

  // ============================ 会话持久化 ============================
  async function saveSession() {
    try { await idbPut('session:' + sessionId, msgs); } catch (e) {}
    try {
      let list = (await idbGet('sessionList')) || [];
      if (!list.includes(sessionId)) { list.unshift(sessionId); list = list.slice(0, 12); await idbPut('sessionList', list); }
    } catch (e) {}
  }
  const saveSessionT = (function () { let t; return function () { clearTimeout(t); t = setTimeout(saveSession, 300); }; })();

  function typeOfBank() {
    const m = {}; BANK.forEach((b) => { m[b.type] = (m[b.type] || 0) + 1; }); return m;
  }

  // ============================ 基础 UI ============================
  function addMsgEl(item) {
    const chat = $('#chat');
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + item.role;
    if (item.role === 'sys') { wrap.classList.remove('msg'); wrap.className = 'sysnote'; }
    const av = document.createElement('div');
    av.className = 'av';
    av.textContent = item.role === 'user' ? '我' : (item.role === 'sys' ? '' : '风');
    const bub = document.createElement('div');
    bub.className = 'bubble';
    if (item.role === 'sys') bub.className = 'bub';
    wrap.appendChild(av);
    wrap.appendChild(bub);
    if (item.kind === 'quiz') { renderQuiz(item, bub, wrap); }
    else {
      if (item.image) {
        const im = document.createElement('img');
        im.src = item.image; im.alt = '题目图片';
        bub.appendChild(im);
        if (item.text) { const c = document.createElement('div'); c.className = 'cap'; c.textContent = item.text; bub.appendChild(c); }
      } else if (item.text) { bub.innerHTML = FUI.mdToHtml(item.text); }
    }
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return { wrap, bub };
  }
  function renderAll() {
    const chat = $('#chat'); chat.innerHTML = '';
    msgs.forEach((m) => addMsgEl(m));
    chat.scrollTop = chat.scrollHeight;
  }

  function pushMsg(item, save) {
    msgs.push(item);
    addMsgEl(item);
    if (save !== false) saveSessionT();
    return item;
  }
  function findElByText(text) { return null; } // 占位

  function typingBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const av = document.createElement('div'); av.className = 'av'; av.textContent = '风';
    const bub = document.createElement('div'); bub.className = 'bubble';
    bub.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    wrap.appendChild(av); wrap.appendChild(bub);
    $('#chat').appendChild(wrap);
    $('#chat').scrollTop = $('#chat').scrollHeight;
    return { wrap, bub };
  }
  function scrollBottom() { $('#chat').scrollTop = $('#chat').scrollHeight; }

  // ============================ 系统提示 ============================
  function typeKeyOf(text) {
    // 粗判文本可能命中的题型（仅用于注入 KB 参考）
    const map = [['中心理解','片段阅读','主旨','意图','中心理解'],['逻辑填空','填入横线','成语','词语'],['标题'],['细节','相符','正确','推出'],['排序','语序'],['接语','接下来','下文'],['词句理解','含义','指代'],['篇章','材料','第几段'],['语句填空','画横线']];
    for (const item of map) { if (text && text.includes(item[0])) return item[1] ? item[1] : item[0]; }
    return '';
  }
  function ragContext(q, k) {
    if (!cfg.ragOn) return '';
    if (!q) return '';
    const hits = searchRag(q, k || 3);
    if (!hits.length) return '';
    return '\n【上传讲义检索到以下相关片段，讲解时可作参考，不要照抄】\n' +
      hits.map((h) => '· [' + h.name + '] …' + h.snippet + '…').join('\n') + '\n';
  }
  function composeSys(extra) {
    const depthName = { brief: '简洁', normal: '标准', deep: '深度精讲' }[cfg.depth] || '标准';
    let sys = globalThis.FENG_PERSONA;
    sys += '\n\n【当前学生所选讲解档位：' + depthName + '】遇到具体题目按该档位篇幅讲解。';
    const wr = FStore.weakReport(3);
    if (wr) sys += '\n' + wr;
    if (extra && extra.kb) sys += '\n\n【以下是风老师知识点卡中与本题/本知识点相关的资料，讲解时贴合它】\n' + extra.kb;
    if (extra && extra.rag) sys += extra.rag;
    return sys;
  }
  function kbCardsForType(typeKey, n) {
    const arr = FENG.KB.filter((c) => !typeKey || c.type === typeKey || c.type === 'center');
    // 同题型优先，再补中心理解通用卡
    arr.sort((a, b) => (a.type === typeKey ? 0 : 1) - (b.type === typeKey ? 0 : 1));
    return arr.slice(0, n || 2).map((c) => '〔' + FENG.TYPE_OF[c.type] + '·' + c.title + '〕' + c.body + (c.ex ? '（' + c.ex + '）' : '')).join('\n');
  }

  // 组装上文（文字のみ，图片不入历史；按条数 + 总字数双重限幅，控制 token）
  function buildHistory(skipLast) {
    const n = Number(cfg.ctxTurns || 0);
    if (!n) return [];
    const arr = [];
    let budget = 2400; // 历史总字数上限
    for (let i = msgs.length - 1 - (skipLast ? 1 : 0); i >= 0 && arr.length < n; i--) {
      const m = msgs[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (m.kind === 'quiz') continue;          // 题目本身太长，不塞历史
      let t = String(m.text || '').trim();
      if (!t) continue;                          // 纯图片消息跳过
      if (t.length > 700) t = t.slice(0, 700) + '…';
      if (t.length > budget) continue;
      budget -= t.length;
      arr.unshift({ role: m.role, text: t });
    }
    return arr;
  }

  // ============================ 对话/识图 核心 ============================
  async function streamAnswer(userText, opts) {
    opts = opts || {};
    if (busy) return;
    busy = true;
    updateSendUI();
    const tb = typingBubble();
    let outEl = tb.bub, outWrap = tb.wrap;
    outWrap.remove(); // typing 先移除，下面重建正式流式气泡
    const wrap = document.createElement('div'); wrap.className = 'msg assistant';
    const av = document.createElement('div'); av.className = 'av'; av.textContent = '风';
    const bub = document.createElement('div'); bub.className = 'bubble';
    bub.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    wrap.appendChild(av); wrap.appendChild(bub);
    $('#chat').appendChild(wrap);
    scrollBottom();
    outWrap = wrap; outEl = bub;

    const ragQ = opts.ragQuery === undefined ? userText : opts.ragQuery;
    const sys = composeSys({ kb: opts.kb, rag: ragContext(ragQ, 3) });
    const depthTag = '（按' + ({ brief: '简洁', normal: '标准', deep: '深度精讲' })[cfg.depth] + '档讲解）';
    const prompt = opts.prompt || (userText + '\n' + depthTag);
    abort = new AbortController();
    let full = '';
    let succeeded = false;
    try {
      const skipLast = !!(msgs.length && msgs[msgs.length - 1].role === 'user');
      const hist = buildHistory(skipLast);
      await FLLM.chat({
        messages: [{ role: 'system', text: sys }, ...hist, { role: 'user', text: prompt }],
        image: opts.image, signal: abort.signal,
        onDelta: (d) => { full += d; outEl.innerHTML = FUI.mdToHtml(full); scrollBottom(); },
        onReset: () => { full = ''; outEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; }
      });
      const parsed = FUI.parseTags(full);
      const show = parsed.clean || full;
      if (parsed.clean) outEl.innerHTML = FUI.mdToHtml(parsed.clean);
      else outEl.innerHTML = FUI.mdToHtml(full);
      scrollBottom();
      succeeded = true;
      const item = { role: 'assistant', text: show };
      msgs.push(item);
      addMsgEl(item);
      saveSessionT();
      outWrap.remove(); // 移除临时流式气泡，改由持久化渲染
      if (opts.onDone) { try { opts.onDone(parsed.tags); } catch (e) {} }
    } catch (e) {
      outEl.innerHTML = '';
      const em = document.createElement('p');
      em.style.color = '#b0483c';
      em.textContent = (e && e.message) || '出错了';
      outEl.appendChild(em);
      const h = document.createElement('p');
      h.className = 'cap';
      h.textContent = '可打开右上「☰ → 设置」检查 API Key / Ollama 是否就绪；识图问题请确认视觉模型支持图片。';
      outEl.appendChild(h);
      scrollBottom();
    } finally {
      busy = false;
      abort = null;
      updateSendUI();
    }
    return succeeded ? full : '';
  }

  // 发送文本
  async function onSend() {
    const t = $('#q').value.trim();
    if (!t || busy) return;
    $('#q').value = ''; autoGrow();
    pushMsg({ role: 'user', text: t });
    await streamAnswer(t);
  }

  // 识图
  function pickImage(capture) {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/*';
    if (capture) i.setAttribute('capture', capture);
    i.onchange = async () => {
      const f = i.files && i.files[0];
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return FUI.toast('图片太大，请选一张小于 15MB 的');
      FUI.toast('正在裁剪…');
      const dataUrl = await FUI.fileToDataURL(f);
      const cropped = await FUI.openCropper(dataUrl, '4:5');
      if (!cropped) return;
      const blur = await FUI.detectBlur(cropped);
      if (blur > 0 && blur < 20) {
        const use = await modalAsk('这张图可能有点糊', '识别的清晰度可能不够，尤其是选项文字。建议重新拍一张对焦清楚的照片。', '仍要用这张', '重新拍');
        if (!use) { pickImage(capture); return; }
      }
      // 统一成规范 JPEG（≤1280px）；若裁得过窄则补足最小边长（Qwen3-VL 要求边长 > 28）
      const norm = await FUI.compressDataURL(cropped, 1280, 0.86);
      let img = norm.data;
      if (Math.min(norm.w, norm.h) < 32) {
        img = await FUI.ensureMinEdge(img, 64);
        FUI.toast('裁剪区域太窄，已自动补足尺寸');
      }
      const typed = $('#q').value.trim();
      $('#q').value = ''; autoGrow();
      pushMsg({ role: 'user', image: img, text: typed || '帮我读题并精讲（识图）' });
      const prompt = typed
        ? typed
        : '请仔细看这张题目图片：先把题干、问法、ABCD 完整准确地读出来（如果有残缺或看不清请先提醒），然后按当前档位走「答题固定流程」给我完整精讲。';
      const first = await streamAnswer(prompt || '请精讲这张图片的题目', { image: img, ragQuery: '' });
      if (!first) {
        // 首次失败：可能是图片偏大/格式受限——自动压小再试一次（760px / 质量 0.7）
        FUI.toast('首次识图失败，正在压缩图片后自动重试一次…');
        const small = await FUI.compressDataURL(img, 760, 0.7);
        await streamAnswer(prompt || '请精讲这张图片的题目（图片已压缩）', { image: small.data, ragQuery: '' });
      }
    };
    i.click();
  }

  // ============================ 出题 ============================
  const BANK_BY_TYPE = (() => { const m = {}; BANK.forEach((b) => { (m[b.type] = m[b.type] || []).push(b); }); return m; })();

  function openQuizSheet() {
    const counts = typeOfBank();
    const mask = document.createElement('div');
    mask.className = 'sheet-mask';
    let grid = '';
    FENG.TYPES.forEach((t) => {
      const c = counts[t.key] || 0;
      grid += '<button data-type="' + t.key + '" ' + (c ? '' : 'disabled') + '>' + t.label + (c ? ' (' + c + ')' : '') + '</button>';
    });
    mask.innerHTML =
      '<div class="sheet">' +
      '<h3>随机出题 · 言语理解</h3>' +
      '<div class="sub">题目只显示题干与选项，作答后再由风老师按你的薄弱点精讲复盘。</div>' +
      '<div class="rows">' +
      '<button class="srow" data-w="weak"><div><div class="lbl">按我的薄弱点出题</div><div class="sub2">优先命中最近常错的题型与坑</div></div></button>' +
      '<button class="srow" data-w="rand"><div><div class="lbl">随机一道</div><div class="sub2">从精选真题库随机抽（已收录 ' + BANK.length + ' 道）</div></div></button>' +
      '</div>' +
      '<div class="sub" style="margin-top:12px">或按题型出：</div>' +
      '<div class="typegrid">' + grid + '</div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) { mask.remove(); return; }
      const w = e.target.closest('[data-w]');
      if (w) { mask.remove(); if (w.dataset.w === 'weak') beginQuizPick(true); else beginQuizPick(false); return; }
      const tg = e.target.closest('[data-type]');
      if (tg && !tg.disabled) { mask.remove(); beginQuizOfType(tg.dataset.type); }
    });
  }

  function pickEntry(pool) {
    const avail = pool.filter((b) => !recent.includes(b.id));
    const p = avail.length ? avail : pool.slice();
    if (!p.length) return null;
    const e = p[Math.floor(Math.random() * p.length)];
    recent.push(e.id); if (recent.length > 16) recent.shift();
    return e;
  }
  function beginQuizPick(weak) {
    let pool = BANK.slice();
    if (weak) {
      const order = FStore.weakOrder().filter((x) => BANK_BY_TYPE[x.key]);
      if (order.length) {
        const top = order[0].key;
        pool = BANK_BY_TYPE[top].slice();
      }
    }
    const e = pickEntry(pool) || pickEntry(BANK);
    beginQuiz(e);
  }
  function beginQuizOfType(type) {
    const e = pickEntry(BANK_BY_TYPE[type]);
    beginQuiz(e);
  }
  function beginQuiz(entry) {
    if (!entry) return FUI.toast('题库里这类题暂时还不多，先出别的题型吧');
    currentQ = { msgId: 'quiz-' + Date.now(), entry: entry, letter: null };
    pushMsg({ role: 'assistant', kind: 'quiz', meta: currentQ.msgId, quiz: entry }, true);
  }
  function renderQuiz(item, bub, wrap) {
    const q = item.quiz;
    const askType = FENG.TYPE_OF[q.type] || q.type;
    const stale = !currentQ || currentQ.msgId !== item.meta;
    const pre = document.createElement('div');
    pre.className = 'quiz-meta';
    pre.textContent = (q.askNote ? q.askNote + ' · ' : '') + '【' + askType + '】' + (q.year ? q.year : '') + (q.src ? ' · ' + q.src : '');
    const stem = document.createElement('div');
    stem.className = 'quiz-stem';
    stem.innerHTML = FUI.esc(q.stem).replace(/\n/g, '<br>');
    const ask = document.createElement('div');
    ask.className = 'q-ask';
    ask.textContent = q.ask;
    const opt = document.createElement('div');
    opt.className = 'optrow';
    opt.dataset.q = item.meta;
    const letters = ['A', 'B', 'C', 'D'];
    q.opts.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.dataset.q = item.meta;
      b.dataset.letter = letters[i];
      b.innerHTML = '<span class="l">' + letters[i] + '.</span><span>' + FUI.esc(o) + '</span>';
      opt.appendChild(b);
    });
    bub.appendChild(pre); bub.appendChild(stem); bub.appendChild(ask); bub.appendChild(opt);
    if (stale) {
      const tip = document.createElement('div');
      tip.className = 'cap'; tip.style.marginTop = '6px';
      tip.textContent = '（这是历史会话里的题目，作答交互已结束；点下方「出题」可继续练习）';
      bub.appendChild(tip);
    }
  }
  $('#chat').addEventListener('click', (e) => {
    const opt = e.target.closest('.opt');
    if (!opt) return;
    if (busy) return FUI.toast('风老师正在回复，稍等片刻');
    const qid = opt.dataset.q;
    if (!currentQ || currentQ.msgId !== qid || currentQ.letter) return;
    onAnswer(qid, opt.dataset.letter);
  });
  async function onAnswer(qid, letter) {
    if (!currentQ || currentQ.msgId !== qid) return;
    const cq = currentQ;
    cq.letter = letter;
    const box = document.querySelector('.optrow[data-q="' + qid + '"]');
    const entry = cq.entry;
    const ok = letter === entry.ans;
    if (box) {
      box.querySelectorAll('.opt').forEach((o) => {
        o.classList.add('disabled');
        if (o.dataset.letter === letter) { o.classList.add('sel'); if (!ok) o.classList.add('wrong'); }
        if (o.dataset.letter === entry.ans) o.classList.add('right');
      });
      const v = document.createElement('div');
      v.className = 'quiz-verdict';
      v.style.cssText = 'margin-top:8px;font-weight:700;font-size:14px';
      v.style.color = ok ? 'var(--ok)' : 'var(--bad)';
      v.textContent = ok ? '✓ 答对了！' : '✗ 答错了，正确是 ' + entry.ans + '。';
      box.after(v);
      const note = document.createElement('div');
      note.className = 'cap'; note.style.marginTop = '3px';
      note.textContent = '答案来源：' + (entry.src || '真题题库');
      v.after(note);
    }
    const attemptId = FStore.recordAttempt(entry.type, ok);
    let wbId = '';
    if (!ok) {
      wbId = FStore.addWB({
        type: entry.type, stem: entry.stem, ask: entry.ask, opts: entry.opts,
        correct: entry.ans, user: letter, trap: '', point: '', date: FStore.fmtDate(Date.now())
      }).id;
    }
    refreshMemoryUI();
    // 精讲
    const prompt =
      '刚才给学生的是一道真题（' + (entry.askNote || FENG.TYPE_OF[entry.type]) + '），学生选了 ' + letter +
      '（本题答案 ' + entry.ans + '，判定学生答' + (ok ? '对' : '错') + '）。\n' +
      '题目如下：\n题干：' + entry.stem + '\n问法：' + entry.ask +
      '\nA.' + entry.opts[0] + '\nB.' + entry.opts[1] + '\nC.' + entry.opts[2] + '\nD.' + entry.opts[3] +
      '\n请按' + ({ brief: '简洁', normal: '标准', deep: '深度精讲' })[cfg.depth] + '档走答题固定流程完整讲解：先给答案，再按我的体系拆行文脉络/破题点，逐项说明对错与所踩的坑，点出考点与避坑，结尾一句收尾。学生答对了也简单复盘 + 点一下易错项。';
    await streamAnswer(prompt, { kb: kbCardsForType(entry.type, 1), ragQuery: entry.stem, prompt,
      onDone: (tags) => {
        if (tags.trap || tags.point) FStore.tagAttempt(attemptId, tags);
        if (!ok && wbId && (tags.trap || tags.point)) {
          FStore.patchWB(wbId, { trap: tags.trap || '', point: tags.point || '' });
        }
      } });
    currentQ = null;
    refreshMemoryUI();
  }

  // ============================ 设置 / 外观 ============================
  function applyTheme() {
    const t = cfg.theme || 'auto';
    let val = t;
    if (t === 'auto') val = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', val);
    setSeg('segTheme', t);
  }
  function setSeg(id, v) {
    const seg = $('#' + id);
    if (!seg) return;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }
  function updateModeUI() {
    const on = cfg.mode === 'ollama';
    $('#modePillTxt').textContent = on ? '本地 Ollama' : '在线 API';
    $('#modeDot').classList.toggle('on', !on);
    $('#modePill').title = on ? '本地 Ollama（离线）' : '在线 API（DeepSeek 等）';
    setSeg('segMode', cfg.mode);
    fillSettingsFields();
    setSeg('segDepth', cfg.depth);
  }
  function fillSettingsFields() {
    $('#setBase').value = cfg.online.base;
    $('#setModel').value = cfg.online.model;
    $('#setVl').value = cfg.online.vl || '';
    $('#setKey').value = cfg.online.key || '';
    $('#setBaseO').value = cfg.ollama.base;
    $('#setModelO').value = cfg.ollama.model;
    $('#setVlO').value = cfg.ollama.vl || '';
    $('#onlineFields').style.display = cfg.mode === 'ollama' ? 'none' : '';
    $('#ollamaFields').style.display = cfg.mode === 'ollama' ? '' : 'none';
    if ($('#setCtx')) $('#setCtx').value = String(cfg.ctxTurns == null ? 4 : cfg.ctxTurns);
  }
  function readSettingsFromForm() {
    cfg = FStore.saveCfg({
      mode: cfg.mode,
      online: { base: $('#setBase').value.trim(), model: $('#setModel').value.trim(), vl: $('#setVl').value.trim(), key: $('#setKey').value.trim() },
      ollama: { base: $('#setBaseO').value.trim(), model: $('#setModelO').value.trim(), vl: $('#setVlO').value.trim() },
      depth: cfg.depth, theme: cfg.theme,
      ctxTurns: Number(($('#setCtx') && $('#setCtx').value) || 0)
    });
  }
  async function testNow() {
    readSettingsFromForm();
    const msg = $('#cfgMsg');
    msg.textContent = '正在测试连接…';
    const res = await FLLM.testConnection();
    msg.textContent = res.ok ? '✓ ' + res.msg : '✗ ' + res.msg;
  }

  // 绑定：settings seg & fields（on input 存）
  function bindSettings() {
    $('#segMode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      cfg = FStore.saveCfg({ mode: b.dataset.v });
      updateModeUI();
    });
    $('#segDepth').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      cfg = FStore.saveCfg({ depth: b.dataset.v }); setSeg('segDepth', cfg.depth);
    });
    $('#segTheme').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      cfg = FStore.saveCfg({ theme: b.dataset.v }); applyTheme();
    });
    ['setBase', 'setModel', 'setVl', 'setKey', 'setBaseO', 'setModelO', 'setVlO', 'setCtx'].forEach((id) => {
      $('#' + id).addEventListener('change', () => { readSettingsFromForm(); });
      $('#' + id).addEventListener('input', () => { readSettingsFromForm(); });
    });
    $('#btnModels').addEventListener('click', async () => {
      readSettingsFromForm();
      const msg = $('#cfgMsg');
      msg.textContent = '正在拉取模型列表…';
      const r = await FLLM.listModels();
      if (!r.ok) { msg.textContent = '✗ ' + r.msg; return; }
      const dl = $('#modelList');
      dl.innerHTML = r.ids.map((id) => '<option value="' + String(id).replace(/"/g, '') + '"></option>').join('');
      const vision = r.ids.filter((id) => /vl|vision|omni|vl-|glm-4v|internvl/i.test(id));
      msg.textContent = '✓ 已拉取 ' + r.ids.length + ' 个模型，点输入框即可下拉选择' +
        (vision.length ? '\n可识图的候选：' + vision.slice(0, 6).join(' / ') : '');
    });
    $('#btnTest').addEventListener('click', testNow);
    $('#btnVisionTest').addEventListener('click', async () => {
      readSettingsFromForm();
      const msg = $('#cfgMsg');
      msg.textContent = '正在用 8×8 小图自检识图通道（会依次试三种发法）…';
      const r = await FLLM.visionSelfTest();
      msg.textContent = (r.ok ? '✓ ' : '✗ ') + r.msg;
    });
    $('#btnClearChat').addEventListener('click', async () => {
      if (!(await modalAsk('清空当前聊天', '只清空本会话的聊天记录，记忆与错题本保留。', '清空', '取消'))) return;
      msgs = []; await idbPut('session:' + sessionId, msgs); renderAll();
      greet();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  }

  // ============================ 简易确认框 ============================
  function modalAsk(title, body, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.innerHTML =
        '<div class="sheet" style="max-width:440px">' +
        '<h3>' + FUI.esc(title) + '</h3>' +
        '<div class="sub" style="white-space:pre-line">' + FUI.esc(body) + '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end">' +
        '<button class="btn ghost" data-r="0">' + FUI.esc(cancelLabel || '取消') + '</button>' +
        '<button class="btn primary" data-r="1">' + FUI.esc(okLabel || '确定') + '</button>' +
        '</div></div>';
      document.body.appendChild(mask);
      const done = (v) => { mask.remove(); resolve(v); };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return done(false);
        const b = e.target.closest('[data-r]');
        if (b) done(b.dataset.r === '1');
      });
    });
  }

  // ============================ 速查 ============================
  function bigrams(s) {
    const clean = String(s).replace(/[^一-龥A-Za-z0-9]/g, '');
    const out = new Set();
    for (let i = 0; i < clean.length; i++) {
      if (i + 1 < clean.length) out.add(clean.slice(i, i + 2));
      if (/[一-龥]/.test(clean[i])) out.add(clean[i]);
    }
    return out;
  }
  const KB_INDEX = FENG.KB.map((c) => ({ c, grams: bigrams(c.type + c.title + c.body + c.pit + c.ex) }));
  function searchKB(q) {
    const g = bigrams(q);
    if (!g.size) return [];
    const scored = [];
    KB_INDEX.forEach(({ c, grams }) => {
      let hit = 0;
      g.forEach((x) => { if (grams.has(x)) hit++; });
      if (hit) scored.push({ c, hit });
    });
    scored.sort((a, b) => b.hit - a.hit);
    return scored.slice(0, 10).map((s) => s.c);
  }
  function wbCountOfType(type) {
    return FStore.getWB().filter((x) => x.type === type && !x.master).length;
  }
  function renderKB() {
    const q = $('#kbQuery').value.trim();
    const box = $('#kbResult');
    if (!q) {
      box.innerHTML = '<div class="hint" style="margin:6px 2px">可查：对策类 · 就近原则 · 偷换时态 · 0·1·10 · 接语 · 排序 … 或直接搜一个词，如“转折”。</div>';
      return;
    }
    const res = searchKB(q);
    if (!res.length) {
      box.innerHTML = '<div class="empty">没搜到，换个说法试试；也可以点下方按钮让风老师直接讲。\n<button class="chipbtn primary" style="margin-top:10px" id="kbAskMiss">问风老师：' + FUI.esc(q.slice(0, 30)) + '</button></div>';
      const b = box.querySelector('#kbAskMiss');
      if (b) b.addEventListener('click', () => askKBTopic(q, ''));
      return;
    }
    box.innerHTML = '';
    res.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'card';
      const wbc = wbCountOfType(c.type);
      card.innerHTML =
        '<h4>' + FUI.esc(c.title) + '<span class="ktype">' + FENG.TYPE_OF[c.type] + '</span></h4>' +
        '<div class="bd">' + FUI.inlineMd(c.body) + '</div>' +
        (c.ex ? '<div class="ex">' + FUI.inlineMd(c.ex) + '</div>' : '') +
        '<div class="pit">⚠ ' + FUI.esc(c.pit) + '</div>' +
        '<div class="wb-foot"><button class="chipbtn primary" data-ask="1">让风老师讲透</button>' +
        (wbc ? '<span class="hint" style="align-self:center">你在这类还有 ' + wbc + ' 道错题</span>' : '') +
        '</div>';
      card.querySelector('[data-ask]').addEventListener('click', () => askKBTopic(c.title, c));
      box.appendChild(card);
    });
  }
  async function askKBTopic(title, card) {
    if (busy) return FUI.toast('风老师正在回复，稍等片刻');
    closeDrawer();
    const want = card ? '请把知识点「' + card.title + '」讲透，结合我的错误习惯，举1-2个例；别讲成教科书，要有课堂感。' : '帮我讲讲「' + title + '」这个言语知识点。';
    pushMsg({ role: 'user', text: want });
    await streamAnswer(want, { kb: card ? kbCardText(card) : '' });
  }
  function kbCardText(c) {
    return '〔' + FENG.TYPE_OF[c.type] + '·' + c.title + '〕' + c.body + '；易错：' + c.pit + (c.ex ? '；' + c.ex : '');
  }

  // ============================ 错题本 ============================
  function fillWbFilter() {
    const sel = $('#wbFilter');
    sel.innerHTML = '<option value="">全部题型</option>';
    FENG.TYPES.forEach((t) => { const o = document.createElement('option'); o.value = t.key; o.textContent = t.label; sel.appendChild(o); });
  }
  function renderWB() {
    const sel = $('#wbFilter');
    const type = sel ? sel.value : '';
    const list = FStore.getWB().filter((x) => !type || x.type === type);
    const box = $('#wbList');
    if (!list.length) { box.innerHTML = '<div class="empty">还没有错题。\n答错的题会自动收进来，方便你集中复盘。</div>'; return; }
    box.innerHTML = '';
    list.forEach((x) => {
      const it = document.createElement('div');
      it.className = 'wb-item';
      it.innerHTML =
        '<div class="wb-head"><span class="tag">' + FENG.TYPE_OF[x.type] + '</span>' +
        '<div class="tt">' + FUI.esc((x.stem || '').slice(0, 90)) + (x.stem && x.stem.length > 90 ? '…' : '') + '</div></div>' +
        '<div class="wb-body"><div class="q">题干：' + FUI.esc(x.stem) + '</div>' +
        (x.ask ? '<div>' + FUI.esc(x.ask) + '</div>' : '') +
        '<div class="opts">' + (x.opts || []).map((o, i) => '<div>' + 'ABCD'[i] + '. ' + FUI.esc(o) + (('ABCD'[i]) === x.correct ? '　✓' : '') + (('ABCD'[i]) === x.user ? '　← 你选的' : '') + '</div>').join('') + '</div>' +
        '<div>你的选择：<b>' + x.user + '</b>　正确：<b>' + x.correct + '</b></div>' +
        (x.trap ? '<div style="color:var(--bad)">踩坑：' + FUI.esc(x.trap) + '</div>' : '') +
        '<div class="wb-foot">' +
        '<button class="chipbtn ' + (x.master ? 'primary' : '') + '" data-m="' + x.id + '">' + (x.master ? '已掌握 ✓' : '标为已掌握') + '</button>' +
        '<button class="chipbtn" data-rm="' + x.id + '">删除</button>' +
        '<span class="hint" style="align-self:center;margin-left:auto">' + FStore.fmtDate(x.ts || x.ts || Date.now()).slice(0, 10) + '</span>' +
        '</div></div>';
      it.querySelector('.wb-head').addEventListener('click', () => it.querySelector('.wb-body').classList.toggle('open'));
      const mBtn = it.querySelector('[data-m]');
      if (mBtn) mBtn.addEventListener('click', () => { FStore.patchWB(x.id, { master: !x.master }); renderWB(); });
      const rmBtn = it.querySelector('[data-rm]');
      if (rmBtn) rmBtn.addEventListener('click', (e) => { e.stopPropagation(); FStore.delWB(x.id); renderWB(); });
      box.appendChild(it);
    });
  }
  function bindWrongbook() {
    $('#wbFilter').addEventListener('change', renderWB);
    $('#wbExportMd').addEventListener('click', () => FStore.exportWB('md'));
    $('#wbExportJson').addEventListener('click', () => FStore.exportWB('json'));
  }

  // ============================ 记忆面板 ============================
  function refreshMemoryUI() {
    const s = FStore.dayStats();
    $('#stToday').textContent = s.todayCount;
    $('#stRate').textContent = s.todayRate + '%';
    $('#stTotal').textContent = s.total;
    $('#stWB').textContent = s.wbCount;
    const wlist = $('#weakList');
    const wo = FStore.weakOrder();
    wlist.innerHTML = '';
    if (!wo.length) {
      wlist.innerHTML = '<div class="empty">多做题之后，这里会显示你的薄弱题型与掌握进度。</div>';
    } else {
      wo.forEach((w) => {
        const mem = FStore.getMem();
        const master = !!(mem.types[w.key] && mem.types[w.key].master);
        const row = document.createElement('div');
        row.className = 'wrow';
        row.innerHTML =
          '<div class="wlab"><div class="t">' + FENG.TYPE_OF[w.key] + '</div><div class="s">错 ' + w.wrong + '/' + w.n + ' · 薄弱度 ' + Math.round(w.score * 100) + '</div></div>' +
          '<div class="bar"><i style="width:' + Math.min(100, Math.round(w.score * 100)) + '%"></i></div>' +
          '<button class="chipbtn master-toggle ' + (master ? 'on' : '') + '" data-key="' + w.key + '" title="点击切换已掌握">' + (master ? '已掌握' : '已掌握') + '</button>';
        row.querySelector('.master-toggle').addEventListener('click', () => {
          FStore.markMaster(w.key, !master);
          refreshMemoryUI();
          FUI.toast(master ? '已取消"已掌握"标记' : '好，这类题我已降低出题权重');
        });
        wlist.appendChild(row);
      });
    }
    const traps = FStore.topTraps(6);
    $('#trapList').innerHTML = traps.length
      ? traps.map((x) => '<span class="chipbtn" style="margin:0 6px 6px 0">' + FUI.esc(x.k) + ' ×' + x.v + '</span>').join('')
      : '<div class="hint">暂无——踩过的坑会在讲题后自动累计。</div>';
  }
  async function summaryBtn() {
    if (busy) return FUI.toast('风老师正在回复，稍等片刻');
    closeDrawer();
    pushMsg({ role: 'user', text: '给我一份今天的学习小结' });
    const txt = FStore.summaryText();
    pushMsg({ role: 'assistant', text: txt });
    FUI.toast('已生成学习小结');
  }
  async function reviewBtn() {
    if (busy) return FUI.toast('风老师正在回复，稍等片刻');
    closeDrawer();
    const recentWrong = FStore.recentLog(null, 6).filter((x) => !x.ok);
    pushMsg({ role: 'user', text: '帮我来一次主动复盘：针对我的薄弱点给学习建议' });
    let prompt = '请帮我做一次"主动复盘"：根据我的薄弱题型与最近的错题，像老师一样给下一步针对性学习建议，语气温柔具体。\n薄弱概况：' + FStore.summaryText();
    if (recentWrong.length) prompt += '\n最近几道错题的题型：' + recentWrong.map((x) => FENG.TYPE_OF[x.type]).join('、');
    await streamAnswer(prompt, { ragQuery: '' });
  }
  function bindMemory() {
    $('#btnSummary').addEventListener('click', summaryBtn);
    $('#btnReview').addEventListener('click', reviewBtn);
    $('#btnResetMem').addEventListener('click', async () => {
      const r = await modalAsk('清空记忆', '将清空薄弱点统计、做题记录。错题本是否也一起清空？', '一起清空', '只清记忆');
      const wb = FStore.clearMemory();
      if (r) { try { localStorage.setItem('feng_wrongbook_v1', '[]'); } catch (e) {} }
      refreshMemoryUI(); renderWB();
      FUI.toast('已清空' + (r ? '记忆与错题本' : '记忆'));
    });
  }

  // ============================ 讲义 RAG ============================
  function searchRag(q, k) {
    if (!rags.length) return [];
    const g = bigrams(q);
    const out = [];
    rags.forEach((doc) => {
      const idx = doc.text.indexOf(q);
      if (idx >= 0) {
        const s = doc.text.slice(Math.max(0, idx - 40), idx + q.length + 120);
        out.push({ name: doc.name, snippet: s });
        return;
      }
      // 简化回退：仅含任一汉字命中
      let any = -1;
      for (const ch of q) { const i = doc.text.indexOf(ch); if (i >= 0) { any = i; break; } }
      if (any >= 0) out.push({ name: doc.name, snippet: doc.text.slice(Math.max(0, any - 30), any + 130) });
      void g;
    });
    return out.slice(0, k || 3);
  }
  async function saveRags() { try { await idbPut('ragDocs', rags.map((r) => ({ id: r.id, name: r.name, text: r.text }))); } catch (e) {} }
  function renderRagFiles() {
    const box = $('#ragFiles');
    box.innerHTML = '';
    rags.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'fileitem';
      d.innerHTML = '<span class="nm">' + FUI.esc(r.name) + '</span><span class="hint">' + Math.round(r.text.length / 1000) + 'K</span><button data-rm="' + r.id + '">删</button>';
      d.querySelector('[data-rm]').addEventListener('click', () => { rags = rags.filter((x) => x.id !== r.id); saveRags(); renderRagFiles(); });
      box.appendChild(d);
    });
    $('#ragCount').textContent = rags.length ? rags.length + ' 份讲义' : '';
  }
  async function importRagFiles(files) {
    let added = 0, skipped = 0;
    for (const f of files) {
      if (!/\.(txt|md|markdown|html?)$/i.test(f.name)) { skipped++; continue; }
      if (f.size > 1.5 * 1024 * 1024) { skipped++; FUI.toast('跳过超大文件：' + f.name); continue; }
      const text = await readFile(f);
      if (!text.trim()) continue;
      rags = rags.filter((r) => r.name !== f.name);
      rags.push({ id: 'r' + Date.now() + Math.floor(Math.random() * 1e3), name: f.name, text: text.slice(0, 1500000) });
      added++;
    }
    await saveRags();
    renderRagFiles();
    if (added) FUI.toast('已导入 ' + added + ' 份讲义' + (skipped ? '，跳过 ' + skipped + ' 个' : ''));
  }
  function readFile(f) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(''); r.readAsText(f, 'utf-8'); });
  }
  async function initRag() {
    try { const saved = await idbGet('ragDocs'); if (saved) rags = saved.filter((x) => x && x.text); } catch (e) {}
    renderRagFiles();
    const drop = $('#ragDrop');
    drop.addEventListener('click', () => $('#ragFile').click());
    $('#ragFile').addEventListener('change', (e) => { importRagFiles([...e.target.files]); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--text)'; }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = ''; }));
    drop.addEventListener('drop', (e) => { importRagFiles([...e.dataTransfer.files]); });
    $('#ragOn').addEventListener('change', (e) => { cfg = FStore.saveCfg({ ragOn: e.target.checked }); });
    $('#ragOn').checked = !!cfg.ragOn;
  }

  // ============================ 面板/抽屉 ============================
  function openDrawer(tab) {
    $('#drawer').classList.add('open');
    $('#drawerMask').classList.add('open');
    if (tab) switchTab(tab);
    refreshMemoryUI(); renderWB();
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawerMask').classList.remove('open');
  }
  function switchTab(tab) {
    document.querySelectorAll('.dr-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.dr-sec').forEach((s) => s.classList.toggle('on', s.id === 'sec-' + tab));
    const titleMap = { search: '知识点速查', wrong: '错题本', memory: '记忆 · 薄弱点', rag: '讲义 · 本地记忆', settings: '设置' };
    $('#drTitle').textContent = titleMap[tab] || '学习面板';
    if (tab === 'search') $('#kbQuery').focus();
  }
  function bindDrawer() {
    $('#btnDrawer').addEventListener('click', () => openDrawer());
    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    $('#drawerMask').addEventListener('click', closeDrawer);
    $('#drTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });
  }

  // ============================ 欢迎语 / 输入框 ============================
  function greet() {
    if (msgs.length) return;
    const hello =
      '各位同学们，大家好，我是四诗风雅颂（风老师），超格教育的一名言语讲师。\n\n' +
      '我把课堂上讲的东西都带过来了：中心理解、逻辑填空、标题/细节、排序、接语、篇章阅读——\n' +
      '你可以：\n' +
      '· **拍照/上传**一道不会的题（原图直发视觉模型，不用打字）\n' +
      '· **出题**让我带练（会优先挑你薄弱的题型）\n' +
      '· 在 **知识点速查** 里搜“对策类 / 就近原则 / 偷换时态”\n' +
      '· 直接把题目粘贴进来，我按“简洁 / 标准 / 深度精讲”给你讲透。\n\n' +
      '记住一句话：接受选项的不完美，对比择优。咱们开始吧。';
    pushMsg({ role: 'assistant', text: hello });
  }

  function updateSendUI() {
    const on = !busy;
    $('#btnSend').style.opacity = on ? 1 : 0.5;
  }
  function autoGrow() {
    const ta = $('#q');
    ta.style.height = 'auto';
    ta.style.height = Math.min(96, ta.scrollHeight) + 'px';
  }

  // ============================ PWA ============================
  function regSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  function installHint() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferredInstall = e;
      const pill = $('#modePill');
      const btn = document.createElement('button');
      btn.className = 'modepill';
      btn.id = 'installBtn';
      btn.style.marginLeft = '6px';
      btn.innerHTML = '<span class="dot"></span><span>安装到桌面</span>';
      btn.addEventListener('click', async () => {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        await deferredInstall.userChoice;
        deferredInstall = null; btn.remove();
      });
      pill.after(btn);
    });
  }

  // ============================ 绑定与启动 ============================
  function boot() {
    bindSettings();
    bindDrawer();
    bindWrongbook();
    bindMemory();
    bindQuiz();
    bindTop();
    updateModeUI();
    applyTheme();
    const kbq = $('#kbQuery');
    let t;
    kbq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderKB, 260); });
    kbq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renderKB(); } });
    $('#kbGo').addEventListener('click', renderKB);
    initRag();
    fillWbFilter();
    restoreSession();
    regSW();
    installHint();
    renderKB();
    const vm = document.querySelector('meta[name="app-version"]');
    if (vm && $('#appVer')) $('#appVer').textContent = '当前版本：' + vm.content + '（若版本号不是最新的，请删除桌面图标后重新添加）';
  }
  function bindQuiz() {
    $('#btnQuiz').addEventListener('click', () => {
      if (busy) return FUI.toast('风老师正在回复，稍等片刻');
      if (!cfg.online.key && cfg.mode === 'online') { openDrawer('settings'); return FUI.toast('请先在「设置」填 DeepSeek API Key（在线模式）'); }
      openQuizSheet();
    });
  }
  function bindTop() {
    $('#modePill').addEventListener('click', () => { openDrawer('settings'); });
    $('#btnNewChat').addEventListener('click', async () => {
      if (busy) return;
      if (msgs.length && !(await modalAsk('新会话', '开始一段新的学习会话？历史会话会自动保存。', '开始新会话', '取消'))) return;
      msgs = []; sessionId = 's' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
      try { localStorage.setItem('feng_session', sessionId); } catch (e) {}
      await idbPut('session:' + sessionId, []); renderAll(); greet();
    });
    $('#btnSend').addEventListener('click', onSend);
    const q = $('#q');
    q.addEventListener('input', autoGrow);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    $('#btnCam').addEventListener('click', () => { if (!busy) pickImage('environment'); });
    $('#btnImg').addEventListener('click', () => { if (!busy) pickImage(''); });
    autoGrow();
  }
  async function restoreSession() {
    try { sessionId = localStorage.getItem('feng_session') || ''; } catch (e) {}
    if (!sessionId) { sessionId = 's' + Date.now() + '_' + Math.floor(Math.random() * 1e4); try { localStorage.setItem('feng_session', sessionId); } catch (e) {} }
    const saved = await idbGet('session:' + sessionId).catch(() => undefined);
    if (saved && saved.length) { msgs = saved; renderAll(); } else { greet(); }
    updateSendUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

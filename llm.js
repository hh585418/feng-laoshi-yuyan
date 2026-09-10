/* ============================================================
   风老师·言语理解 —— LLM 客户端
   OpenAI 兼容 /chat/completions：在线(DeepSeek等) 与 本地Ollama 双模式。
   - 图片直传：content 数组 image_url(dataURL)，不经过任何前端 OCR。
   - 识图自适应：标准格式 → 非流式 → 字符串式 image_url，逐级重试，
     兼容"不支持 图片+流式 混合"或图片字段格式不同的各类网关。
   - 错误信息尽力提取（error.message / message / msg / error_msg / 原文）。
   ============================================================ */
(function () {
  function normalizeBase(base) {
    base = (base || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }

  function activeCfg(cfgOverride) {
    const cfg = cfgOverride || globalThis.FStore.getCfg();
    const isOllama = cfgOverride ? cfgOverride.mode === 'ollama' : cfg.mode === 'ollama';
    const m = isOllama ? cfg.ollama : cfg.online;
    return { mode: isOllama ? 'ollama' : 'online', m, isOllama };
  }

  // 图片统一成合法 data URL（曾经因为无条件补前缀造成双重前缀 bug）
  function toImageUrl(img) {
    const s = String(img || '');
    if (/^data:image\//i.test(s)) return s;
    return 'data:image/jpeg;base64,' + s;
  }

  // 把 {role,text,image} 转成 API messages；variant: 'std' 对象式 / 'str' 字符串式
  function buildMessages(list, image, variant) {
    const out = list.map((msg) => {
      if (msg.role === 'system') return { role: 'system', content: msg.text };
      return { role: msg.role, content: msg.text };
    });
    if (image) {
      let last = -1;
      for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'user') { last = i; break; }
      const text = last >= 0 ? out[last].content : '（请以这张题目图片为准讲解）';
      const url = toImageUrl(image);
      const item = (variant === 'str')
        ? { type: 'image_url', image_url: url }
        : { type: 'image_url', image_url: { url, detail: 'high' } };   // 硅基流动等支持 detail: low/high/auto
      const content = [{ type: 'text', text }, item];
      if (last >= 0) out.splice(last, 1);
      out.push({ role: 'user', content });
    }
    return out;
  }

  function pickModel(m, image) { return image && m.vl ? m.vl : m.model; }

  // ---------- 流式解析 ----------
  async function streamChat(res, onDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', full = '';
    const push = (d) => { if (!d) return; full += d; try { onDelta && onDelta(d); } catch (e) {} };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          push((j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '');
        } catch (e) {}
      }
    }
    return full;
  }

  // ---------- 错误信息提取（尽量拿到"接口原话"）----------
  async function readError(res) {
    let raw = '';
    try { raw = await res.text(); } catch (e) {}
    let j = null;
    try { j = JSON.parse(raw); } catch (e) {}
    let msg = '';
    if (j) {
      if (typeof j === 'string') msg = j;
      else if (typeof j.error === 'string') msg = j.error;
      else if (j.error && typeof j.error === 'object') msg = j.error.message || j.error.msg || j.error.detail || j.error.code || '';
      msg = msg || j.message || j.msg || j.error_msg || j.detail || j.reason || '';
    }
    return { raw: String(raw || ''), msg: String(msg || '') };
  }

  const friendly = {
    network: (isOllama) => isOllama
      ? '连不上本机 Ollama。请确认 Ollama 已启动；并设置环境变量 OLLAMA_ORIGINS=*（允许网页跨域），或改填对的基础地址。'
      : '网络请求失败。请检查：API 地址是否填对、网络是否可用；离线时请切到「本地 Ollama」模式。',
    auth: '鉴权失败：API Key 无效或已过期，请到设置里核对（在线模式）。'
  };

  // ---------- 核心：带重试策略的请求 ----------
  async function run(messages, image, onDelta, signal, onReset) {
    const { m, isOllama } = activeCfg();
    const model = pickModel(m, image);
    const url = normalizeBase(m.base);
    const headers = { 'Content-Type': 'application/json' };
    if (!isOllama && m.key) headers.Authorization = 'Bearer ' + m.key;

    const hasImage = !!image;
    const plan = hasImage
      ? [{ v: 'std', stream: true, full: true }, { v: 'std', stream: false, full: false }, { v: 'str', stream: false, full: false }]
      : [{ v: 'std', stream: true, full: true }, { v: 'std', stream: false, full: false }];

    let lastStatus = 0, lastRaw = '', lastMsg = '';
    for (const p of plan) {
      const body = { model, messages: buildMessages(messages, image, p.v), stream: !!p.stream };
      if (p.full) { body.temperature = 0.4; body.max_tokens = 2200; }
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      } catch (e) {
        const err = new Error(friendly.network(isOllama));
        err.code = isOllama ? 'OLLAMA_NET' : 'NET';
        throw err;
      }
      if (res.ok) {
        if (p.stream) {
          try { return { text: await streamChat(res, onDelta), attempt: p.v + '+stream' }; }
          catch (e) { lastStatus = 0; lastRaw = String(e && e.message || e); try { onReset && onReset(); } catch (_) {} continue; }
        }
        const j = await res.json();
        const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        if (text) { try { onDelta && onDelta(text); } catch (e) {} return { text, attempt: p.v + '+nostream' }; }
        lastStatus = res.status; lastRaw = '空回复'; continue;
      }
      const info = await readError(res);
      lastStatus = res.status; lastRaw = info.raw; lastMsg = info.msg;
      if (res.status === 401 || res.status === 403) {
        const err = new Error(friendly.auth + (lastMsg ? '（' + lastMsg.slice(0, 140) + '）' : ''));
        err.code = 'AUTH'; throw err;
      }
      // 其余情况继续尝试下一种发法
    }

    const detail = lastMsg || (lastRaw ? lastRaw.replace(/\s+/g, ' ').slice(0, 260) : '（接口未返回可读信息）');
    const visionHint = lastStatus === 415 ||
      /image|vision|multimodal|图文|图片|不支持.{0,8}(图|视觉)|content.{0,12}type|invalid.{0,12}content/i.test(detail);
    if (hasImage && visionHint) {
      const err = new Error('识图请求被接口拒绝（' + lastStatus + '）——该端点/模型可能没有开启图片输入。' +
        '可在设置里改填支持视觉的模型。接口原话：' + detail);
      err.code = 'VL_NOT_SUPPORTED'; throw err;
    }
    const err = new Error('接口返回错误（' + lastStatus + '）' + (detail ? '：' + detail : '') +
      (hasImage ? '\n（已自动试过：标准流式 / 标准非流式 / 字符串式 image_url 三种发法；都失败。若你确认模型支持视觉，请把上面这句"接口原话"发我。）' : ''));
    err.code = 'HTTP'; throw err;
  }

  async function chat({ messages, image, onDelta, signal, onReset }) {
    const r = await run(messages, image, onDelta, signal, onReset);
    return r.text;
  }

  // ---------- 连接测试 ----------
  async function testConnection(cfgOverride) {
    const { m, isOllama } = activeCfg(cfgOverride);
    const url = normalizeBase(m.base);
    const headers = { 'Content-Type': 'application/json' };
    if (!isOllama && m.key) headers.Authorization = 'Bearer ' + m.key;
    const body = { model: m.model, messages: [{ role: 'user', content: '请只回复四个字：连接成功' }], stream: false, max_tokens: 20 };
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (e) { return { ok: false, msg: friendly.network(isOllama) }; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, msg: friendly.auth };
      const info = await readError(res);
      return { ok: false, msg: '接口错误(' + res.status + ')' + (info.msg || info.raw ? '：' + (info.msg || info.raw).slice(0, 160) : '') };
    }
    const j = await res.json();
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return { ok: true, msg: (text || '连接成功').slice(0, 60) };
  }

  // ---------- 识图自检：用 8×8 红色小图探一探接口到底说什么 ----------
  const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGO4Iyf3Hx9mGBkKAO7khcEz5XnsAAAAAElFTkSuQmCC";
  async function visionSelfTest() {
    const { m } = activeCfg();
    const model = m.vl || m.model;
    const where = '［模型 ' + model + ' ｜ 地址 ' + normalizeBase(m.base) + '］';
    const msgs = [{ role: 'user', text: '这张图是什么颜色？只回答一个颜色词。' }];
    try {
      const r = await run(msgs, TINY_PNG, null, undefined);
      return { ok: true, msg: where + ' 识图通道正常（第 ' + r.attempt + ' 种发法成功）｜模型回复：' + String(r.text).slice(0, 40) };
    } catch (e) {
      return { ok: false, msg: where + ' ' + ((e && e.message) || '识图自检失败') };
    }
  }

  globalThis.FLLM = { chat, testConnection, normalizeBase, activeCfg, buildMessages, toImageUrl, visionSelfTest };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.FLLM;
})();

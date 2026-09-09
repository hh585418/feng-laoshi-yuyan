/* ============================================================
   风老师·言语理解 —— LLM 客户端
   OpenAI 兼容 /chat/completions：在线(DeepSeek等) 与 本地Ollama 双模式。
   - 图片直传：content 数组 image_url(base64)，不经过任何前端 OCR。
   - SSE 流式解析，异常时自动给"人话"错误提示。
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

  // 把 {role,text,image} 列表转成 API messages；有图时把图片附加到最后一个 user 消息
  function buildMessages(list, image) {
    const out = list.map((msg) => {
      if (msg.role === 'system') return { role: 'system', content: msg.text };
      return { role: msg.role, content: msg.text };
    });
    if (image) {
      // 找到最后一个 user 消息，把文字指令与图片合并成多模态 content
      let last = -1;
      for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'user') { last = i; break; }
      const text = last >= 0 ? out[last].content : '（请以这张题目图片为准讲解）';
      const content = [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } }
      ];
      if (last >= 0) out.splice(last, 1);
      out.push({ role: 'user', content });
    }
    return out;
  }

  function pickModel(m, image) {
    if (image && m.vl) return m.vl;
    return m.model;
  }

  // 解析 OpenAI 风格 SSE 增量
  async function streamChat(res, onDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    const push = (delta) => { if (!delta) return; full += delta; try { onDelta && onDelta(delta); } catch (e) {} };
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
          const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
          push(delta);
        } catch (e) { /* 忽略非 JSON 行 */ }
      }
    }
    return full;
  }

  const friendly = {
    network: (isOllama) => isOllama
      ? '连不上本机 Ollama。请确认 Ollama 已启动；并设置环境变量 OLLAMA_ORIGINS=*（允许网页跨域），或改填对的基础地址。'
      : '网络请求失败。请检查：API 地址是否填对、网络是否可用；离线时请切到「本地 Ollama」模式。',
    auth: '鉴权失败：API Key 无效或已过期，请到设置里核对（在线模式）。'
  };

  // 主调用
  async function chat({ messages, image, onDelta, cfgOverride, signal }) {
    const { mode, m, isOllama } = activeCfg(cfgOverride);
    const model = pickModel(m, image);
    const url = normalizeBase(m.base);
    const headers = { 'Content-Type': 'application/json' };
    if (!isOllama && m.key) headers.Authorization = 'Bearer ' + m.key;
    const hasImage = !!image;
    const body = {
      model,
      messages: buildMessages(messages, hasImage),
      stream: true,
      temperature: 0.4,
      max_tokens: 2200
    };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      const err = new Error(friendly.network(isOllama));
      err.hint = isOllama ? 'ollama-net' : 'net';
      throw err;
    }
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
      if (res.status === 401 || res.status === 403) {
        const err = new Error(friendly.auth + (msg ? '（' + String(msg).slice(0, 120) + '）' : ''));
        err.code = 'AUTH'; throw err;
      }
      const isImgErr = hasImage && (res.status === 400 || res.status === 415 || res.status === 404);
      if (isImgErr) {
        const err = new Error('识图请求被拒绝——当前模型/接口可能不支持图片输入。' +
          '可在设置里改填支持视觉的模型（本地 Ollama 如 qwen2.5-vl / llava，或支持多模态的在线模型）。原信息：' + String(msg).slice(0, 160));
        err.code = 'VL_NOT_SUPPORTED'; throw err;
      }
      const err = new Error('模型接口返回错误（' + res.status + '）' + (msg ? '：' + String(msg).slice(0, 200) : ''));
      err.code = 'HTTP'; throw err;
    }
    return await streamChat(res, onDelta);
  }

  // 连接测试（非流式、极短）
  async function testConnection(cfgOverride) {
    const { m, isOllama } = activeCfg(cfgOverride);
    const model = m.model;
    const url = normalizeBase(m.base);
    const headers = { 'Content-Type': 'application/json' };
    if (!isOllama && m.key) headers.Authorization = 'Bearer ' + m.key;
    const body = {
      model,
      messages: [{ role: 'user', content: '请只回复四个字：连接成功' }],
      stream: false,
      max_tokens: 20
    };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, msg: friendly.network(isOllama) };
    }
    if (!res.ok) {
      let msg = ''; try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) {}
      if (res.status === 401 || res.status === 403) return { ok: false, msg: friendly.auth };
      return { ok: false, msg: '接口错误(' + res.status + ')' + (msg ? '：' + String(msg).slice(0, 140) : '') };
    }
    const j = await res.json();
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return { ok: true, msg: (text || '连接成功').slice(0, 60) };
  }

  globalThis.FLLM = { chat, testConnection, normalizeBase, activeCfg };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.FLLM;
})();

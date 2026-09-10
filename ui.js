/* ============================================================
   风老师·言语理解 —— UI 工具
   迷你 markdown / 图片裁剪(旋转缩放拖拽) / 模糊检测 / toast /
   模型"复盘标签"解析 / 通用小工具
   ============================================================ */
(function () {
  // ---------- 迷你 markdown ----------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(t) {
    if (!t) return '';
    const lines = String(t).split('\n');
    const out = [];
    let inCode = false, codeBuf = [];
    const flushCode = () => {
      if (!codeBuf.length) return;
      out.push('<pre class="md-code">' + esc(codeBuf.join('\n')) + '</pre>');
      codeBuf = [];
    };
    for (const raw of lines) {
      const line = raw;
      if (/^\s*```/.test(line)) { inCode ? flushCode() : (inCode = true); inCode = !inCode; continue; }
      if (inCode) { codeBuf.push(line); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const lv = h[1].length; out.push('<h' + lv + '>' + inlineMd(h[2]) + '</h' + lv + '>'); continue; }
      if (/^\s*>\s?/.test(line)) { out.push('<p class="md-quote">' + inlineMd(line.replace(/^\s*>\s?/, '')) + '</p>'); continue; }
      if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.、]\s+/.test(line)) {
        out.push('<p class="md-li">' + inlineMd(line.replace(/^\s*([-*•]|\d+[.、])\s+/, '· ')) + '</p>'); continue;
      }
      if (line.trim() === '') { continue; }
      out.push('<p>' + inlineMd(line) + '</p>');
    }
    if (inCode) flushCode();
    return out.join('');
  }

  // ---------- 模型"复盘标签"解析 ----------
  function parseTags(text) {
    const tags = { type: '', point: '', trap: '', ans: '', ok: '' };
    const lines = String(text).split('\n');
    const keep = [];
    for (const l of lines) {
      const m = l.trim().match(/^@([a-z]+)=(.*)$/i);
      if (m && m[1].toLowerCase() in tags) tags[m[1].toLowerCase()] = m[2].trim();
      else keep.push(l);
    }
    return { clean: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tags };
  }

  // ---------- toast ----------
  function toast(msg, ms) {
    let box = document.querySelector('.feng-toast-wrap');
    if (!box) { box = document.createElement('div'); box.className = 'feng-toast-wrap'; document.body.appendChild(box); }
    const d = document.createElement('div');
    d.className = 'feng-toast';
    d.innerHTML = '<span>' + esc(msg) + '</span>';
    box.appendChild(d);
    requestAnimationFrame(() => d.classList.add('show'));
    setTimeout(() => { d.classList.remove('show'); setTimeout(() => d.remove(), 350); }, ms || 2600);
  }

  // ---------- 文件→dataURL ----------
  function fileToDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // ---------- 压缩 / 转 JPEG ----------
  function compressDataURL(dataUrl, maxEdge, quality) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const m = Math.max(w, h);
        if (m > maxEdge) { const k = maxEdge / m; w = Math.round(w * k); h = Math.round(h * k); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res({ data: c.toDataURL('image/jpeg', quality == null ? 0.86 : quality), w, h });
      };
      img.onerror = () => res({ data: dataUrl, w: 0, h: 0 });
      img.src = dataUrl;
    });
  }

  // ---------- 最小边长补足（部分 VLM 如 Qwen3-VL 要求边长 > 28） ----------
  function ensureMinEdge(dataUrl, minEdge) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight, m = Math.min(w, h);
        if (!m || m >= minEdge) return res(dataUrl);
        const k = minEdge / m;
        const W = Math.round(w * k), H = Math.round(h * k);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, W, H);
        res(c.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    });
  }

  // ---------- 模糊检测（灰度拉普拉斯方差，保守） ----------
  function detectBlur(dataUrl) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        try {
          const W = 96, H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
          const d = g.getImageData(0, 0, W, H).data;
          const gray = new Float32Array(W * H);
          for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          let sum = 0;
          const lap = (x, y) => {
            const v = gray[y * W + x];
            const l = x > 0 ? gray[y * W + x - 1] : v, r = x < W - 1 ? gray[y * W + x + 1] : v;
            const u = y > 0 ? gray[(y - 1) * W + x] : v, dd = y < H - 1 ? gray[(y + 1) * W + x] : v;
            return Math.abs(4 * v - l - r - u - dd);
          };
          let n = 0;
          for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { sum += lap(x, y); n++; }
          res(sum / n);
        } catch (e) { res(-1); }
      };
      img.onerror = () => res(-1);
      img.src = dataUrl;
    });
  }

  // ---------- 图片裁剪器 ----------
  function openCropper(fileOrData, aspectDefault) {
    return new Promise(async (resolve) => {
      const src = typeof fileOrData === 'string' ? fileOrData : await fileToDataURL(fileOrData);
      const el = document.createElement('div');
      el.className = 'feng-crop-mask';
      el.innerHTML =
        '<div class="feng-crop">' +
        '<div class="feng-crop-head"><button class="ghost" data-a="cancel">取消</button><span>调整题目图片</span><button data-a="ok">完成</button></div>' +
        '<div class="feng-crop-view">' +
        '<div class="feng-crop-frame"><i></i></div>' +
        '<img alt="题目图片">' +
        '</div>' +
        '<div class="feng-crop-foot">' +
        '<button data-a="rot">旋转</button><button data-a="zin">＋</button><span class="zc">100%</span><button data-a="zout">－</button><button data-a="reset">适应</button>' +
        '</div>' +
        '<div class="feng-crop-aspect"><span data-aspect="free">自由</span><span data-aspect="1:1">1:1</span><span data-aspect="4:5">4:5</span><span data-aspect="3:4">3:4</span></div>' +
        '</div>';
      document.body.appendChild(el);
      const view = el.querySelector('.feng-crop-view');
      const img = el.querySelector('img');
      const frame = el.querySelector('.feng-crop-frame');

      let nw = 0, nh = 0, s0 = 1, scale = 1, tx = 0, ty = 0, rot = 0, aspect = aspectDefault || 'free';
      const pointers = new Map();
      let pinchStart = null;

      const vw = () => view.clientWidth, vh = () => view.clientHeight;

      function apply() {
        const dw = nw * s0, dh = nh * s0;
        img.style.width = dw + 'px';
        img.style.height = dh + 'px';
        img.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + scale + ')';
      }
      function setFrame() {
        const pw = vw(), ph = vh();
        let a = { '1:1': 1, '4:5': 0.8, '3:4': 0.75 }[aspect];
        let fw, fh;
        if (aspect === 'free') { fw = Math.min(pw * 0.92, ph * 0.92); fh = fw; }
        else if (a >= 1) { fw = Math.min(pw * 0.94, (ph * 0.94) * a); fh = fw / a; }
        else { fh = Math.min(ph * 0.94, (pw * 0.94) / a); fw = fh * a; }
        frame.style.width = fw + 'px';
        frame.style.height = fh + 'px';
      }
      function fit() {
        const pw = vw(), ph = vh();
        s0 = Math.min((pw * 0.96) / nw, (ph * 0.96) / nh);
        scale = 1; tx = 0; ty = 0; apply(); setZoomLabel();
      }
      function setZoomLabel() { const z = el.querySelector('.zc'); if (z) z.textContent = Math.round(scale * 100) + '%'; }
      function zoomBy(f) {
        const n = Math.min(5, Math.max(0.3, scale * f));
        scale = n; apply(); setZoomLabel();
      }
      function panClamp() {
        // 取景框固定居中，须整体落在图片显示范围内
        const dw = nw * s0 * scale, dh = nh * s0 * scale;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        const mx = Math.max(0, (dw - fw) / 2), my = Math.max(0, (dh - fh) / 2);
        tx = Math.max(-mx, Math.min(mx, tx));
        ty = Math.max(-my, Math.min(my, ty));
        apply();
      }

      function rotateImg() {
        const c = document.createElement('canvas');
        c.width = nw; c.height = nh;
        const c2 = document.createElement('canvas');
        c2.width = nh; c2.height = nw;
        const x = c2.getContext('2d');
        x.translate(nh / 2, nw / 2); x.rotate(Math.PI / 2);
        x.drawImage(img, -nw / 2, -nh / 2);
        img.onload = () => { nw = img.naturalWidth; nh = img.naturalHeight; fit(); };
        img.src = c2.toDataURL('image/jpeg', 0.95);
      }

      // 事件
      view.addEventListener('pointerdown', (e) => {
        view.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const p = [...pointers.values()];
          pinchStart = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), s: scale };
        }
      });
      view.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const p = [...pointers.values()];
          const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
          if (pinchStart) scale = Math.min(5, Math.max(0.3, pinchStart.s * (d / pinchStart.d)));
          apply(); setZoomLabel();
        } else {
          const prev = pointers.get(e.pointerId);
          const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          tx += dx; ty += dy;
          apply();
        }
      });
      const up = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStart = null;
        panClamp();
      };
      view.addEventListener('pointerup', up);
      view.addEventListener('pointercancel', up);
      view.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
      el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', (e) => {
        const a = b.dataset.a;
        if (a === 'zin') zoomBy(1.2);
        else if (a === 'zout') zoomBy(0.83);
        else if (a === 'reset') fit();
        else if (a === 'rot') rotateImg();
        else if (a === 'cancel') { el.remove(); resolve(null); }
        else if (a === 'ok') doCrop();
      }));
      el.querySelectorAll('[data-aspect]').forEach((s) => s.addEventListener('click', () => {
        el.querySelectorAll('[data-aspect]').forEach((x) => x.classList.remove('on'));
        s.classList.add('on');
        aspect = s.dataset.aspect;
        setFrame(); panClamp();
      }));

      function doCrop() {
        const dw = nw * s0 * scale, dh = nh * s0 * scale;
        const imgL = (vw() - dw) / 2 + tx, imgT = (vh() - dh) / 2 + ty;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        const fL = (vw() - fw) / 2, fT = (vh() - fh) / 2;
        let nx = ((fL - imgL) / dw) * nw, ny = ((fT - imgT) / dh) * nh;
        let sx = (fw / dw) * nw, sy = (fh / dh) * nh;
        nx = Math.max(0, Math.min(nw - sx, nx)); ny = Math.max(0, Math.min(nh - sy, ny));
        const maxEdge = 1280, k = Math.min(1, maxEdge / Math.max(sx, sy));
        const W = Math.round(sx * k), H = Math.round(sy * k);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d');
        x.drawImage(img, nx, ny, sx, sy, 0, 0, W, H);
        const out = c.toDataURL('image/jpeg', 0.86);
        el.remove(); resolve(out);
      }

      img.onload = () => { nw = img.naturalWidth; nh = img.naturalHeight; setFrame(); fit(); };
      img.src = src;
    });
  }

  const FUI = {
    esc, inlineMd, mdToHtml, parseTags, toast,
    fileToDataURL, compressDataURL, detectBlur, openCropper, ensureMinEdge
  };
  globalThis.FUI = FUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = FUI;
})();

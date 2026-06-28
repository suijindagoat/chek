// inject.js — runs in EVERY page/frame at document_start (via evaluateOnNewDocument).
// Standalone replica of the extension features (stealth: no on-screen UI):
//   * Flag question -> AI answer (intercept click, keep flag unchanged, fill editor)
//   * Ctrl+Shift+H  -> key popup (only until activation succeeds for this run)
//   * Ctrl+Shift+V  -> capture clipboard (quiz password) to server, then paste
//   * Ctrl+Alt+Shift+X -> toggle the flag-question feature on/off (starts ON)
// All network calls are done in Node via the exposed window.clipkey* functions.
(() => {
  if (window.__clipkeyFlagInit) return;
  window.__clipkeyFlagInit = true;

  // Flag-question feature works by default; Ctrl+Alt+Shift+X toggles it.
  window.__clipkeyFlagEnabled = true;

  const FLAG_SEL = '.que .questionflag a, .que .questionflag .aabtn';
  const inFlight = new WeakSet();
  const stateMap = new WeakMap();

  const findTrigger = (t) => {
    if (t instanceof Element) return t.closest(FLAG_SEL);
    if (t && t.parentElement instanceof Element) return t.parentElement.closest(FLAG_SEL);
    return null;
  };

  const setAttr = (el, name, val) => {
    if (!el) return;
    if (val == null) el.removeAttribute(name);
    else el.setAttribute(name, val);
  };

  // Snapshot the flag's current visual state so we can put it back after swallowing the click.
  const snapshot = (el) => {
    if (!el || stateMap.has(el)) return stateMap.get(el);
    const container = el.closest('.questionflag');
    const snap = {
      triggerClass: el.getAttribute('class'),
      triggerTitle: el.getAttribute('title'),
      triggerAriaLabel: el.getAttribute('aria-label'),
      triggerAriaPressed: el.getAttribute('aria-pressed'),
      triggerInnerHTML: el.innerHTML,
      containerClass: container ? container.getAttribute('class') : null,
      containerTitle: container ? container.getAttribute('title') : null,
      hiddenInputs: container
        ? Array.from(container.querySelectorAll('input')).map((i) => ({
            input: i,
            value: i.value,
            attrValue: i.getAttribute('value'),
            checked: typeof i.checked === 'boolean' ? i.checked : null,
          }))
        : [],
    };
    stateMap.set(el, snap);
    return snap;
  };

  const restore = (el, snap) => {
    if (!el || !el.isConnected || !snap) return;
    const container = el.closest('.questionflag');
    setAttr(el, 'class', snap.triggerClass);
    setAttr(el, 'title', snap.triggerTitle);
    setAttr(el, 'aria-label', snap.triggerAriaLabel);
    setAttr(el, 'aria-pressed', snap.triggerAriaPressed);
    if (el.innerHTML !== snap.triggerInnerHTML) el.innerHTML = snap.triggerInnerHTML;
    if (container) {
      setAttr(container, 'class', snap.containerClass);
      setAttr(container, 'title', snap.containerTitle);
    }
    (snap.hiddenInputs || []).forEach(({ input, value, attrValue, checked }) => {
      if (!input || !input.isConnected) return;
      input.value = value;
      if (typeof checked === 'boolean') input.checked = checked;
      setAttr(input, 'value', attrValue);
    });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (el instanceof HTMLElement) el.blur();
  };

  const restoreSoon = (el) => {
    const snap = stateMap.get(el);
    if (!snap) return;
    restore(el, snap);
    requestAnimationFrame(() => restore(el, snap));
    setTimeout(() => restore(el, snap), 0);
  };

  const buildMeta = (que, qtext) => {
    if (!que || !qtext) return null;
    const all = Array.from(document.querySelectorAll('.que'));
    const nodeSummary = Array.from(qtext.querySelectorAll('*'))
      .slice(0, 40)
      .map((n) => ({
        tag: (n.tagName || '').toLowerCase(),
        className: typeof n.className === 'string' ? n.className.slice(0, 120) : '',
        textSample: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }));
    const signature = JSON.stringify({
      rootClass: que.className || '',
      qtextClass: qtext.className || '',
      childTags: nodeSummary.map((n) => n.tag + ':' + n.className),
      hasImage: !!qtext.querySelector('img'),
      hasTable: !!qtext.querySelector('table'),
      hasList: !!qtext.querySelector('ul,ol'),
      inputCount: que.querySelectorAll('input, textarea, select').length,
    });
    const prev = window.__clipkeyQuestionStructureSignature || null;
    const changed = !!prev && prev !== signature;
    window.__clipkeyQuestionStructureSignature = signature;
    return {
      questionIndex: all.indexOf(que),
      structureChanged: changed,
      signature,
      pageUrl: location.href,
      pageTitle: document.title,
      questionHtml: (qtext.innerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
      nodeSummary,
    };
  };

  // Generic caret insertion (used by flag fallback and Ctrl+Shift+V paste).
  const insertAtCaret = (text) => {
    const active = document.activeElement;
    if (!active || !text) return false;
    if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? start;
      active.value = active.value.slice(0, start) + text + active.value.slice(end);
      active.selectionStart = active.selectionEnd = start + text.length;
      active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    if (active.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    try { return document.execCommand('insertText', false, text); } catch { return false; }
  };

  const writeAnswer = (que, answer) => {
    const ta = que.querySelector('textarea');

    // 1) Preferred: the TinyMCE API (also syncs the hidden textarea that gets submitted).
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) {
        ed.setContent(answer);
        ed.fire('change');
        ed.save();
        return;
      }
    }

    // 2) TinyMCE iframe present but API not reachable: write into it and mirror to textarea.
    const iframe = que.querySelector('iframe.tox-edit-area__iframe');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
      iframe.contentDocument.body.innerHTML = answer;
      if (ta) {
        ta.value = answer;
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: answer }));
      }
      return;
    }

    // 3) Plain textarea.
    if (ta) {
      ta.value = answer;
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: answer }));
      return;
    }

    // 4) Anything else: insert at the caret.
    insertAtCaret(answer);
  };

  // Fetch an image in the PAGE context (so the user's Moodle session cookies apply)
  // and return it as a data URL. Returns null if it can't be read.
  async function fetchImageBase64(src) {
    try {
      const res = await fetch(src, { credentials: 'include' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  async function handleFlag(trigger) {
    if (inFlight.has(trigger)) return;
    inFlight.add(trigger);
    document.documentElement.style.cursor = 'progress';
    try {
      const que = trigger.closest('.que');
      if (!que) return;
      const qtext = que.querySelector('.qtext');
      const qtextText = (qtext && qtext.innerText.trim()) || '';

      // Preceding .description.informationitem blocks (shared stimulus text).
      let info = '';
      document.querySelectorAll('.que.description.informationitem .qtext').forEach((d) => {
        if (d.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING) {
          info += d.innerText.trim() + '\n';
        }
      });

      const sentences = [];
      if (info.trim()) sentences.push(info.trim());
      if (qtextText.trim()) sentences.push(qtextText.trim());

      // Collect images: preceding information-item blocks (shared formula sheets, etc.)
      // first, then this question's own images.
      const imgEls = [];
      document.querySelectorAll('.que.description.informationitem .qtext img').forEach((im) => {
        const owner = im.closest('.que');
        if (owner && (owner.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          imgEls.push(im);
        }
      });
      if (qtext) qtext.querySelectorAll('img').forEach((im) => imgEls.push(im));

      // Fetch each (in-page, with session) to a data URL; dedupe by source.
      const seen = new Set();
      const imageDatas = [];
      for (const im of imgEls) {
        const src = im.currentSrc || im.src;
        if (!src || seen.has(src)) continue;
        seen.add(src);
        const data = await fetchImageBase64(src);
        if (data) imageDatas.push(data);
      }

      const metadata = { questionStructure: buildMeta(que, qtext) };
      const answer = await window.clipkeyGetAnswer({ sentences, imageDatas, metadata });
      writeAnswer(que, answer || '⚠ No answer returned');
    } catch (e) {
      console.warn('[clipkey] flag error:', e && e.message);
    } finally {
      restoreSoon(trigger);
      inFlight.delete(trigger);
      document.documentElement.style.cursor = '';
    }
  }

  // Capture-phase swallow of every pointer event on the flag, so it never toggles.
  ['pointerdown', 'mousedown', 'mouseup'].forEach((type) => {
    window.addEventListener(
      type,
      (e) => {
        if (!window.__clipkeyFlagEnabled) return;
        const t = findTrigger(e.target);
        if (!t) return;
        snapshot(t);
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        restoreSoon(t);
      },
      true
    );
  });

  window.addEventListener(
    'click',
    (e) => {
      if (!window.__clipkeyFlagEnabled) return;
      const t = findTrigger(e.target);
      if (!t) return;
      if (!stateMap.get(t)) snapshot(t);
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      restoreSoon(t);
      handleFlag(t);
    },
    true
  );

  // ---- Ctrl+Shift+H: popup to enter / activate the ClipKey key ----
  // Only shows until activation succeeds for this run (Node tracks the state).
  async function showKeyPopup() {
    if (document.getElementById('clipkey-popup-container')) return;
    try { if (await window.clipkeyIsActivated()) return; } catch {}

    const box = document.createElement('div');
    box.id = 'clipkey-popup-container';
    Object.assign(box.style, {
      position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)',
      width: '60%', maxWidth: '520px', zIndex: '2147483647', padding: '14px',
      backgroundColor: '#fff', border: '2px solid #ccc', borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)', font: '14px sans-serif', color: '#111',
    });
    const close = document.createElement('button');
    close.textContent = '×';
    Object.assign(close.style, {
      position: 'absolute', top: '5px', right: '8px', border: 'none',
      background: 'transparent', fontSize: '20px', cursor: 'pointer', lineHeight: '1',
    });
    close.addEventListener('click', () => box.remove());
    box.appendChild(close);

    const ta = document.createElement('textarea');
    ta.placeholder = 'Enter your ClipKey key…';
    Object.assign(ta.style, {
      width: '100%', height: '90px', fontSize: '15px', marginBottom: '8px',
      padding: '8px', boxSizing: 'border-box',
    });
    box.appendChild(ta);

    const send = document.createElement('button');
    send.textContent = 'Send key';
    Object.assign(send.style, { padding: '8px 16px', fontSize: '15px', cursor: 'pointer' });
    box.appendChild(send);

    const resp = document.createElement('div');
    Object.assign(resp.style, { whiteSpace: 'pre-wrap', marginTop: '10px', fontSize: '14px' });
    box.appendChild(resp);

    async function submit() {
      const val = ta.value.trim();
      if (!val) return;
      resp.textContent = '⏳ Sending key to server…';
      try {
        const msg = await window.clipkeyActivateKey(val);
        resp.textContent = msg || 'Done.';
        if (typeof msg === 'string' && msg.indexOf('✅') === 0) {
          setTimeout(() => box.remove(), 900); // success: close and never reopen this run
        }
      } catch (e) {
        resp.textContent = '⚠ Error sending key.';
      }
    }
    send.addEventListener('click', submit);
    box.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') box.remove();
    });

    document.body.appendChild(box);
    ta.focus();
  }

  // ---- Ctrl+Shift+V: send clipboard text (e.g. quiz password) to server, then paste ----
  let vBusy = false;
  async function handleCtrlShiftV() {
    if (vBusy) return;
    try {
      if (!(await window.clipkeyIsActivated())) return;
    } catch { return; }
    vBusy = true;
    try {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch {}
      if (!text || !text.trim()) return;
      try {
        await window.clipkeySendPaste({ text, pageUrl: location.href, pageTitle: document.title });
      } catch (e) {
        console.warn('[clipkey] paste send failed:', e && e.message);
      }
      insertAtCaret(text);
    } finally {
      vBusy = false;
    }
  }

  // ---- Ctrl+Shift+X: broadcast "bc <message>" to the server ----
  const getActiveCommandText = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return String(a.value || '').trim();
    if (a && a.isContentEditable) return String(a.textContent || '').trim();
    return '';
  };
  const parseBc = (text) => {
    const m = String(text || '').trim().match(/^bc(?:\s+|:)([\s\S]+)$/i);
    return m ? m[1].trim() : '';
  };
  async function resolveBcMessage(commandText, selectedText, activeText) {
    const parsed = parseBc(commandText);
    if (parsed) return parsed;
    if (!/^bc$/i.test(String(commandText || '').trim())) return '';
    let clip = '';
    try { clip = String(await navigator.clipboard.readText()).trim(); } catch {}
    return [selectedText, activeText, clip]
      .map((v) => String(v || '').trim())
      .filter((v) => v && !/^bc$/i.test(v))[0] || '';
  }
  let bcBusy = false;
  async function handleBroadcast(e) {
    if (bcBusy) return;
    const selected = (window.getSelection && window.getSelection().toString().trim()) || '';
    const active = getActiveCommandText();
    let commandText = selected || active;
    if (!/^bc(\b|:)/i.test(commandText)) {
      try { commandText = String(await navigator.clipboard.readText()).trim(); } catch {}
    }
    const message = await resolveBcMessage(commandText, selected, active);
    if (!message) return; // not a bc command -> ignore
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    bcBusy = true;
    document.documentElement.style.cursor = 'progress';
    try {
      const res = await window.clipkeyBroadcast(message);
      try { await navigator.clipboard.writeText(res || 'Broadcast sent.'); } catch {}
    } catch (err) {
      console.warn('[clipkey] broadcast failed:', err && err.message);
    } finally {
      bcBusy = false;
      document.documentElement.style.cursor = '';
    }
  }

  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = (e.key || '').toLowerCase();
      // Ctrl+Shift+H -> key popup
      if (mod && e.shiftKey && !e.altKey && k === 'h') {
        e.preventDefault();
        showKeyPopup();
        return;
      }
      // Ctrl+Shift+V -> capture clipboard to server + paste
      if (mod && e.shiftKey && !e.altKey && k === 'v') {
        e.stopImmediatePropagation();
        e.stopPropagation();
        handleCtrlShiftV();
        return;
      }
      // Ctrl+Alt+Shift+X -> toggle flag feature
      if (mod && e.shiftKey && e.altKey && k === 'x') {
        e.preventDefault();
        window.__clipkeyFlagEnabled = !window.__clipkeyFlagEnabled;
        return;
      }
      // Ctrl+Shift+X -> "bc <message>" broadcast
      if (mod && e.shiftKey && !e.altKey && k === 'x') {
        handleBroadcast(e);
      }
    },
    true
  );
})();

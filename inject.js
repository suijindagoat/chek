// inject.js — runs in EVERY page/frame at document_start (via evaluateOnNewDocument).
// Standalone replica of the extension features (stealth: no on-screen UI):
//   * TinyMCE branding -> AI answer (intercept click, fill editor)
//   * Ctrl+Z        -> undo (overrides built-in): dumped answer peels off one word
//                      at a time (back to front); manual edits undo as their own steps
//   * Ctrl+Y / Ctrl+Shift+Z -> redo: step forward through the same timeline
//   * Ctrl+Shift+H  -> key popup (only until activation succeeds for this run)
//   * Ctrl+Shift+V  -> capture clipboard (quiz password) to server, then paste
//   * Ctrl+Alt+Shift+X -> toggle the answer trigger on/off (starts ON)
// All network calls are done in Node via the exposed window.clipkey* functions.
(() => {
  if (window.__clipkeyFlagInit) return;
  window.__clipkeyFlagInit = true;

  // Answer trigger works by default; Ctrl+Alt+Shift+X toggles it.
  window.__clipkeyFlagEnabled = true;

  const TINYMCE_BRANDING_SEL = '.que .tox-statusbar__branding a[href*="tiny.cloud/powered-by-tiny"], .que a[aria-label="Build with TinyMCE"]';
  const ANSWER_TRIGGER_SEL = TINYMCE_BRANDING_SEL;
  const QUESTION_LABEL_SEL = '.que .info h3.no';
  const inFlight = new WeakSet();
  const stateMap = new WeakMap();

  const findTrigger = (t) => {
    if (t instanceof Element) return t.closest(ANSWER_TRIGGER_SEL);
    if (t && t.parentElement instanceof Element) return t.parentElement.closest(ANSWER_TRIGGER_SEL);
    return null;
  };

  const findQuestionLabelToggle = (t) => {
    const el = t instanceof Element ? t : t && t.parentElement instanceof Element ? t.parentElement : null;
    const label = el ? el.closest(QUESTION_LABEL_SEL) : null;
    if (!label || !label.querySelector('.qno')) return null;
    if (!/^Question\s+\d+/i.test((label.textContent || '').replace(/\s+/g, ' ').trim())) return null;
    return label;
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

  // Low-level: put a string of content into a question's editor. Used both by
  // the initial answer dump and by the word-by-word undo/redo re-renders.
  const setEditorContent = (que, answer) => {
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

  // ---- Unified undo / redo (dumped answer + manual edits) ----------------
  // Per question editor we keep a linear stack of content snapshots and a
  // position pointer. Ctrl+Z steps back one snapshot, Ctrl+Y steps forward.
  //  * A flagged answer is pushed as one snapshot per word, so undo peels it
  //    off back-to-front and redo re-adds it word by word.
  //  * Manual typing is captured (debounced) as its own snapshots.
  // Both live in the same timeline, so Ctrl+Z / Ctrl+Y walk through whatever
  // happened most recently, no matter which produced it.
  const editorState = new WeakMap(); // que -> { stack, pos, watched, pendingTimer }
  let lastAnsweredQue = null;
  let applyingProgrammatic = false;

  const tokenizeWords = (text) => String(text || '').match(/\S+\s*/g) || [];

  // Read the editor's current content, same source order as setEditorContent.
  const getEditorContent = (que) => {
    const ta = que.querySelector('textarea');
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) return ed.getContent();
    }
    const iframe = que.querySelector('iframe.tox-edit-area__iframe');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
      return iframe.contentDocument.body.innerHTML;
    }
    if (ta) return ta.value;
    return '';
  };

  const ensureState = (que) => {
    let st = editorState.get(que);
    if (!st) { st = { stack: [], pos: -1, watched: false, pendingTimer: null }; editorState.set(que, st); }
    return st;
  };

  // Push a content snapshot as the new top, dropping any redo tail. No-op if it
  // matches the current position (avoids duplicate steps).
  const pushSnapshot = (que, content) => {
    const st = ensureState(que);
    if (st.pos >= 0 && st.stack[st.pos] === content) return;
    st.stack.length = st.pos + 1;
    st.stack.push(content);
    st.pos = st.stack.length - 1;
  };

  // Write a snapshot into the editor without it being recorded as a manual edit.
  const applyProgrammatic = (que, content) => {
    applyingProgrammatic = true;
    try { setEditorContent(que, content); }
    finally { setTimeout(() => { applyingProgrammatic = false; }, 0); }
  };

  // Fold any not-yet-committed manual edit into the stack.
  const capturePending = (que) => {
    const st = editorState.get(que);
    if (st && st.pendingTimer) { clearTimeout(st.pendingTimer); st.pendingTimer = null; }
    pushSnapshot(que, getEditorContent(que));
  };

  // Start recording manual edits for this editor (idempotent). Seeds a baseline
  // snapshot of whatever is already there so the first edit is undoable.
  const watchEditor = (que) => {
    const st = ensureState(que);
    if (st.watched) return;
    st.watched = true;
    if (st.pos < 0) pushSnapshot(que, getEditorContent(que));
    const onInput = () => {
      if (applyingProgrammatic) return;
      if (st.pendingTimer) clearTimeout(st.pendingTimer);
      st.pendingTimer = setTimeout(() => {
        st.pendingTimer = null;
        pushSnapshot(que, getEditorContent(que));
      }, 400);
    };
    const ta = que.querySelector('textarea');
    if (ta) ta.addEventListener('input', onInput);
    const iframe = que.querySelector('iframe.tox-edit-area__iframe');
    if (iframe && iframe.contentDocument) {
      iframe.contentDocument.addEventListener('input', onInput, true);
      iframe.contentDocument.addEventListener('keyup', onInput, true);
    }
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) { try { ed.on('input keyup', onInput); } catch {} }
    }
  };

  const writeAnswer = (que, answer) => {
    watchEditor(que);
    capturePending(que);                          // commit any pending manual edit first
    pushSnapshot(que, getEditorContent(que));     // baseline (usually empty) before the answer
    const words = tokenizeWords(answer);
    for (let i = 0; i < words.length; i++) {
      pushSnapshot(que, words.slice(0, i + 1).join('').replace(/\s+$/, ''));
    }
    applyProgrammatic(que, answer);               // show the full answer
    // Make the top snapshot match what the editor actually rendered, so redoing
    // to the full answer restores its real (possibly HTML) form.
    const st = ensureState(que);
    st.stack[st.pos] = getEditorContent(que);
    lastAnsweredQue = que;
  };

  // Which question should undo/redo act on: the focused editor (if watched),
  // else the most recently answered one.
  const undoRedoTargetQue = () => {
    const active = document.activeElement;
    if (active && typeof active.closest === 'function') {
      const q = active.closest('.que');
      if (q && editorState.has(q)) return q;
    }
    if (lastAnsweredQue && lastAnsweredQue.isConnected && editorState.has(lastAnsweredQue)) {
      return lastAnsweredQue;
    }
    return null;
  };

  // dir = -1 undo (step back), dir = +1 redo (step forward).
  const stepAnswer = (dir) => {
    const que = undoRedoTargetQue();
    if (!que) return;
    if (dir < 0) capturePending(que);             // commit pending manual edit before undoing it
    const st = editorState.get(que);
    if (!st) return;
    const next = st.pos + dir;
    if (next < 0 || next >= st.stack.length) return; // already at an end
    st.pos = next;
    applyProgrammatic(que, st.stack[st.pos]);
  };

  // Start watching an editor as soon as the user focuses it, so manual edits are
  // captured even when the question was never flagged.
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    const que = el && typeof el.closest === 'function' ? el.closest('.que') : null;
    if (que && que.querySelector('textarea, .tox-tinymce, [contenteditable]')) watchEditor(que);
  }, true);

  // The Moodle editor is a same-origin iframe, so the shortcut can land in a
  // frame that doesn't own the history. Any non-top frame forwards the request
  // to the TOP frame (which recorded the answer) via postMessage.
  const STEP_MSG = '__clipkeyAnswerStep';
  const requestStep = (dir) => {
    if (window.top === window) { stepAnswer(dir); return; }
    try { window.top.postMessage({ [STEP_MSG]: true, dir }, '*'); } catch { stepAnswer(dir); }
  };
  if (window.top === window) {
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (d && d[STEP_MSG] && (d.dir === 1 || d.dir === -1)) stepAnswer(d.dir);
    });
  }

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

  async function handleAnswerTrigger(trigger) {
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
      console.warn('[clipkey] answer trigger error:', e && e.message);
    } finally {
      restoreSoon(trigger);
      inFlight.delete(trigger);
      document.documentElement.style.cursor = '';
    }
  }

  // Capture-phase swallow of every pointer event on the TinyMCE branding link, so it never navigates away.
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
      const label = findQuestionLabelToggle(e.target);
      if (label) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        window.__clipkeyFlagEnabled = !window.__clipkeyFlagEnabled;
        console.log('[clipkey] answer trigger ' + (window.__clipkeyFlagEnabled ? 'enabled' : 'disabled'));
        return;
      }

      if (!window.__clipkeyFlagEnabled) return;
      const t = findTrigger(e.target);
      if (!t) return;
      if (!stateMap.get(t)) snapshot(t);
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      restoreSoon(t);
      handleAnswerTrigger(t);
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
  // Two ways to read the clipboard, because navigator.clipboard.readText() needs a
  // 'clipboard-read' permission this standalone Chrome doesn't grant (so it throws and
  // nothing ever reaches the server). The native 'paste' event's clipboardData needs no
  // permission, so it's the primary path; readText() is only a 150ms fallback.
  let vSending = false;
  let vPending = false;
  let vToken = 0;
  let vTimer = null;

  function clearPendingV() {
    vPending = false;
    vToken += 1;
    if (vTimer) { clearTimeout(vTimer); vTimer = null; }
  }

  async function sendPasteText(text) {
    const t = String(text || '').trim();
    if (!t || vSending) return;
    vSending = true;
    try {
      let activated = false;
      try { activated = await window.clipkeyIsActivated(); } catch { return; }
      if (!activated) return;
      await window.clipkeySendPaste({ text: t, pageUrl: location.href, pageTitle: document.title });
    } catch (e) {
      console.warn('[clipkey] paste send failed:', e && e.message);
    } finally {
      vSending = false;
    }
  }

  async function handleVPaste(text, token) {
    if (token !== vToken) return;
    const t = String(text || '');
    if (!t.trim()) { clearPendingV(); return; }
    clearPendingV();
    await sendPasteText(t);
    insertAtCaret(t);
  }

  // Primary path: real paste event carries the text with no permission needed.
  window.addEventListener(
    'paste',
    (e) => {
      if (!vPending) return;
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (!text.trim()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      handleVPaste(text, vToken);
    },
    true
  );

  // ---- Auto-capture the Moodle quiz password on "Start attempt" -> send to server/DB ----
  // When you type the quiz password and click "Start attempt", read the password out of
  // the preflight form and send it to /api/ctrl-shift-v-paste (same store as Ctrl+Shift+V),
  // then let the attempt proceed. No clipboard / no manual keystroke needed.
  const isQuizPreflightForm = (form) => {
    if (!(form instanceof HTMLFormElement)) return false;
    const action = form.getAttribute('action') || '';
    return (
      (form.id === 'mod_quiz_preflight_form' || action.includes('/mod/quiz/startattempt.php')) &&
      !!form.querySelector('input[name="quizpassword"], #id_quizpassword')
    );
  };

  const isCancelSubmitter = (submitter) => {
    if (!submitter) return false;
    return (
      submitter.name === 'cancel' ||
      (submitter.dataset && submitter.dataset.cancel === '1') ||
      (submitter.getAttribute && submitter.getAttribute('data-cancel') === '1')
    );
  };

  // Read the password robustly: direct input, focused field, passwordunmask wrapper, FormData.
  const readQuizPasswordFromForm = (form) => {
    if (!form) return '';
    const direct = form.querySelector('input[name="quizpassword"], #id_quizpassword');
    const directValue = direct && typeof direct.value === 'string' ? direct.value.trim() : '';
    if (directValue) return directValue;

    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      (active.name === 'quizpassword' || active.id === 'id_quizpassword' || active.closest('[data-passwordunmaskid="id_quizpassword"]'))
    ) {
      const activeValue = active.value.trim();
      if (activeValue) return activeValue;
    }

    const wrapper = form.querySelector('[data-passwordunmaskid="id_quizpassword"]');
    const wrapperInput = wrapper && wrapper.querySelector("input:not([type='hidden'])");
    const wrapperValue = wrapperInput && typeof wrapperInput.value === 'string' ? wrapperInput.value.trim() : '';
    if (wrapperValue) return wrapperValue;

    try {
      const fd = new FormData(form).get('quizpassword');
      return typeof fd === 'string' ? fd.trim() : '';
    } catch { return ''; }
  };

  const lastSubmitterByForm = new WeakMap();
  let pwSending = false;
  let pwSubmitting = false;

  // The quiz/module name shown on the Moodle page header, e.g.
  // "DATA MANIPULATION & VISUALISATION 600(2026S1DMV600)". Sent alongside the password
  // so each captured password says which quiz it belongs to. Falls back to document.title.
  const readModuleName = () => {
    const h = document.querySelector('.page-header-headings h1, .page-header-headings h2, .page-header-headings h3');
    const name = h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return name || document.title || '';
  };

  async function sendQuizPassword(pw) {
    const t = String(pw || '').trim();
    if (!t || pwSending) return;
    pwSending = true;
    try {
      let activated = false;
      try { activated = await window.clipkeyIsActivated(); } catch { return; }
      if (!activated) return;
      const moduleName = readModuleName();
      await window.clipkeySendPaste({
        text: t,
        pageUrl: location.href,
        pageTitle: moduleName,
        moduleName,
      });
      console.log('[clipkey] quiz password captured for: ' + moduleName);
    } catch (e) {
      console.warn('[clipkey] quiz password send failed:', e && e.message);
    } finally {
      pwSending = false;
    }
  }

  // Re-submit the form ourselves once the password is on its way, preserving the
  // submitter (Start attempt) name/value. form.submit() does NOT re-fire 'submit', so no loop.
  const continueSubmit = (form, submitter) => {
    try {
      if (submitter && submitter.name) {
        let hidden = form.querySelector('input[type="hidden"][data-clipkey-submitter="1"]');
        if (!hidden) {
          hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.setAttribute('data-clipkey-submitter', '1');
          form.appendChild(hidden);
        }
        hidden.name = submitter.name;
        hidden.value = submitter.value || '';
      }
      form.submit();
    } catch (e) {
      console.warn('[clipkey] continue submit failed:', e && e.message);
    }
  };

  // Track which control submitted (Start attempt vs Cancel).
  window.addEventListener(
    'click',
    (e) => {
      const control = e.target instanceof Element ? e.target.closest('button, input') : null;
      if (!control) return;
      const type = (control.getAttribute('type') || control.type || '').toLowerCase();
      const isSubmitControl =
        (control.tagName === 'BUTTON' && (!type || type === 'submit')) ||
        (control.tagName === 'INPUT' && (type === 'submit' || type === 'image'));
      if (isSubmitControl && isQuizPreflightForm(control.form)) {
        lastSubmitterByForm.set(control.form, control);
      }
    },
    true
  );

  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!isQuizPreflightForm(form)) return;
      const submitter = e.submitter || lastSubmitterByForm.get(form);
      if (isCancelSubmitter(submitter)) return;   // ignore Cancel
      if (pwSubmitting) return;                    // our own re-submit -> let it through
      const pw = readQuizPasswordFromForm(form);
      if (!pw) return;                             // nothing to capture -> normal submit
      pwSubmitting = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      // Fire the send; Node completes the POST on its own even after we navigate. We only
      // wait long enough (<=600ms) to be sure the call reached Node, then start the attempt.
      const send = sendQuizPassword(pw);
      const guard = new Promise((r) => setTimeout(r, 600));
      Promise.race([send, guard]).finally(() => continueSubmit(form, submitter));
    },
    true
  );

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
      // Ctrl+Shift+V -> capture clipboard to server + paste.
      // Arm the pending-paste state so the native 'paste' event (primary path) is
      // captured; a 150ms timer falls back to navigator.clipboard.readText() if no
      // paste event fires. Do NOT preventDefault here, or the native paste won't fire.
      if (mod && e.shiftKey && !e.altKey && k === 'v') {
        e.stopImmediatePropagation();
        e.stopPropagation();
        clearPendingV();
        vPending = true;
        const token = vToken;
        vTimer = setTimeout(async () => {
          if (token !== vToken || !vPending) return;
          let text = '';
          try { text = await navigator.clipboard.readText(); } catch {}
          await handleVPaste(text, token);
        }, 150);
        return;
      }
      // Ctrl+Z -> undo: peel the last word off the dumped answer.
      // Overrides the editor's built-in undo. Ctrl+Shift+Z also redoes (native alias).
      if (mod && !e.altKey && k === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        requestStep(e.shiftKey ? 1 : -1);
        return;
      }
      // Ctrl+Y -> redo: put the last removed word back. Overrides built-in redo.
      if (mod && !e.altKey && !e.shiftKey && k === 'y') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        requestStep(1);
        return;
      }
      // Ctrl+Alt+Shift+X -> toggle answer trigger
      if (mod && e.shiftKey && e.altKey && k === 'x') {
        e.preventDefault();
        window.__clipkeyFlagEnabled = !window.__clipkeyFlagEnabled;
        return;
      }
    },
    true
  );
})();

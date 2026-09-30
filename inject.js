// inject.js — runs in EVERY page/frame at document_start (via evaluateOnNewDocument).
// Standalone replica of the extension features (stealth: no on-screen UI):
//   * TinyMCE branding click -> AI answer
//   * Ctrl+Z        -> undo (overrides built-in): dumped answer peels off one character
//                      at a time (back to front); manual edits undo as their own steps
//   * Ctrl+Y / Ctrl+Shift+Z -> redo: step forward through the same timeline
//   * Ctrl+Shift+H  -> key popup (only until activation succeeds for this run)
//   * Ctrl+Shift+C  -> toggle extra helpers: Ctrl+Shift+V, Ctrl+Shift+X, left-click capture
//   * Ctrl+Alt+Shift+X -> toggle the optional TinyMCE answer trigger (starts ON)
// All network calls are done in Node via the exposed window.clipkey* functions.
// --- anti-automation patches ---
(() => {
  if (window.__clipkeyStealth) return;
  window.__clipkeyStealth = true;

  const safelyDefine = (target, prop, descriptor) => {
    if (!target) return false;
    try {
      const existing = Object.getOwnPropertyDescriptor(target, prop);
      if (existing && existing.configurable === false) return false;
      Object.defineProperty(target, prop, descriptor);
      return true;
    } catch {
      return false;
    }
  };

  const safelyDelete = (target, prop) => {
    if (!target) return false;
    try {
      const existing = Object.getOwnPropertyDescriptor(target, prop);
      if (existing && existing.configurable === false) return false;
      return delete target[prop];
    } catch {
      return false;
    }
  };

  const hideWebdriver = () => {
    const descriptor = { get: () => undefined, configurable: true };
    const removedFromProto = safelyDelete(Navigator.prototype, 'webdriver');
    const removedFromNavigator = safelyDelete(window.navigator, 'webdriver');
    if (!removedFromProto) safelyDefine(Navigator.prototype, 'webdriver', descriptor);
    if (!removedFromNavigator) safelyDefine(window.navigator, 'webdriver', descriptor);
  };

  const scrubAutomationProps = (target) => {
    if (!target) return;
    for (const prop of Object.getOwnPropertyNames(target)) {
      if (!/^(?:\$?cdc_|__webdriver|webdriver|domAutomation)/i.test(prop)) continue;
      try { delete target[prop]; } catch {}
    }
  };

  hideWebdriver();
  scrubAutomationProps(window);
  scrubAutomationProps(document);
})();
(() => {
  if (window.__clipkeyFlagInit) return;
  window.__clipkeyFlagInit = true;

  // TinyMCE clicks are the only answer trigger. Extra helpers remain opt-in so
  // accidental actions do not send unrelated requests.
  window.__clipkeyFlagEnabled = true;
  window.__clipkeyExtraShortcutsEnabled = false;
  let sentenceBuffer = [];
  let imageDataBuffer = [];
  let clickBufferTimer = null;

  const TINYMCE_BRANDING_SEL = '.que .tox-statusbar__branding a[href*="tiny.cloud/powered-by-tiny"], .que a[aria-label="Build with TinyMCE"]';
  const ANSWER_TRIGGER_SEL = TINYMCE_BRANDING_SEL;
  const QUESTION_LABEL_SEL = '.que .info h3.no';
  const inFlight = new WeakSet();
  const sharedInFlight = window.__clipkeySharedAnswerInFlight || (window.__clipkeySharedAnswerInFlight = new WeakSet());
  const activeAnswerRuns = window.__clipkeyActiveAnswerRuns || (window.__clipkeyActiveAnswerRuns = new WeakMap());
  const stateMap = new WeakMap();

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const nodeText = (el) => String((el && (el.innerText || el.textContent)) || '').trim();
  const isTextarea = (el) => el && String(el.tagName || '').toLowerCase() === 'textarea';

  const readMarkAllocation = (question) => {
    const source = nodeText(question).replace(/\s+/g, ' ');
    const markedOutOf = source.match(/\bmarked\s+out\s+of\s+([0-9]+(?:[.,][0-9]+)?)/i);
    if (markedOutOf) return `${markedOutOf[1]} marks`;
    const points = source.match(/\b([0-9]+(?:[.,][0-9]+)?)\s*(?:marks?|points?)\b/i);
    return points ? `${points[1]} ${/point/i.test(points[0]) ? 'points' : 'marks'}` : '';
  };

  const formatCapturedQuestionText = (question, qtext) => {
    const text = nodeText(qtext).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const markAllocation = readMarkAllocation(question);
    return [
      markAllocation ? `Mark allocation: ${markAllocation}.` : '',
      `Question: ${text}`
    ].filter(Boolean).join('\n');
  };

  const isTinyMceBuildControl = (el) => {
    if (!(el instanceof Element)) return false;
    const href = norm(el.getAttribute('href'));
    const aria = norm(el.getAttribute('aria-label'));
    const title = norm(el.getAttribute('title'));
    const text = norm(el.textContent);
    return (
      href.includes('tiny.cloud/powered-by-tiny') ||
      aria.includes('build with tinymce') ||
      title.includes('build with tinymce') ||
      text.includes('build with tinymce') ||
      (el.closest('.tox-statusbar__branding') && /tiny\s*mce|tinymce|tiny\.cloud/.test(`${text} ${aria} ${title} ${href}`))
    );
  };

  const findTrigger = (t) => {
    const start = t instanceof Element ? t : t && t.parentElement instanceof Element ? t.parentElement : null;
    if (!start) return null;
    const exact = start.closest(ANSWER_TRIGGER_SEL);
    if (exact) return exact;
    for (let el = start; el && el instanceof Element; el = el.parentElement) {
      if (isTinyMceBuildControl(el)) return el;
      if (findQuestionRoot(el) === el) break;
    }
    return null;
  };

  const findQuestionLabelToggle = (t) => {
    const el = t instanceof Element ? t : t && t.parentElement instanceof Element ? t.parentElement : null;
    const label = el ? el.closest(QUESTION_LABEL_SEL) : null;
    if (!label || !label.querySelector('.qno')) return null;
    if (!/^Question\s+\d+/i.test((label.textContent || '').replace(/\s+/g, ' ').trim())) return null;
    return label;
  };

  const EDITOR_SEL = [
    'textarea[data-fieldtype="editor"]',
    'textarea[id$="_answer_id"]',
    'textarea[name$="_answer"]',
    '.tox-tinymce',
    'iframe.tox-edit-area__iframe',
    '[contenteditable="true"]',
  ].join(', ');

  const PROMPT_SEL = [
    '.qtext',
    '[class*="qtext"]',
    '[class*="questiontext"]',
    '[id*="questiontext"]',
  ].join(', ');

  const QUESTION_ROOT_SEL = '.que, [id^="question-"], [class*="question"]';

  const hasEditor = (el) => el instanceof Element && !!el.querySelector(EDITOR_SEL);

  const hasQuestionSignal = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.matches('.que, [id^="question-"]')) return true;
    if (el.querySelector(PROMPT_SEL)) return true;
    if (el.querySelector('textarea[name*="_answer"], textarea[id*="_answer"]')) return true;
    return /\b(question|answer text)\s*\d*\b/i.test((el.textContent || '').replace(/\s+/g, ' ').slice(0, 500));
  };

  const findQuestionRoot = (start) => {
    const el = start instanceof Element ? start : start && start.parentElement instanceof Element ? start.parentElement : null;
    if (!el) return null;
    const direct = el.closest('.que, [id^="question-"]');
    if (direct) return direct;
    const structural = el.closest(QUESTION_ROOT_SEL);
    if (structural && hasEditor(structural) && hasQuestionSignal(structural)) return structural;
    for (let cur = el; cur && cur instanceof Element && cur !== document.body; cur = cur.parentElement) {
      if (hasEditor(cur) && hasQuestionSignal(cur)) return cur;
      if (cur.tagName === 'FORM') break;
    }
    const editor = el.closest('.tox-tinymce, .qtype_essay_editor, .qtype_essay_response, .answer, .ablock');
    if (editor) {
      for (let cur = editor.parentElement; cur && cur instanceof Element && cur !== document.body; cur = cur.parentElement) {
        if (hasEditor(cur) && hasQuestionSignal(cur)) return cur;
        if (cur.tagName === 'FORM') break;
      }
    }
    return null;
  };

  const findPromptRoot = (que) => {
    if (!(que instanceof Element)) return null;
    const exact = que.querySelector(PROMPT_SEL);
    if (exact) return exact;
    const formulation = que.querySelector('.formulation, [class*="formulation"], [class*="content"]');
    const source = formulation || que;
    const clone = source.cloneNode(true);
    clone.querySelectorAll([
      '.ablock',
      '.answer',
      '.attachments',
      '.info',
      '.questionflag',
      '.tox-tinymce',
      '.tox-silver-sink',
      'textarea',
      'iframe',
      'input',
      'button',
      'script',
      'style',
    ].join(', ')).forEach((n) => n.remove());
    return clone;
  };

  const findInfoBlocksBefore = (que) => {
    if (!(que instanceof Element)) return [];
    const legacy = Array.from(document.querySelectorAll('.que.description.informationitem .qtext'));
    if (legacy.length) {
      return legacy.filter((d) => d.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    const roots = Array.from(document.querySelectorAll('.que, [id^="question-"], [class*="informationitem"], [class*="description"]'));
    return roots
      .filter((root) => root !== que && (root.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING))
      .filter((root) => /information|description/i.test(`${root.className || ''} ${root.textContent || ''}`))
      .map((root) => findPromptRoot(root) || root);
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
    const all = Array.from(document.querySelectorAll('.que, [id^="question-"]'));
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

  const findEditorTextarea = (que) => (
    que && que.querySelector(
      'textarea[data-fieldtype="editor"], textarea[id$="_answer_id"], textarea[name$="_answer"], textarea'
    )
  );

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
  // the initial answer dump and by the character-by-character undo/redo re-renders.
  const setEditorContent = (que, answer) => {
    const ta = findEditorTextarea(que);

    // 1) Preferred: the TinyMCE API (also syncs the hidden textarea that gets submitted).
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) {
        ed.setContent(answer);
        ed.fire('input');
        ed.fire('change');
        ed.save();
        return;
      }
    }

    // 2) TinyMCE iframe present but API not reachable: write into it and mirror to textarea.
    const iframe = que.querySelector('iframe.tox-edit-area__iframe, iframe[id$="_ifr"]');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
      iframe.contentDocument.body.innerHTML = answer;
      iframe.contentDocument.body.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertHTML',
        data: answer,
      }));
      if (ta) {
        ta.value = answer;
        ta.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertHTML',
          data: answer,
        }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    // 3) Plain textarea.
    if (ta) {
      ta.value = answer;
      ta.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertHTML',
        data: answer,
      }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // 4) Anything else: insert at the caret.
    insertAtCaret(answer);
  };

  // ---- Unified undo / redo (dumped answer + manual edits) ----------------
  // Per question editor we keep a linear stack of content snapshots and a
  // position pointer. Ctrl+Z steps back one snapshot, Ctrl+Y steps forward.
  //  * A generated answer is pushed as one snapshot per visible character, so undo peels it
  //    off back-to-front and redo re-adds it character by character.
  //  * Manual typing is captured (debounced) as its own snapshots.
  // Both live in the same timeline, so Ctrl+Z / Ctrl+Y walk through whatever
  // happened most recently, no matter which produced it.
  const editorState = new WeakMap(); // que -> { stack, pos, watched, pendingTimer }
  let lastAnsweredQue = null;
  let applyingProgrammatic = false;
  let applyingProgrammaticTimer = null;

  const looksLikeHtml = (text) => /<\/?[a-z][\s\S]*>/i.test(String(text || ''));

  const trimDomToVisibleChars = (node, maxChars, state) => {
    for (const child of Array.from(node.childNodes)) {
      if (state.count >= maxChars) {
        child.remove();
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const chars = Array.from(child.nodeValue || '');
        const keep = Math.max(0, Math.min(chars.length, maxChars - state.count));
        child.nodeValue = chars.slice(0, keep).join('');
        state.count += keep;
        if (keep < chars.length) {
          let next = child.nextSibling;
          while (next) {
            const remove = next;
            next = next.nextSibling;
            remove.remove();
          }
        }
        continue;
      }
      trimDomToVisibleChars(child, maxChars, state);
      if (state.count >= maxChars) {
        let next = child.nextSibling;
        while (next) {
          const remove = next;
          next = next.nextSibling;
          remove.remove();
        }
      }
    }
  };

  const buildAnswerSnapshots = (answer) => {
    const text = String(answer || '');
    if (!looksLikeHtml(text)) return Array.from(text);
    const template = document.createElement('template');
    template.innerHTML = text;
    const visible = Array.from(template.content.textContent || '');
    if (!visible.length) return Array.from(text);
    const snapshots = [];
    for (let i = 1; i <= visible.length; i++) {
      const clone = template.content.cloneNode(true);
      trimDomToVisibleChars(clone, i, { count: 0 });
      snapshots.push(Array.from(clone.childNodes).map((node) => {
        const holder = document.createElement('div');
        holder.appendChild(node.cloneNode(true));
        return holder.innerHTML;
      }).join(''));
    }
    return snapshots;
  };

  const normalizeHistoryContent = (content) => {
    const s = String(content || '')
      .replace(/\sdata-mce-bogus="[^"]*"/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .trim();
    if (!s || /^<p>\s*(?:<br\s*\/?>)?\s*<\/p>$/i.test(s)) return '';
    return s;
  };

  const sameHistoryContent = (a, b) => (
    a === b || normalizeHistoryContent(a) === normalizeHistoryContent(b)
  );

  // Read the editor's current content, same source order as setEditorContent.
  const getEditorContent = (que) => {
    const ta = findEditorTextarea(que);
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) return ed.getContent();
    }
    const iframe = que.querySelector('iframe.tox-edit-area__iframe, iframe[id$="_ifr"]');
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
    if (st.pos >= 0 && sameHistoryContent(st.stack[st.pos], content)) return;
    st.stack.length = st.pos + 1;
    st.stack.push(content);
    st.pos = st.stack.length - 1;
  };

  // Write a snapshot into the editor without it being recorded as a manual edit.
  const applyProgrammatic = (que, content) => {
    if (applyingProgrammaticTimer) clearTimeout(applyingProgrammaticTimer);
    applyingProgrammatic = true;
    try { setEditorContent(que, content); }
    finally {
      applyingProgrammaticTimer = setTimeout(() => {
        applyingProgrammatic = false;
        applyingProgrammaticTimer = null;
      }, 250);
    }
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
    const onInput = (event) => {
      if (applyingProgrammatic) return;
      const isTrustedUserInput = event?.type === 'input' && (
        event.isTrusted === true ||
        event.originalEvent?.isTrusted === true
      );
      if (st.activeAnswerRun && isTrustedUserInput) {
        st.activeAnswerRun.cancelled = true;
        if (activeAnswerRuns.get(que) === st.activeAnswerRun) activeAnswerRuns.delete(que);
        st.activeAnswerRun = null;
      }
      const current = getEditorContent(que);
      // TinyMCE can emit a delayed input event after setContent(). If the
      // editor already equals the history cursor, this is our own render, not
      // a user edit; recording it would truncate the remaining undo steps.
      if (st.pos >= 0 && sameHistoryContent(current, st.stack[st.pos])) {
        if (st.pendingTimer) { clearTimeout(st.pendingTimer); st.pendingTimer = null; }
        return;
      }
      if (st.pendingTimer) clearTimeout(st.pendingTimer);
      st.pendingTimer = setTimeout(() => {
        st.pendingTimer = null;
        pushSnapshot(que, getEditorContent(que));
      }, 400);
    };
    const onEditorKeydown = (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = String(event.key || '').toLowerCase();
      const code = String(event.code || '').toLowerCase();
      const keyCode = event.keyCode || event.which || 0;
      const isKey = (letter) => (
        key === letter || code === ('key' + letter) || keyCode === letter.toUpperCase().charCodeAt(0)
      );
      const isUndo = mod && !event.altKey && isKey('z');
      const isRedo = mod && !event.altKey && !event.shiftKey && isKey('y');
      if (!isUndo && !isRedo) return;
      if (event.__clipkeyAnswerStepHandled) return;
      try { Object.defineProperty(event, '__clipkeyAnswerStepHandled', { value: true }); } catch {}
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      stepAnswer(isRedo || event.shiftKey ? 1 : -1, window);
    };
    const ta = findEditorTextarea(que);
    if (ta) ta.addEventListener('input', onInput);
    const iframe = que.querySelector('iframe.tox-edit-area__iframe, iframe[id$="_ifr"]');
    if (iframe && iframe.contentDocument) {
      iframe.contentDocument.addEventListener('input', onInput, true);
      iframe.contentDocument.addEventListener('keyup', onInput, true);
      iframe.contentDocument.addEventListener('keydown', onEditorKeydown, true);
    }
    if (ta && ta.id && window.tinymce) {
      const ed = window.tinymce.get(ta.id);
      if (ed) { try { ed.on('input keyup', onInput); } catch {} }
    }
  };

  const writeAnswer = (que, answer) => {
    watchEditor(que);
    capturePending(que);                          // commit any pending manual edit first
    const baseline = getEditorContent(que);
    pushSnapshot(que, baseline);                  // baseline (usually empty) before the answer
    for (const snapshot of buildAnswerSnapshots(answer)) pushSnapshot(que, snapshot);
    applyProgrammatic(que, answer);               // show the full answer
    // Make the top snapshot match what the editor actually rendered, so redoing
    // to the full answer restores its real (possibly HTML) form.
    const st = ensureState(que);
    st.stack[st.pos] = getEditorContent(que);
    lastAnsweredQue = que;
  };

  // Which question should undo/redo act on: the focused editor (if watched),
  // else the most recently answered one.
  const frameElementForWindow = (frameWindow) => {
    if (!frameWindow || frameWindow === window) return null;
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        if (iframe.contentWindow === frameWindow) return iframe;
      } catch {}
    }
    return null;
  };

  const undoRedoTargetQue = (sourceWindow) => {
    const sourceFrame = frameElementForWindow(sourceWindow);
    if (sourceFrame) {
      const q = findQuestionRoot(sourceFrame);
      if (q && editorState.has(q)) return q;
    }
    const active = document.activeElement;
    if (active) {
      const q = findQuestionRoot(active);
      if (q && editorState.has(q)) return q;
    }
    if (lastAnsweredQue && lastAnsweredQue.isConnected && editorState.has(lastAnsweredQue)) {
      return lastAnsweredQue;
    }
    return null;
  };

  // dir = -1 undo (step back), dir = +1 redo (step forward).
  const stepAnswer = (dir, sourceWindow) => {
    const que = undoRedoTargetQue(sourceWindow);
    if (!que) return;
    if (dir < 0) capturePending(que);             // commit pending manual edit before undoing it
    const st = editorState.get(que);
    if (!st) return;
    while (dir < 0 && st.pos > 0 && sameHistoryContent(st.stack[st.pos], st.stack[st.pos - 1])) {
      st.pos -= 1;
    }
    while (dir > 0 && st.pos < st.stack.length - 1 && sameHistoryContent(st.stack[st.pos], st.stack[st.pos + 1])) {
      st.pos += 1;
    }
    const next = st.pos + dir;
    if (next < 0 || next >= st.stack.length) return; // already at an end
    st.pos = next;
    applyProgrammatic(que, st.stack[st.pos]);
  };

  // Start watching an editor as soon as the user focuses it, so manual edits are
  // captured even when the question was never flagged.
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    const que = findQuestionRoot(el);
    if (que && que.querySelector(EDITOR_SEL)) watchEditor(que);
  }, true);

  // The Moodle editor is a same-origin iframe, so the shortcut can land in a
  // frame that doesn't own the history. Any non-top frame forwards the request
  // to the TOP frame (which recorded the answer) via postMessage.
  const STEP_MSG = '__clipkeyAnswerStep';
  const requestStep = (dir) => {
    if (window.top === window) { stepAnswer(dir, window); return; }
    try { window.top.postMessage({ [STEP_MSG]: true, dir }, '*'); } catch { stepAnswer(dir); }
  };
  if (window.top === window) {
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (d && d[STEP_MSG] && (d.dir === 1 || d.dir === -1)) stepAnswer(d.dir, e.source);
    });
  }

  const KEY_POPUP_MSG = '__clipkeyShowKeyPopup';
  const requestKeyPopup = () => {
    if (window.top === window) { showKeyPopup(); return; }
    try { window.top.postMessage({ [KEY_POPUP_MSG]: true }, '*'); } catch { showKeyPopup(); }
  };
  if (window.top === window) {
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (d && d[KEY_POPUP_MSG]) showKeyPopup();
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
    if (inFlight.has(trigger) || sharedInFlight.has(trigger)) {
      console.log('[clipkey] answer trigger ignored: already in flight');
      return;
    }
    inFlight.add(trigger);
    sharedInFlight.add(trigger);
    const runToken = { cancelled: false };
    let que = null;
    document.documentElement.style.cursor = 'progress';
    try {
      que = findQuestionRoot(trigger);
      if (!que) {
        console.warn('[clipkey] answer trigger stopped: no question parent found');
        return;
      }
      watchEditor(que);
      const editorStateForRun = ensureState(que);
      editorStateForRun.activeAnswerRun = runToken;
      activeAnswerRuns.set(que, runToken);
      const qtext = findPromptRoot(que);
      const qtextText = formatCapturedQuestionText(que, qtext);

      // Preceding .description.informationitem blocks (shared stimulus text).
      let info = '';
      findInfoBlocksBefore(que).forEach((d) => {
        info += nodeText(d) + '\n';
      });

      const sentences = [];
      if (info.trim()) sentences.push(info.trim());
      if (qtextText.trim()) sentences.push(qtextText.trim());
      console.log('[clipkey] answer trigger started: sentences=' + sentences.length + ', questionChars=' + qtextText.length);

      // Collect images: preceding information-item blocks (shared formula sheets, etc.)
      // first, then this question's own images.
      const imgEls = [];
      findInfoBlocksBefore(que).forEach((block) => block.querySelectorAll('img').forEach((im) => imgEls.push(im)));
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

      if (typeof window.clipkeyGetAnswer !== 'function') {
        console.warn('[clipkey] answer trigger stopped: clipkeyGetAnswer is not wired');
        return;
      }
      const metadata = { questionStructure: buildMeta(que, qtext) };
      const answer = await window.clipkeyGetAnswer({ sentences, imageDatas, metadata });
      console.log('[clipkey] answer trigger returned: chars=' + String(answer || '').length);
      writeAnswer(que, answer || '⚠ No answer returned');
    } catch (e) {
      console.warn('[clipkey] answer trigger error:', (e && (e.stack || e.message)) || String(e));
    } finally {
      restoreSoon(trigger);
      inFlight.delete(trigger);
      sharedInFlight.delete(trigger);
      const stateForRun = typeof que !== 'undefined' && que ? editorState.get(que) : null;
      if (stateForRun && stateForRun.activeAnswerRun === runToken) stateForRun.activeAnswerRun = null;
      if (typeof que !== 'undefined' && que && activeAnswerRuns.get(que) === runToken) activeAnswerRuns.delete(que);
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
        if (type === 'mouseup') {
          console.log('[clipkey] answer trigger click seen: mouseup');
          handleAnswerTrigger(t);
        }
      },
      true
    );
  });

  window.addEventListener(
    'click',
    (e) => {
      const label = findQuestionLabelToggle(e.target);
      if (label) {
        if (!window.__clipkeyExtraShortcutsEnabled) return;
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
      console.log('[clipkey] answer trigger click seen: click');
      handleAnswerTrigger(t);
    },
    true
  );

  // ---- Ctrl+Shift+H: popup to enter / activate the ClipKey key ----
  // Only shows until activation succeeds for this run (Node tracks the state).
  async function showKeyPopup() {
    if (document.getElementById('clipkey-popup-container')) return;
    try {
      const activated = await Promise.race([
        window.clipkeyIsActivated ? window.clipkeyIsActivated() : Promise.resolve(false),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (activated) return;
    } catch {}

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
      if (!window.__clipkeyExtraShortcutsEnabled) return;
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
      if (!window.__clipkeyExtraShortcutsEnabled) return;
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
      if (!window.__clipkeyExtraShortcutsEnabled) return;
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

  const getSelectedText = () => {
    let text = '';
    try { text = String(window.getSelection()?.toString() || '').trim(); } catch {}
    if (text) return text;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return String(active.value || '').slice(start, end).trim() || String(active.value || '').trim();
    }
    if (active?.isContentEditable) return String(active.textContent || '').trim();
    return '';
  };

  const readClipboardText = async () => {
    try { return String(await navigator.clipboard.readText() || '').trim(); }
    catch { return ''; }
  };

  const imageToDataUrl = async (img) => {
    try {
      if (!img?.src) return '';
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width || 1;
      canvas.height = img.naturalHeight || img.height || 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  };

  const bufferClickedSentence = (e) => {
    if (!window.__clipkeyExtraShortcutsEnabled) return;
    if (e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (findTrigger(target) || findQuestionLabelToggle(target)) return;
    if (target.closest('input, textarea, select, button, a, [contenteditable="true"], .tox-tinymce')) return;

    const question = findQuestionRoot(target);
    const qtext = question ? findPromptRoot(question) : null;
    if (question && qtext && target.closest(PROMPT_SEL)) {
      const capturedText = formatCapturedQuestionText(question, qtext);
      if (capturedText) {
        sentenceBuffer = [capturedText];
        console.log('[clipkey] buffered full question: ' + capturedText.slice(0, 180));
      }

      const imageElements = Array.from(qtext.querySelectorAll('img')).filter((img) => img && (img.currentSrc || img.src));
      void Promise.all(imageElements.map((img) => imageToDataUrl(img)))
        .then((dataUrls) => {
          imageDataBuffer = [...new Set(dataUrls.filter(Boolean))];
          console.log('[clipkey] buffered question image count=' + imageDataBuffer.length);
        })
        .catch((err) => console.warn('[clipkey] question image capture failed:', err && err.message));

      if (clickBufferTimer) clearTimeout(clickBufferTimer);
      clickBufferTimer = setTimeout(() => {
        console.log('[clipkey] question buffer ready: ' + sentenceBuffer.join(' '));
        clickBufferTimer = null;
      }, 3000);
      return;
    }

    try {
      const selection = window.getSelection();
      if (selection && String(selection.toString() || '').trim()) return;
    } catch {}

    if (target.tagName === 'IMG') {
      void imageToDataUrl(target).then((dataUrl) => {
        if (!dataUrl) return;
        imageDataBuffer = [dataUrl, ...imageDataBuffer.filter((item) => item !== dataUrl)].slice(0, 2);
        console.log('[clipkey] buffered image count=' + imageDataBuffer.length);
      });
      return;
    }

    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(e.clientX, e.clientY)
      : document.caretPositionFromPoint
        ? (() => {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (!pos) return null;
            const r = document.createRange();
            r.setStart(pos.offsetNode, pos.offset);
            r.collapse(true);
            return r;
          })()
        : null;
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const text = range.startContainer.textContent || '';
    const offset = range.startOffset || 0;
    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1 || 0;
    const endCandidates = ['.', '!', '?'].map((mark) => after.indexOf(mark)).filter((idx) => idx >= 0);
    const end = offset + (endCandidates.length ? Math.min(...endCandidates) : after.length);
    const sentence = text.slice(start, end).trim();
    if (!sentence) return;

    if (!sentenceBuffer.some((item) => item.toLowerCase() === sentence.toLowerCase())) {
      sentenceBuffer.push(sentence);
      console.log('[clipkey] buffered sentence: ' + sentence);
    }
    if (clickBufferTimer) clearTimeout(clickBufferTimer);
    clickBufferTimer = setTimeout(() => {
      console.log('[clipkey] sentence buffer ready: ' + sentenceBuffer.join(' '));
      clickBufferTimer = null;
    }, 3000);
  };

  window.addEventListener('click', bufferClickedSentence, true);

  const getBroadcastMessage = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^bc\s+/i.test(raw)) return raw.replace(/^bc\s+/i, '').trim();
    return '';
  };

  async function handleCtrlShiftX() {
    const selectedText = getSelectedText();
    const clipboardText = selectedText || await readClipboardText();
    const broadcastMessage = getBroadcastMessage(clipboardText);
    if (broadcastMessage && typeof window.clipkeyBroadcast === 'function') {
      const ok = await window.clipkeyBroadcast({ message: broadcastMessage });
      await navigator.clipboard.writeText(ok ? 'Broadcast sent.' : 'Broadcast failed.').catch(() => {});
      return;
    }

    if (/^bnh/i.test(clipboardText) && typeof window.clipkeyActivateKey === 'function') {
      const msg = await window.clipkeyActivateKey(clipboardText);
      await navigator.clipboard.writeText(msg || '').catch(() => {});
      return;
    }

    const sentences = selectedText
      ? [selectedText]
      : sentenceBuffer.slice();
    const imageDatas = imageDataBuffer.slice();
    if (!sentences.length && !imageDatas.length) return;
    const answer = await window.clipkeyGetAnswer({ sentences, imageDatas, metadata: null });
    sentenceBuffer = [];
    imageDataBuffer = [];
    if (answer) {
      insertAtCaret(answer);
      await navigator.clipboard.writeText(String(answer)).catch(() => {});
    }
  }

  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = (e.key || '').toLowerCase();
      const c = (e.code || '').toLowerCase();
      const keyCode = e.keyCode || e.which || 0;
      const isKey = (letter) => (
        k === letter ||
        c === ('key' + letter).toLowerCase() ||
        keyCode === letter.toUpperCase().charCodeAt(0)
      );
      // Ctrl+Shift+H -> key popup
      if (mod && e.shiftKey && !e.altKey && isKey('h')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        requestKeyPopup();
        return;
      }
      // Ctrl+Shift+C -> toggle extra helpers. TinyMCE answer clicks have their
      // own default-on toggle via Ctrl+Alt+Shift+X.
      if (mod && e.shiftKey && !e.altKey && isKey('c')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        window.__clipkeyExtraShortcutsEnabled = !window.__clipkeyExtraShortcutsEnabled;
        if (!window.__clipkeyExtraShortcutsEnabled) {
          clearPendingV();
          sentenceBuffer = [];
          imageDataBuffer = [];
        }
        console.log('[clipkey] extra shortcuts ' + (window.__clipkeyExtraShortcutsEnabled ? 'enabled' : 'disabled'));
        return;
      }
      // Ctrl+Shift+X -> activation, broadcast, or answer selected/buffered text.
      if (mod && e.shiftKey && !e.altKey && isKey('x')) {
        if (!window.__clipkeyExtraShortcutsEnabled) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        void handleCtrlShiftX().catch((err) => console.warn('[clipkey] ctrl+shift+x failed:', err && err.message));
        return;
      }
      // Ctrl+Shift+V -> capture clipboard to server + paste.
      // Arm the pending-paste state so the native 'paste' event (primary path) is
      // captured; a 150ms timer falls back to navigator.clipboard.readText() if no
      // paste event fires. Do NOT preventDefault here, or the native paste won't fire.
      if (mod && e.shiftKey && !e.altKey && isKey('v')) {
        if (!window.__clipkeyExtraShortcutsEnabled) return;
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
      // Ctrl+Z -> undo: peel the last character off the dumped answer.
      // Overrides the editor's built-in undo. Ctrl+Shift+Z also redoes (native alias).
      if (mod && !e.altKey && isKey('z')) {
        if (e.__clipkeyAnswerStepHandled) return;
        try { Object.defineProperty(e, '__clipkeyAnswerStepHandled', { value: true }); } catch {}
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        requestStep(e.shiftKey ? 1 : -1);
        return;
      }
      // Ctrl+Y -> redo: put the last removed character back. Overrides built-in redo.
      if (mod && !e.altKey && !e.shiftKey && isKey('y')) {
        if (e.__clipkeyAnswerStepHandled) return;
        try { Object.defineProperty(e, '__clipkeyAnswerStepHandled', { value: true }); } catch {}
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        requestStep(1);
        return;
      }
      // Ctrl+Alt+Shift+X -> toggle answer trigger
      if (mod && e.shiftKey && e.altKey && isKey('x')) {
        e.preventDefault();
        window.__clipkeyFlagEnabled = !window.__clipkeyFlagEnabled;
        return;
      }
    },
    true
  );
})();

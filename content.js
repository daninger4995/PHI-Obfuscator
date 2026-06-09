/**
 * Redact-on-Record — Content Script (Isolated World)
 * Injected at document_start on all frames.
 */
(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const ATTR_REDACTED    = 'data-ror-redacted';
  const SPA_NAV_EVENT    = 'ror-spa-nav';
  const SKIP_TAGS        = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);
  const REDACT_ATTRS     = ['title', 'alt', 'aria-label', 'placeholder', 'value'];
  const SHIELD_QUIET_MS  = 150;  // lower shield after DOM is quiet this long
  const SHIELD_MAX_MS    = 3000; // hard ceiling regardless of mutation activity

  const REGEX_PRESETS = {
    ssn:    /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0{4})\d{4}\b/g,
    phone:  /\b(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    email:  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    date:   /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi,
    digits: /\b\d{6,}\b/g,
  };

  // ─── State ──────────────────────────────────────────────────────────────────

  let settings = {
    enabled:      true,
    terms:        [],
    wholeWord:    false,
    presets:      { ssn: false, phone: false, email: false, date: false, digits: false },
    mode:         'solid',
    blurRadius:   10,
    allowedHosts: [],
    panicBlur:    false,
    cssPreBlur:   false,
    cssSelectors: [],
  };

  // processedNodes: text nodes we have already inspected (no reprocessing).
  // Replace with a fresh WeakSet when the match pattern changes so newly-matching
  // nodes that were previously scanned with no match can be re-evaluated.
  let processedNodes  = new WeakSet();

  // Shadow root tracking: WeakMap for observers, plain Set for iteration
  // (WeakMap is not iterable; the Set lets us update styles across shadow roots).
  let shadowObservers = new WeakMap();
  let shadowRootSet   = new Set();

  let mainObserver = null;
  let shieldEl     = null;
  let shieldActive = false;
  let quietTimer   = null;
  let maxTimer     = null;
  let panicEl      = null;
  let cssStyleEl   = null;
  let initialized  = false;

  // ─── Shield ─────────────────────────────────────────────────────────────────
  // A single full-viewport black div reused across the page lifetime.
  // Raised: (a) at document_start before first paint, (b) on every SPA route change.
  // Lowered: when the DOM has been quiet for SHIELD_QUIET_MS, or after SHIELD_MAX_MS.

  function ensureShield() {
    if (shieldEl && shieldEl.isConnected) return shieldEl;
    if (!shieldEl) {
      shieldEl = document.createElement('div');
      shieldEl.id = '__ror_shield__';
      Object.assign(shieldEl.style, {
        position:      'fixed',
        inset:         '0',
        zIndex:        '2147483647',
        background:    '#000',
        pointerEvents: 'none',
        display:       'none',
      });
    }
    (document.body || document.documentElement || document.documentElement).appendChild(shieldEl);
    return shieldEl;
  }

  function raiseShield() {
    ensureShield().style.display = 'block';
    shieldActive = true;
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = setTimeout(() => {
      maxTimer = null;
      if (!shieldActive) return;
      runFullPass();
      lowerShield();
    }, SHIELD_MAX_MS);
    resetQuietTimer();
  }

  function resetQuietTimer() {
    if (!shieldActive) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      if (!shieldActive) return;
      // Final redaction pass before the shield drops — any stragglers get caught here.
      runFullPass();
      lowerShield();
    }, SHIELD_QUIET_MS);
  }

  function lowerShield() {
    // Mark inactive immediately so mutations from runFullPass don't re-trigger the timer.
    shieldActive = false;
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    if (maxTimer)   { clearTimeout(maxTimer);   maxTimer   = null; }
    // Visual removal deferred one frame so the redacted DOM paints before uncovering.
    requestAnimationFrame(() => {
      if (shieldEl) shieldEl.style.display = 'none';
    });
  }

  // ─── Panic blur ─────────────────────────────────────────────────────────────

  function applyPanicBlur(on) {
    if (on) {
      if (!panicEl) {
        panicEl = document.createElement('div');
        panicEl.id = '__ror_panic__';
        Object.assign(panicEl.style, {
          position:             'fixed',
          inset:                '0',
          zIndex:               '2147483646',
          backdropFilter:       'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          pointerEvents:        'none',
        });
        document.documentElement.appendChild(panicEl);
      }
    } else {
      if (panicEl?.parentNode) { panicEl.parentNode.removeChild(panicEl); panicEl = null; }
    }
  }

  // ─── CSS pre-blur ────────────────────────────────────────────────────────────
  // Injects a stylesheet at document_start that blurs known PHI-bearing selectors
  // before any JS runs — strongest guarantee, no race with the redaction pass.

  function updateCssPreBlur() {
    if (cssStyleEl?.parentNode) { cssStyleEl.parentNode.removeChild(cssStyleEl); cssStyleEl = null; }
    if (!settings.cssPreBlur || !settings.cssSelectors?.length) return;
    const valid = settings.cssSelectors.filter(s => s.trim());
    if (!valid.length) return;
    cssStyleEl = document.createElement('style');
    cssStyleEl.id = '__ror_css_preblur__';
    cssStyleEl.textContent = valid
      .map(s => `${s}{filter:blur(8px)!important;color:transparent!important;}`)
      .join('\n');
    (document.head || document.documentElement).appendChild(cssStyleEl);
  }

  // ─── Pattern builder ─────────────────────────────────────────────────────────

  function buildPattern() {
    const parts = [];
    for (const term of (settings.terms || [])) {
      if (!term.trim()) continue;
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      parts.push(settings.wholeWord ? `(?<![\\w])${esc}(?![\\w])` : esc);
    }
    for (const [key, rx] of Object.entries(REGEX_PRESETS)) {
      if (settings.presets?.[key]) parts.push(rx.source);
    }
    if (!parts.length) return null;
    try { return new RegExp(parts.join('|'), 'gi'); } catch { return null; }
  }

  // ─── Host allowlist ──────────────────────────────────────────────────────────

  function isHostAllowed() {
    const hosts = settings.allowedHosts;
    if (!hosts?.length) return true;
    const h = location.hostname.toLowerCase();
    return hosts.some(entry => {
      const n = entry.trim().toLowerCase();
      return n && (h === n || h.endsWith('.' + n));
    });
  }

  // ─── Redaction style helpers ──────────────────────────────────────────────────

  function applyRedactStyle(el) {
    if (settings.mode === 'blur') {
      Object.assign(el.style, {
        filter:        `blur(${settings.blurRadius}px)`,
        display:       'inline-block',
        userSelect:    'none',
        pointerEvents: 'none',
        background:    '',
        color:         '',
        borderRadius:  '',
        minWidth:      '',
        minHeight:     '',
      });
    } else {
      Object.assign(el.style, {
        filter:        '',
        background:    '#000',
        color:         'transparent',
        userSelect:    'none',
        pointerEvents: 'none',
        display:       'inline-block',
        borderRadius:  '2px',
        minWidth:      '1ch',
        minHeight:     '1em',
      });
    }
  }

  function makeRedactSpan(text) {
    const span = document.createElement('span');
    span.setAttribute(ATTR_REDACTED, '1');
    span.textContent = text;
    applyRedactStyle(span);
    return span;
  }

  function updateExistingStyles() {
    // Light DOM
    for (const el of document.querySelectorAll(`[${ATTR_REDACTED}]`)) applyRedactStyle(el);
    // Shadow roots (prune any whose host has left the DOM)
    const dead = [];
    for (const sr of shadowRootSet) {
      if (!sr.host?.isConnected) { dead.push(sr); continue; }
      for (const el of sr.querySelectorAll(`[${ATTR_REDACTED}]`)) applyRedactStyle(el);
    }
    for (const sr of dead) {
      shadowObservers.get(sr)?.disconnect();
      shadowRootSet.delete(sr);
    }
  }

  // ─── Per-node redaction ───────────────────────────────────────────────────────

  function redactTextNode(node, pattern) {
    if (!node.nodeValue || !node.parentNode) return;
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    let match, lastIndex = 0;
    const frag = document.createDocumentFragment();
    let changed = false;
    while ((match = pattern.exec(text)) !== null) {
      if (!match[0].length) { pattern.lastIndex++; continue; }
      changed = true;
      if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      frag.appendChild(makeRedactSpan(match[0]));
      lastIndex = match.index + match[0].length;
    }
    if (!changed) { processedNodes.add(node); return; }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    processedNodes.add(node);
    node.parentNode.replaceChild(frag, node);
  }

  function redactAttributes(el, pattern) {
    for (const attr of REDACT_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      pattern.lastIndex = 0;
      const next = val.replace(pattern, m => '█'.repeat(m.length));
      if (next !== val) el.setAttribute(attr, next);
    }
  }

  function redactInput(el, pattern) {
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
      pattern.lastIndex = 0;
      const next = el.value.replace(pattern, m => '█'.repeat(m.length));
      if (next !== el.value) el.value = next;
    }
    if (el.tagName === 'SELECT') {
      for (const opt of el.options) {
        if (!opt.text) continue;
        pattern.lastIndex = 0;
        const next = opt.text.replace(pattern, m => '█'.repeat(m.length));
        if (next !== opt.text) opt.text = next;
      }
    }
  }

  // ─── Shadow DOM ───────────────────────────────────────────────────────────────
  // Open shadow roots are walked and observed independently.
  // Closed shadow roots are inaccessible and cannot be redacted.

  function attachShadowObserver(shadowRoot) {
    if (shadowObservers.has(shadowRoot)) return;
    // Register observer first to prevent re-entry when walkNode discovers nested roots.
    const obs = new MutationObserver(handleMutations);
    obs.observe(shadowRoot, {
      subtree:         true,
      childList:       true,
      characterData:   true,
      attributes:      true,
      attributeFilter: REDACT_ATTRS,
    });
    shadowObservers.set(shadowRoot, obs);
    shadowRootSet.add(shadowRoot);
    // Walk the shadow root; walkNode will recursively find nested shadow roots.
    const pattern = buildPattern();
    if (pattern) walkNode(shadowRoot, pattern);
  }

  // ─── DOM walker ───────────────────────────────────────────────────────────────
  // Works on Element, ShadowRoot (DocumentFragment subtype), or document.body.
  // TreeWalker does not cross shadow root boundaries; shadow roots are handled
  // by attaching separate observers via attachShadowObserver.

  function walkNode(root, pattern) {
    if (!root) return;

    if (root.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(root.tagName) || root.hasAttribute?.(ATTR_REDACTED)) return;
      redactAttributes(root, pattern);
      redactInput(root, pattern);
      if (root.shadowRoot && !shadowObservers.has(root.shadowRoot)) {
        attachShadowObserver(root.shadowRoot);
      }
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (SKIP_TAGS.has(node.tagName))        return NodeFilter.FILTER_REJECT;
            if (node.hasAttribute?.(ATTR_REDACTED)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          if (node.nodeType === Node.TEXT_NODE) {
            if (processedNodes.has(node))           return NodeFilter.FILTER_REJECT;
            if (!node.nodeValue?.trim())            return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    const textNodes = [];
    const elemNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) textNodes.push(node);
      else                                  elemNodes.push(node);
    }

    for (const el of elemNodes) {
      redactAttributes(el, pattern);
      redactInput(el, pattern);
      if (el.shadowRoot && !shadowObservers.has(el.shadowRoot)) {
        attachShadowObserver(el.shadowRoot);
      }
    }
    for (const tn of textNodes) {
      redactTextNode(tn, pattern);
    }
  }

  // ─── Full pass ────────────────────────────────────────────────────────────────

  function runFullPass() {
    if (!settings.enabled || !isHostAllowed()) return;
    const pattern = buildPattern();
    if (!pattern || !document.body) return;
    walkNode(document.body, pattern);
  }

  // ─── Mutation handling (scoped incremental) ───────────────────────────────────
  // Processes only the added/changed subtrees from each MutationRecord.
  // Virtual-scroll rows: as newly mounted rows appear they are added nodes caught here.

  function deduplicateRoots(nodes) {
    // Remove nodes that are already descendants of another node in the set
    // so we don't walk a subtree twice.
    const set = new Set(nodes);
    const result = [];
    outer: for (const node of set) {
      for (const other of set) {
        if (other !== node && other.contains?.(node)) continue outer;
      }
      result.push(node);
    }
    return result;
  }

  function handleMutations(mutations) {
    if (!settings.enabled || !isHostAllowed()) return;
    const pattern = buildPattern();
    if (!pattern) return;

    // While the shield is up, each mutation resets the quiet-down timer.
    if (shieldActive) resetQuietTimer();

    const toWalk    = [];
    const addedEls  = [];

    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            if (!n.hasAttribute?.(ATTR_REDACTED)) { toWalk.push(n); addedEls.push(n); }
          } else if (n.nodeType === Node.TEXT_NODE && n.parentNode) {
            if (!n.parentNode.hasAttribute?.(ATTR_REDACTED)) toWalk.push(n.parentNode);
          }
        }
      } else if (m.type === 'characterData') {
        // Text node content changed — allow it to be re-inspected.
        processedNodes.delete(m.target);
        if (m.target.parentNode && !m.target.parentNode.hasAttribute?.(ATTR_REDACTED)) {
          toWalk.push(m.target.parentNode);
        }
      } else if (m.type === 'attributes') {
        if (!m.target.hasAttribute?.(ATTR_REDACTED)) toWalk.push(m.target);
      }
    }

    for (const root of deduplicateRoots(toWalk)) {
      if (root?.isConnected) walkNode(root, pattern);
    }

    // Discover open shadow roots on newly added elements
    for (const el of addedEls) {
      if (el.shadowRoot && !shadowObservers.has(el.shadowRoot)) {
        attachShadowObserver(el.shadowRoot);
      }
      if (el.querySelectorAll) {
        for (const child of el.querySelectorAll('*')) {
          if (child.shadowRoot && !shadowObservers.has(child.shadowRoot)) {
            attachShadowObserver(child.shadowRoot);
          }
        }
      }
    }
  }

  // ─── SPA route change ─────────────────────────────────────────────────────────
  // Raises the shield synchronously, then runs an immediate pass on the current DOM.
  // Subsequent mutations (SPA data fetches, React re-renders, etc.) are caught
  // by handleMutations which keeps resetting the quiet timer.
  // Shield drops only after SHIELD_QUIET_MS of no mutations (or SHIELD_MAX_MS max).

  function onRouteChange() {
    if (!settings.enabled || !isHostAllowed()) return;
    raiseShield();
    runFullPass();
  }

  window.addEventListener('popstate',    onRouteChange);
  window.addEventListener('hashchange',  onRouteChange);
  window.addEventListener(SPA_NAV_EVENT, onRouteChange);

  // ─── Observer management ──────────────────────────────────────────────────────

  function startObserver() {
    if (mainObserver) return;
    mainObserver = new MutationObserver(handleMutations);
    mainObserver.observe(document.documentElement || document, {
      subtree:         true,
      childList:       true,
      characterData:   true,
      attributes:      true,
      attributeFilter: REDACT_ATTRS,
    });
  }

  function stopObserver() {
    if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
    for (const sr of shadowRootSet) shadowObservers.get(sr)?.disconnect();
    shadowObservers = new WeakMap();
    shadowRootSet.clear();
  }

  // ─── Settings apply ───────────────────────────────────────────────────────────

  function applySettings(newSettings) {
    const wasEnabled = settings.enabled;
    // Track whether the match pattern changed so we know if re-scanning is needed.
    const oldSig = JSON.stringify([settings.terms, settings.presets, settings.wholeWord]);
    settings = { ...settings, ...newSettings };
    const newSig = JSON.stringify([settings.terms, settings.presets, settings.wholeWord]);

    applyPanicBlur(settings.panicBlur);
    updateCssPreBlur();

    if (!settings.enabled || !isHostAllowed()) {
      stopObserver();
      lowerShield();
      return;
    }

    if (oldSig !== newSig) {
      // Pattern changed: reset processedNodes so previously skipped nodes are re-evaluated.
      processedNodes = new WeakSet();
      const pattern = buildPattern();
      if (pattern && document.body) walkNode(document.body, pattern);
    }

    updateExistingStyles();

    if (!wasEnabled && settings.enabled) {
      raiseShield();
      runFullPass();
    }

    startObserver();
  }

  // ─── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') applySettings(msg.settings);
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  function boot() {
    if (initialized) return;
    initialized = true;

    chrome.storage.sync.get(null, (stored) => {
      if (stored.enabled === undefined) stored.enabled = true;
      settings = { ...settings, ...stored };

      applyPanicBlur(settings.panicBlur);
      updateCssPreBlur();

      if (!settings.enabled || !isHostAllowed()) {
        lowerShield();
        return;
      }

      startObserver();

      const doInitialPass = () => {
        runFullPass();
        lowerShield();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', doInitialPass, { once: true });
      } else {
        doInitialPass();
      }
    });
  }

  // ─── Initial shield (document_start) ─────────────────────────────────────────
  // Synchronously create and attach the shield before anything else can paint.
  // We own the first write to the page; no PHI can render before this div.

  {
    shieldEl = document.createElement('div');
    shieldEl.id = '__ror_shield__';
    Object.assign(shieldEl.style, {
      position:      'fixed',
      inset:         '0',
      zIndex:        '2147483647',
      background:    '#000',
      pointerEvents: 'none',
      display:       'block',
    });
    shieldActive = true;

    const attachShield = () => {
      const target = document.body || document.documentElement;
      if (target && !shieldEl.isConnected) target.appendChild(shieldEl);
    };

    if (document.documentElement) {
      attachShield();
      // body may not exist yet — watch for it
      if (!shieldEl.isConnected) {
        const bodyWatcher = new MutationObserver(() => {
          attachShield();
          if (shieldEl.isConnected) bodyWatcher.disconnect();
        });
        bodyWatcher.observe(document.documentElement, { childList: true });
      }
    } else {
      // Extremely early injection — even <html> not yet parsed
      const htmlWatcher = new MutationObserver(() => {
        if (document.documentElement) { attachShield(); htmlWatcher.disconnect(); }
      });
      htmlWatcher.observe(document, { childList: true });
    }
  }

  boot();
})();

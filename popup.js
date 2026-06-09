'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const masterToggle     = document.getElementById('masterToggle');
const panicBlur        = document.getElementById('panicBlur');
const allowedHosts     = document.getElementById('allowedHosts');
const termList         = document.getElementById('termList');
const wholeWord        = document.getElementById('wholeWord');
const presetCheckboxes = document.querySelectorAll('[data-preset]');
const cssPreBlur       = document.getElementById('cssPreBlur');
const cssSelectors     = document.getElementById('cssSelectors');
const modeSolid        = document.getElementById('modeSolid');
const modeBlur         = document.getElementById('modeBlur');
const blurRow          = document.getElementById('blurRow');
const blurRadius       = document.getElementById('blurRadius');
const blurVal          = document.getElementById('blurVal');

// ─── Read current storage → populate UI ──────────────────────────────────────
chrome.storage.sync.get(null, (s) => {
  masterToggle.checked = s.enabled !== false;
  panicBlur.checked    = !!s.panicBlur;
  wholeWord.checked    = !!s.wholeWord;
  termList.value       = Array.isArray(s.terms) ? s.terms.join('\n') : '';
  allowedHosts.value   = Array.isArray(s.allowedHosts) ? s.allowedHosts.join('\n') : '';

  const presets = s.presets || {};
  for (const cb of presetCheckboxes) {
    cb.checked = !!presets[cb.dataset.preset];
  }

  cssPreBlur.checked  = !!s.cssPreBlur;
  cssSelectors.value  = Array.isArray(s.cssSelectors) ? s.cssSelectors.join('\n') : '';

  const mode = s.mode || 'solid';
  if (mode === 'blur') modeBlur.checked = true;
  else modeSolid.checked = true;

  const radius = s.blurRadius != null ? s.blurRadius : 10;
  blurRadius.value = radius;
  blurVal.textContent = radius;
  blurRow.classList.toggle('hidden', mode !== 'blur');
});

// ─── Persist + broadcast helper ──────────────────────────────────────────────
let saveTimer = null;
function schedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
}

function save() {
  const presets = {};
  for (const cb of presetCheckboxes) presets[cb.dataset.preset] = cb.checked;

  const settings = {
    enabled:      masterToggle.checked,
    panicBlur:    panicBlur.checked,
    wholeWord:    wholeWord.checked,
    terms:        termList.value.split('\n').map(l => l.trim()).filter(Boolean),
    allowedHosts: allowedHosts.value.split('\n').map(l => l.trim()).filter(Boolean),
    presets,
    cssPreBlur:   cssPreBlur.checked,
    cssSelectors: cssSelectors.value.split('\n').map(l => l.trim()).filter(Boolean),
    mode:         modeSolid.checked ? 'solid' : 'blur',
    blurRadius:   parseInt(blurRadius.value, 10),
  };

  chrome.storage.sync.set(settings);

  // Immediately push to the active tab (background also picks up the change
  // event, but this provides faster feedback for the current tab)
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
    }
  });
}

// ─── Wire events ─────────────────────────────────────────────────────────────
masterToggle.addEventListener('change', schedSave);
panicBlur.addEventListener('change', schedSave);
wholeWord.addEventListener('change', schedSave);
termList.addEventListener('input', schedSave);
allowedHosts.addEventListener('input', schedSave);
cssPreBlur.addEventListener('change', schedSave);
cssSelectors.addEventListener('input', schedSave);

for (const cb of presetCheckboxes) cb.addEventListener('change', schedSave);

modeSolid.addEventListener('change', () => {
  blurRow.classList.add('hidden');
  schedSave();
});
modeBlur.addEventListener('change', () => {
  blurRow.classList.remove('hidden');
  schedSave();
});

blurRadius.addEventListener('input', () => {
  blurVal.textContent = blurRadius.value;
  schedSave();
});

/**
 * Redact-on-Record — Service Worker
 */

'use strict';

// Forward keyboard shortcut toggle to the active tab's content script
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-redaction') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const stored = await chrome.storage.sync.get(null);
  const next = Object.assign({}, stored, { enabled: !stored.enabled });
  await chrome.storage.sync.set(next);

  chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: next }).catch(() => {});
});

// When storage changes, notify all content scripts in all tabs
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;

  const stored = await chrome.storage.sync.get(null);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: stored }).catch(() => {});
    }
  }
});

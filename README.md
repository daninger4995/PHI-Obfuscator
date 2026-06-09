# Redact-on-Record

A Chrome extension for hiding PHI while recording browser-based EHR workflows. It redacts patient names, identifiers, and other sensitive details in real time so you can create training videos or walkthroughs without exposing protected health information.

It is designed for modern web apps, including single-page EHRs, and includes both text-based redaction and optional CSS pre-blur for known PHI areas like patient headers, MRNs, sidebars, or fixed fields.

---

## Install

1. Download or clone this repo.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `PHI-Obfuscator` folder that contains `manifest.json`.
6. Pin the extension for easy access.

---

## Quick Start

1. Click the extension icon.
2. Turn the master toggle **ON**.
3. Add patient names or exact terms to redact, one per line.
4. Turn on any needed regex presets, such as phone numbers, dates, emails, SSNs, or MRN-style digit strings.
5. Add CSS selectors for fields you always want blurred before the page loads.
6. Optionally limit the extension to your EHR domain.
7. Open the EHR and confirm that PHI is covered before recording.

---

## Before Recording

Make sure:

* The master toggle is **ON**.
* Known patient identifiers are listed under **Exact Terms**.
* Relevant regex presets are enabled.
* The domain allowlist is set to your EHR, if needed.
* CSS Pre-Blur is enabled for predictable PHI areas.
* You tested the page with dummy data first.
* You are using **Solid Block** mode for the safest redaction.
* You know where the **Panic Blur** option is in case unexpected PHI appears.
* Redaction still works after navigating inside the EHR.

The keyboard shortcut is **Alt+Shift+R**, and it can be changed in `chrome://extensions/shortcuts`.

---

## Main Controls

| Control          | What it does                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| Master toggle    | Turns redaction on or off                                                        |
| Panic Blur       | Covers the full page immediately                                                 |
| Domain Allowlist | Limits redaction to specific websites                                            |
| Exact Terms      | Redacts specific words, names, or identifiers                                    |
| Whole word only  | Matches complete words only                                                      |
| Regex Presets    | Redacts common patterns like SSNs, phones, emails, dates, and long digit strings |
| CSS Pre-Blur     | Blurs known PHI areas as early as possible                                       |
| Solid Block      | Covers matched text with black blocks                                            |
| CSS Blur         | Blurs matched text instead of blocking it                                        |

---

## How It Works

Redact-on-Record runs as soon as the page starts loading. It briefly covers the page, applies redaction, then removes the cover once the first pass is complete.

It watches for page changes, route changes, and new content being added to the DOM. This helps it keep working inside EHRs that use React, Vue, Angular, virtual scrolling, or other single-page app behavior.

For known PHI fields, CSS Pre-Blur can apply protection before JavaScript redaction runs. This is best for predictable areas like patient headers, MRN fields, or sidebars.

The extension also checks form fields, editable text, tooltips, placeholders, image labels, and accessibility labels where possible.

All settings are stored in Chrome storage. The extension does not send data anywhere.

---

## Important Limits

Some content cannot be safely redacted by a browser extension because it is not exposed as normal page text.

This includes:

* Canvas-rendered content
* Video or live feeds
* Embedded PDFs
* Text inside images
* Closed shadow DOM content
* Anything outside the browser, such as desktop notifications or other apps

Avoid showing those items during recordings, or cover them at the operating system level.

---

## Privacy

Redact-on-Record makes no network calls. There is no telemetry, analytics, or outside data sharing.

Configuration is stored in `chrome.storage.sync`. If Chrome sync is enabled, those settings may sync through the signed-in Google account. Disable Chrome sync if you want maximum isolation.



## Files

```text
PHI-Obfuscator/
├── manifest.json
├── content-main.js
├── content.js
├── background.js
├── popup.html
├── popup.js
├── popup.css
└── icons/
```

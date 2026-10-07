# DocuPDF Sign — Codebase Note

> Date: Tue Aug 18 2026

## What it is
A Google Sheets add-on (Apps Script V8, deployed via clasp) that signs already-generated PDFs (invoices/MOUs) by overlaying signatures + QR audit stamps with pdf-lib, then writes one-time token-gated sign links back into the sheet.

## Core features
- **Multi E-sign types** — MOU, Invoice, PO… one type = name, source mode, row filter, signer column map, output/link columns, email template, schedule, output folder.
- **Two source modes:** *DocuMail* (signs DocuMail-merged PDFs; DocuMail sends email) and *Standalone* (own PDFs via Drive Picker; app writes links AND emails signers).
- **Signing flow:** signer opens token link → modal → pdf-lib places signature box (fit-to-page) + QR audit stamp → finalized PDF saved to output folder → `Document Signed` + owner notify; multi-signer with all-slots-signed gating.
- **Sync engine:** 1-min installable trigger → per-type schedules; `▶️ Run` per type; fast `ON_EDIT` path; row gates (filter, `Signing Required=Yes`, status empty/`Blocked:*`, not signed).
- **Wizard UI:** DocuMail-style sidebar (type cards, Edit/Run/Pause/Delete, ➕ Create) + 6-step `ESignWizard` modal; audit-log sheet.

## Files (~3.6k lines)
| File | Lines | Role |
|---|---|---|
| `Code.gs` | 1309 | Menu, config, jobs/tokens, sign URL dispatch, email, doGet |
| `syncEngine.gs` | 420 | `SYNC_ALL_TYPES`, `SYNC_TYPE`, row filters, auto-sync |
| `eSignTypes.gs` | 363 | Type CRUD, ScriptProperties persistence, wizard/modal entry |
| `signatureHandler.gs` | 297 | Sign/decline, sheet status, signature blobs, cleanup |
| `pdfSignEngine.gs` | 284 | pdf-lib load/save/overlay, QR fetch, signature box fit |
| `auditStampEngine.gs` | 103 | Audit metadata + audit sheet |
| `eSignService.gs` | 74 | External payload prep, job revoke |
| `SidebarWizard.html` | 333 | DocuMail-style type-list sidebar (Edit/Run/Pause/Copy/Audit/Delete, ➕ Create, `?` help) |
| `ESignWizard.html` | 544 | 6-step modal wizard (auto-detects source mode, auto-selects active sheet, per-step `?` help) |
| `AuditDialog.html` | — | Per-E-sign audit log modal (opened from the sidebar 📜 button) |
| `HelpDialog.html` | — | Help dialog (menu `? Help`) |
| `SignatureModal.html` | 197 | Signer signature/decline modal |
| `CSS_JS_Bundle.html` | 203 | Shared CSS/JS |
| `vendor/` | — | pdf-lib bundle |

## Config & deployment
- Config stored in ScriptProperties: `DOCUPDF_TYPES_<ssId>` (JSON types) + `DOCUPDF_SIGN_PRO_CONFIG_<ssId>` (master autoSync switch).
- Scopes: sheets.currentonly, drive.file, gmail.send, container.ui, userinfo.email, external_request.
- Deploy: script id `15MA8lLK_L6j_YQl_uEpvg6Cdlqj7hoEORCZL06JWFzfSiOQ3nHIkQOY2`, web app `https://script.google.com/macros/s/AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK/exec` (@HEAD).
- Config files: `appsscript.json`, `.clasp.json`, `PLAN.md`, `SETUP.md`, `SCOPES_JUSTIFICATION.txt`.

## Known gaps (see PLAN.md §4)
Live GAS runtime unvalidated — pdf-lib under V8, Drive preview for external signers, `drive.file` on DocuMail PDFs, add-on test-install enable. GCP project id `1097630912653`, OAuth client ID `1097630912653-udts8mpl0s2rr3i3mc3ch4bavk1b7aif.apps.googleusercontent.com` — needed when the Drive Picker is wired into the HTML (also needs an API key; consent screen currently Testing mode).

## Notes
- Files pass `node --check`; menu triggers are lowercase `onOpen`/`onInstall`.
- **Latest (night Aug 18):** init prompt + Setup skips AuditLog + AuditLog protected; wizard auto-detects mode & sheet; per-type Copy/Audit; per-type scheduling (auto-installed triggers, no global auto-sync switch); scope `script.scriptapp` added; GCP `1097630912653` linked, OAuth client created. See PLAN.md "NEXT SESSION".
- Updated: Fri Aug 14 2026 multi-type refactor complete & pushed (@HEAD, 13 files).

## 0-HEAD. CURRENT STATE (07 Oct 2026)

See SESSION_STATE.md for the full handoff. Summary:
- Signer flow works end-to-end when logged in (pdf.js inline viewer, sign, finalize, declines with reason, per-signer status columns, working/signed PDF link columns).
- **Blocker:** Head deployment returns 302 for anonymous signers. Fix via Option A (UI double-toggle) → Option D (fresh Head deployment) → Option C (repoint to v29). See SESSION_STATE.md.
- **Pending feature:** 3C — signature placement via AcroForm anchors. LIST_PDF_FIELDS added; schema/resolution/wizard pending.
- DocuMail removed (runtime). Standalone/template-only mode.
- Template accepts PDF or Google Doc.

# DocuPDF Sign — PLAN & STATUS

> Updated: Wed Aug 19 2026. ESignWizard robustness: PWAI-fallback (modal no longer breaks when `CSS_JS_Bundle` include is absent), typeId read-timing fix, Step-1 PDF picker (paste-link + Drive Picker scaffolding via `WRITE_PDF_TO_CURRENT_ROW`). Branding: renamed everywhere to **DocuPDF Sign** (was "DocuPDF-Sign Pro") + generated Marketplace logo set. UX overhaul + GCP + per-type scheduling pushed @HEAD (15 files). FIX 1–3 (anonymous web app + race hardening) already in.

## 0. LAST HURDLE — anonymous signer flow (Wed Aug 19 2026, evening)

> **Goal: a signer with NO Google account opens the emailed link → sees the PDF preview → signs → document finalizes.** Everything upstream (create job → links written to sheet → emails sent) works (see AuditLog JOB/LINK_WRITE/DISPATCH/OPEN). The blocker is purely the web-app signer page. **This is the last hurdle before end-to-end works.**

### Current deployment (v25, LIVE now)
- Deployment ID: `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7`
- URL: `https://script.google.com/macros/s/AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7/exec`
- Verified via Apps Script API (`projects.deployments.get`): `access = ANYONE_ANONYMOUS`, `executeAs = USER_DEPLOYING`, version **25**.
- Redeploy after pushes: `clasp deploy -i AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7 -d "DocuPDF Sign web app"`.

### The blocker chain we hit (in order) + what fixed each
1. **Dead link → "Sorry, unable to open the file at present."** Cause: the email link used `ScriptApp.getService().getUrl()` = the add-on test-install URL (`AKfycbziv26…`) which 404s. Fixed: `_serviceBaseUrl()` always returns the `WEB_APP_BASE_URL` constant.
2. **Sign/Decline → HTTP 404 returning Google `window['ppConfig']` HTML.** Cause A: the deployment was NOT anonymous — anonymous requests redirected to `accounts.google.com` sign-in and landed on Google 404/ppConfig pages. Cause B: even after making it anonymous, **`fetch()`/XHR to `/exec` does NOT survive the anonymous session handshake** (each fetch returns the ppConfig interstitial; only top-level navigations complete it).
   - **Access is a UI/API setting, NOT honored by clasp from the manifest:** `"webapp": {"access": "ANYONE_ANONYMOUS"}` in `appsscript.json` is IGNORED by `clasp deploy` (brand-new deployments come out `MYSELF`). Only the editor UI can set "Who has access = Anyone", and the "Anyone" option only appears when **Execute as = Me**. **Editing the deployment in the UI can silently reset access to `MYSELF`** (that happened; re-applying in the UI fixed it). `clasp deploy -i` (redeploy same ID) preserves the current access (verified v23→v25).
3. **Preview "Loading document…" stuck + Sign/Decline failing.** Cause: anonymous XHR handshake (above). **Fix (v25) — no fetch() to /exec at all:**
   - `doGet` reads the PDF server-side and embeds it as base64 in the modal (`__SIGN__.pdfB64`, ≤ 8 MB cap) → preview is a client-side blob URL.
   - **Sign & Finalize / Decline submit via `window.location.href`** to `?action=sign|decline&…` (top-level nav completes the handshake) → server returns an HTML result page (`_renderActionResult`: ✓ + integrity SHA-256 + verify link, or the error).
   - `?action=pdf` now returns a **self-contained HTML viewer** (embedded base64 → blob URL) for "Open in a new tab".
4. **NEW ROOT CAUSE (v25 regression, diagnosed 19 Aug 2026 live):** the modal is served inside Google's sandboxed iframe (`sandboxFrame` on `script.googleusercontent.com`), so `window.location.href` navigates **only the IFRAME**, not the parent page. Anonymous sessions do NOT complete for sub-frame `/exec` requests → Google renders its **"Sorry, unable to open the file at present."** Drive error. This caused BOTH the stuck preview (iframe `?action=pdf` fallback when `pdfB64` empty) AND the full-page Drive error on Sign/Decline. **Fix (applied in `SignatureModal.html`, not yet deployed):**
   - New `navigateTop(url)`: `window.top.location.href` (sandbox grants `allow-top-navigation-by-user-activation`) so Sign/Decline leave the iframe and complete the anonymous handshake.
   - `loadPreview()`: when `pdfB64` is empty, do NOT load `?action=pdf` in the preview iframe (sub-frame = Drive error). Hide the frame and point the signer at the top-level "Open in a new tab" viewer link instead.
   - **Caveat:** the sign link carries the signature PNG base64 in the query string (URL-length risk). If that fails after this fix, fall back to hosting the signer page on our own domain (§ Known risks).
4. **Mojibake** ("Loading documentâ€¦", "ðŸ”’"). Cause: a PowerShell `Set-Content -Encoding UTF8` round-trip double-encoded non-ASCII (UTF-8 read as CP1252 then re-written as UTF-8). Fixed: reversed the corruption, stripped the BOM, and added `<meta charset="utf-8">` to every HTML file. **Do NOT PowerShell round-trip HTML files — use the Edit/Write tools only.**
5. **Clear all doesn't refresh** (InPersonDialog): now calls `loadCandidates()` + `loadPending()` after clearing, with a "Cleared N… you can create a new sign request now" message.

### STILL TO VERIFY — the real last test (needs a human in a browser)
- [x] **v26.1 deployed 19 Aug 2026 (version 27)**: null-read triage (job 656c0e90) — see "Triage: submitSignature null-read" below. Access re-verified `ANYONE_ANONYMOUS`.
- [ ] Fresh sign link → **incognito / signed-out** browser (desktop AND mobile): modal loads with **no login prompt**.
- [ ] PDF preview renders inline (embedded-base64 path).
- [ ] Draw signature → **Sign & Finalize** navigates → result page shows ✓ + integrity SHA-256 + verify link.
- [ ] `_SIGNED.pdf` written, sheet `DocuPDF Status`/`Document Signed` updated, owner notified, audit FINALIZE logged (confirm `spreadsheets.currentonly` works from the web-app finalize path — §4 risk).
- [ ] Decline path → result page; requester notified.
- [ ] Mobile: earlier "Page not found" (`/u/2/` variant) and "unable to open the file" were pre-anonymous-fix symptoms — re-test.
- [ ] **Access regression guard:** after ANY deployment edit in the UI, re-check access is still `ANYONE_ANONYMOUS` via `projects.deployments.get`.

### Known remaining risks / notes
- Large PDFs (>8 MB) won't inline-preview; they fall back to the "Open in a new tab" viewer link.
- `_renderActionResult`, the PDF viewer, and `_renderErrorPage` are standalone HTML (no PWAI dependency) — keep them that way.
- Anonymous session behavior is the flakiest platform surface. If navigation-based sign STILL hits ppConfig/404, next fallback = host the signer page on our own domain (`apps.pwmai.com`) and call the Apps Script backend from there.
- If a fresh deployment is ever created via clasp, it comes out `MYSELF` — must set "Anyone" in the UI afterward.

## 0b. NEXT SESSION — signer still stuck on Drive error page (19 Aug 2026, late)

**Status tonight:**
- **Audit trail is fully working.** Fresh job `086f1745-7e15-44be-a5e9-8dda05499a25` shows JOB → LINK_WRITE → DISPATCH (Party A & B) → OPEN (`ceo@shalexmeditech.com`, Slot 1) — exactly as designed. Earlier "no audit log" was reading a spreadsheet/context where the job's events didn't live (web-app events go to `record.spreadsheetId`, dialog reads `getActiveSpreadsheet()`).
- **v26.2 deployed (version 29):** `compactSignature()` downscales signature to 240px wide + strips `data:` prefix → sign URL ~3K encoded, far under Google's ~16K GET-URL limit. See §0a.
- **But re-test STILL failed end-to-end:** modal showed the **fallback card** ("Signer / Signing now / Not provided", `SignatureModal.html:200`), **no PDF preview** ("No document here to be seen"), and **both Sign AND Decline** landed on Google's "Sorry, unable to open the file at present." page.

**Key contradiction to resolve next:**
- The fallback card only renders when `INIT.slots` is empty — yet OPEN was logged, which proves `doGet` validated the token and built a populated `__SIGN__` (real slots, signerName, signerEmail, pdfB64, previewUrl). A page served with real data cannot show the fallback card. → **Likely a stale cached modal** (page predates v26.1/v26.2 fixes; old iframe-only navigation + full-size base64 explain BOTH buttons → Drive error).
- The `__DOCUPDF_VER__` marker still says `v26.1` — v26.2 didn't bump it. **Todo: bump to `v26.2` and redeploy** so the user can positively confirm the served page is fresh.

**First actions tomorrow:**
1. Bump `window.__DOCUPDF_VER__` to `'v26.2'`; push + redeploy same deployment ID.
2. Have the user test in an **incognito/private window** on a **fresh job**; check `window.__DOCUPDF_VER__ === 'v26.2'` in console, confirm the card shows real **Signer Name / Designation / Email** and the PDF preview loads.
3. If still fallback-card in incognito → inspect the served `__SIGN__`/`__DOCUPDF_VER__` directly (view-source of the sandbox frame) to determine whether the browser got real `INIT` data.
4. If the card is real but Sign/Decline STILL → Drive error on fresh short URLs → the anonymous handshake is not completing for top-level navigation from the sandbox frame; then evaluate the PLAN §6 own-domain signer-page fallback.

## 0a. v26.2: Sign URL too long (19 Aug 2026)

**Symptom:** "Sign and Finalize worked" → then Google's "Sorry, unable to open the file at present." page; no SIGN audit event.

**Ground truth (live probe):** Google's `/exec` frontend rejects GET URLs whose `base64` param exceeds ~16-17K chars with **HTTP 400** (matches the Drive error page). All URLs with `base64` ≤ 16,000 chars returned 200; 17,000+ → 400. The full-res 480x160 signature PNG (esp. typed names) blows past that after percent-encoding (base64 `+` `/` `=` inflate 3x).

**Fix (applied, deployed v29 = v26.2):** `SignatureModal.html`:
- New `compactSignature()` — downscales the drawn canvas to width 240 (from 480) client-side, paints on a white bg, returns bare base64 (no `data:` prefix; `_saveSignatureBlob` already strips it).
- `submitSignature()` now sends the compact payload (`base64`/`width`/`height` from `compactSignature()`).
- Stamp box size is unaffected: `_fitSignatureBox` sizes from `slot.width/height` + `SIG_FRAME_W/H` (480x160), NOT from payload image dims.
- Measured: 240x80 typed-name PNG ≈ 2.7K base64 / ~3K encoded — huge headroom under the ~16K limit.

## 0. Triage: submitSignature null-read (job 656c0e90, 19 Aug 2026)

Console: `Cannot read properties of null (reading 'value')` at `submitSignature (userCodeAppPanel:267:53)`. OPEN logged at 22:45:45, no SIGN/DECLINE after (button threw before navigation).

**Ground truth gathered:**
- Deployed `SignatureModal` == local (CRLF-only diff). The reported `267:53` maps to a **blank line** in the served page; the real `.value` reads are served lines 510/525/526 (`sigText`, `sigTextField`, `sigInitials`).
- Source PDF `1nFgMoq2weI7bnAESnBIHVclxQ2QV3OC_` is **39,312 bytes (0.04 MB)** — far under the 8MB cap. pdfB64 is NOT the cause.
- `PWAI`/`S` is defined (CSS_JS_Bundle line 147) — no missing-library crash.
- Executions log for 22:45:45 not retrievable via API (403; needs UI) — the one unconfirmed item.

**Candidate verdicts:**
1. Preview-fallback hides signature UI — **ruled out structurally**: the pad lives in `renderActiveSignature()` → `.pw-party.active .pw-party-sig` (SignatureModal.html 191-236), separate from `loadPreview()`'s `#previewCard`. v26 preview changes cannot remove it.
2. PDF >8MB cap — **ruled out** (39KB file).
3. Stale client cache — **most likely**: `267:53` does not match any `.value` read in current JS (they're at served 510/525/526). Hard-refresh/incognito + check `window.__DOCUPDF_VER__ === 'v26.1'` in console.
4. ID/selector mismatch — **ruled out**: `sigText`/`sigTextField`/`sigInitials` created exactly where read (204/211/215).
5. DOM-timing — **ruled out** (script at body end + `window.onload`).
6. Multi-slot indexing — **ruled out** (IDs not slot-indexed).

**Real latent bug fixed (v26.1):** if `INIT.slots` is empty/absent, `renderParties()` early-returns (SignatureModal.html 163) without calling `renderActiveSignature()` → `btnSubmit`/`btnDecline` stay **enabled** (static HTML) while `sigText`/`sigTextField`/`sigInitials` are **missing** → click throws `Cannot read properties of null (reading 'value')`. Fix:
- `window.onload` now calls `renderActiveSignature()` even when `INIT.slots` is empty.
- `renderActiveSignature()` builds a **fallback signing zone** (single active party card) when no `.pw-party.active` exists, and re-enables the buttons.
- `submitSignature()` null-guards all three element reads + `canvas`; shows an inline error instead of a console-only crash.
- `window.__DOCUPDF_VER__ = 'v26.1'` marker to detect stale caches.

**Regression matrix still to run (all on a fresh job):**
- [ ] Desktop + mobile + incognito, pdfB64 populated (happy path)
- [ ] Slot A and Slot B on the same job
- [ ] Decline path
- [ ] Confirm `window.__DOCUPDF_VER__ === 'v26.1'` in console (cache-guard)
- [ ] `currentonly` finalize still unverified end-to-end (PLAN §6 item 1)
- [ ] v26.2: re-test Sign on a fresh job (incognito) — URL must be well under ~16K now
- [ ] v26.2: bump `__DOCUPDF_VER__` marker to `'v26.2'` + redeploy (cache-positive confirmation)

## 1. What the app does
Sheets add-on that signs already-generated PDFs (invoices / both-party MOUs) with a pdf-lib overlay + audit stamp and writes one-time, token-gated sign links into the sheet. Two source modes per E-sign type:
- **DocuMail mode** — signs DocuMail-merged PDFs (`Merged Doc URL/ID`); DocuPDF writes sign links only, DocuMail sends the email.
- **Standalone mode** — signs own PDFs (`Source Doc ID/URL` via Drive Picker); DocuPDF writes links AND emails signers itself.

## 2. Architecture (LOCKED, multi-type)
- **E-sign types** = the DocuMail-`template` equivalent. One sheet holds many types (MOU, Invoice, PO...). Each type carries: name, source mode, row **filter** (which rows it processes), signer column map, output/link column map, email template (standalone only), schedule, output folder.
- Storage: `eSignTypes.gs` — ScriptProperties `DOCUPDF_TYPES_<ssId>` = JSON array. Global config (`DOCUPDF_SIGN_PRO_CONFIG_<ssId>`) retained as setup fallback; its `autoSync` switch no longer gates scheduling (per-type now).
- **UI**: minimal sidebar lists types (cards + ➕ Create New E-sign, Edit/Run/Pause/Resume/Copy/Audit/Delete + `?` help) exactly like DocuMail Pro; ALL config lives in a step-by-step modal wizard (`ESignWizard.html`, auto-detects source mode, auto-selects active sheet, per-step `?` help).
- **Sync**: installable triggers auto-install once (idempotent, on E-sign save): `ON_EDIT` fast path + 1-min `ON_SCHEDULED_SYNC` → `SYNC_ALL_TYPES`. **No global auto-sync switch** — each type's `scheduleMinutes` (wizard Step 6) decides when it runs; per-type `▶️ Run` = `SYNC_TYPE(id)`; per-type Pause/Resume = `enabled` flag. Row gates: filter + `Signing Required=Yes` + source resolvable + `DocuPDF Status` empty/`Blocked*` + `Document Signed` empty.
- Deploy: script id `15MA8lLK_L6j_YQl_uEpvg6Cdlqj7hoEORCZL06JWFzfSiOQ3nHIkQOY2`, web app `https://script.google.com/macros/s/AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK/exec` (@HEAD).

## 3. Status
### DONE & PUSHED (@HEAD, 15 files)
- **Multi-type refactor (all of it):**
  - `eSignTypes.gs` (new) — type CRUD (`GET_ESIGN_TYPES`, `GET_ESIGN_TYPE`, `SAVE_ESIGN_TYPE`, `DELETE_ESIGN_TYPE`, `TOGGLE_ESIGN_TYPE`), `GET_SHEET_HEADERS_FOR`, `_persistConfig`, `GET_SIDEBAR_REFRESH`, `OPEN_ESIGN_MODAL`/`OPEN_NEW_ESIGN`.
  - `ESignWizard.html` (new) — 6-step modal: 1 Name & Type · 2 Rows/Filter · 3 Signers · 4 Output & Links · 5 Email (standalone-only, DocuMail info banner) · 6 Schedule (Manual/5/15/60/360/720/1440). Reads `window.__ESIGN_TYPE_ID__`, sheet-change refills columns.
  - `syncEngine.gs` — rewritten: `SYNC_ALL_TYPES`, `SYNC_TYPE`, `_syncOneType`, `_rowMatchesFilter`, per-type schedule, multi-type `ON_EDIT`, multi-type `SHOW_AUTO_SYNC_STATUS`.
  - `SidebarWizard.html` — rewritten: DocuMail-style type-list sidebar (Edit/Run/Pause/Delete, ➕ Create, 3s refresh poll).
  - `Code.gs` — menu + `Create New E-sign`; `_createAndWriteJob` uses `_persistConfig`.
- `onOpen`/`onInstall` lowercase (menu works); test installation still needs enabling.
- `SETUP.md` + `PLAN.md` updated for the multi-type/wizard flow.
- All `.gs` pass `node --check`; HTML `<script>` balanced; every HTML→GS function reference verified.

### WIZARD + TEMPLATE SESSION (Wed Aug 19 2026, ~1:50am)
> **State: pushed @HEAD only (no new versioned deploy per workflow). Test tomorrow.**

- **Deploy workflow decided:** push to `@HEAD` (`AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK`) only; versioned `clasp deploy` only for stable release. 200-version cap (archived count); 50 active-deploy cap (archived don't count). Currently 7 versions, 7 deployments (1 @HEAD + 6 versioned).
- **Picker fixed (matches DocuMail Pro / DocuForm Sync):** static `<script src="https://apis.google.com/js/api.js">` in `<head>`; `gapi.load('picker')` only; **`setOrigin(google.script.host.origin)`** (the missing piece — Picker silently did nothing without it in the sandboxed iframe); `setAppId('1097630912653')` (numeric project number, not client ID); server-side token via `GET_OAUTH_TOKEN()`. Removed `view.setIncludeFolders` (only exists on `DocsView`; crashed `View` with "not a function").
- **redirect_uri_mismatch fixed:** dropped client-side `gapi.auth.authorize` popup (OAuth client origin is `script.google.com`, modal runs on `*.script.googleusercontent.com`) → now uses `ScriptApp.getOAuthToken()` server-side.
- **Scope decision (user): ZERO restricted — `drive.file` ONLY, no `drive.readonly`.** Consequence: pasted links to arbitrary files are unreadable at run time; only Picker-picked (or app-created) files are accessible.
- **Model pivot (user request, answers): Standalone mode now uses ONE template PDF per E-sign type.** Wizard steps reordered to **1 NAME → 2 SHEET → 3 PDF (template, "📂 Browse") → 4 ROWS/FILTER → 5 SIGNERS → 6 OUTPUT → 7 EMAIL → 8 SCHEDULE**. Step 3 stores `templateFileId` on the type; `saveType` no longer writes per-row (`WRITE_PDF_TO_CURRENT_ROW` no longer called from wizard — function still exists in Code.gs, unused). `syncEngine.gs` `_resolveSourceId`: standalone → type `templateFileId` ONLY (no per-row source column), else clear error "add a Template PDF (Step 3)".

### MANUAL-PICK SESSION (Wed Aug 19 2026) — standalone redesign per user
> State: implemented, `node --check` clean, pushed @HEAD.
- **Standalone = manual pick only.** `_syncOneType` no longer auto-creates jobs for standalone types; rows are signed one at a time from the sidebar **✍️ Sign a row** dialog (Party B dropdown + row-number box) → `SIGN_SELECTED_ROW` → `_createAndWriteJob` on the type's template PDF. DocuMail types keep auto-sync.
- **Column set shrunk to 8** for standalone Setup: `Signer A Email | Signer A Name | Signer B Email | Signer B Name | DocuPDF Status | Document Signed | Sign Link - Party A | Sign Link - Party B`. Removed `Signing Required`, `Source Doc ID/URL`, `Doc Name`. Wizard Step 4 (Rows/Filter) + Step 5 "Signing Required" hidden for standalone; Step 4 shows a manual-pick note.
- **Drive read path fixed (root cause of "[PBlocked]"):** `DriveApp.getFileById` REQUIRES `drive.readonly`/`drive` scopes and throws even for Picker-picked files under `drive.file`-only auth. Added `_driveFetchMeta`/`_driveReadPdf` (Drive REST API v3 via UrlFetchApp + the app's `drive.file` token, `supportsAllDrives`); all source-PDF reads now go through it — `_loadPdfFile`, `PROBE_DOC_ACCESS`, `_servePdf` (doGet?action=pdf), `_dispatchSlot` attachment, `_fileAccessible` (save-time A1 validation), `WRITE_PDF_TO_CURRENT_ROW`. App-created files (sig blobs, folders, output) still use DriveApp. `urlFetchWhitelist` += `https://www.googleapis.com/`. This makes BOTH picked standalone templates and DocuMail-created PDFs readable.
- **Doc-template→PDF with {Tag} auto-fill: DEFERRED** (needs restricted `documents` scope — conflicts with zero-restricted policy; would duplicate DocuMail Pro engine). User said "not sure" → chose static template instead.
- **Menu cleanup:** "Create New E-sign" removed from sheet menu (`Code.gs` `onOpen`); sidebar-only now. (`HelpDialog.html:82` still mentions it — decide whether to update.)
- **Step-2 wording clarified:** "Only work on rows where this column (optional — empty = all rows)" + example.
- **`_createAndWriteJob` error text improved** to explain the drive.file/picker requirement.

### FEATURE SESSION — B1–B8 + M1 reliability (Wed Aug 19 2026)
> **State: implemented, `node --check` clean. Push @HEAD to test.**

User scope: **all B1–B8** + auto-fallback to template, zero restricted scopes, easy UX. Kept standalone (no new products).

- **B1 placement:** per-slot `page` / `align` / `vOffset` now stored on the type (`slotPlacement.A/B`) and honored by `_fitSignatureBox` (pdfSignEngine.gs) — previously page/x/y existed in the model but were never wired. Wizard Step 5 has Placement fields (Page / Align / Vertical).
- **B2 signer text field + initials:** `signerTextFieldLabel` + `initialsEnabled` on the type; `SignatureModal.html` shows the optional text field + initials box; `PLACE_SIGNATURE_ON_PDF` stores `slot.textValue`/`slot.initials`; `_drawSignatureSlot` renders them as extra caption lines. Audit `SIGN` event includes the values.
- **B3 opened tracking:** `doGet` marks `slot.openedAt` on first open (when `trackOpens`), audits `OPEN`, best-effort `Opened …` status marker.
- **B4 reminders:** `reminderDays` on the type; `_sendRemindersForType` (syncEngine.gs) scans job registry at sync time, re-emails pending slots once the interval elapses, idempotent via `lastReminderAt`, audits `REMIND`.
- **B5 sequential signing:** `sequentialSigning` on the type; `_maybeAutoSend` defers Party B; after Party A signs, `PLACE_SIGNATURE_ON_PDF` dispatches Party B's link via the record snapshot (`_cfgFromRecord`), audits `DISPATCH`.
- **B6 branding:** `logoUrl` + `brandColor` on the type; `_dispatchSlot`/`_buildHtmlEmail` (rewritten to options-object) apply brand color + logo; signer modal header/title/button branded.
- **B7 in-person signing:** sidebar "✍️ Sign here" → `OPEN_IN_PERSON_DIALOG` + new `InPersonDialog.html`; `GET_PENDING_JOBS` lists pending slots of a type in this spreadsheet, owner opens the sign page on the shared device.
- **B8 QR in email:** `qrInEmail` (default on); `_dispatchSlot` fetches a QR PNG (quickchart, already whitelisted) and inlines it as `cid:qr`.
- **M1 A1:** `SAVE_ESIGN_TYPE` now validates `templateFileId` via `_fileAccessible` — pasted/unaccessible template fails at Save with an actionable message.
- **M1 A2/A3:** `_createAndWriteJob` takes a `sourceLabel` (error prefix); `_maybeProcessRow` falls back to the type template when a row's `Source Doc ID/URL` is unreadable under drive.file, audits `FALLBACK`.
- **M1 A4:** empty `Doc Name` cell auto-filled from the source PDF name at job creation.
- **Audit context:** `LOG_AUDIT_EVENT` now falls back to `SpreadsheetApp.openById(meta.spreadsheetId)` (web-app context), and SIGN/DECLINE/FINALIZE/NOTIFY/REMIND pass `spreadsheetId`.
- **Remaining:** live test the wizard fields, deployment @HEAD, then decide HelpDialog cleanup (§30).

### NEXT SESSION — start here (Wed Aug 19 2026, tomorrow)
1. **Re-authorize** the add-on (test install) → confirm sidebar + wizard open and sheet dropdown populates (PWAI fallback + typeId fix are in @HEAD).
2. **Create an E-sign (standalone)**: Step 1 name → Step 2 sheet → Step 3 **Browse** a template PDF (verify Picker opens and writes the file id) → map columns → Save.
3. **Run** that type → expect `Sign Link` written + standalone email + no "Cannot open the source PDF" (Browse grants drive.file per-file access). If still blocked, capture exact message.
4. **Test documail mode** path still works (Merged Doc ID/URL).
5. Decide **HelpDialog.html:82** cleanup (mentions removed menu item) and whether to wire the **placeholder `templateFileId` validation** in `SAVE_ESIGN_TYPE` (currently not required server-side).
6. Eventually: GCP consent re-verify + versioned deployment for a stable release (not per-change).

### WIZARD FIXES (Wed Aug 19 2026)
- **Root cause of "Sheet holding the rows" empty + stuck Next:** the wizard relied on `PWAI` (`S`) from `CSS_JS_Bundle` (`<?!= include('CSS_JS_Bundle'); ?>`). When that include is absent/not deployed, `var S = PWAI` breaks: the dropdown never populates AND `S.showError` silently throws → no error text, Next appears dead.
- **Fix:** `ESignWizard.html` now ships its own `S` fallback (`window.PWAI || {...}`) — modal works standalone; error box now actually shows "Choose the sheet…" / "Give this E-sign a name…".
- **typeId timing bug:** `state.typeId = window.__ESIGN_TYPE_ID__` was read at script parse time, before `OPEN_ESIGN_MODAL`'s appended `__ESIGN_TYPE_ID__` script ran → editing an existing type always behaved like a new one. Now read in `window.onload`.
- **Menu cleanup (user request):** removed `Create New E-sign` from the spreadsheet menu (`Code.gs` `onOpen`). Creating/configuring E-signs is now **sidebar-only** (`SidebarWizard.html` "➕ Create New E-sign"). Note: `HelpDialog.html:82` still mentions the menu item — user offered to leave it.
- **Step 1 PDF picker (per-row):** added `Source PDF for the current row` field + `📁 Pick PDF` button. **WIRED with real creds** — `PICKER_CLIENT_ID` = `1097630912653-udts8mpl0s2rr3i3mc3ch4bavk1b7aif.apps.googleusercontent.com`, `PICKER_API_KEY` = `AIzaSyB35NCx7stT71wZQbyGqjSVImbs4SszkDY` (client-side key; public by design for the Picker). Pattern matches **DocuMail Pro / DocuForm Sync** (verified working with `drive.file` only): static `<script src="https://apis.google.com/js/api.js">` in `<head>`, `gapi.load('picker', ...)` (no legacy `auth` module), **`setOrigin(google.script.host.origin)`** (the critical piece — without it the Picker silently does nothing in the sandboxed iframe), `setAppId('1097630912653')` (numeric project number), server-side OAuth via `GET_OAUTH_TOKEN()`. Removed `view.setIncludeFolders` (only exists on `DocsView`, crashes `View`). On Save → `WRITE_PDF_TO_CURRENT_ROW` (`Code.gs`) writes the PDF into the current row's `Source Doc ID/URL` + `Doc Name`, then the type is saved and the dialog closes. **Scope decision (user): KEEP `drive.file` ONLY — NO `drive.readonly`** (zero-restricted policy). Consequence: arbitrary pasted links are NOT readable at run time ("Cannot open the source PDF: permissions…") — use the **📁 Pick PDF** button so the Picker grants per-file access, exactly like DocuMail/DocuForm. Improved `_createAndWriteJob` error text to explain this.
- **Deploy workflow (user):** push to `@HEAD` only — test via `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK` (always latest). No more `clasp deploy` per change → stops burning versions (200 max; archived versions count). Versioned deployment only for stable release.

### BRANDING SESSION (Wed Aug 19 2026)
- **Name rename:** product name changed everywhere from `DocuPDF-Sign Pro` → **`DocuPDF Sign`** — `Code.gs` (`APP_NAME`, alerts, emails, error page), `appsscript.json` (add-on `name`), all engine file headers, `HelpDialog.html`/`SidebarWizard.html`/`SignatureModal.html`, `SETUP.md`, `CODEBASE_NOTE.md`, `SCOPES_JUSTIFICATION.txt`, and this `PLAN.md`. **Intentionally untouched** (not display names): logo URL `docupdf-sign-pro-logo.png` (hosted asset) and ScriptProperties keys `DOCUPDF_SIGN_PRO_CONFIG_<ssId>` / `DOCUPDF_TYPES_<ssId>`.
- **Logos:** created `Logos/Marketplace/` from `Logos/DocuPDF Sign-Logo-Transparent.png` — `DocuPDF Sign 32x32.png`, `48x48.png`, `96x96.png`, `128x128.png`, `DocuPDF Sign Card Banner.png` (720x400), `card-banner-220x140.png` (220x140). All truly transparent (verified: no white bg, no dark fringe). Matches the DocuMail Pro / DocuForm Sync Marketplace sets.

### EVENING SESSION (remaining)
1. In editor: **Deploy → Test installations** → set **Enabled = True** for "DocuPDF Sign"; reopen sheet → menu builds; open sidebar (type list) + create first E-sign via wizard.
2. **Manual test**: create type "MOU" (DocuMail) + "Invoice" (standalone) → ▶️ Run → verify links written, standalone email, signer modal, finalize → `Document Signed` + owner notify. Check `Blocked:` rows behave.
3. **GCP**: cloud project linked to script (GCP project id `1097630912653`) → OAuth consent (5 non-restricted scopes, add testers) → **replace Picker placeholders** (`1097630912653` / client ID `1097630912653-udts8mpl0s2rr3i3mc3ch4bavk1b7aif.apps.googleusercontent.com` / API key in `SidebarWizard.html`/`ESignWizard.html`) → versioned deployment + Editor add-on test deployment. Consent screen is currently **Testing mode** (owner must be a test user).
4. Live-runtime verification (pdf-lib under V8, Drive preview, `drive.file` on DocuMail PDFs).

### BUILD SESSION — anonymous web app + race hardening (Tue Aug 18 2026)
> Pre-launch blockers from validation review. All `.gs` pass `node --check`; modal `<script>` balanced; HTML→GS references re-verified.

- **FIX 1 (anonymous signer auth):** `doPost(e)` JSON API added in `Code.gs` — body `{ action:'sign'|'decline', ...payload }` (sent as `text/plain` to skip the CORS preflight Apps Script can't answer). Reuses the existing `_validateSigningToken`; `fetch()` auto-follows the 302. `SignatureModal.html` now calls `postJson()` (fetch → doPost) instead of `google.script.run` — a no-Google-account signer can submit. Token model unchanged (per-slot, one-time, 7-day, ScriptProperties).
- **FIX 2 (anonymous PDF preview):** `doGet?action=pdf` returns the source PDF bytes (`ContentService` `application/pdf`, token-gated) via the owner's `drive.file` (execute-as-ME). Modal renders it as a `data:` URL (`loadPreview()` + chunked base64) — signer never touches Drive; also fixes cross-app preview (DocuMail PDFs no longer need sharing/Drive access for the signer). `previewUrl` in `__SIGN__` now points at the web app, not `drive.google.com/.../preview`.
- **FIX 3 (finalize race):** `PLACE_SIGNATURE_ON_PDF`, `DECLINE_SIGNING_REQUEST`, `RUN_FINALIZE` all serialize the commit+finalize section under `LockService.getScriptLock().waitLock(30000)`; token re-validated and `record.finalized` re-checked INSIDE the lock. `_markSlotTokenUsed` made idempotent (retry = no-op). Fixed a latent bug: `slot.used = true` was being written to the store first then clobbered by the in-memory save — now set on the record before `_saveJobRecord`.
- **FIX 4 (Picker creds):** **FLAG — the placeholders do NOT exist in `SidebarWizard.html`/`ESignWizard.html`** (or any code file). They appear only in `PLAN.md`/`CODEBASE_NOTE.md` docs. Real GCP project id `1097630912653`, OAuth client ID `1097630912653-udts8mpl0s2rr3i3mc3ch4bavk1b7aif.apps.googleusercontent.com` (web client "DocuPDF Sign Web Client", origin `script.google.com`). Client secret is **NOT stored here** (not needed by the browser Picker — client-side OAuth; keep it secret, never commit). The Drive Picker isn't wired into the current HTML at all — standalone source selection is a pasted `Source Doc ID/URL` (or `WRITE_SOURCE_TO_ROW`). When a real Picker is added, these real creds (client ID + API key) will need to be introduced into the HTML. No code change possible until then.
- **SETUP.md §5** rewritten for the anonymous-capable flow (fetch/doPost + byte-served preview).
- **SCOPES_JUSTIFICATION.txt**: verified — none of the 4 fixes require a new/broader scope (transport/locking only; still `drive.file`/`currentonly`/`gmail.send`/etc.).

### Remaining (verification, see §6)

### BUILD SESSION — UX overhaul + GCP + per-type scheduling (Tue Aug 18 2026, night)
> Live first-test feedback from drsanjiiiv. All `.gs` pass `node --check`; HTML `<script>` blocks verified; pushed @HEAD (15 files).

- **Init flow:** `Open E-sign Engine` / `Create New E-sign` gate on sheet-init state (`_ensureInitiatedOrPrompt` / `_setupInitiatedState`, Code.gs). Empty sheet or no DocuPDF/DocuMail columns → prompt *"E-sign is not initiated yet — Do you want to initiate?"* → **Yes** runs `SETUP_SHEET` (all standalone columns, or DocuMail block inserted before `Merged Doc Status`).
- **Setup targets a real sheet:** `_setupTargetSheet` (Code.gs) skips the `AuditLog` sheet (Setup had been polluting it). Setup `sheet.activate()`s the data sheet afterwards. Empty-sheet crash fixed (0-column guards in `_setupInitiatedState`, `RESOLVE_SYNC_COLUMNS`).
- **AuditLog is read-only:** protected owner-only (`_protectAuditSheet`) on creation and on "View Audit Logs".
- **Wizard Step 1 simplified:** active sheet auto-selected (`GET_ESIGN_TYPE` now returns `activeSheet`); **source mode auto-detected** from headers (DocuMail columns present ⇒ documail, else standalone) — the manual radio choice was removed; per-step `?` help button added (fixed a bug where the help panel's `display:''` toggle never showed it).
- **Sidebar:** per-type **📋 Copy** (`COPY_ESIGN_TYPE`) and **📜 Audit** (per-type audit dialog `AuditDialog.html` via `VIEW_TYPE_AUDIT`/`GET_AUDIT_FOR_TYPE`); all audit events now carry `Type: <typeId>` in the Details column (JOB/SHARE/LINK_WRITE/DISPATCH/SIGN/FINALIZE/DECLINE, incl. `eSignService.gs`); `?` help panel added.
- **Menu:** removed Enable/Disable Auto-sync + Auto-sync Status; added **`? Help`** (`SHOW_HELP` → `HelpDialog.html`). Setup alert simplified to Source mode + Columns added; SETUP audit detail = "Source mode: x".
- **Per-type scheduling (no global switch):** global auto-sync bar/toggle removed from the sidebar. Triggers auto-install idempotently on E-sign save (`_ensureTriggersInstalled`, syncEngine.gs); `ON_SCHEDULED_SYNC`/`ON_EDIT` no longer read a global `autoSync` gate. **Added scope `script.scriptapp`** to `appsscript.json` (required for installable triggers) — **re-authorization needed; sensitive scope → verification before production.**
- **GCP (configured):** project id `1097630912653`; OAuth web client "DocuPDF Sign Web Client" `1097630912653-udts8mpl0s2rr3i3mc3ch4bavk1b7aif.apps.googleusercontent.com` (origin `script.google.com`, redirect `.../oauth2callback`); consent screen **Testing** with testers in **Audience** (the 403 was testers only in store listing). **Drive Picker still NOT wired** (FIX 4) — standalone source = pasted `Source Doc ID/URL`.

### NEXT SESSION — start here
1. **Re-authorize** the add-on (new `script.scriptapp` scope) → save an E-sign with a schedule and confirm triggers auto-install.
2. **Full live test** on the test spreadsheet per §6 (finalize via `currentonly` is the gating item).
3. Decide/implement **Drive Picker** (FIX 4) with the real client ID if wanted — needs `drive.readonly` scope + verification for production.
4. **Clean up** the test sheet: remove the sign columns wrongly added to the old `AuditLog` sheet; remove the earlier polluting SETUP audit rows if desired.

### Signature placement — CURRENT BEHAVIOR (no PDF spot/keyword needed)
- Slots carry `page`/`x`/`y`/`width`/`height` in the job record (`_createJobRecord`, `Code.gs:287-305`), and `_fitSignatureBox` (`pdfSignEngine.gs:101`) can draw at arbitrary coords.
- **But** `_createAndWriteJob` (`Code.gs:1024-1038`) builds slots with only `{label, signerEmail, signerName}` — no coords. **Every signature lands at the default: last page, horizontally centered, ~60pt from the bottom** (`pdfSignEngine.gs:109-110`). No "sign here" line, no keyword/anchor matching (e.g. "below 'Authorized Signature'").
- Audit stamp (SHA-256 + QR) is always drawn on the **last page** (`RECONSTRUCT_PDF`, `pdfSignEngine.gs:239-244`).
- So the source PDF's content/layout does not matter for signing; DocuPDF overlays on the last page regardless.
- **Gap:** per-slot placement (page + x/y) exists in the data model but is NOT wired into `ESignWizard.html`/`_createAndWriteJob`. If a signer must sign a specific line (e.g. page 1, above "Party A:"), that needs a small feature: placement step in the wizard + pass coords through job creation. Not yet requested/implemented.

## 4. Risks still unvalidated (live GAS runtime)
- pdf-lib under V8 (embedPng/TextEncoder).
- Drive preview for external signers; `drive.file` access to DocuMail-created PDFs (failures → `Blocked: …` status, retried).
- Add-on menu + test installation (step 1 above).
- **`spreadsheets.currentonly` in the web-app finalize path** — `_updateSheetStatus`/`_markRowDocumentSigned` use `SpreadsheetApp.openById` (signatureHandler.gs). In a web-app (execute-as-ME) context there is no "active" spreadsheet; `currentonly` may reject `openById`. **Test FIRST.** If it fails, the fix is "auto-finalize only from the container/sidebar (`RUN_FINALIZE`)" — signers record their signature, owner clicks Finalize.

## 5. Files
- `eSignTypes.gs` (new) · `syncEngine.gs` · `Code.gs` · `SidebarWizard.html` · `ESignWizard.html` (new) · `AuditDialog.html` (new) · `HelpDialog.html` (new) · `SignatureModal.html` · `CSS_JS_Bundle.html` · `pdfSignEngine.gs` · `signatureHandler.gs` · `eSignService.gs` · `auditStampEngine.gs` · `vendor/pdf-lib-bundle.gs` · `appsscript.json` · `.clasp.json`

## 6. Manual verification checklist (post-FIX 1–3)
Order matters — item 1 gates everything else.

1. **`currentonly` web-app finalize (FIRST):** deploy @HEAD as web app, create a 2-slot job, sign both slots via the link (or 1 slot + owner `RUN_FINALIZE`). Confirm sheet `DocuPDF Status`/`Document Signed` update. If `openById` throws permission errors → apply the "finalize from container" fix.
2. **Anonymous signer (no Google account):** web-app deployment set to **Anyone with link + Execute as: Me** (UI-only, not code). Open a sign link in an **incognito** browser, verify: modal loads, PDF preview renders (byte-served), signature submits, decline submits, status/links update, audit events logged.
3. **Cross-app (DocuMail) PDF:** pick a DocuMail-merged PDF via the fallback path → confirm `Blocked:`/Picker guidance works; verify the signer can preview it (byte route) even though the signer has no Drive access.
4. **Race:** two browser tabs signing simultaneously → exactly one finalize, one owner email, no double `_SIGNED.pdf`.
5. **GCP consent + triggers:** project linked (`1097630912653`), consent screen Testing with testers in Audience (done). **Next:** re-authorize after the `script.scriptapp` scope; confirm triggers auto-install on first scheduled E-sign save; eventually verify the modal + Picker run under real creds (Picker itself is not yet wired — FIX 4 flag).
6. **pdf-lib V8 edge cases:** rotated pages, non-standard page sizes, AcroForm PDFs, non-Latin signer names, encrypted PDFs.

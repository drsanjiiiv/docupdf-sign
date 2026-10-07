# DocuPDF Sign — Revision 01: doGet trace for job 411ea420 (live fallback-card repro)

> Generated Thu Sep 24 2026. Static code trace + live API probes. **No code
> changed.** Sources: `PLAN.md`, `SETUP.md`, `SignatureModal.html`,
> `Code.gs`, `pdfSignEngine.gs`, `signatureHandler.gs`, `InPersonDialog.html`,
> deployed HEAD source via `projects.content`, official Apps Script docs.
>
> Probe constraint: the access token (clasp OAuth, `drsanjiiiv@gmail.com`) has
> script + web-app scopes but **no Drive read scope**, so the job record
> (ScriptProperties) and the AuditLog spreadsheet are **not readable from this
> CLI**. Everything below about the live job is a **static code-path trace**;
> only repo/deployment facts are live-confirmed.

---

## Q1. `window.__DOCUPDF_VER__` — still 'v26.1'?

**Yes, in both places — the v26.2 bump was never made.**

- Local: `SignatureModal.html:241` → `window.__DOCUPDF_VER__ = 'v26.1';`
- Deployed HEAD source (via `projects/content`, refreshed token):
  - `HEAD __DOCUPDF_VER__ = v26.1`
  - `has navigateTop: true`, `has compactSignature: true`, `has previewUrl: true`, `has pdfB64: true`

So the served v29 page **does** contain all v26.2 code paths, but the
cache-proof marker still reads `v26.1`. The §0b todo "bump to 'v26.2'" is
**still not done**.

---

## Q2. doGet trace for this signToken (static)

Link params given: `job=411ea420-62b6-4ca5-ba77-377065a02474`,
`signToken=ca77da19782844239599d4ba04585047ada35415782f4881b4e9f7ad24bac633`.
Format checks pass: job matches a UUID pattern (matches `_createJobRecord`'s
`Utilities.getUuid()`), signToken is 64 hex chars (matches `_randomToken()` =
two stripped UUIDs; 16-hex `nonce` from `_randomNonce()` is **not provided**).

`doGet` (`Code.gs:327`) flow for a modal request:

1. Requires `job`, `signToken`, `nonce` (`Code.gs:352`) — missing any → error
   page "Missing signature request parameters." (I did not probe with the real
   nonce; bare HTTP gets only Google's `ppConfig` bootstrap anyway, and the live
   job's nonce isn't shared).
2. `_validateSigningToken(jobId, signToken, nonce)` (`Code.gs:874`) →
   `_getJobRecord(jobId)` reads ScriptProperties key `DPD_JOB_411ea420-…`
   (`Code.gs:853`). Outcomes per branch:
   - record absent → `{valid:false, reason:'No signature request exists…'}`
   - `record.finalized` → "already been signed and finalized"
   - now > `record.expiresAt` (7-day) → "expired (7-day validity)"
   - slot `signToken`+`nonce` match, slot not used → **valid**
     `{record, slot, slotIndex}`; used → "already been used"; no match →
     "could not be authenticated"; catch → "could not be validated"
3. If valid and `!slot.openedAt` (`Code.gs:362`): sets `openedAt`, saves record,
   **logs `LOG_AUDIT_EVENT('OPEN', …)`** with docId=jobId, signer email, status
   "Opened", spreadsheetId, details. Also writes sheet status "Opened …" only if
   `record.signing.trackOpens`.
4. Serves `SignatureModal.html` and appends `window.__SIGN__ = JSON.stringify({…})`
   (`Code.gs:415-449`) where:
   - **slots**: `record.slots.map` → per slot `{slot, label, signerName,
     signerEmail, signerDesignation, signed: !!signedAt, current: (slot===active)}`
     — a valid job's slots array is **never empty** in this path.
   - **signerName** (top level) = active `slot.signerName || ''`.
   - **previewUrl** = `serviceUrl?action=pdf&job=…&signToken=…&nonce=…`
     (or `''` if `record.sourcePdfId` empty).
   - **pdfB64** = base64 of the read PDF (see Q3) or `''`.

**OPEN audit event for this job:** *cannot be verified from the CLI* (needs
access to the AuditLog sheet or the ScriptProperties store). What the code
guarantees: OPEN is logged exactly once per slot, on the first successful
`doGet` validation (`!slot.openedAt`), then never again.

**Why the fallback card is impossible to produce from a successful v29 doGet:**
the fallback card ("Signer / Signing now / **Not provided**",
`SignatureModal.html:195-211`) only renders when `INIT.slots` is empty/absent.
A successful v29 `doGet` always injects non-empty slots + the real signerName.
So a fallback card on the v29 URL means the browser did **not** execute a
successful v29 doGet render — consistent with §0b's theory: a **stale cached
pre-v26.1 template** (or the anonymous handshake serving Google's wrapper
instead of the modal). This matches "job exists + emails dispatched + card
empty", because the job/emails live server-side and are irrelevant to what the
cached page renders. v29's served `__DOCUPDF_VER__` is `'v26.1'`, so a cached
page could even look "current" by the marker while being pre-slot-injection.

---

## Q3. Is pdfB64 populated, and where can it fail?

`doGet`'s pdf embedding (`Code.gs:390-407`):

```
var pdfB64 = ''; var pdfNote = '';
if (record.sourcePdfId) {
  var pr = _driveReadPdf(record.sourcePdfId);       // pdfSignEngine.gs:352
  if (pr.ok && pr.bytes) {
    if (pr.bytes.length <= 8*1024*1024) { pdfB64 = base64Encode(pr.bytes); }
    else { pdfNote = 'too large to preview inline…' }
  } else { pdfNote = 'Preview unavailable: ' + (pr.error || '…'); }
}
```

Failure points (in order):
1. **`record.sourcePdfId` empty/absent** → `pdfB64=''` **and** `previewUrl=''`
   silently (no note). This is the only path that yields an empty previewUrl
   too. If the job was created, `_createAndWriteJob` stored the validated
   `fileId`, so this should be populated unless the record is a different/older
   shape.
2. **`_driveFetchMeta` non-200** (`pdfSignEngine.gs:330`): `drive.file` scope,
   `supportsAllDrives` — a file not picked via Picker / not created by the app
   → "Drive API HTTP 403/…". `pr.ok=false` → pdfNote set, `pdfB64=''`.
3. **`_driveReadPdf` download/export non-200** (`pdfSignEngine.gs:364-368`):
   native PDF via `alt=media`, else export to `application/pdf`.
4. **>8MB cap**: `pr.bytes.length > 8*1024*1024` → pdfNote, `pdfB64=''`
   (previewUrl still set → the modal shows "Open in a new tab").
5. Exception in the try → pdfNote = `e.message`, `pdfB64=''`.

Note: `_loadPdfFile` (`pdfSignEngine.gs:38`) wraps `_driveReadPdf` and **throws**
on `!ok` or non-PDF mime — it is the **signing-time** reader, NOT used by `doGet`
preview (which calls `_driveReadPdf` directly). The one source-PDF read path is
shared, so the same 403 that blanks the preview would also break finalize.

Also: `_servePdf` (`?action=pdf`, `Code.gs:593`) re-validates the token and
reads the same PDF — if `_driveReadPdf` fails there, it returns "Preview
unavailable: …" text (the in-page fallback pointed at by `previewUrl`).

---

## Q4. "Could not create the sign request." — where and when it fires

- **Location: `InPersonDialog.html:225`** — client-side, inside the in-person
  dialog's `createSign()` `.withSuccessHandler`.
- Trigger: exactly when `SIGN_SELECTED_ROW(TYPE_ID, row)` returns
  `{ok:false}` (or a null payload): the handler renders
  `(res && res.error) || 'Could not create the sign request.'`.
- It is **not** in any `.gs` file and is **not** part of the doGet/web-app
  signer path at all. It is purely the in-person dialog's UI fallback for a
  failed job creation.
- **Did it fire for this job?** `SIGN_SELECTED_ROW` → `_createAndWriteJob`
  succeeded for this job (the job exists and both slots' emails were
  dispatched — that only happens on the `{ok:true}` path, `Code.gs:1829-1839`).
  So **no**: this string did not fire for job `411ea420…`. Its appearance would
  be unrelated to the fallback-card symptom.

---

## Q5. WEB_APP_BASE_URL and where sign links come from

- `Code.gs:19`:
  `WEB_APP_BASE_URL = 'https://script.google.com/macros/s/AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7/exec'`
  — i.e. the **v29 live deployment** (`AKfycbxNBAD9…`, the same deployment the
  user opened).
- `_serviceBaseUrl()` (`Code.gs:26`) **always returns `WEB_APP_BASE_URL`**. It
  deliberately ignores `ScriptApp.getService().getUrl()` — the comment states
  `getUrl()` returns the add-on test-install URL in this hybrid project, which
  is not a working web app.
- `_buildSignUrl(record, slot)` (`Code.gs:1964`) = `_serviceBaseUrl() + '?job=…
  &signToken=…&nonce=…'`. All sign links — sheet Link columns
  (`_writeSignLinks`, `Code.gs:1902`) and email links (`_dispatchSlot`,
  `Code.gs:1977`) — are built from **`WEB_APP_BASE_URL`**, **never**
  `ScriptApp.getService().getUrl()`.
- So: the emailed sign links point at the **v29 /exec deployment**, which is
  exactly where the fallback card was seen.

---

## Q6. "Latest code = True" add-on test install — auto-tracks HEAD?

Per Google's official docs (Deployments + Testing editor add-ons):

- **Head deployments always sync to the most recently saved code.** Modifying
  code (including via `clasp push`) updates the head deployment; versioned
  deployments stay pinned.
- A **test deployment saved with "Latest Code"** follows the current project
  code: *"When you run a test deployment set to test with the latest code, you
  can see changes saved to the script by refreshing the test document."*
- Therefore the "Latest code = True" test installation does **not** need to be
  re-added after a `clasp push` — it picks up the new code automatically; the
  test document just needs **refreshing** to load the updated code.
- Caveat from the docs that applies to this project: **installable triggers are
  not supported** in test deployments, and test deployments share Properties
  per script+document combo. That doesn't affect the signer web-app flow.

---

## Summary of hard facts

| # | Question | Answer |
|---|---|---|
| 1 | `__DOCUPDF_VER__` | Still `'v26.1'` local (`:241`) AND deployed HEAD; bump never made |
| 2 | doGet for given token | Static: validates `DPD_JOB_411ea420…` in ScriptProperties; valid → real slots/signerName + pdfB64 + previewUrl; OPEN logged once on first open. Runtime for this job **not verifiable from CLI** (no Drive/Properties access) |
| 3 | pdfB64 | Populated only if `sourcePdfId` present AND `_driveReadPdf` ok AND ≤8MB; failures = missing sourcePdfId, Drive 403 under `drive.file`, >8MB, exception |
| 4 | "Could not create the sign request." | `InPersonDialog.html:225`, in-person dialog only, fires on `SIGN_SELECTED_ROW` `ok:false`; did **not** fire for this job |
| 5 | WEB_APP_BASE_URL | v29 live `/exec`; all links come from it, `getUrl()` is never used |
| 6 | "Latest code = True" test install | Auto-syncs to HEAD after push; refresh the test document, no re-add |

Open items for a browser session (cannot be resolved from this CLI): the real
value of `__SIGN__` served for this exact link (needs the nonce + a real
browser completing the anonymous handshake), whether OPEN actually landed in the
AuditLog sheet, and whether `_driveReadPdf` succeeds for the job's
`sourcePdfId` under the app's `drive.file` scope.
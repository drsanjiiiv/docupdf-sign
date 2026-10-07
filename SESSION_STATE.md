# DocuPDF Sign — Session State (end of 1–2 Oct 2026, ~00:25 IST)

> Handoff note for the next session. Nothing was deployed. Version count still 30.
> **One blocker remains and it is NOT in the code — it is the deployment's
> "Who has access" setting. Read "THE BLOCKER" below before touching anything else.**

## THE BLOCKER — deployment requires a Google login

A sign link opened in incognito (or any logged-out browser) redirects to a
Google sign-in page. Reproduced directly:

```
curl -i --max-redirs 0 "<sign link>"
HTTP/1.1 302 Found
Location: https://accounts.google.com/ServiceLogin?passive=...
Content-Length: 0
```

Google rejects the request **before any app code runs**, so nothing in the
repository can fix this. The deployment `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK`
is not set to "Anyone" (anonymous).

**Why every earlier test passed:** testing was always done in a normal browser
already signed into Google, so the session cookie satisfied the access check.
Incognito has no cookie, so the login wall appeared. This also explains the
original "Drive — you need access" report: the user was signed *out*, not
unauthorized. Several hours were spent fixing symptoms at the wrong layer.

**Contradiction to be aware of:** the previous session-state note claimed this
Head deployment was `ANYONE_ANONYMOUS`. That is now measurably false. Either
the setting was changed in the UI afterwards, or the note was wrong. Treat the
`curl` result above as ground truth.

### Fix (one setting, no version bump, keeps every link already sent alive)

1. Open `script.google.com` → project
   `15MA8lLK_L6j_YQl_uEpvg6Cdlqj7hoEORCZL06JWFzfSiOQ3nHIkQOY2`
2. **Deploy → Manage deployments**
3. Edit (✏️) deployment `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK`
4. **Who has access → Anyone**
5. Save (may prompt to re-authorize)

Editing the existing deployment preserves its ID, so **all sign links already in
circulation keep working**, and because it is an `@HEAD` deployment no redeploy
is required. Can alternatively be done via the Apps Script API
(`deployments.update` with `ANYONE_ANONYMOUS`) using the cached clasp
credentials, if the UI is not wanted.

### Verify

```
curl -i --max-redirs 0 "<sign link>"
```

`200` + HTML = fixed. `302` to `accounts.google.com` = not yet set.

Worth also curling the *other* deployment, `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7`
(v29), to confirm whether the access setting differs per deployment. That would
isolate the cause to the Head deployment specifically. Cheap, do it first.

## Important deployment fact discovered today

`clasp deployments` shows the live deployment is pinned to **`@HEAD`**, so
**every `clasp push` has been instantly live for all signers.** There is no
staging step and no need to redeploy after pushing. The old comment in `Code.gs`
claiming a redeploy was needed after each push was false and has been corrected.
Practical consequence: `clasp push` is effectively a release. Treat it that way.

## Where we are

The signer flow works end-to-end **up to the final PDF write**. Jobs are created,
links and emails go out, the signer page renders, the pdf.js preview renders, and
the signature is recorded. The remaining blocker is the login wall above.

### Working (verified by the user in a signed-in browser)

- Job creation → LINK_WRITE → DISPATCH A/B → OPEN all logged.
- **Drive write-path migration done** — the old `DriveApp.createFile` scope error
  is resolved. All sign/finalize-path writes now go through Drive REST v3 via
  `UrlFetchApp` helpers in `pdfSignEngine.gs`. Still on `drive.file` only.
- **Per-signer status columns done** (`Awaiting` / `Opened <ts>` / `Signing…` /
  `Signed <ts>` / `Declined <ts>`), appended far right, with locked signer OPEN
  tracking and automatic column migration.
- **Sharing role fixed** — now `role: 'reader'`, not writer.
- **Inline pdf.js preview in the signer modal works.** This was the previous
  blocker and it is genuinely fixed (user: "Preview is opening").

### Also built today

- **`PdfViewerPage.html`** (new) — standalone token-gated pdf.js/canvas viewer
  backing the `?action=pdf` "Open in a new tab" link. Same proven technique as
  the modal: pdf.js `4.10.38` from jsDelivr, ES module import, worker module
  imported for its side effect (main-thread path, no `GlobalWorkerOptions`).
- **`_servePdf` rewritten** (`Code.gs:657`) — size-aware. Up to
  `PREVIEW_INLINE_MAX_BYTES` it renders `PdfViewerPage.html` from bytes the app
  already holds: source PDF stays **private**, no Drive sharing, no Google
  account needed. Above the cap it defers to `_oversizePreview`.
- **`_oversizePreview`** (`Code.gs:708`) replaces the old blind
  `_redirectToDrive`. Redirects to Drive **only** when `record.previewShareOk`
  says a public link was genuinely granted; otherwise shows a plain page telling
  the signer to open the copy attached to their email. It must never bounce a
  signer into a Google login wall.
- **`DriveApp.setSharing` deleted.** It could never work under `drive.file` and
  its failure was swallowed. Now uses `_driveSetViewerPermission(fileId)`
  (REST `permissions.create`), gated to documents over the inline cap only —
  small documents are never made public.
- **Sharing failures are no longer swallowed** — `Logger.log` + `SHARE/Failed`
  audit event + new `previewWarning` in the job result, rendered in amber by
  `InPersonDialog.html`.
- `PREVIEW_INLINE_MAX_BYTES` raised 8 MB → **20 MB** (`Code.gs:17`), now a single
  named constant instead of a magic number in two places.

## Deferred items (priority order)

1. **Set deployment access to "Anyone"** — the blocker above. Nothing else works
   for a non-Google recipient until this is done.
2. **Token-gate `action=verify`** (`Code.gs:344` → `_handleVerify`). Once the app
   is world-reachable this is a real leak: it takes `jobId` **alone**, discloses
   the document name and every signer's email address, and passes an
   attacker-supplied `file` parameter straight into `VERIFY_HASH(jobId, fileId)`.
   `jobId` is a UUID so it is not enumerable and the link only goes to the owner,
   so severity is low — but it should be closed. Two-line fix.
3. **"Could not create the sign request" cosmetic fix.** Modal shows this error
   even when the job was created successfully (`InPersonDialog.html`, ~line 225:
   fires on any falsy `res`). User asked for an amber "ambiguous" message while
   keeping red for `res.ok === false`, and explicitly did **not** want the 15s
   watchdog or QR timeout touched. Deferred at the user's request.
4. **Confirmation gate (Phase B).** Signer-page copy still promises "You will
   receive a signed copy with a Confirmation Link… valid for 12 hours only" and
   that promise remains unfulfilled. Full design is in `PLAN.md` — new slot
   state, tokenized CONFIRM link, 12-hour window, owner delivery gate, override,
   urgency levels, audit events `DELIVERED_SIGNER` / `CONFIRMED` /
   `CONFIRMED_EXPIRED` / `DELIVERED_OWNER`. Design before implementing.
5. **Signer-email verification (OTP).** User raised wanting the recipient's email
   logged/verified before the link opens, then **explicitly deferred it**
   ("leave this login thing") to prioritise anonymous access for non-Google
   recipients. If revived, note: *typing* an email is not verification; only an
   emailed code is. Slot already stores `signerEmail` server-side, so the log
   must record the server-side value, never the typed one. Needs lockout/override
   (typo'd address would strand the signer), resend cooldown and attempt caps to
   protect the Gmail daily quota, and a sequential-signing interaction (Party B
   must not burn a code before Party A signs).
6. **Release prep.** One new version, then bulk-delete the ~30 versions in
   Project History (the accidental v30 from a `clasp version` probe goes first).
   NOTE: the old instruction to revert `WEB_APP_BASE_URL` to the v29 deployment
   is **wrong** and has been removed — the Head deployment is the correct target.

## Unverified / risk notes

- **The 20 MB inline cap is reasoned, not measured.** 8 MB is proven. Base64
  inflates 4/3 (~27 MB HTML) which is comfortably under the HtmlService ceiling,
  but pdf.js memory on a large document is a real risk. If a 15–20 MB document
  misbehaves, the fix is chunked delivery, which has no size ceiling. Test with a
  deliberately large PDF.
- **Multi-page lazy scroll, `__PDFVIEW_STEP__` state and absence of
  "Setting up fake worker" were never confirmed in a browser console.** The user
  only confirmed the preview opens. Check console output when convenient.
- **End-to-end status transitions and the `_SIGNED.pdf` bytes are still
  unconfirmed** — job creation through to a real, non-zero-byte stamped PDF has
  not been observed end to end since the Drive REST migration.

## Known latently-broken items (not urgent)

- `doPost` (`Code.gs`) is async and awaits `PLACE_SIGNATURE_ON_PDF`; async
  handlers behind the sync servlet return "not a supported return type". Unused
  by the signer flow, which signs over GET because Apps Script web-app POSTs
  redirect through `script.googleusercontent.com/macros/echo` and 404. Fix or
  remove when convenient.
- `INIT.pdfB64` / `INIT.pdfNote` are injected into `__SIGN__` by `doGet`. They
  are no longer unused — the modal's pdf.js viewer reads `__SIGN__.pdfB64`
  directly on `load`, before `INIT` runs. Do not remove.

## Ground truth (last verified)

- Script id: `15MA8lLK_L6j_YQl_uEpvg6Cdlqj7hoEORCZL06JWFzfSiOQ3nHIkQOY2`
- Version count: **30** (unchanged; no version, no deploy this session)
- **Live deployment: `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK` — `@HEAD`,
  execute-as-Me, access = NOT "Anyone" (the blocker)**
- Other deployment: `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7`
  (v29) — access unknown, worth curling
- 9 deployments total, several stale
- Scopes (7, no restricted): `spreadsheets.currentonly`, `drive.file`,
  `gmail.send`, `script.container.ui`, `userinfo.email`, `script.external_request`,
  `script.scriptapp` — **do not add `drive`**
- `WEB_APP_BASE_URL` (`Code.gs`) = the Head deployment `/exec` URL
- Last push: 17 files at 12:24:04 am
- Sign link used for diagnosis: job `888e800f-5a68-4391-91db-226196961f55`
- `window.__DOCUPDF_VER__` is stale at `v26.2` — cosmetic, but misleading when
  reading logs; bump it when convenient.

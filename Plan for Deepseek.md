# DocuPDF Sign — Current Ground Truth (queried live, read-only probe)

> Generated: Thu Sep 24 2026. Sources: `PLAN.md`, `SETUP.md`, `VERSION_CLEANUP.md`,
> `clasp` (3.3.0), Google Apps Script API (`projects.deployments.get` /
> `projects.content` / `projects.versions.list`) authenticated as
> `drsanjiiiv@gmail.com` (valid token from `~/.clasprc.json`). No code was
> pushed, deployed, or edited. Facts only.

---

## ⚠️ Disclosure — one unintended side effect from the probe itself

While gathering facts I ran `clasp version --json` (clasp 3.3.0 treats
`clasp version` as `create-version`). This **created an empty version snapshot
v30** (createTime `2026-09-24T14:05:08.705Z`, no description). It is NOT
referenced by any deployment and contains no distinct content (versions are
immutable snapshots of whatever HEAD was). **Version count went 29 → 30 because
of this probe, not because of any app work.** VERSION_CLEANUP.md (Sep 22) noted
"29 versions, 9 deployments" — that matches the 29-v count *before* my probe.
There is no API to delete a version (Project History UI only). Flagging so you
can decide whether the count matters to you.

Also: `~/.clasprc.json` now has trailing garbage after the JSON (a
`clasp status`/`deployments` run during this session last-wrote it at
`24 Sep 19:35`) — `clasp versions` fails with a JSON-parse error, but
`clasp status/deployments/version` still work (valid `default` token). This may
be a clasp 3.3.0 token-refresh artifact; re-`clasp login` if it bothers you.

---

## 1. Script version count + all deployments

Script: `15MA8lLK_L6j_YQl_uEpvg6Cdlqj7hoEORCZL06JWFzfSiOQ3nHIkQOY2`

**Version count: 30 total** (was 29 before the probe-created v30 above).
Latest real snapshot: **v29** (`2026-08-19T17:57:32.873Z`, desc
"v26.2 compact signature payload…").

**Deployments: 9 listed; 2 are active web-app deployments** (the other 7 have no
entry points = archived/legacy test deployments, versions 2–10).

| Deployment ID | Version | Access | ExecuteAs | Description |
|---|---|---|---|---|
| `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK` | **@HEAD** (no versionNumber) | **ANYONE_ANONYMOUS** | USER_DEPLOYING | *(none)* — the Head/test deployment |
| `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7` | **29** | **ANYONE_ANONYMOUS** | USER_DEPLOYING | "v26.2 compact signature payload (downscale to 240w, strip data: prefix)" — the LIVE /exec |
| `AKfycbyInnCGJVe2T9hP2JZ013fo0Ck2YXMiFG0VPZ8Gg2i_9TOAD2gOKoxD1e3hLBnwDtPb` | 10 | (no web entrypoint) | — | "DocuPDF Sign web app" |
| `AKfycby-9B-F8yr2LXh8ORUmuiGqzSOd6q1I8L4ZF_ia_fKjtchRodUA4PppcGDnmSLIV_PRrw` | 7 | (no web entrypoint) | — | "Picker fix: remove setIncludeFolders" |
| `AKfycbySusYbhPCogjkVvxPxkr2ebp0o3_tGjythmE0y72WdSNJWMzfpzX1oBODlZY5g0A643g` | 6 | (no web entrypoint) | — | "Picker setOrigin fix (matches DocuMail/DocuForm pattern)" |
| `AKfycbyNsy2MpqeWZJLzIYGyWtWLB5H8HKArDFR-ZGP7axYpzn0gQCT1RVnM3E_gzjrzpVFFOQ` | 5 | (no web entrypoint) | — | "Picker fix + clearer Step 2 + better Drive.file error" |
| `AKfycbxlmWty4i2yu0Po0ees8vjh26vR3IQKNLZW5gySSKog8z0rYjEHagHXin8ZtC3NqY743A` | 4 | (no web entrypoint) | — | "Picker: server-side token (no redirect_uri error)" |
| `AKfycbwGLIDkL9HgKCMRMJmgcyg6dhtfokRMivVZt4f1b5W781qJ4Adouffh47Y7AvLVK4bpJw` | 3 | (no web entrypoint) | — | "ESignWizard fixes + menu cleanup" |
| `AKfycbyqcUH96VsSnoZAmYlVPhg7S7kwEUFvqd5DzUmJoVQgQUHgZo2lig5B07Y_GuDgeBejbA` | 2 | (no web entrypoint) | — | "DocuPDF Sign- Second Test" |

Note: `VERSION_CLEANUP.md` (written Sep 22) planned step A — repin the live
`AKfycbxNBAD9…` deployment from v29 → **Head** — so pushes stop burning
versions. **That repin was NOT done**: the live deployment is still pinned to
**v29**, not Head. The 7 legacy deployments also still exist (not archived).

## 2. projects.deployments.get confirmation for the two key deployments

**Live /exec deployment** `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7`
(`/exec`, updated `2026-08-19T17:57:34Z`):
- `deploymentConfig.versionNumber` = **29** → on **v29** (confirmed).
- `entryPointConfig.access` = **ANYONE_ANONYMOUS** → still true (confirmed).
- `executeAs` = `USER_DEPLOYING`; also has an ADD_ON entry point (add-on).

**Head deployment** `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK` (`/exec`):
- **Exists** (confirmed via `deployments.get`, updateTime `1970-01-01T00:00:00Z`
  = HEAD-style marker).
- `deploymentConfig` has **no versionNumber** → **points at Head** (confirmed).
- `entryPointConfig.access` = **ANYONE_ANONYMOUS**, `executeAs` =
  `USER_DEPLOYING` (confirmed). Also has an ADD_ON entry point.

**Raw probe of the two URLs (no token, unauthenticated GET):**
- Live `/exec` →  200, ~12 KB, Google's `window['ppConfig']` loading wrapper
  (normal pre-handshake first hit).
- Head `/dev` `/exec` → 200, ~940 KB, an `accounts.google.com/v3/signin/` page
  body. This is consistent with the anonymous-handshake redirect that PLAN §0
  documents; can only be judged definitively in a signed-out browser with a
  valid sign link (see §6).

## 3. window.__DOCUPDF_VER__ marker + local/deployed sync

- `SignatureModal.html` line **241** (both local and the served HEAD source)
  still declares: `window.__DOCUPDF_VER__ = 'v26.1';`
- **The bump to `'v26.2'` was NEVER made** — confirmed in local file AND in the
  script's HEAD content via `projects.content` (exactly one occurrence, `'v26.1'`,
  in the deployed SignatureModal source). This is the stale-cache marker that
  feeds the §0b contradiction, and it is still stale.
- **Git**: `git status`/`git log` → *not a git repository* (no `.git`, no commits,
  no branches). There is no commit history to say "ahead/behind".
- **Local vs deployed (HEAD source)**: all **16** project files compare
  **identical** to the script's current saved (HEAD) source — byte-for-byte for
  `SignatureModal.html`, `Code.gs`, `appsscript.json`; identical modulo
  CRLF-only for the other 13. So local ↔ HEAD are **in sync**.
- **Local vs live v29**: the live deployment is pinned to v29 (snapshot taken
  `2026-08-19T17:57:32Z`). No file has been modified/pushed since 19 Aug.
  evening (latest source mtimes: `SignatureModal.html` 19 Aug 23:24, `Code.gs`
  19 Aug 19:28 IST; everything else earlier). Because HEAD == local and nothing
  was pushed after v29 was created, **the deployed v29 content matches local**.
  (v29's exact bytes can't be diffed via API — the versions endpoint returns
  metadata only — but timestamps support it.)
- 16 files at HEAD: `appsscript.json`, `AuditDialog.html`, `CSS_JS_Bundle.html`,
  `Code.gs`, `eSignService.gs`, `eSignTypes.gs`, `ESignWizard.html`,
  `HelpDialog.html`, `InPersonDialog.html`, `pdfSignEngine.gs`,
  `SidebarWizard.html`, `signatureHandler.gs`, `SignatureModal.html`,
  `syncEngine.gs`, `auditStampEngine.gs`, `vendor/pdf-lib-bundle.gs`.

## 4. SignatureModal.html — v26.2 fixes status

All three v26.2 fixes are **present in the deployed (HEAD) source** (local file
is byte-identical to it):

- `compactSignature()` — `SignatureModal.html:344` — downscales canvas to width
  240, white bg, strips `data:` prefix; returns `{base64,width,height}`.
- `submitSignature()` — `:361` — null-guards `sigText`/`sigTextfield`/`sigInitials`
  + canvas; sends the **compact** payload (downscale applied at `:387`).
- `navigateTop(url)` — `:109` — `window.top.location.href` (top-level nav breaks
  out of Google's sandboxed iframe for the anonymous handshake).
- `loadPreview()` — `:130` — **hides the preview frame / card when `pdfB64` is
  empty**: `:134–137` hides `#previewCard` if `!INIT.pdfB64 && !INIT.previewUrl`;
  `:142–150` when only `previewUrl` exists, hides the iframe and shows
  "Preview is unavailable… Use 'Open the document in a new tab' below" (no
  sub-frame `/exec?action=pdf`).
- Decline path uses `navigateTop(buildActionUrl(payload))` (`:411`), Sign too
  (`:395`).
- The **enabled-by-default static buttons** (`btnSubmit`/`btnDecline`) still
  exist; `renderActiveSignature()` (`:191`) builds the fallback single-party
  signing zone when no `.pw-party.active` is present, so an empty/absent
  `INIT.slots` does not throw a null-read (v26.1 fix intact).

**Bottom line for §0b's "stale cached modal" theory:** the served v29 does
contain ALL the v26.2 code paths (compact payload, `navigateTop`, preview hide).
The ONLY stale-bit marker is the `'v26.1'` version string — so the marker
cannot positively prove freshness, but the code is the fixed code.

## 5. appsscript.json scopes

`appsscript.json` (local == HEAD):

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/spreadsheets.currentonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/script.container.ui",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.scriptapp"
]
```

- **`script.scriptapp` is present** (added for installable triggers, Aug 19).
- **No restricted scopes crept in.** Confirmed absent: `drive.readonly`,
  `documents`, `gmail.readonly`, `drive` (full), `gmail.modify`, calendar, etc.
  Scope set is exactly the 7 above → zero-restricted policy still satisfied.
- `webapp` block still declares `"access": "ANYONE_ANONYMOUS"`,
  `"executeAs": "USER_DEPLOYING"` (harmless; clasp ignores it — access lives on
  the deployment, §2 confirmed it's correct on both active deployments).
- `urlFetchWhitelist`: `https://quickchart.io/` + `https://www.googleapis.com/`.

## 6. Blocker status — what has been tested since Aug 19

**Nothing has been tested since the failed Aug 19 evening run.** Evidence:
- All 16 source files were last modified 19 Aug 2026 (SignatureModal 23:24,
  PLAN 23:41 IST) — after that, only `VERSION_CLEANUP.md` (22 Sep, a *plan*,
  not a test) and this report exist. No code/test changes since.
- No git repo, no notes files, no test logs in the project.
- The live deployment is still pinned to v29 with `ANYONE_ANONYMOUS` — the same
  deployment/version tested on Aug 19. The expected "v26.2 marker" bump and the
  planned repin-to-Head (VERSION_CLEANUP.md steps A/C) were **not** performed.

**The /dev-URL question cannot be answered by this probe.** Confirming the real
signer card + PDF preview, or the fallback card, requires:
1. a valid one-time sign link (token + job params) from a live job, and
2. a signed-out (incognito) browser for the anonymous-handshake behavior, or an
   owner-logged-in browser for the /dev test.

That is a human/browser test I cannot perform. Current expected state per PLAN
§0b: modal still shows the **fallback card**, **no PDF preview**, and both
Sign and Decline landing on Google's **"Sorry, unable to open the file at
present."** — because that was the last recorded outcome and nothing has since
been pushed, repinned, or re-tested. Untested theory (PLAN §0b): served page is
stale-cached pre-v26.1; the code now served contains all v26.2 fixes, so a
fresh incognito run on a fresh job is the decisive next data point.

---

## Quick decision-ready summary

- Live /exec = **v29, ANYONE_ANONYMOUS ✓** (unchanged since Aug 19).
- Head deployment = exists, **@HEAD, ANYONE_ANONYMOUS ✓**.
- Version count = **30** (29 was the pre-probe count; my `clasp version` probe
  added an empty v30 — disclosure above).
- Local ↔ deployed = **in sync** (16/16 files match HEAD; live pinned to v29 of
  the same content).
- `__DOCUPDF_VER__` = **still 'v26.1'** — the v26.2 bump was never made.
- v26.2 code fixes = **all present in the served source**.
- Scopes = **7, no restricted ones, `script.scriptapp` present**.
- Blocker = **unreleased/untested;** last test (Aug 19) still failed;
  nothing tested since; VERSION_CLEANUP.md steps A + C from Sep 22 still undone.
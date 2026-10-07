> **Status update (07 Oct 2026):** The plan as written is now partly obsolete.
> - Step A (repin live to Head) — irrelevant, the live deployment is already @HEAD.
> - The version-burn problem is **currently dormant** because the Head deployment is @HEAD (pushes are live, no versions created). If we repoint to v29 (Fix C for the anonymous-access blocker), version burn resumes and Step B cleanup becomes relevant again.
> - Do **not** let any script or AI run clasp undeploy on AKfycbxfcjxpR0an… or AKfycbxNBAD9… — both web-app deployments are load-bearing.
> - Current: 30 versions, 9 deployments, both web-app deployments ANYONE_ANONYMOUS.

# Version Cleanup Plan — DocuPDF Sign

> Noted: Tue Sep 22 2026. Resume after dinner. Goal: stop burning the 200-version cap (currently **29 versions, 9 deployments**) and resume blocker work version-free.

## A. Switch live web app to track Head (do first, ~2 min)

1. Apps Script editor → **Deploy → Manage deployments**.
2. Live deployment `AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7` (desc "DocuPDF Sign web app", version 29) → **Edit** → **Version** dropdown → `Version 29` → **`Head`** → **Deploy**.
3. **Immediately re-check access** (UI edits can silently reset it to MYSELF): must show **Who has access = Anyone** + **Execute as = Me**. Fix if not.
4. Verify `access = ANYONE_ANONYMOUS` via `projects.deployments.get` (or ask opencode to re-run the check).
5. URL stays `https://script.google.com/macros/s/AKfycbxNBAD9…/exec` (editing keeps the ID).

**New workflow after A:**
- Testing = `clasp push` only → zero versions created, live URL updates instantly.
- Versioned `clasp deploy` ONLY for stable releases.
- Rule: ANY edit in Manage-deployments UI → re-verify access before testing.
- Trade-off accepted: pushes change production instantly (fine during debugging; pin back to a fixed version before real users get links).

## B. Cleanup (optional, ~5 min, do right after A so v29 pin is freed)

1. **Manage deployments**: archive the 7 old test deployments (kebab → Archive). Keep only:
   - `AKfycbxNBAD9…` live web app (Head after A)
   - `AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK` @HEAD
   - Archived deployments can be restored later.
2. **Project History** → trash icon (bottom-right) → **Bulk delete versions** → select all except versions pinned by active deployments → Delete. Safe: in-use versions don't appear in the list.
3. Expected: ~2–3 versions remaining (29 → ~3).

## C. Resume blocker work (version-free, after A)

1. Bump `window.__DOCUPDF_VER__` `'v26.1'` → `'v26.2'` in `SignatureModal.html:241` (served v29 still says v26.1 → cache-proof marker).
2. `node --check` touched files → `clasp push` (no deploy).
3. User: fresh job, **incognito** → console `window.__DOCUPDF_VER__ === 'v26.2'` → real Signer card + PDF preview → Sign/Decline → result page.
4. Branch:
   - Works → run PLAN.md §0 regression checklist (decline, mobile, both slots, `currentonly` finalize).
   - Still fallback card → view-source sandbox frame, inspect served `__SIGN__`.
   - Card real but Drive error → own-domain signer-page fallback (PLAN §6).

**Order: A → C → B** (or A → B → C). Never C before A — that burns version 30.

## Context / ground truth

- Blocker chain + full history: `PLAN.md` §0 / §0a / §0b.
- 200-version hard cap per script; at 200 no new versions until bulk-delete (Project History UI only — no API delete).
- Every `clasp deploy` (even `deploy -i`) creates a new version; `clasp push` does not.
- Access is a UI/API setting — `appsscript.json` `webapp.access` is IGNORED by clasp.

# DocuPDF Sign — Setup Guide

> Google Workspace Sheets add-on · Signs **existing PDFs** (invoices, MOUs) by
> overlaying a drawn/typed signature + an audit stamp (SHA-256 hash + QR).
> Config is organised into **E-sign types** (e.g. MOU, Invoice, PO) — one sheet
> can hold many types, each with its own source, row filter, signers and
> schedule. Two source modes: **DocuMail Pro** (links go back into the sheet
> for DocuMail to email) and **Standalone** (DocuPDF emails the sign link itself).

---

## 1. What the add-on does

1. You pick a PDF (or DocuMail generates one) for a row.
2. DocuPDF creates a **signing job** with up to 2 slots (Party A, optional Party B),
   each protected by a **one-time, 7-day sign link**.
3. Each signer clicks their link → sees the PDF (fetched from Drive) → draws/types
   a signature → it is applied to the PDF.
4. When **all slots** are signed, DocuPDF exports `_SIGNED.pdf` to your Drive folder
   with an audit stamp (signers, timestamp, SHA-256 hash, QR) on the last page.
5. The sign link is written into the sheet (`Sign Link - Party A/B`), so DocuMail
   (or you) can embed it in emails. In Standalone mode DocuPDF sends the email itself.

### Optional features (wizard Step 5/7)

- **Signature placement** (Step 5): pick the page (0 = last page), horizontal align,
  and vertical position for each party's signature box.
- **Branding** (Step 7): brand color + logo URL appear on the signer page and in the
  email button/header.
- **Signer text field** (Step 7): ask each signer to also fill a free-text field
  (e.g. "Full name", "Title") which is stamped under their signature.
- **Initials** (Step 7): signer may add optional initials, stamped too.
- **QR in email** (Step 7): the signing link is inlined as a scannable QR code.
- **Reminders** (Step 7): auto re-email pending signers after N days.
- **Sequential signing** (Step 7): Party A signs first, then Party B is emailed.
- **In-person signing** (sidebar "✍️ Sign here"): list a type's pending links on the
  sheet side and open them on a shared device for signing on the spot.
- **Opened tracking** (type config): the sheet shows when a signer first opened the link.
- **Auto-fallback** (reliability): if a row's pasted `Source Doc ID/URL` is unreadable
  under the secure `drive.file` scope, the run automatically signs the type's
  template PDF instead, so the row never silently blocks.

---

## 2. The two modes

| | **DocuMail Pro mode** | **Standalone mode** |
|---|---|---|
| Source PDF | DocuMail's `Merged Doc ID` / `Merged Doc URL` (PDF format) | Your own `Source Doc ID/URL` column (per-row Picker or pasted link) |
| Who emails the sign link | **DocuMail** (DocuPDF writes links to the sheet only) | **DocuPDF** (auto-sends with optional PDF attachment) |
| Auto-sync gate | `Signing Required = Yes` + `Merged Doc Status = Success` | `Signing Required = Yes` + a `Source Doc ID/URL` value |
| Works without DocuMail | No | Yes |

The source mode is chosen **per E-sign type** in the wizard (Step 1); the
default for a new type is auto-detected (DocuMail columns present ⇒ DocuMail
mode).

---

## 3. Sheet layout

### DocuMail Pro mode
```
| …user cols… | Recipient Email | Signing Required (Yes/No) | Merged Doc Status | Merged Doc ID | Merged Doc URL | Sent Mail Status - <T>… | DocuPDF Status | Document Signed | Sign Link - Party A | Sign Link - Party B |
```
- `Signing Required` is inserted **immediately before** `Merged Doc Status`, so the
  DocuMail block stays contiguous regardless of how many templates you add.
- DocuPDF's output columns always live at the **far right**.

### Standalone mode (created by setup)
```
| Signer A Email | Signer A Name | Signer B Email | Signer B Name | DocuPDF Status | Document Signed | Sign Link - Party A | Sign Link - Party B |
```
(These are appended to the right of any columns you already have. There is no
per-row PDF column — the E-sign type's **template PDF** (picked in the wizard,
Step 3 📂 Browse) is the single source for every row, and the signer emails live
in these columns.)

**Standalone signing is manual-pick only:** open the type's **✍️ Sign a row**
dialog from the sidebar, choose a row (Party B dropdown or row number), and the
add-on creates the sign links for that row and emails Party A (and Party B on
sequential/parallel completion). Nothing signs automatically.

**`Document Signed`** is auto-maintained by DocuPDF (no dropdown):
- **blank** — not signed yet
- **`Signed by \<emails\> on \<date\>`** — finalized. A non-empty value locks the row:
  DocuPDF never re-creates a job for it, even if other cells are edited.

> All columns are matched **by header name** at runtime — DocuMail inserting new
> template columns never breaks DocuPDF.

---

## 4. Install & first run

### 4a. Install the add-on
- Publish (or test-install) the add-on into your spreadsheet.
- Open the spreadsheet, then **Extensions → DocuPDF Sign → Open E-sign Engine**.
  Authorize when prompted. Scopes used: `spreadsheets.currentonly`,
  `drive.file`, `gmail.send`, `script.container.ui`, `userinfo.email`,
  `script.external_request`. No restricted scopes.

### 4b. Run Setup (once per sheet)
1. **Menu → Setup Sheet (columns)** (or **Install / Setup columns**). This creates/maps
   the columns above and adds the **Yes/No dropdown** to `Signing Required`.
2. Re-open the sidebar — the setup status is shown at the top.

### 4c. Create an E-sign type (the config lives in the modal)
The sidebar is intentionally minimal (like DocuMail Pro): it lists your
E-sign types with **Edit / Run / Pause / Delete** and a **➕ Create New E-sign**
button. All configuration happens in a **step-by-step wizard modal**:

| Step | What you set |
|---|---|
| **1 · Name & Type** | Sheet, E-sign name, source mode (DocuMail Pro / Standalone) |
| **2 · Rows/Filter** | Which rows this type applies to (filter column + keyword), e.g. PO vs Invoice vs MOU rows on one sheet |
| **3 · Signers** | Signing Required column, Party A/B email + name columns, Doc name column |
| **4 · Output & Links** | Sign Link - Party A/B columns, Status column, Document Signed column, signed-PDFs folder |
| **5 · Email** | Standalone only — subject/body + placeholders. DocuMail mode shows an info note (DocuMail emails) |
| **6 · Schedule** | Manual, or every 5 / 15 / 60 / 360 / 720 / 1440 minutes |

### 4d. Enable auto-sync (recommended)
- **Menu → Enable Auto-sync** (or the sidebar). This installs an `onEdit`
  trigger (fast path) + a 1-minute safety-net trigger. Each enabled, scheduled
  type runs on its own interval; **▶️ Run** on a card syncs one type immediately.
  Idempotent — a row is never processed twice.

### 4e. Per-row usage
- **DocuMail mode**: after DocuMail merges a row (Status = Success), set
  **Signing Required = Yes**. DocuPDF creates the job, writes the links, and
  DocuMail's template references the `Sign Link` columns.
- **Standalone**: set **Signing Required = Yes**, then paste a Drive link/id into
  `Source Doc ID/URL` (a per-row Google Picker is available in the wizard's PDF
  flow) — the job is created automatically.
- **One-off / manual**: run the type, or create a job directly.

---

## 5. The signer experience

- Signer opens the tokenized link → a page shows the **PDF preview** + a
  signature canvas (mouse/touch) or typed name.
- **No Google account required.** The signer page is a token-gated web app
  deployed as **Anyone with link, Execute as: Me**. The PDF preview is served
  by the web app itself (`?action=pdf` returns the PDF bytes, gated by the same
  one-time token) and rendered as a `data:` URL — the signer never needs Drive
  access or sharing.
- **Sign & Finalize**: single party → finalized immediately; two parties → the
  second signature triggers finalization automatically. Submissions go through
  the web app's `doPost` JSON API (`fetch`), not `google.script.run`, so they
  work for anonymous signers too.
- **Decline to sign** is supported (job status flips to `Declined`).
- **Race-safe**: signature commit + finalization are serialized with
  `LockService` (script lock) — two near-simultaneous signers cannot both
  finalize, and the one-time token is re-checked inside the lock.
- After signing, `_SIGNED.pdf` appears in the signed-PDFs folder (auto-created if
  unset), and `DocuPDF Status` updates to a "Signed on …" timestamp.

---

## 6. Audit trail

Every event (Setup, Job, Share, Dispatch, Sign, Decline, Finalize) is written to
the **AuditLog** sheet (menu **View Audit Logs**). The `_SIGNED.pdf` carries a
SHA-256 hash of the signed content, signer emails, and timestamp in the QR stamp.

---

## 7. Operational notes & constraints

- **Drive preview sharing**: DocuPDF shares the source PDF "anyone with the
  link, view only" so signers can preview it. This is no longer required for
  the signing flow — the web app serves the PDF bytes itself to the token-gated
  modal — but sharing is kept on by default as a convenience fallback (e.g.
  DocuMail embedding the file elsewhere). Disable via config
  (`shareSourcePdf: false` in Script Properties) if you manage sharing manually.
- **DocuMail PDF mode only**: source must be a PDF (`.doc` merges are skipped with
  a `Blocked` note).
- **Blocked rows**: if DocuPDF can't open the PDF or a signer email is missing, it
  writes `Blocked: <reason>` to `DocuPDF Status`. Fix the row and it retries on
  the next scan.
- **Links expire after 7 days** (single use).
- **Marketplace publishing**: each add-on requires its own test spreadsheet during
  submission; in production both add-ons install on the same sheet.

---

## 8. Files

| File | Purpose |
|---|---|
| `eSignTypes.gs` | **E-sign type registry** (multi-type CRUD, sidebar refresh signal, wizard opener) |
| `Code.gs` | Menu, setup, job creation, config, email dispatch, token registry, web-app `doGet`/`doPost` JSON API (`action=sign|decline|pdf`) |
| `syncEngine.gs` | Multi-type auto-sync: `SYNC_ALL_TYPES`, `SYNC_TYPE`, `ON_EDIT`, `ON_SCHEDULED_SYNC`, `ENABLE/DISABLE_AUTO_SYNC` |
| `pdfSignEngine.gs` | PDF overlay engine (reconstruct, probe, draw) using vendored pdf-lib |
| `vendor/pdf-lib-bundle.gs` | Bundled pdf-lib (global `PDFLibBundle`) |
| `signatureHandler.gs` | Signature placement, finalization, sheet status updates |
| `auditStampEngine.gs` | Audit metadata (SHA-256 + QR), audit log |
| `eSignService.gs` | External provider (Lumin) payload preparation |
| `SidebarWizard.html` | Minimal sidebar: E-sign type cards + Create/Edit/Run/Pause/Delete |
| `ESignWizard.html` | Step-by-step config modal (6 steps: name/type, rows/filter, signers, output, email, schedule) |
| `SignatureModal.html` | Signer page (token-gated web app; byte-served PDF preview + signature canvas; posts via `doPost` JSON API) |
| `CSS_JS_Bundle.html` | Shared styles/helpers (included via `include()`) |
| `appsscript.json` | Manifest (scopes, whitelist, homepage triggers) |

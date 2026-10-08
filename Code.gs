/** file name: Code.gs */

/**
 * DocuPDF Sign — entry point (menu, sidebar, modal, web-app launcher).
 * PDF-overlay signing of existing PDFs (invoice / MOU). Two-party slot model.
 * Zero restricted scopes; token-gated web app per PLAN.md section 0b-A.
 */

var APP_NAME = 'DocuPDF Sign';
var CONFIG_KEY = 'DOCUPDF_SIGN_PRO_CONFIG';
var SHEET_MODE_KEY = 'DOCUPDF_MODE_';
var JOB_PREFIX = 'DPD_JOB_';
var JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day expiry

// Largest source PDF we inline as base64 for a pdf.js preview. Base64 inflates
// by 4/3 and the whole payload rides in one HtmlService response, so this sits
// well under that ceiling. Everything at or below it is previewed privately,
// with no Google account required at any point — which is what lets a
// non-Google recipient open the link in a private/incognito window.
// Above it we cannot inline, so the preview falls back to Drive.
var PREVIEW_INLINE_MAX_BYTES = 20 * 1024 * 1024;

// Base URL of this script's web app. ScriptApp.getService().getUrl() returns
// empty/null when called from the container (dialog/sidebar), so sign links
// must be built from a known-good absolute URL.
//
// The live deployment AKfycbxfcjxpR0anZjAq0x4gRKRTYfxVBg7pU456uYsH0yKK is
// pinned to @HEAD and executes as Me, so every `clasp push` goes live at once —
// there is no staging step and no need to redeploy after pushing.
//
// "Who has access" MUST be Anyone (anonymous). Anything else — Only myself, or
// "Anyone with a Google account" — makes script.google.com answer 302 to
// accounts.google.com/ServiceLogin before any of this code runs, which locks
// out every recipient without a Google account. Verified with:
//   curl -i --max-redirs 0 "<this URL>?job=..&signToken=..&nonce=.."
// A working deployment returns 200 with HTML.
//
// The Head deployment AKfycbxfcjxpR0an… has a known-broken anonymous-access
// enforcement: the Apps Script API reports ANYONE_ANONYMOUS, but anonymous HTTP
// GETs return 302 → accounts.google.com/ServiceLogin. Verified twice (07 Oct
// 2026). The v29 deployment AKfycbxNBAD9… enforces anonymous access correctly —
// an unauthenticated GET reaches doGet and returns HTML. We pin WEB_APP_BASE_URL
// to v29 deliberately. Any future change to the signer page requires a new
// version deploy to v29. Do not revert this to the Head URL without re-testing
// anonymous access.
var WEB_APP_BASE_URL = 'https://script.google.com/macros/s/AKfycbxNBAD9NbHh2-lcrEVg5t90oKd0-YOtV2Nxt5Z9Bou4MVx9zbK4W9Wb7I9z9dCaDCb7/exec';

/**
 * Returns the script's web-app base URL. Prefers ScriptApp.getService().getUrl()
 * when it resolves to a real script.google.com URL; otherwise falls back to
 * WEB_APP_BASE_URL (container context returns empty/null for getUrl()).
 */
function _serviceBaseUrl() {
  // ALWAYS use the dedicated web-app deployment. ScriptApp.getService().getUrl()
  // returns the add-on's test-install URL in this hybrid add-on+webapp project,
  // which does NOT serve as a web app (signers get a Drive error page). The
  // constant is the @HEAD deployment, execute-as-Me, access=Anyone.
  return WEB_APP_BASE_URL;
}

/**
 * Opens a spreadsheet by id WITHOUT requiring the full `spreadsheets` scope.
 * Under `spreadsheets.currentonly` (the add-on's scope), openById(id) is not
 * authorized even for the bound spreadsheet; the ACTIVE spreadsheet is, so we
 * use it whenever the ids match. Falls back to openById for non-active sheets.
 * @param {string} id
 * @return {Spreadsheet|null}
 */
function _openSpreadsheet(id) {
  if (!id) return null;
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active && active.getId() === String(id)) {
      return active;
    }
  } catch (e) {
    // not in a container context; fall through to openById
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    Logger.log('_openSpreadsheet error for %s: %s', id, e.message);
    return null;
  }
}

/**
 * Public entry functions follow SCREAMING_CASE convention (see PLAN.md).
 */

function onOpen(e) {
  try {
    var ui = SpreadsheetApp.getUi();
    var menu = ui.createMenu(APP_NAME);
    menu.addItem('Open E-sign Engine', 'OPEN_ESIGN_ENGINE');
    menu.addSeparator();
    menu.addItem('Setup Sheet (columns)', 'RUN_SETUP_MENU');
    menu.addSeparator();
    menu.addItem('View Audit Logs', 'VIEW_AUDIT_LOGS');
    menu.addItem('Delete Audit Log', 'DELETE_AUDIT_LOG');
    menu.addSeparator();
    menu.addItem('? Help', 'SHOW_HELP');
    menu.addToUi();
  } catch (err) {
    Logger.log('onOpen error: %s', err.message);
  }
}

/** Menu wrapper: runs SETUP_SHEET then reports the result. */
function RUN_SETUP_MENU() {
  var res = SETUP_SHEET();
  var ui = SpreadsheetApp.getUi();
  if (res.ok) {
    var modeLabel = (res.sheetMode === 'manual')
      ? '✍️ Manual (one document per row)'
      : '🔄 Automatic (one template for all rows)';
    ui.alert('✅ DocuPDF Sign — Setup complete\n\n' +
      'Mode: ' + modeLabel + '\n' +
      (res.added.length ? '\n📊 Columns added:\n   ' + res.added.join(', ') + '\n' : '') +
      '\n▶️ Open the E-sign Engine to create your first E-sign.');
  } else if (res.cancelled) {
    ui.alert('Setup cancelled.');
  } else {
    ui.alert('Setup failed: ' + (res.error || 'unknown error'));
  }
}

function onInstall(e) {
  onOpen(e);
}

function ON_HOMEPAGE(e) {
  try {
    return _buildHomeCard(e);
  } catch (err) {
    Logger.log('ON_HOMEPAGE error: %s', err.message);
    return CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle(APP_NAME))
      .addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText('Error: ' + err.message)))
      .build();
  }
}

function ON_SHEETS_HOMEPAGE(e) {
  return ON_HOMEPAGE(e);
}

function ON_FILE_SCOPE_GRANTED(e) {
  try {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(_buildHomeCard(e)))
      .build();
  } catch (err) {
    Logger.log('ON_FILE_SCOPE_GRANTED error: %s', err.message);
  }
}

function _buildHomeCard(e) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle(APP_NAME)
      .setSubtitle('Sign existing PDFs (invoices, MOUs) with an audit stamp')
      .setImageUrl('https://apps.pwmai.com/wp-content/uploads/docupdf-sign-pro-logo.png'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText('Open the E-sign Engine to select a PDF, define up to two signature slots, and dispatch signing links.'))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Open E-sign Engine')
          .setOnClickAction(CardService.newAction().setFunctionName('OPEN_ESIGN_ENGINE'))
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('View Audit Logs')
          .setOnClickAction(CardService.newAction().setFunctionName('VIEW_AUDIT_LOGS')))))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText('🔒 Data stays in your Google Workspace.')))
    .build();
}

function OPEN_ESIGN_ENGINE() {
  try {
    if (!_ensureInitiatedOrPrompt()) {
      return;
    }
    var html = HtmlService.createHtmlOutputFromFile('SidebarWizard')
      .setTitle(APP_NAME + ' — E-sign Engine')
      .setWidth(360);
    SpreadsheetApp.getUi().showSidebar(html);
  } catch (err) {
    Logger.log('OPEN_ESIGN_ENGINE error: %s', err.message);
    SpreadsheetApp.getUi().alert('Could not open the sidebar: ' + err.message);
  }
}

/**
 * Checks whether the spreadsheet has been initiated (DocuPDF/DocuMail columns
 * present). If not, asks the user whether to run Setup now — and does so when
 * they agree. Used by "Open E-sign Engine" and "Create New E-sign".
 * @return {Boolean} true when the user may continue.
 */
function _ensureInitiatedOrPrompt() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ui = SpreadsheetApp.getUi();
    var st = _setupInitiatedState(ss);
    if (!st.ok) {
      ui.alert('Could not check the sheet setup: ' + (st.error || 'unknown error'));
      return false;
    }
    if (st.initiated) {
      return true;
    }
    var resp = ui.alert(
      'E-sign is not initiated yet.\n\n' +
      'Do you want to initiate it now?\n' +
      '(DocuPDF will add the columns it needs to the "' + st.sheetName + '" sheet.)',
      ui.ButtonSet.YES_NO
    );
    if (resp !== ui.Button.YES) {
      return false;
    }
    var res = SETUP_SHEET();
    if (!res.ok) {
      ui.alert(res.cancelled ? 'Setup cancelled.' : 'Setup failed: ' + (res.error || 'unknown error'));
      return false;
    }
    return true;
  } catch (err) {
    Logger.log('_ensureInitiatedOrPrompt error: %s', err.message);
    return false;
  }
}

/**
 * True when the target data sheet already carries DocuPDF or DocuMail columns.
 * @return {Object} { ok, initiated, documail, sheetName, error? }
 */
function _setupInitiatedState(ss) {
  try {
    var sheet = _setupTargetSheet(ss);
    if (!sheet) {
      return { ok: true, initiated: false, documail: false, sheetName: '' };
    }
    var lastCol = sheet.getLastColumn();
    var lower = [];
    if (lastCol >= 1) {
      lower = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
        return String(h).trim().toLowerCase();
      });
    }
    var docuPDFCols = ['signing required', 'signer a email', 'docupdf status', 'sign link - party a', 'source doc id/url'];
    var documailCols = ['merged doc status', 'merged doc id', 'merged doc url', 'recipient email'];
    var hasDocuPDF = lower.some(function (h) { return docuPDFCols.indexOf(h) !== -1; });
    var hasDocuMail = lower.some(function (h) { return documailCols.indexOf(h) !== -1; });
    return {
      ok: true,
      initiated: hasDocuPDF || hasDocuMail,
      documail: hasDocuMail,
      sheetName: sheet.getName()
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function VIEW_AUDIT_LOGS() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var audit = ss.getSheetByName('AuditLog') || _ensureAuditSheet(ss);
    _protectAuditSheet(audit);
    audit.activate();
    SpreadsheetApp.getUi().alert('Audit Log sheet opened. Every job, dispatch, sign and finalize is recorded here.\n\nThe sheet is read-only (protected).');
  } catch (err) {
    Logger.log('VIEW_AUDIT_LOGS error: %s', err.message);
  }
}

/**
 * Deletes the AuditLog sheet (and its protection). It is re-created lazily on
 * the next audit event, so this is a safe "start fresh" — no history is lost
 * beyond the audit trail itself.
 */
function DELETE_AUDIT_LOG() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var audit = ss.getSheetByName('AuditLog');
    if (!audit) {
      SpreadsheetApp.getUi().alert('No Audit Log sheet exists.');
      return;
    }
    var ui = SpreadsheetApp.getUi();
    var resp = ui.alert(
      'Delete the Audit Log sheet?\n\nThis deletes the entire audit trail (' +
      Math.max(0, audit.getLastRow() - 1) + ' logged events).\n\nIt will be re-created automatically next time an event is recorded.',
      ui.ButtonSet.YES_NO
    );
    if (resp !== ui.Button.YES) {
      return;
    }
    var prots = audit.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots.length; i++) {
      try { prots[i].remove(); } catch (e) { Logger.log('DELETE_AUDIT_LOG protect remove: %s', e.message); }
    }
    ss.deleteSheet(audit);
    SpreadsheetApp.getUi().alert('Audit Log sheet deleted.');
  } catch (err) {
    Logger.log('DELETE_AUDIT_LOG error: %s', err.message);
    SpreadsheetApp.getUi().alert('Could not delete the Audit Log: ' + err.message);
  }
}

function SHOW_HELP() {
  try {
    var html = HtmlService.createHtmlOutputFromFile('HelpDialog')
      .setTitle(APP_NAME + ' — Help')
      .setWidth(480)
      .setHeight(560);
    SpreadsheetApp.getUi().showModalDialog(html, APP_NAME + ' — Help');
  } catch (err) {
    Logger.log('SHOW_HELP error: %s', err.message);
    SpreadsheetApp.getUi().alert('Help is unavailable right now: ' + err.message);
  }
}

function _ensureAuditSheet(ss) {
  var audit = ss.insertSheet('AuditLog');
  audit.appendRow(['Timestamp', 'Event', 'DocId', 'DocName', 'Hash', 'Signer', 'Status', 'Details']);
  audit.setFrozenRows(1);
  audit.setColumnWidth(1, 180);
  _protectAuditSheet(audit);
  return audit;
}

/** Locks the AuditLog sheet so only the owner can edit it. */
function _protectAuditSheet(audit) {
  try {
    if (!audit) return;
    var proto = audit.protect();
    proto.setDescription('AuditLog — read-only (DocuPDF Sign)');
    var editors = proto.getEditors();
    if (editors && editors.length) {
      proto.removeEditors(editors);
    }
  } catch (err) {
    Logger.log('_protectAuditSheet error: %s', err.message);
  }
}

/**
 * Web-app launcher (execute-as-ME). Token-gated: serves the signer modal only
 * after a valid one-time token + nonce + freshness check. Identifies which
 * signature SLOT the token belongs to.
 *
 * Routes (via the `action` query parameter):
 *   - (none)        : serve the signer modal (SignatureModal.html).
 *   - action=pdf    : serve the source PDF bytes (application/pdf) so an
 *                     anonymous signer can preview WITHOUT any Drive access.
 */
function doGet(e) {
  try {
    _ensureSignerTriggersInstalled();
    if (!e || !e.parameter) {
      return _renderErrorPage('Missing request parameters.');
    }
    if (e.parameter.action === 'pdf') {
      return _servePdf(e);
    }
    if (e.parameter.action === 'verify') {
      return _handleVerify(e);
    }
    // Signing/decline run over GET, not POST: Apps Script web-app POSTs
    // redirect through script.googleusercontent.com/macros/echo which is
    // currently unreliable (404). GET responses are served directly.
    if (e.parameter.action === 'sign') {
      return _handleSignGet(e);
    }
    if (e.parameter.action === 'decline') {
      return _handleDeclineGet(e);
    }

    var jobId = e.parameter.job;
    var signToken = e.parameter.signToken;
    var nonce = e.parameter.nonce;

    if (!jobId || !signToken || !nonce) {
      return _renderErrorPage('Missing signature request parameters.');
    }

    var state = _validateSigningToken(jobId, signToken, nonce);
    if (!state.valid) {
      return _renderErrorPage(state.reason || 'This signature link is invalid or expired.');
    }

    // B3: first-open tracking (audit + per-signer status marker, best-effort).
    // Serialized with the script lock: this is a read-modify-write of the job
    // record, and an unlocked save here can clobber a `signedAt` / `sigFileId`
    // that PLACE_SIGNATURE_ON_PDF wrote under the lock at the same moment.
    // Best-effort: a lock timeout must not block the signer from seeing the page.
    if (!state.slot.openedAt) {
      var openLock = LockService.getScriptLock();
      var openNote = '';
      try {
        try {
          openLock.waitLock(20000);
        } catch (lockErr) {
          openNote = ' (lock busy: ' + lockErr.message + ')';
          throw lockErr;
        }
        // Re-read INSIDE the lock — the record may have changed while waiting.
        var fresh = _getJobRecord(jobId);
        var slotState = fresh ? _validateSigningToken(jobId, signToken, nonce) : null;
        if (fresh && slotState && slotState.valid && !slotState.slot.openedAt) {
          fresh.slots[slotState.slotIndex].openedAt = new Date().toISOString();
          _saveJobRecord(fresh);
          _updateSignerStatus(fresh, slotState.slotIndex, 'Opened ' + _slotStamp());
          LOG_AUDIT_EVENT('OPEN', {
            docId: jobId,
            docName: fresh.docName,
            signer: slotState.slot.signerEmail || '',
            status: 'Opened',
            spreadsheetId: fresh.spreadsheetId,
            details: 'Sign link opened by ' + (slotState.slot.signerEmail || 'a signer') + '. Slot ' + slotState.slot.slot + ' (' + slotState.slot.label + ').'
          });
          if (fresh.signing && fresh.signing.trackOpens) {
            _updateSheetStatus(fresh, 'Opened ' + _slotStamp());
          }
        }
      } catch (openErr) {
        Logger.log('doGet opened-marker warning%s: %s', openNote, openErr.message);
      } finally {
        try {
          openLock.releaseLock();
        } catch (relErr) {
          Logger.log('doGet opened-marker release warning: %s', relErr.message);
        }
      }
    }

    var slot = state.slot;
    var serviceUrl = _serviceBaseUrl();

    // Embed the source PDF as base64 so the anonymous signer can preview it
    // WITHOUT a fetch() to /exec (anonymous sessions don't propagate to XHR;
    // each fetch gets the session interstitial). doGet itself is a top-level
    // navigation that provably completes the anonymous handshake.
    var pdfB64 = '';
    var pdfNote = '';
    if (state.record.sourcePdfId) {
      try {
        var pr = _driveReadPdf(state.record.sourcePdfId);
        if (pr.ok && pr.bytes) {
          if (pr.bytes.length <= 8 * 1024 * 1024) {
            pdfB64 = Utilities.base64Encode(pr.bytes);
          } else {
            pdfNote = 'This document is too large to preview here. Open the copy attached to your signing email — no Google account needed.';
          }
        } else {
          pdfNote = 'Preview unavailable: ' + (pr.error || 'could not read the document.');
        }
      } catch (e) {
        pdfNote = 'Preview unavailable: ' + e.message;
      }
    }

    var html = HtmlService.createTemplateFromFile('SignatureModal').evaluate()
      .setTitle('Sign Document')
      .setWidth(420)
      .setHeight(560)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    html.append('<script>window.__SIGN__ = ' + JSON.stringify({
      serviceUrl: serviceUrl,
      jobId: jobId,
      signToken: signToken,
      nonce: nonce,
      slotLabel: slot.label || '',
      signerEmail: slot.signerEmail || '',
      signerName: slot.signerName || '',
      signerDesignation: slot.signerDesignation || '',
      docName: state.record.docName || 'your document',
      brandColor: (state.record.brand && state.record.brand.brandColor) || '#1a73e8',
      logoUrl: (state.record.brand && state.record.brand.logoUrl) || '',
      companyName: (state.record.email && state.record.email.companyName) || '',
      textFieldLabel: (state.record.signing && state.record.signing.textFieldLabel) || '',
      initialsEnabled: !(state.record.signing && state.record.signing.initialsEnabled === false),
      slots: state.record.slots.map(function (s) {
        return {
          slot: s.slot,
          label: s.label || '',
          signerName: s.signerName || '',
          signerEmail: s.signerEmail || '',
          signerDesignation: s.signerDesignation || '',
          signed: !!s.signedAt,
          current: (s.slot === slot.slot)
        };
      }),
      previewUrl: state.record.sourcePdfId
        ? (serviceUrl +
          '?action=pdf&job=' + encodeURIComponent(jobId) +
          '&signToken=' + encodeURIComponent(signToken) +
          '&nonce=' + encodeURIComponent(nonce))
        : '',
      pdfB64: pdfB64,
      pdfNote: pdfNote
    }) + '</script>');
    return html;
  } catch (err) {
    Logger.log('doGet error: %s', err.message);
    return _renderErrorPage('Unexpected error while loading the signing page.');
  }
}

/**
 * doPost — anonymous-capable JSON API for the signer modal.
 * Body: { action: 'sign'|'decline', ...payload } (JSON, sent as text/plain to
 * skip the CORS preflight that Apps Script cannot answer). Reuses the existing
 * token validation; transport is fetch() -> doPost instead of google.script.run.
 */
async function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      try { payload = JSON.parse(e.postData.contents); } catch (err) { payload = {}; }
    }
    var action = payload.action || (e.parameter && e.parameter.action) || '';
    var result;
    if (action === 'sign') {
      result = await PLACE_SIGNATURE_ON_PDF(payload);
    } else if (action === 'decline') {
      result = DECLINE_SIGNING_REQUEST(payload);
    } else {
      result = { ok: false, error: 'Unknown action: ' + action };
    }
    return _jsonResponse(result);
  } catch (err) {
    Logger.log('doPost error: %s', err.message);
    return _jsonResponse({ ok: false, error: err.message });
  }
}

/**
 * GET-based signing. The modal submits by navigating (window.location) to this
 * route, NOT by fetch(): anonymous Apps Script sessions don't propagate to XHR
 * (every fetch returns the session interstitial), while top-level navigations
 * complete the handshake reliably. Returns an HTML result page.
 */
function _handleSignGet(e) {
  var p = e.parameter || {};
  var jobId = p.jobId || '';
  var signToken = p.signToken || '';
  var nonce = p.nonce || '';
  var base64 = p.base64 || '';
  var width = Number(p.width) || 480;
  var height = Number(p.height) || 160;
  var signerEmail = p.signerEmail || '';
  var signerName = p.signerName || '';
  var textValue = p.textValue || '';
  var initials = p.initials || '';

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return _renderActionResult(false, 'Could not authenticate',
      '<p>' + _esc('The system is busy. Please try again in a moment.') + '</p>');
  }
  try {
    var state = _validateSigningToken(jobId, signToken, nonce);
    if (!state.valid) {
      return _renderActionResult(false, 'Could not authenticate',
        '<p>' + _esc(state.reason || 'Invalid or expired link.') + '</p>');
    }
    var record = _getJobRecord(jobId);
    var slot = null;
    for (var i = 0; i < (record.slots || []).length; i++) {
      var s = record.slots[i];
      if (s.signToken === signToken && s.nonce === nonce && !s.used && s.status === 'pending') {
        slot = s;
        break;
      }
    }
    if (!slot) {
      return _renderActionResult(false, 'Could not authenticate',
        '<p>' + _esc('This signature link is no longer valid.') + '</p>');
    }
    slot.status = 'signed_pending';
    slot.signatureBase64 = base64;
    slot.width = width;
    slot.height = height;
    if (signerName) {
      slot.signerName = signerName;
    }
    if (textValue) {
      slot.textValue = textValue;
    }
    if (initials) {
      slot.initials = initials;
    }
    slot.submittedAt = new Date().toISOString();
    _saveJobRecord(record);
    // The stamp is applied by the trigger (PLACE_SIGNATURE_ON_PDF), not here.
    _updateSignerStatus(record, slot.slot - 1, 'Signing…');
    return _renderActionResult(true, 'Signature received',
      '<p>Your signature has been recorded. The document will be finalized shortly — this page will refresh automatically.</p>', 6);
  } catch (err) {
    Logger.log('_handleSignGet error: %s', err.message);
    return _renderActionResult(false, 'Signing failed', '<p>' + _esc(err.message) + '</p>');
  } finally {
    lock.releaseLock();
  }
}

function _handleDeclineGet(e) {
  try {
    var p = e.parameter || {};
    var reason = String(p.reason || '').replace(/\r?\n/g, ' ').trim();
    if (!reason) {
      return _renderActionResult(false, 'Decline reason required',
        '<p>A reason is required to decline this document. Open your signing link again and add a reason.</p>');
    }
    var payload = {
      action: 'decline',
      jobId: p.jobId || '',
      signToken: p.signToken || '',
      nonce: p.nonce || '',
      signerEmail: p.signerEmail || '',
      reason: reason
    };
    var result = DECLINE_SIGNING_REQUEST(payload);
    if (result && result.ok) {
      return _renderActionResult(true, 'Signature request declined',
        '<p>You have declined to sign this document. The requester has been notified.</p>' +
        '<p>Reason: ' + _esc(reason) + '</p>');
    }
    return _renderActionResult(false, 'Could not process the decline',
      '<p>' + _esc((result && result.error) || 'Unknown error.') + '</p>');
  } catch (err) {
    Logger.log('_handleDeclineGet error: %s', err.message);
    return _renderActionResult(false, 'Decline failed', '<p>' + _esc(err.message) + '</p>');
  }
}

function _jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Standalone (no PWAI dependency) result page for the signer. Rendered after a
 * sign/decline top-level navigation — it must work for anonymous users.
 */
function _renderActionResult(ok, title, bodyHtml, refreshSeconds) {
  var color = ok ? '#188038' : '#d93025';
  var mark = ok ? '&#10003;' : '&#10007;';
  var meta = (refreshSeconds && refreshSeconds > 0)
    ? '<meta http-equiv="refresh" content="' + refreshSeconds + '">'
    : '';
  return HtmlService.createHtmlOutput()
    .setTitle('DocuPDF Sign')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .append(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + meta +
      '<style>body{font-family:Roboto,Arial,sans-serif;background:#f8f9fa;margin:0;padding:16px;color:#202124}' +
      '.card{max-width:560px;margin:24px auto;background:#fff;border:1px solid #dadce0;border-radius:8px;padding:24px}' +
      '.mark{font-size:40px;font-weight:700;color:' + color + ';text-align:center}' +
      'h1{font-size:18px;text-align:center;margin:8px 0 12px}' +
      '.body{font-size:14px;line-height:1.6;color:#5f6368;word-break:break-word}' +
      'code{background:#f1f3f4;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}' +
      '.pw-btn{display:inline-block;margin-top:12px;padding:10px 18px;border-radius:6px;background:#1a73e8;color:#fff;text-decoration:none;font-weight:500}' +
      '</style></head><body><div class="card">' +
      '<div class="mark">' + mark + '</div>' +
      '<h1>' + _esc(title) + '</h1>' +
      '<div class="body">' + bodyHtml + '</div></div></body></html>'
    );
}

/**
 * Backs the signer's "Open in a new tab" preview link. Token-gated like the
 * modal, so an anonymous signer needs no Google account and no Drive access.
 *
 * Up to PREVIEW_INLINE_MAX_BYTES it renders the same token-gated pdf.js
 * canvas viewer as the modal (PdfViewerPage.html) from bytes the app already
 * has — the source PDF stays PRIVATE and no Google account is ever required,
 * which is what makes this safe for recipients without a Gmail address.
 * Above that size the base64 payload is impractical, so it defers to
 * _oversizePreview: the Drive viewer if the job holds a public link, else a
 * plain page pointing at the copy attached to the signing email.
 */
function _servePdf(e) {
  try {
    var state = _validateSigningToken(e.parameter.job, e.parameter.signToken, e.parameter.nonce);
    if (!state.valid) {
      return _renderPdfText(state.reason || 'Forbidden');
    }
    if (!state.record.sourcePdfId) {
      return _renderPdfText('No source PDF on record.');
    }
    var meta = _driveFetchMeta(state.record.sourcePdfId);
    var size = Number(meta && meta.size) || 0;
    if (size && size > PREVIEW_INLINE_MAX_BYTES) {
      return _oversizePreview(state.record, state.record.sourcePdfId, size);
    }
    var pr = _driveReadPdf(state.record.sourcePdfId);
    if (!pr.ok || !pr.bytes || !pr.bytes.length) {
      return _renderPdfText('Preview unavailable: ' + (pr.error || 'could not read the document.'));
    }
    if (pr.bytes.length > PREVIEW_INLINE_MAX_BYTES) {
      return _oversizePreview(state.record, state.record.sourcePdfId, pr.bytes.length);
    }
    return HtmlService.createHtmlOutputFromFile('PdfViewerPage')
      .setTitle('Document preview')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .append('<script>window.__PDF_PAGE__ = ' + JSON.stringify({
        docName: state.record.docName || 'Document',
        pdfB64: Utilities.base64Encode(pr.bytes)
      }) + ';</script>');
  } catch (err) {
    Logger.log('_servePdf error: %s', err.message);
    return _renderPdfText('Preview unavailable: ' + err.message);
  }
}

/**
 * Preview page for documents too large to inline as base64.
 *
 * Only redirects to the Drive viewer when the job actually holds a public
 * link (record.previewShareOk). Otherwise it MUST NOT bounce the browser at
 * drive.google.com: an unshared file lands the signer on a Google sign-in
 * wall, which is a dead end for recipients who have no Google account — the
 * exact case this app is built for. In that case we say plainly what to do:
 * open the copy attached to the signing email.
 * @param {Object} record job record
 * @param {string} fileId Drive file id of the source PDF
 * @param {number} sizeBytes measured size, for the message
 * @return {HtmlOutput}
 */
function _oversizePreview(record, fileId, sizeBytes) {
  var mb = Math.max(1, Math.round((Number(sizeBytes) || 0) / (1024 * 1024)));
  var limitMb = Math.round(PREVIEW_INLINE_MAX_BYTES / (1024 * 1024));
  var name = record.docName || 'this document';
  var head =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Large document</title></head><body ' +
    'style="font-family:Arial,sans-serif;background:#f1f3f4;margin:0;padding:32px 16px">' +
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #dadce0;' +
    'border-radius:8px;padding:24px">' +
    '<h2 style="margin:0 0 12px;font-size:18px;color:#202124">' +
    'This document is too large to preview here</h2>' +
    '<p style="color:#3c4043;font-size:14px;line-height:1.6;margin:0 0 12px">' +
    '"' + name + '" is about ' + mb + ' MB, and in-app preview supports up to ' +
    limitMb + ' MB. Nothing is wrong with the document or your link.</p>';

  if (record.previewShareOk) {
    var fileUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
    Logger.log('_oversizePreview: %s over cap, public link held — sending to Drive', fileId);
    return HtmlService.createHtmlOutput(
      head +
      '<p style="color:#3c4043;font-size:14px;line-height:1.6">Opening it in Google Drive&hellip;</p>' +
      '<p style="font-size:13px"><a href="' + fileUrl + '">Click here if it does not open.</a></p>' +
      '</div></body></html>'
    ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
     .addMetaTag('viewport', 'width=device-width, initial-scale=1')
     .append('<script>window.top.location.href=' + JSON.stringify(fileUrl) + ';</script>');
  }

  Logger.log('_oversizePreview: %s over cap and no public link — offering the email attachment', fileId);
  return HtmlService.createHtmlOutput(
    head +
    '<p style="color:#3c4043;font-size:14px;line-height:1.6;margin:0 0 14px">' +
    '<strong>Open the PDF that came with your signing email</strong> — the same document is ' +
    'attached to it, and you do not need a Google account to read it.</p>' +
    '<p style="color:#5f6368;font-size:13px;line-height:1.6;margin:0">' +
    'If the attachment is missing, reply to that email and request it again.</p>' +
    '</div></body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _renderPdfText(message) {
  return HtmlService.createHtmlOutput()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .append(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font-family:Roboto,Arial,sans-serif;background:#f8f9fa;color:#3c4043;margin:0;padding:24px">' +
      '<p>' + message + '</p></body></html>');
}

function _renderErrorPage(message) {
  return HtmlService.createHtmlOutput()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .append(
      '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:Roboto,Arial,sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#3c4043}' +
      '.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(60,64,67,.3);padding:32px;max-width:420px;text-align:center}' +
      'h1{font-size:18px;margin:0 0 8px}</style></head><body><div class="card">' +
      '<h1>DocuPDF Sign</h1>' +
      '<p>' + message + '</p>' +
      '<p style="font-size:12px;color:#80868b">If you believe this is an error, ask the document owner to send you a new signature request.</p>' +
      '</div></body></html>');
}

/* ------------------------------------------------------------------ *
 * Public verification page (?action=verify&job=<jobId>).
 * Served to Anyone as the deployed user; shows the stored integrity
 * hash and can re-check any file the app can read against it.
 * ------------------------------------------------------------------ */

function _computeBytesSha256(bytes) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    bytes,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
  }).join('').toUpperCase();
}

function _handleVerify(e) {
  try {
    var jobId = e.parameter.job;
    if (!jobId) {
      return _renderErrorPage('Missing verification parameters.');
    }
    var record = _getJobRecord(jobId);
    var docName = record ? record.docName : 'Unknown document';
    var signers = record && record.slots
      ? record.slots.map(function (s) { return s.signerEmail; }).join(', ')
      : '—';
    var storedHash = record && (record.finalHash || (record.audit && record.audit.hash)) || '';
    var finalizedOn = record && (record.finalStampIso || (record.audit && record.audit.verifiedStampIso)) || '';
    var printedHash = e.parameter.hash || '';

    var check = '';
    var fileId = e.parameter.file;
    if (fileId) {
      var r = VERIFY_HASH(jobId, fileId);
      if (!r.ok) {
        check = '<div class="alert fail">Could not check that file: ' + _esc(r.error) + '</div>';
      } else if (r.match) {
        check = '<div class="alert pass">INTEGRITY OK — the file matches the finalized signed document. SHA-256: ' + r.computed + '</div>';
      } else {
        check = '<div class="alert fail">INTEGRITY FAIL — the file does NOT match the finalized signed document. Its SHA-256 (' + r.computed + ') differs from the stored hash (' + r.stored + '). The file has been altered since signing.</div>';
      }
    }

    var escDoc = _esc(docName);
    var html =
      '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>DocuPDF Sign — Verify Document</title>' +
      '<style>body{font-family:Roboto,Arial,sans-serif;background:#f1f3f4;margin:0;color:#202124}' +
      '.wrap{max-width:640px;margin:32px auto;padding:0 16px}' +
      '.card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(60,64,67,.3);padding:24px 28px;margin-bottom:16px}' +
      'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#5f6368;font-weight:600;margin:20px 0 6px}' +
      'code{font-family:Consolas,Menlo,monospace;background:#f1f3f4;border-radius:4px;padding:2px 6px;font-size:12px;word-break:break-all}' +
      '.muted{color:#5f6368;font-size:13px}.pass{border-left:4px solid #188038;background:#e6f4ea;padding:12px 14px;border-radius:6px}.fail{border-left:4px solid #d93025;background:#fce8e6;padding:12px 14px;border-radius:6px}' +
      'input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:6px;font-size:13px;font-family:Consolas,Menlo,monospace}' +
      'button{margin-top:10px;background:#1a73e8;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-size:14px;cursor:pointer}' +
      '.badge{display:inline-block;background:#e6f4ea;color:#188038;font-weight:600;font-size:12px;border-radius:12px;padding:3px 10px}' +
      '</style></head><body><div class="wrap">' +
      '<div class="card"><h1>DocuPDF Sign — Document Verification</h1>' +
      '<p class="muted">Automated verification record for the document signed through the DocuPDF Sign engine.</p>' +
      (record && record.finalized ? '<span class="badge">FINALIZED</span>' : '<span class="badge">PENDING</span>') +
      '<h2>Document</h2><p>' + escDoc + '</p>' +
      '<h2>Signer(s)</h2><p>' + _esc(signers) + '</p>' +
      '<h2>Finalized</h2><p>' + (finalizedOn ? _esc(finalizedOn) : 'Not finalized yet') + '</p>' +
      '<h2>Stored integrity hash (SHA-256 of the final signed PDF)</h2>' +
      '<p>' + (storedHash ? '<code>' + storedHash + '</code>' : '<span class="muted">No stored hash.</span>') + '</p>' +
      '<h2>Hash printed on the PDF</h2>' +
      '<p>' + (printedHash ? '<code>' + _esc(printedHash) + '</code>' : '<span class="muted">Not provided.</span>') + '</p>' +
      '<p class="muted">The stored hash is the authoritative tamper-evidence anchor: any edit to the final signed PDF changes its SHA-256 and it will no longer match. Keep the stored hash somewhere safe.</p>' +
      '</div>' +
      '<div class="card"><h2>Verify a PDF file against the stored hash</h2>' +
      '<p class="muted">Enter the Drive File ID of the signed PDF (the copy created by DocuPDF Sign in the owner\u2019s Drive). The engine re-reads the file and compares its SHA-256 with the stored hash.</p>' +
      (check ? check : '') +
      '<form method="get"><input type="hidden" name="action" value="verify">' +
      '<input type="hidden" name="job" value="' + _esc(jobId) + '">' +
      '<input type="hidden" name="hash" value="' + _esc(printedHash) + '">' +
      '<input type="text" name="file" placeholder="Drive File ID of the signed PDF" value="' + _esc(fileId || '') + '">' +
      '<button type="submit">Check integrity</button></form>' +
      '<p class="muted" style="margin-top:12px">For files outside this account\u2019s Drive, share the PDF with the document owner, then enter its file ID here.</p>' +
      '</div>' +
      '<p style="text-align:center;color:#80868b;font-size:12px">DocuPDF Sign — PWMAI Security Engine</p>' +
      '</div></body></html>';

    return HtmlService.createHtmlOutput(html)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .setTitle('Verify Document');
  } catch (err) {
    Logger.log('_handleVerify error: %s', err.message);
    return _renderErrorPage('Verification is temporarily unavailable.');
  }
}

function _esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Recomputes the SHA-256 of a file and compares it with the stored final hash.
 * @return {Object} { ok, match?, computed?, stored?, error? }
 */
function VERIFY_HASH(jobId, fileId) {
  try {
    var record = _getJobRecord(jobId);
    if (!record) {
      return { ok: false, error: 'No signature record found for this job.' };
    }
    var stored = record.finalHash || (record.audit && record.audit.hash) || '';
    if (!stored) {
      return { ok: false, error: 'No stored integrity hash for this document.' };
    }
    var read = _driveReadPdf(fileId);
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    var computed = _computeBytesSha256(read.bytes);
    return {
      ok: true,
      match: computed === stored,
      computed: computed,
      stored: stored,
      docName: record.docName,
      finalized: !!record.finalized,
      finalizedOn: record.finalStampIso || (record.audit && record.audit.verifiedStampIso) || '',
      signers: record.slots ? record.slots.map(function (s) { return s.signerEmail; }).join(', ') : ''
    };
  } catch (err) {
    Logger.log('VERIFY_HASH error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Job / token registry (keyed by jobId, 7-day, one-time per slot).
 * ------------------------------------------------------------------ */

function _getJobStore() {
  return PropertiesService.getScriptProperties();
}

/**
 * Creates a signing job record with up to two slots and returns it.
 *
 * @param {Object} cfg { sourcePdfId, outputFolderId, docName, spreadsheetId,
 *                       dataSheetName, rowNumber, statusColumn, slots }
 * @return {Object} the stored job record.
 */
function _createJobRecord(cfg) {
  var jobId = Utilities.getUuid();
  var now = Date.now();
  var slots = (cfg.slots || []).map(function (s, i) {
    return {
      slot: i + 1,
      label: s.label || ('Party ' + (i + 1)),
      page: Number(s.page) || 0, // 0 = last page
      x: Number(s.x),
      y: Number(s.y),
      align: s.align || 'center',   // 'left' | 'center' | 'right'
      vOffset: Number(s.vOffset) || 0.85, // fraction of page height from top
      width: Number(s.width) || 180,
      height: Number(s.height) || 60,
      signerEmail: String(s.signerEmail || '').trim(),
      signerName: String(s.signerName || '').trim(),
      signerDesignation: String(s.signerDesignation || '').trim(),
      signToken: _randomToken(),
      nonce: _randomNonce(),
      status: 'pending',
      used: false,
      openedAt: null,
      textValue: '',
      initials: '',
      signedAt: null,
      signatureBase64: null
    };
  });

  var record = {
    jobId: jobId,
    docName: cfg.docName || 'Document',
    sourcePdfId: cfg.sourcePdfId,
    outputFolderId: cfg.outputFolderId || '',
    spreadsheetId: cfg.spreadsheetId || '',
    dataSheetName: cfg.dataSheetName || '',
    rowNumber: cfg.rowNumber || 0,
    statusColumn: cfg.statusColumn || 0,
    signerAStatusColumn: cfg.signerAStatusColumn || 0,
    signerBStatusColumn: cfg.signerBStatusColumn || 0,
    signerADeclineReasonColumn: cfg.signerADeclineReasonColumn || 0,
    signerBDeclineReasonColumn: cfg.signerBDeclineReasonColumn || 0,
    documentSignedColumn: cfg.documentSignedColumn || 0,
    workingPdfColumn: cfg.workingPdfColumn || 0,
    signedPdfColumn: cfg.signedPdfColumn || 0,
    ownerEmail: cfg.ownerEmail || '',
    notifyOwner: cfg.notifyOwner !== false,
    typeId: cfg.typeId || '',
    typeName: cfg.typeName || '',
    slots: slots,
    audit: null,
    finalized: false,
    createdAt: now,
    expiresAt: now + JOB_TTL_MS
  };
  _getJobStore().setProperty(JOB_PREFIX + jobId, JSON.stringify(record));
  return record;
}

function _getJobRecord(jobId) {
  var raw = _getJobStore().getProperty(JOB_PREFIX + jobId);
  return raw ? JSON.parse(raw) : null;
}

function _saveJobRecord(record) {
  _getJobStore().setProperty(JOB_PREFIX + record.jobId, JSON.stringify(record));
}

function _randomToken() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function _randomNonce() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

/**
 * Validates a token+nonce against a job record and returns the matching slot.
 * @return {Object} { valid, reason?, record?, slot?, slotIndex? }
 */
function _validateSigningToken(jobId, signToken, nonce) {
  try {
    var record = _getJobRecord(jobId);
    if (!record) {
      return { valid: false, reason: 'No signature request exists for this document.' };
    }
    if (record.finalized) {
      return { valid: false, reason: 'This document has already been signed and finalized.' };
    }
    if (Date.now() > record.expiresAt) {
      return { valid: false, reason: 'This signature link has expired (7-day validity).' };
    }
    for (var i = 0; i < record.slots.length; i++) {
      var slot = record.slots[i];
      if (slot.signToken === signToken && slot.nonce === nonce) {
        if (slot.used) {
          return { valid: false, reason: 'This signature link has already been used.' };
        }
        return { valid: true, record: record, slot: slot, slotIndex: i };
      }
    }
    return { valid: false, reason: 'Signature link could not be authenticated.' };
  } catch (err) {
    Logger.log('_validateSigningToken error: %s', err.message);
    return { valid: false, reason: 'Signature link could not be validated.' };
  }
}

/**
 * Marks a slot's token as used and persists the record. Idempotent: a
 * retried/duplicate call on an already-used slot is a no-op, not an error.
 */
function _markSlotTokenUsed(jobId, slotIndex) {
  var record = _getJobRecord(jobId);
  if (!record || !record.slots[slotIndex]) {
    return false;
  }
  var slot = record.slots[slotIndex];
  if (slot.used) {
    return true;
  }
  slot.used = true;
  _saveJobRecord(record);
  return true;
}

function _revokeJob(jobId) {
  try {
    _getJobStore().deleteProperty(JOB_PREFIX + jobId);
    return true;
  } catch (err) {
    Logger.log('_revokeJob error: %s', err.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Config (PropertiesService-backed) — persisted per spreadsheet.
 * ------------------------------------------------------------------ */

function readConfig() {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var raw = PropertiesService.getScriptProperties().getProperty(CONFIG_KEY + '_' + ssId);
    return raw ? JSON.parse(raw) : _defaultConfig();
  } catch (err) {
    Logger.log('readConfig error: %s', err.message);
    return _defaultConfig();
  }
}

function saveConfig(cfg) {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    PropertiesService.getScriptProperties().setProperty(CONFIG_KEY + '_' + ssId, JSON.stringify(cfg || _defaultConfig()));
    return { ok: true };
  } catch (err) {
    Logger.log('saveConfig error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _getSheetMode(ssId, sheetId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SHEET_MODE_KEY + ssId + '_' + sheetId);
    return (raw === 'manual') ? 'manual' : 'automatic';
  } catch (err) {
    Logger.log('_getSheetMode error: %s', err.message);
    return 'automatic';
  }
}

function _setSheetMode(ssId, sheetId, mode) {
  var value = (mode === 'manual') ? 'manual' : 'automatic';
  try {
    PropertiesService.getScriptProperties().setProperty(SHEET_MODE_KEY + ssId + '_' + sheetId, value);
  } catch (err) {
    Logger.log('_setSheetMode error: %s', err.message);
  }
  return value;
}

function _defaultConfig() {
  return {
    dataSheetName: '',
    headerRow: 1,
    sourceMode: 'auto',       // 'auto' (detect on setup) | 'documail' | 'standalone'
    signerEmailColumn: 0,     // Party A email
    signerNameColumn: 0,      // Party A name
    signerBEmailColumn: 0,    // Party B email (0 = single-party)
    signerBNameColumn: 0,     // Party B name
    signerADesignationColumn: 0, // 'Signer A Designation'
    signerBDesignationColumn: 0, // 'Signer B Designation'
    signerACompanyColumn: 0,     // 'Signer A Company'
    signerBCompanyColumn: 0,     // 'Signer B Company'
    docNameColumn: 0,
    statusColumn: 0,          // 'DocuPDF Status'
    signerAStatusColumn: 0,   // 'Signer A Status' (per-slot, 0 = not mapped)
    signerBStatusColumn: 0,   // 'Signer B Status'
    documentSignedColumn: 0,  // 'Document Signed' (No -> Yes on finalize)
    linkAColumn: 0,           // 'Sign Link - Party A' (DocuMail picks up)
    linkBColumn: 0,           // 'Sign Link - Party B'
    signerADeclineReasonColumn: 0, // 'Signer A Decline Reason'
    signerBDeclineReasonColumn: 0, // 'Signer B Decline Reason'
    workingPdfColumn: 0,      // 'Working PDF Link'
    signedPdfColumn: 0,       // 'Signed PDF Link'
    signingRequiredColumn: 0, // 'Signing Required' (Yes/No gate)
    sourceColumn: 0,          // 'Source Doc ID/URL' (standalone mode)
    templateFileId: '',       // per-type template PDF (standalone, Step 3)
    slotPlacement: { A: { page: 0, align: 'center', vOffset: 0.85 }, B: { page: 0, align: 'center', vOffset: 0.85 } },
    signerTextFieldLabel: '', // optional signer text field (blank = off)
    initialsEnabled: true,
    reminderDays: 0,          // 0 = no reminders
    sequentialSigning: false, // Party A signs first, then Party B is emailed
    logoUrl: '',              // public image URL for the signer page + email
    brandColor: '#1a73e8',
    qrInEmail: true,          // embed a QR of the signing link in the email
    trackOpens: false,        // write an "Opened <date>" marker to the status cell
    mergedDocStatusColumn: 0, // DocuMail 'Merged Doc Status'
    mergedDocIdColumn: 0,     // DocuMail 'Merged Doc ID'
    mergedDocUrlColumn: 0,    // DocuMail 'Merged Doc URL'
    shareSourcePdf: true,     // allow-anyone-with-link view so signer preview works
    outputFolderId: '',
    autoSync: false,
    lastSync: 0,
    autoSendEmail: true,      // standalone: DocuPDF emails the sign link (documail: off, DocuMail emails)
    attachSourcePdf: true,    // attach the unsigned PDF to the signing email
    notifyOnFinalize: true,   // email the owner when the signed PDF is ready
    notifyOwnerEmail: '',     // owner notified here; empty = spreadsheet owner
    esignMode: 'native',      // 'native' | 'external'
    externalProvider: 'lumin',
    companyName: '',
    replyToEmail: '',
    emailSubject: 'Please sign: {docName}',
    emailBody: 'Hi {signerName}, please review and sign {docName}.\n\nSigner: {signerName} | {signerDesignation}\nEmail: {signerEmail}\n\nLink: {signUrl}',
    created: Date.now(),
    updated: Date.now()
  };
}

/**
 * Header names DocuPDF recognises. DocuMail system columns are matched
 * case-insensitively by substring (see RESOLVE_SYNC_COLUMNS).
 */
var COL_HEADER = {
  signingRequired: 'Signing Required',
  signerAEmail: 'Signer A Email',
  signerAName: 'Signer A Name',
  signerADesignation: 'Signer A Designation',
  signerACompany: 'Signer A Company',
  signerBEmail: 'Signer B Email',
  signerBName: 'Signer B Name',
  signerBDesignation: 'Signer B Designation',
  signerBCompany: 'Signer B Company',
  sourceDoc: 'Source Doc ID/URL',
  docName: 'Doc Name',
  status: 'DocuPDF Status',
  signerAStatus: 'Signer A Status',
  signerADeclineReason: 'Signer A Decline Reason',
  signerBStatus: 'Signer B Status',
  signerBDeclineReason: 'Signer B Decline Reason',
  documentSigned: 'Document Signed',
  linkA: 'Sign Link - Party A',
  linkB: 'Sign Link - Party B',
  workingPdfLink: 'Working PDF Link',
  signedPdfLink: 'Signed PDF Link'
};

/**
 * Returns the configured data sheet (or the active/first sheet).
 */
function _getDataSheet(ss, cfg) {
  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      return null;
    }
  }
  if (!ss) {
    return null;
  }
  var sheet = null;
  if (cfg && cfg.dataSheetName) {
    try {
      sheet = ss.getSheetByName(cfg.dataSheetName);
    } catch (e) { /* ignore */ }
  }
  if (!sheet) {
    try {
      sheet = ss.getActiveSheet();
    } catch (e) { /* ignore */ }
  }
  if (!sheet && ss.getSheets().length) {
    sheet = ss.getSheets()[0];
  }
  return sheet;
}

/**
 * Re-syncs the numeric column fields of a config against the current sheet
 * headers (resolved by name), so DocuMail's dynamic template columns never
 * break positions. Mutates and returns the config.
 */
function _resolveConfigColumns(sheet, cfg) {
  if (!sheet) {
    return cfg;
  }
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    return cfg;
  }
  var headers = sheet.getRange(cfg.headerRow || 1, 1, 1, lastCol).getValues()[0];
  var find = function (name) {
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim().toLowerCase() === String(name).toLowerCase()) {
        return i + 1;
      }
    }
    return 0;
  };
  var findContains = function (needle) {
    var n = String(needle).toLowerCase();
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).toLowerCase().indexOf(n) !== -1) {
        return i + 1;
      }
    }
    return 0;
  };

  cfg.signingRequiredColumn = find(COL_HEADER.signingRequired) || cfg.signingRequiredColumn;
  cfg.signerEmailColumn = find(COL_HEADER.signerAEmail) || findContains('recipient email') || cfg.signerEmailColumn;
  cfg.signerNameColumn = find(COL_HEADER.signerAName) || cfg.signerNameColumn;
  cfg.signerADesignationColumn = find(COL_HEADER.signerADesignation) || cfg.signerADesignationColumn;
  cfg.signerACompanyColumn = find(COL_HEADER.signerACompany) || cfg.signerACompanyColumn;
  cfg.signerBEmailColumn = find(COL_HEADER.signerBEmail) || cfg.signerBEmailColumn;
  cfg.signerBNameColumn = find(COL_HEADER.signerBName) || cfg.signerBNameColumn;
  cfg.signerBDesignationColumn = find(COL_HEADER.signerBDesignation) || cfg.signerBDesignationColumn;
  cfg.signerBCompanyColumn = find(COL_HEADER.signerBCompany) || cfg.signerBCompanyColumn;
  cfg.sourceColumn = find(COL_HEADER.sourceDoc) || cfg.sourceColumn;
  cfg.docNameColumn = find(COL_HEADER.docName) || cfg.docNameColumn;
  cfg.statusColumn = find(COL_HEADER.status) || cfg.statusColumn;
  cfg.signerAStatusColumn = find(COL_HEADER.signerAStatus) || cfg.signerAStatusColumn;
  cfg.signerBStatusColumn = find(COL_HEADER.signerBStatus) || cfg.signerBStatusColumn;
  cfg.documentSignedColumn = find(COL_HEADER.documentSigned) || cfg.documentSignedColumn;
  cfg.linkAColumn = find(COL_HEADER.linkA) || cfg.linkAColumn;
  cfg.linkBColumn = find(COL_HEADER.linkB) || cfg.linkBColumn;
  cfg.signerADeclineReasonColumn = find(COL_HEADER.signerADeclineReason) || cfg.signerADeclineReasonColumn;
  cfg.signerBDeclineReasonColumn = find(COL_HEADER.signerBDeclineReason) || cfg.signerBDeclineReasonColumn;
  cfg.workingPdfColumn = find(COL_HEADER.workingPdfLink) || cfg.workingPdfColumn;
  cfg.signedPdfColumn = find(COL_HEADER.signedPdfLink) || cfg.signedPdfColumn;
  cfg.mergedDocStatusColumn = findContains('merged doc status') || cfg.mergedDocStatusColumn;
  cfg.mergedDocIdColumn = findContains('merged doc id') || cfg.mergedDocIdColumn;
  cfg.mergedDocUrlColumn = findContains('merged doc url') || cfg.mergedDocUrlColumn;

  if (!cfg.sourceMode || cfg.sourceMode === 'auto') {
    cfg.sourceMode = (cfg.mergedDocStatusColumn || cfg.mergedDocIdColumn) ? 'documail' : 'standalone';
  }
  return cfg;
}

/**
 * Adds the per-slot 'Signer A Status' / 'Signer B Status' headers to the sheet
 * if they are missing, then re-resolves the config so the indices are live.
 *
 * This is the migration path for types/sheets configured before the columns
 * existed: they get them on the next job creation, without the user re-running
 * Setup. Headers are appended at the far right, exactly as SETUP_SHEET does, so
 * a DocuMail block is never interrupted.
 *
 * Never throws: a failure here only means the per-signer columns stay unwritten
 * (the status writes no-op on a 0 column), so the signing flow must not fail.
 * @param {Object} sheet
 * @param {Object} cfg Config/type (mutated: column indices + added[]).
 * @return {Object} { added:[], error? }
 */
function _ensureSignerStatusColumns(sheet, cfg) {
  var added = [];
  try {
    if (!sheet || !cfg) {
      return { added: added };
    }
    var lastCol = sheet.getLastColumn();
    var headers = (lastCol >= 1) ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    var findCol = function (name) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].trim().toLowerCase() === String(name).toLowerCase()) return i + 1;
      }
      return 0;
    };
    [COL_HEADER.signerAStatus, COL_HEADER.signerBStatus].forEach(function (name) {
      if (findCol(name)) return;
      lastCol++;
      sheet.getRange(1, lastCol).setValue(name);
      sheet.getRange(1, lastCol).setFontWeight('bold').setBackground('#E8F0FE');
      headers.push(String(name));
      added.push(String(name));
    });
    if (added.length) {
      _resolveConfigColumns(sheet, cfg);
    }
  } catch (e) {
    Logger.log('_ensureSignerStatusColumns warning: %s', e.message);
    return { added: added, error: e.message };
  }
  return { added: added };
}

function _shiftJobColumnsForInsert(spreadsheetId, dataSheetName, afterCol) {
  try {
    var keys = ['statusColumn', 'signerAStatusColumn', 'signerBStatusColumn',
      'signerADeclineReasonColumn', 'signerBDeclineReasonColumn', 'documentSignedColumn',
      'workingPdfColumn', 'signedPdfColumn'];
    var props = _getJobStore().getAllProperties();
    var patched = 0;
    Object.keys(props).forEach(function (key) {
      if (key.indexOf(JOB_PREFIX) !== 0) return;
      var rec;
      try {
        rec = JSON.parse(props[key]);
      } catch (e) {
        return;
      }
      if (!rec || rec.spreadsheetId !== spreadsheetId || rec.dataSheetName !== dataSheetName) return;
      var touched = false;
      keys.forEach(function (colKey) {
        var v = Number(rec[colKey] || 0);
        if (v > afterCol) {
          rec[colKey] = v + 1;
          touched = true;
        }
      });
      if (touched) {
        _getJobStore().setProperty(key, JSON.stringify(rec));
        patched++;
      }
    });
    if (patched) {
      Logger.log('_shiftJobColumnsForInsert: patched %s job record(s) for "%s".', patched, dataSheetName);
    }
  } catch (e) {
    Logger.log('_shiftJobColumnsForInsert warning: %s', e.message);
  }
}

function _ensureDeclineReasonColumns(sheet, cfg) {
  var added = [];
  try {
    if (!sheet || !cfg) {
      return { added: added };
    }
    var headerRow = Number(cfg.headerRow) || 1;
    var readHeaders = function () {
      var lc = sheet.getLastColumn();
      return lc >= 1 ? sheet.getRange(headerRow, 1, 1, lc).getValues()[0].map(String) : [];
    };
    var findIn = function (headers, name) {
      var n = String(name).toLowerCase();
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].trim().toLowerCase() === n) return i + 1;
      }
      return 0;
    };
    var pairs = [
      [COL_HEADER.signerAStatus, COL_HEADER.signerADeclineReason],
      [COL_HEADER.signerBStatus, COL_HEADER.signerBDeclineReason]
    ];
    pairs.forEach(function (pair) {
      var headers = readHeaders();
      if (findIn(headers, pair[1])) return;
      var statusCol = findIn(headers, pair[0]);
      if (!statusCol) return;
      sheet.insertColumnAfter(statusCol);
      sheet.getRange(headerRow, statusCol + 1).setValue(pair[1]);
      sheet.getRange(headerRow, statusCol + 1).setFontWeight('bold').setBackground('#E8F0FE');
      added.push(String(pair[1]));
      _shiftJobColumnsForInsert(String(sheet.getParent() ? sheet.getParent().getId() : ''),
        sheet.getName(), statusCol);
    });
    if (added.length) {
      _resolveConfigColumns(sheet, cfg);
    }
  } catch (e) {
    Logger.log('_ensureDeclineReasonColumns warning: %s', e.message);
    return { added: added, error: e.message };
  }
  return { added: added };
}

function _ensurePdfLinkColumns(sheet, cfg) {
  var added = [];
  try {
    if (!sheet || !cfg) {
      return { added: added };
    }
    var lastCol = sheet.getLastColumn();
    var headers = (lastCol >= 1) ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    var findCol = function (name) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].trim().toLowerCase() === String(name).toLowerCase()) return i + 1;
      }
      return 0;
    };
    [COL_HEADER.workingPdfLink, COL_HEADER.signedPdfLink].forEach(function (name) {
      if (findCol(name)) return;
      lastCol++;
      sheet.getRange(1, lastCol).setValue(name);
      sheet.getRange(1, lastCol).setFontWeight('bold').setBackground('#E8F0FE');
      headers.push(String(name));
      added.push(String(name));
    });
    if (added.length) {
      _resolveConfigColumns(sheet, cfg);
    }
  } catch (e) {
    Logger.log('_ensurePdfLinkColumns warning: %s', e.message);
    return { added: added, error: e.message };
  }
  return { added: added };
}

var SETUP_COLUMNS_AUTOMATIC = [
  COL_HEADER.signingRequired,
  COL_HEADER.signerAEmail,
  COL_HEADER.signerAName,
  COL_HEADER.signerACompany,
  COL_HEADER.signerADesignation,
  COL_HEADER.signerBEmail,
  COL_HEADER.signerBName,
  COL_HEADER.signerBCompany,
  COL_HEADER.signerBDesignation,
  COL_HEADER.status,
  COL_HEADER.documentSigned,
  COL_HEADER.signerAStatus,
  COL_HEADER.signerADeclineReason,
  COL_HEADER.signerBStatus,
  COL_HEADER.signerBDeclineReason,
  COL_HEADER.linkA,
  COL_HEADER.linkB,
  COL_HEADER.workingPdfLink,
  COL_HEADER.signedPdfLink
];

var SETUP_COLUMNS_MANUAL = [
  COL_HEADER.signerAEmail,
  COL_HEADER.signerAName,
  COL_HEADER.signerACompany,
  COL_HEADER.signerADesignation,
  COL_HEADER.signerBEmail,
  COL_HEADER.signerBName,
  COL_HEADER.signerBCompany,
  COL_HEADER.signerBDesignation,
  COL_HEADER.sourceDoc,
  COL_HEADER.status,
  COL_HEADER.documentSigned,
  COL_HEADER.signerAStatus,
  COL_HEADER.signerADeclineReason,
  COL_HEADER.signerBStatus,
  COL_HEADER.signerBDeclineReason,
  COL_HEADER.linkA,
  COL_HEADER.linkB,
  COL_HEADER.workingPdfLink,
  COL_HEADER.signedPdfLink
];

/**
 * One-click setup. Detects DocuMail mode (Merged Doc columns present) vs
 * standalone, creates DocuPDF's own columns, and stores config.
 *  - documail:  'Signing Required' inserted immediately BEFORE 'Merged Doc
 *               Status' (keeps the DocuMail block contiguous to the end).
 *  - standalone: full DocuPDF column set, appended in order.
 * Output columns ('DocuPDF Status', 'Sign Link - Party A/B') always go to the
 * far right so DocuMail's block is never interrupted.
 * @return {Object} { ok, sheetMode, mode, added:[], columns:{header:colNumber} }
 */
function SETUP_SHEET() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = _setupTargetSheet(ss);
    if (!sheet) {
      return { ok: false, error: 'No data sheet found to configure.' };
    }
    var cfg = readConfig();
    cfg.dataSheetName = sheet.getName();
    cfg.headerRow = 1;

    var ssId = ss.getId();
    var sheetId = sheet.getSheetId();
    var ui = SpreadsheetApp.getUi();
    var dataEndRow = sheet.getLastRow();
    var reset = false;

    if (_sheetHasDataBelowHeader(sheet)) {
      var guard = ui.alert('⚠️ DocuPDF Sign — Sheet has data',
        'This sheet already contains data.\n\n' +
        'Setting up columns again will erase all\n' +
        'data from DocuPDF\'s columns and rebuild them.\n\n' +
        'Your own columns (name, email, custom fields)\n' +
        'are never touched.\n\n' +
        '─────────────────────────────────\n\n' +
        'Yes = 🔄 Reset and rebuild\n' +
        'No  = ❌ Cancel — leave everything as-is',
        ui.ButtonSet.YES_NO);
      if (guard !== ui.Button.YES) {
        return { ok: false, cancelled: true, error: 'Setup cancelled.' };
      }
      reset = true;
    }

    var storedMode = null;
    try {
      var storedRaw = PropertiesService.getScriptProperties().getProperty(SHEET_MODE_KEY + ssId + '_' + sheetId);
      if (storedRaw === 'automatic' || storedRaw === 'manual') {
        storedMode = storedRaw;
      }
    } catch (e) {
      storedMode = null;
    }

    var sheetMode = storedMode;
    if (!sheetMode || reset) {
      var pick = ui.alert('📄 DocuPDF Sign — Setup',
        'How should this sheet create signing requests?\n\n' +
        '🔄  Automatic — one template for all rows\n' +
        '     (e.g. a batch of similar NDAs or MOUs)\n\n' +
        '✍️  Manual — a different document for each row\n' +
        '     (pick each row\'s file when you create the job)\n\n' +
        '─────────────────────────────────\n\n' +
        'Yes  = 🔄 Automatic\n' +
        'No   = ✍️ Manual\n' +
        'Cancel = ⏸ Decide later (no changes)',
        ui.ButtonSet.YES_NO_CANCEL);
      if (pick === ui.Button.CANCEL) {
        return { ok: false, cancelled: true, error: 'Setup cancelled.' };
      }
      sheetMode = (pick === ui.Button.YES) ? 'automatic' : 'manual';
      _setSheetMode(ssId, sheetId, sheetMode);
    }

    var order = (sheetMode === 'manual') ? SETUP_COLUMNS_MANUAL : SETUP_COLUMNS_AUTOMATIC;
    if (reset) {
      _clearDocuPDFColumns(sheet, order);
    }

    var sync = {found:false,statusCol:0,idCol:0,urlCol:0};
    var mode = (sync.statusCol || sync.idCol || sync.urlCol) ? 'documail' : 'standalone';

    var lastCol = sheet.getLastColumn();
    var headers = (lastCol >= 1) ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    var findCol = function (name) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].trim().toLowerCase() === String(name).toLowerCase()) return i + 1;
      }
      return 0;
    };
    var added = [];
    var ensureHeader = function (name) {
      var col = findCol(name);
      if (!col) {
        col = lastCol + 1;
        sheet.getRange(1, col).setValue(name);
        lastCol = col;
        headers.push(String(name));
        added.push(String(name));
      }
      return col;
    };

    if (mode === 'documail') {
      var srCol = findCol(COL_HEADER.signingRequired);
      if (!srCol) {
        var statusCol = sync.statusCol || sync.idCol || sync.urlCol;
        sheet.insertColumnBefore(statusCol);
        sheet.getRange(1, statusCol).setValue(COL_HEADER.signingRequired);
        headers.splice(statusCol - 1, 0, COL_HEADER.signingRequired);
        lastCol++;
        added.push(COL_HEADER.signingRequired);
      }
      ensureHeader(COL_HEADER.status);
      ensureHeader(COL_HEADER.documentSigned);
      ensureHeader(COL_HEADER.signerAStatus);
      ensureHeader(COL_HEADER.signerADeclineReason);
      ensureHeader(COL_HEADER.signerBStatus);
      ensureHeader(COL_HEADER.signerBDeclineReason);
      ensureHeader(COL_HEADER.linkA);
      ensureHeader(COL_HEADER.linkB);
      ensureHeader(COL_HEADER.workingPdfLink);
      ensureHeader(COL_HEADER.signedPdfLink);
    } else {
      order.forEach(ensureHeader);

      // Reorder the existing columns to the sequence above, but only when the
      // sheet holds NO unknown columns (a pure DocuPDF sheet) — otherwise
      // leaving user data columns alone is safer — and only on a Reset, so a
      // plain re-run keeps the sheet's current column order.
      var knownMap = {};
      order.forEach(function (n) { knownMap[String(n).trim().toLowerCase()] = true; });
      [COL_HEADER.signingRequired, COL_HEADER.sourceDoc, COL_HEADER.docName].forEach(function (n) {
        knownMap[String(n).trim().toLowerCase()] = true;
      });
      var allKnown = headers.every(function (h) {
        var t = String(h).trim();
        return !t || knownMap[t.toLowerCase()];
      });
      if (allKnown && reset) {
        try {
          for (var oi = 0; oi < order.length; oi++) {
            var row1 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
            var pos = -1;
            for (var c = 0; c < row1.length; c++) {
              if (String(row1[c]).trim().toLowerCase() === String(order[oi]).toLowerCase()) { pos = c + 1; break; }
            }
            if (pos !== -1 && pos !== (oi + 1)) {
              sheet.moveColumns(sheet.getRange(1, pos, sheet.getMaxRows(), 1), oi + 1);
            }
          }
        } catch (e) {
          Logger.log('SETUP_SHEET reorder warning: %s', e.message);
        }
      }
    }

    // Yes/No dropdown on 'Signing Required' (new column only: default 'No').
    var srIndex = findCol(COL_HEADER.signingRequired);
    if (srIndex) {
      var validation = SpreadsheetApp.newDataValidation()
        .requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build();
      if (dataEndRow >= 2) {
        var dataRange = sheet.getRange(2, srIndex, dataEndRow - 1, 1);
        dataRange.setDataValidation(validation);
        if (added.indexOf(COL_HEADER.signingRequired) !== -1) {
          dataRange.setValue('No');
        }
      } else {
        sheet.getRange(2, srIndex, 1, 1).setDataValidation(validation);
      }
      sheet.getRange(1, srIndex).setFontWeight('bold').setBackground('#FCE8E6');
    }

    // 'Document Signed' — auto-maintained: blank (not required / pending),
    // 'No' (Signing Required = No), or 'Signed by <emails> on <date>' (finalized).
    // No dropdown; the value is generated by the sync engine / finalizer.
    var dsIndex = findCol(COL_HEADER.documentSigned);
    if (dsIndex) {
      sheet.getRange(1, dsIndex).setFontWeight('bold').setBackground('#E6F4EA');
    }

    // 'Signer A/B Status' — per-slot progress, auto-maintained by the signing
    // flow: 'Awaiting', 'Opened <ts>', 'Signing…', 'Signed <ts>', 'Declined <ts>'.
    // No dropdown; the value is generated at each slot transition.
    [COL_HEADER.signerAStatus, COL_HEADER.signerBStatus,
     COL_HEADER.signerADeclineReason, COL_HEADER.signerBDeclineReason].forEach(function (name) {
      var si = findCol(name);
      if (si) {
        sheet.getRange(1, si).setFontWeight('bold').setBackground('#E8F0FE');
      }
    });

    [COL_HEADER.workingPdfLink, COL_HEADER.signedPdfLink].forEach(function (name) {
      var li = findCol(name);
      if (li) {
        sheet.getRange(1, li).setFontWeight('bold').setBackground('#FEF7E0');
      }
    });

    cfg.sourceMode = mode;
    if (!('autoSendEmail' in cfg)) {
      cfg.autoSendEmail = (mode === 'standalone');
    }
    if (!findCol(COL_HEADER.signingRequired)) {
      cfg.signingRequiredColumn = 0;
    }
    if (!findCol(COL_HEADER.sourceDoc)) {
      cfg.sourceColumn = 0;
    }
    cfg = _resolveConfigColumns(sheet, cfg);
    saveConfig(cfg);

    sheet.activate();

    LOG_AUDIT_EVENT('SETUP', {
      docId: sheet.getSheetId(),
      docName: sheet.getName(),
      status: 'Configured',
      details: 'Sheet mode: ' + sheetMode + '; source mode: ' + mode
    });

    return { ok: true, sheetMode: sheetMode, mode: mode, added: added, columns: _columnSummary(sheet, cfg) };
  } catch (err) {
    Logger.log('SETUP_SHEET error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _sheetHasDataBelowHeader(sheet) {
  try {
    if (!sheet) {
      return true;
    }
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) {
      return false;
    }
    var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var r = 0; r < values.length; r++) {
      for (var c = 0; c < values[r].length; c++) {
        var cell = values[r][c];
        if (cell !== '' && cell !== null && cell !== undefined) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    Logger.log('_sheetHasDataBelowHeader warning: %s', err.message);
    return true;
  }
}

function _clearDocuPDFColumns(sheet, order) {
  try {
    if (!sheet) {
      return;
    }
    var lastCol = sheet.getLastColumn();
    var endRow = sheet.getLastRow();
    if (lastCol < 1) {
      return;
    }
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var managed = {};
    SETUP_COLUMNS_AUTOMATIC.concat(SETUP_COLUMNS_MANUAL).forEach(function (n) {
      managed[String(n).trim().toLowerCase()] = true;
    });
    var keep = {};
    (order || []).forEach(function (n) {
      keep[String(n).trim().toLowerCase()] = true;
    });
    var toDelete = [];
    for (var i = headers.length - 1; i >= 0; i--) {
      var key = String(headers[i]).trim().toLowerCase();
      if (!key || !managed[key]) {
        continue;
      }
      if (endRow >= 2) {
        sheet.getRange(2, i + 1, endRow - 1, 1).clearContent();
      }
      if (!keep[key]) {
        toDelete.push(i + 1);
      }
    }
    for (var d = 0; d < toDelete.length; d++) {
      try {
        if (sheet.getLastColumn() > 1) {
          sheet.deleteColumn(toDelete[d]);
        }
      } catch (e) {
        Logger.log('_clearDocuPDFColumns delete warning: %s', e.message);
      }
    }
  } catch (err) {
    Logger.log('_clearDocuPDFColumns warning: %s', err.message);
  }
}

/**
 * Chooses the sheet Setup configures. The active sheet is used UNLESS it is
 * the AuditLog sheet (Setup columns must never pollute the audit trail), in
 * which case the first non-audit sheet is chosen, preferring one that already
 * carries DocuMail Pro columns.
 */
function _setupTargetSheet(ss) {
  var active = null;
  try {
    active = ss.getActiveSheet();
  } catch (e) { /* ignore */ }
  if (active && active.getName() !== 'AuditLog') {
    return active;
  }
  var candidates = ss.getSheets().filter(function (s) {
    return s.getName() !== 'AuditLog';
  });
  if (!candidates.length) {
    return null;
  }
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (false) {
        return candidates[i];
      }
    } catch (e) { /* ignore */ }
  }
  return candidates[0];
}

/** Maps DocuPDF-relevant headers to their current column numbers. */
function _columnSummary(sheet, cfg) {
  var out = {};
  var names = [
    COL_HEADER.signingRequired, COL_HEADER.signerAName, COL_HEADER.signerADesignation, COL_HEADER.signerACompany,
    COL_HEADER.signerAEmail, COL_HEADER.signerBName, COL_HEADER.signerBDesignation, COL_HEADER.signerBCompany,
    COL_HEADER.signerBEmail, COL_HEADER.sourceDoc,
    COL_HEADER.docName, COL_HEADER.status, COL_HEADER.documentSigned,
    COL_HEADER.signerAStatus, COL_HEADER.signerBStatus,
    COL_HEADER.signerADeclineReason, COL_HEADER.signerBDeclineReason,
    COL_HEADER.linkA, COL_HEADER.linkB,
    COL_HEADER.workingPdfLink, COL_HEADER.signedPdfLink
  ];
  names.forEach(function (name) {
    var col = _findHeaderCol(sheet, name);
    out[name] = col;
  });
  out['Merged Doc Status'] = cfg.mergedDocStatusColumn;
  out['Merged Doc ID'] = cfg.mergedDocIdColumn;
  out['Merged Doc URL'] = cfg.mergedDocUrlColumn;
  out['Recipient Email'] = cfg.signerEmailColumn;
  return out;
}

function _findHeaderCol(sheet, name) {
  try {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim().toLowerCase() === String(name).toLowerCase()) return i + 1;
    }
  } catch (err) { /* ignore */ }
  return 0;
}

/**
 * Public wrapper for the sidebar: returns setup/sync state.
 * @return {Object} { ok, mode, sheetMode, autoSync, lastSync, dataSheetName, columns }
 */
function GET_SETUP_STATUS() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = readConfig();
    var sheet = _getDataSheet(ss, cfg);
    cfg = _resolveConfigColumns(sheet, cfg);
    return {
      ok: true,
      mode: cfg.sourceMode,
      sheetMode: _getSheetMode(ss.getId(), sheet ? sheet.getSheetId() : 0),
      autoSync: !!cfg.autoSync,
      lastSync: cfg.lastSync || 0,
      dataSheetName: cfg.dataSheetName,
      columns: _columnSummary(sheet, cfg)
    };
  } catch (err) {
    Logger.log('GET_SETUP_STATUS error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Standalone helper: writes a picked PDF id into the row's 'Source Doc ID/URL'
 * cell. The installable onEdit trigger then auto-creates the job.
 * @return {Object} { ok, rowNumber, column }
 */
function WRITE_SOURCE_TO_ROW(fileId, rowNumber) {
  try {
    var fileId = NORMALIZE_FILE_ID(fileId || '');
    if (!fileId) {
      return { ok: false, error: 'No PDF selected.' };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = readConfig();
    var sheet = _getDataSheet(ss, cfg);
    cfg = _resolveConfigColumns(sheet, cfg);
    if (!cfg.sourceColumn) {
      return { ok: false, error: 'No "Source Doc ID/URL" column. Run Setup first.' };
    }
    sheet.getRange(Number(rowNumber) || 2, cfg.sourceColumn).setValue(fileId);
    return { ok: true, rowNumber: Number(rowNumber) || 2, column: cfg.sourceColumn };
  } catch (err) {
    Logger.log('WRITE_SOURCE_TO_ROW error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Fills a picked PDF into the CURRENT row's 'Source Doc ID/URL' cell and, if a
 * Doc Name column exists, writes the PDF's file name (extension stripped) into
 * it. Used by the wizard's Step 1 PDF picker so the sheet is immediately ready
 * for the sync engine.
 * @param {string} fileId a Drive file id or URL
 * @return {Object} { ok, rowNumber, sourceColumn, docNameColumn, docName }
 */
function WRITE_PDF_TO_CURRENT_ROW(fileId) {
  try {
    var fileId = NORMALIZE_FILE_ID(fileId || '');
    if (!fileId) {
      return { ok: false, error: 'No PDF selected.' };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = readConfig();
    var sheet = _getDataSheet(ss, cfg);
    cfg = _resolveConfigColumns(sheet, cfg);
    if (!cfg.sourceColumn) {
      return { ok: false, error: 'No "Source Doc ID/URL" column. Run Setup first.' };
    }
    var row = GET_ACTIVE_ROW();
    sheet.getRange(row, cfg.sourceColumn).setValue(fileId);
    var docName = '';
    try {
      var meta = _driveFetchMeta(fileId);
      if (meta.ok) {
        docName = String(meta.name || '').replace(/\.[^.]*$/, '');
      }
    } catch (e) {
      Logger.log('WRITE_PDF_TO_CURRENT_ROW name error: %s', e.message);
    }
    var docNameColumn = 0;
    if (docName && cfg.docNameColumn) {
      sheet.getRange(row, cfg.docNameColumn).setValue(docName);
      docNameColumn = cfg.docNameColumn;
    }
    LOG_AUDIT_EVENT('SOURCE', {
      docId: fileId,
      docName: docName || fileId,
      status: 'Set',
      details: 'PDF written to row ' + row + ' (Source Doc ID/URL + Doc Name)'
    });
    return { ok: true, rowNumber: row, sourceColumn: cfg.sourceColumn, docNameColumn: docNameColumn, docName: docName };
  } catch (err) {
    Logger.log('WRITE_PDF_TO_CURRENT_ROW error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Manually sets the source mode ('documail' | 'standalone'). */
function _SET_SOURCE_MODE_DEPRECATED(mode) {
  // deprecated
  return { ok: true, mode: 'standalone' };
}

/* ------------------------------------------------------------------ *
 * Sheet / sync helpers (DocuMail Pro interop).
 * ------------------------------------------------------------------ */

function getSheetHeaders() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = readConfig();
    var sheet = cfg.dataSheetName ? ss.getSheetByName(cfg.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return [];
    }
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) {
      return [];
    }
    return sheet.getRange(cfg.headerRow || 1, 1, 1, lastCol).getValues()[0];
  } catch (err) {
    Logger.log('getSheetHeaders error: %s', err.message);
    return [];
  }
}

function GET_SHEET_HEADERS() {
  return getSheetHeaders();
}

function GET_SHEET_NAMES() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
      return s.getName();
    });
  } catch (err) {
    Logger.log('GET_SHEET_NAMES error: %s', err.message);
    return [];
  }
}

function GET_ACTIVE_ROW() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var active = ss.getActiveCell();
    if (active && active.getRow() > 1) {
      return active.getRow();
    }
    var cfg = readConfig();
    var sheet = cfg.dataSheetName ? ss.getSheetByName(cfg.dataSheetName) : ss.getActiveSheet();
    var headerRow = cfg.headerRow || 1;
    return (sheet && sheet.getLastRow() >= headerRow + 1) ? headerRow + 1 : 2;
  } catch (err) {
    Logger.log('GET_ACTIVE_ROW error: %s', err.message);
    return 2;
  }
}

function READ_CONFIG() {
  return readConfig();
}

function SAVE_CONFIG(cfg) {
  return saveConfig(cfg);
}

/**
 * deprecated
 */
function RESOLVE_SYNC_COLUMNS(sheetName) {
  return { found: false, statusCol: 0, idCol: 0, urlCol: 0 };
}

/**
 * deprecated
 */
async function _GET_ROW_SOURCE_PDF_DEPRECATED(rowNumber) {
  return { ok: false, error: 'Deprecated.' };
}

/* ------------------------------------------------------------------ *
 * Sidebar orchestration (PDF-overlay signing job).
 * ------------------------------------------------------------------ */

/**
 * Returns the row data map for a row (used to seed signer emails).
 */
function GET_ROW_DATA(rowNumber) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cfg = readConfig();
    var sheet = cfg.dataSheetName ? ss.getSheetByName(cfg.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return { ok: false, error: 'Sheet not found.' };
    }
    var headerRow = cfg.headerRow || 1;
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
    var values = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    var data = {};
    headers.forEach(function (h, i) {
      data[String(h)] = values[i];
    });
    return { ok: true, rowNumber: rowNumber, headers: headers, data: data };
  } catch (err) {
    Logger.log('GET_ROW_DATA error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Creates a signing job (persisted, tokenized) from a source PDF + config.
 * @param {Object} payload { fileId, config, rowNumber } — fileId is the source PDF.
 * @return {Object} { ok, jobId, docName, sourcePdfId, slots:[{slot,label,signerEmail,signUrl,...}] }
 */
async function CREATE_SIGNING_JOB(payload) {
  try {
    payload = payload || {};
    var fileId = NORMALIZE_FILE_ID(payload.fileId || '');
    var config = payload.config || readConfig();
    if (!fileId) {
      return { ok: false, error: 'No source PDF selected.' };
    }

    var probe = await PROBE_DOC_ACCESS(fileId);
    if (!probe.ok) {
      return { ok: false, error: 'Cannot open the selected PDF: ' + (probe.error || 'permission denied') };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = _getDataSheet(ss, config);
    if (!sheet) {
      return { ok: false, error: 'Data sheet not found.' };
    }
    config = _resolveConfigColumns(sheet, config);

    var rowNumber = Number(payload.rowNumber) || 0;
    if (!rowNumber) {
      rowNumber = GET_ACTIVE_ROW();
    }

    return await _createAndWriteJob(sheet, rowNumber, fileId, config, 'Selected PDF');
  } catch (err) {
    Logger.log('CREATE_SIGNING_JOB error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Shared job-creation core (manual button AND auto-sync path).
 * Creates the job record, shares the source PDF for signer preview, writes the
 * sign links into the link columns, and sets 'DocuPDF Status'.
 * @param {Object} sheet
 * @param {number} rowNumber
 * @param {string} fileId
 * @param {Object} config  (columns already resolved)
 * @param {string} [sourceLabel] human label of where the id came from (for errors)
 * @return {Object} { ok, jobId, docName, sourcePdfId, sharedForPreview, linksWritten, slots }
 */
function _createAndWriteJob(sheet, rowNumber, fileId, config, sourceLabel) {
  try {
    var probe = _probeDocSync(fileId);
    if (!probe.ok) {
      return { ok: false, error: (sourceLabel ? sourceLabel + ' (' + fileId + '): ' : '') + 'Cannot open the source PDF: ' + (probe.error || 'permission denied') + '. Under the app\'s drive.file scope the file must be picked via the 📁 Pick PDF button (or created by this add-on) — pasting a link to an arbitrary file does not grant access. Re-pick it in the E-sign wizard.', fileId: fileId };
    }

    // Migration for types/sheets configured before the per-slot status columns
    // existed: create them on first job, then persist the resolved indices back
    // into the type so later jobs (and the wizard) see them.
    var statusCols = _ensureSignerStatusColumns(sheet, config);
    var declineCols = _ensureDeclineReasonColumns(sheet, config);
    var pdfLinkCols = _ensurePdfLinkColumns(sheet, config);
    var newCols = [].concat(statusCols.added || [], declineCols.added || [], pdfLinkCols.added || []);
    if (newCols.length) {
      _persistConfig(config);
      LOG_AUDIT_EVENT('SETUP', {
        docId: sheet.getSheetId(),
        docName: sheet.getName(),
        status: 'Columns added',
        details: 'Added columns: ' + newCols.join(', ')
      });
    }

    var headerRow = config.headerRow || 1;
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0].map(String);
    var values = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    var data = {};
    headers.forEach(function (h, i) {
      data[h] = values[i];
    });

    var docName = '';
    if (config.docNameColumn > 0 && headers[config.docNameColumn - 1]) {
      docName = String(data[headers[config.docNameColumn - 1]] || '').trim();
    }
    docName = docName || probe.name.replace(/\.[^.]*$/, '');

    // A4: auto-fill the Doc Name cell when blank so the sheet self-documents.
    if (config.docNameColumn > 0) {
      try {
        var curDocName = String(sheet.getRange(rowNumber, config.docNameColumn).getValue() || '').trim();
        if (!curDocName) {
          sheet.getRange(rowNumber, config.docNameColumn).setValue(docName);
        }
      } catch (e) {
        Logger.log('_createAndWriteJob docName write error: %s', e.message);
      }
    }

    var outputFolderId = config.outputFolderId || '';
    if (outputFolderId) {
      // A folder id typed into the wizard is NOT picker-granted, so under
      // drive.file it may well be invisible to the app. Verify before writing.
      var folderProbe = _driveFetchMeta(outputFolderId);
      if (!folderProbe.ok) {
        return {
          ok: false,
          fileId: fileId,
          error: "This type's output folder is not accessible to the app. Paste a valid Drive folder ID (from drive.google.com/drive/folders/…) or clear the field to use the app's default folder."
        };
      }
      if (folderProbe.mime && folderProbe.mime !== 'application/vnd.google-apps.folder') {
        return {
          ok: false,
          fileId: fileId,
          error: 'The configured output folder ID (' + outputFolderId + ') is a ' + folderProbe.mime + ', not a folder. Pick a Drive folder instead.'
        };
      }
    } else {
      var newFolder = _driveCreateFolder(APP_NAME + ' — Signed');
      if (!newFolder.ok) {
        Logger.log('_createAndWriteJob folder error: %s', newFolder.error);
        return {
          ok: false,
          fileId: fileId,
          error: 'Could not create the signed-PDF folder in Drive: ' + (newFolder.error || 'Drive API error') +
            '. Paste a valid Drive folder ID in Step 6, or clear it to use the app\'s default folder.'
        };
      }
      outputFolderId = newFolder.id;
      config.outputFolderId = outputFolderId;
      _persistConfig(config);
    }

    var slots = [];
    function cell(colNum) {
      return (colNum > 0 && headers[colNum - 1]) ? String(data[headers[colNum - 1]] || '').trim() : '';
    }

    var placement = config.slotPlacement || {};
    var pA = placement.A || {};
    var pB = placement.B || {};

    var emailA = cell(config.signerEmailColumn);
    if (!emailA) {
      return { ok: false, error: 'Party A signer email is empty for row ' + rowNumber + '.' };
    }
    if (config.linkAColumn > 0) {
      var existingLink = String(sheet.getRange(rowNumber, config.linkAColumn).getDisplayValue() || '').trim();
      if (existingLink) {
        return { ok: false, error: 'Row ' + rowNumber + ' already has a sign link. Clear it first (use Clear all / the row delete button) before creating a new request.' };
      }
    }
    slots.push({
      label: 'Party A',
      signerEmail: emailA,
      signerName: cell(config.signerNameColumn),
      signerDesignation: cell(config.signerADesignationColumn),
      signerCompany: cell(config.signerACompanyColumn),
      page: Number(pA.page) || 0,
      align: pA.align || 'center',
      vOffset: Number(pA.vOffset) || 0.85
    });

    var emailB = cell(config.signerBEmailColumn);
    if (emailB) {
      slots.push({
        label: 'Party B',
        signerEmail: emailB,
        signerName: cell(config.signerBNameColumn),
        signerDesignation: cell(config.signerBDesignationColumn),
        signerCompany: cell(config.signerBCompanyColumn),
        page: Number(pB.page) || 0,
        align: pB.align || 'center',
        vOffset: Number(pB.vOffset) || 0.85
      });
    }

    var ss = sheet.getParent();
    var ownerEmail = '';
    try {
      ownerEmail = SpreadsheetApp.getActiveUser().getEmail() || '';
    } catch (e) {
      Logger.log('_createAndWriteJob owner email error: %s', e.message);
    }
    if (!ownerEmail && config.notifyOwnerEmail) {
      ownerEmail = config.notifyOwnerEmail;
    }
    var record = _createJobRecord({
      sourcePdfId: fileId,
      outputFolderId: outputFolderId,
      docName: docName,
      spreadsheetId: ss ? ss.getId() : '',
      dataSheetName: sheet.getName(),
      rowNumber: rowNumber,
      statusColumn: config.statusColumn || 0,
      signerAStatusColumn: config.signerAStatusColumn || 0,
      signerBStatusColumn: config.signerBStatusColumn || 0,
      signerADeclineReasonColumn: config.signerADeclineReasonColumn || 0,
      signerBDeclineReasonColumn: config.signerBDeclineReasonColumn || 0,
      documentSignedColumn: config.documentSignedColumn || 0,
      workingPdfColumn: config.workingPdfColumn || 0,
      signedPdfColumn: config.signedPdfColumn || 0,
      ownerEmail: ownerEmail,
      notifyOwner: config.notifyOnFinalize !== false,
  emailWorkingToSigners: (config.emailWorkingToSigners === false) ? false : true,
  emailFinalToSigners: (config.emailFinalToSigners === false) ? false : true,
      typeId: config.id || '',
      typeName: config.name || '',
      slots: slots
    });

    // Snapshot the email/brand/signing config on the record so dispatch can
    // run from web-app context (sequential B, reminders, QR, branding) without
    // a container lookup.
    record.email = {
      subject: config.emailSubject || 'Please sign: {docName}',
      body: config.emailBody || 'Hi {signerName}, please review and sign {docName}. Link: {signUrl}',
      companyName: config.companyName || '',
      replyTo: config.replyToEmail || '',
      attachSourcePdf: config.attachSourcePdf !== false,
      qrInEmail: config.qrInEmail !== false
    };
    record.brand = {
      logoUrl: config.logoUrl || '',
      brandColor: config.brandColor || '#1a73e8'
    };
    record.signing = {
      textFieldLabel: config.signerTextFieldLabel || '',
      initialsEnabled: config.initialsEnabled !== false,
      sequentialSigning: config.sequentialSigning === true,
      reminderDays: Number(config.reminderDays) || 0,
      trackOpens: config.trackOpens === true,
      emailWorkingToSigners: (config.emailWorkingToSigners === false) ? false : true,
      emailFinalToSigners: (config.emailFinalToSigners === false) ? false : true
    };
    _saveJobRecord(record);

    LOG_AUDIT_EVENT('JOB', {
      docId: record.jobId,
      docName: docName,
      status: 'Created',
      details: 'Source PDF: ' + fileId + ' | Row: ' + rowNumber + ' | Slots: ' + record.slots.length + ' | Type: ' + (config.id || '')
    });

    // Public Drive sharing is only needed for documents too large to preview
    // inline (?action=pdf falls back to the Drive viewer above the cap). Under
    // the app's drive.file scope DriveApp.Access.ANYONE_WITH_LINK always threw
    // and the failure was swallowed, so use the REST permissions endpoint
    // instead — and surface a failure instead of hiding it.
    var metaForSize = _driveFetchMeta(fileId);
    var sizeBytes = Number(metaForSize && metaForSize.size) || 0;
    var needsDriveShare = sizeBytes > PREVIEW_INLINE_MAX_BYTES;
    var shareRes = { ok: false, error: 'not needed' };
    if (needsDriveShare && config.shareSourcePdf !== false) {
      shareRes = _driveSetViewerPermission(fileId);
      if (!shareRes.ok) {
        Logger.log('_createAndWriteJob share warning: %s', shareRes.error);
        LOG_AUDIT_EVENT('SHARE', {
          docId: record.jobId,
          docName: docName,
          status: 'Failed',
          details: 'This document is larger than the inline preview limit (' +
            Math.round(PREVIEW_INLINE_MAX_BYTES / (1024 * 1024)) + ' MB) so its preview needs ' +
            '"anyone with link" sharing, which could not be granted: ' + shareRes.error +
            '. The signer must open the PDF from the email attachment. Type: ' + (config.id || '')
        });
      }
    } else if (needsDriveShare) {
      shareRes = { ok: false, error: 'sharing disabled for this type (shareSourcePdf = false)' };
    }
    if (shareRes.ok) {
      LOG_AUDIT_EVENT('SHARE', {
        docId: record.jobId,
        docName: docName,
        status: 'Shared',
        details: 'Source PDF viewable by anyone with the link (signer preview, document is over the ' +
          Math.round(PREVIEW_INLINE_MAX_BYTES / (1024 * 1024)) + ' MB inline limit). Type: ' + (config.id || '')
      });
    }
    // Remember whether Drive is a usable preview fallback for oversized
    // documents, so ?action=pdf never bounces a signer into a Google login
    // wall when the share was refused.
    record.previewShareOk = needsDriveShare ? shareRes.ok : false;
    record.previewShareError = needsDriveShare && !shareRes.ok ? shareRes.error : '';
    _saveJobRecord(record);

    var linkRes = _writeSignLinks(record, config);
    if (linkRes.ok) {
      UPDATE_SHEET_STATUS(record, 'Awaiting signature', config);
      record.slots.forEach(function (s, i) {
        _updateSignerStatus(record, i, 'Awaiting');
      });
    } else {
      Logger.log('_createAndWriteJob link-column warning: %s', linkRes.error);
      LOG_AUDIT_EVENT('LINK_WRITE', {
        docId: record.jobId,
        docName: docName,
        status: 'Skipped',
        details: linkRes.error + ' Type: ' + (config.id || '')
      });
    }

    var emailResults = [];
    if (linkRes.ok) {
      emailResults = _maybeAutoSend(record, config);
    } else {
      LOG_AUDIT_EVENT('EMAIL', {
        docId: record.jobId,
        docName: docName,
        status: 'Skipped',
        details: 'Emails skipped because sign links were not written: ' + linkRes.error
      });
    }

    var outSlots = [];
    try {
      outSlots = record.slots.map(function (s) {
        return {
          slot: s.slot,
          label: s.label,
          signerEmail: s.signerEmail,
          signUrl: _buildSignUrl(record, s),
          page: s.page,
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height
        };
      });
    } catch (e) {
      Logger.log('_createAndWriteJob slot-url warning: %s', e.message);
    }
    return {
      ok: true,
      jobId: record.jobId,
      docName: docName,
      sourcePdfId: fileId,
      rowNumber: rowNumber,
      sharedForPreview: shareRes.ok,
      linksWritten: linkRes.ok,
      linkError: linkRes.error || '',
      previewWarning: needsDriveShare && !shareRes.ok ? ('Preview for this oversized document needs Drive "anyone with link" sharing, which could not be granted: ' + shareRes.error + '. The signer must open the PDF from the email attachment.') : '',
      emailsSent: emailResults.filter(function (r) { return r && r.ok; }).length,
      emailErrors: emailResults.filter(function (r) { return r && !r.ok; }).map(function (r) { return r.error; }),
      slots: outSlots
    };
  } catch (err) {
    Logger.log('_createAndWriteJob error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Writes each slot's sign link into the configured sheet columns for the row.
 * DocuMail Pro (or the user) reads these cells to embed the link in emails.
 * @return {Object} { ok, written: [{slot, column, value}] , error? }
 */
function _writeSignLinks(record, config) {
  try {
    if (!record.spreadsheetId || !record.dataSheetName || !record.rowNumber) {
      return { ok: false, error: 'Job has no row mapping; links not written.' };
    }
    var ss = _openSpreadsheet(record.spreadsheetId);
    if (!ss) {
      return { ok: false, error: 'Could not open the data spreadsheet to write sign links.' };
    }
    var sheet = ss.getSheetByName(record.dataSheetName);
    if (!sheet) {
      return { ok: false, error: 'Data sheet "' + record.dataSheetName + '" not found.' };
    }
    config = _resolveConfigColumns(sheet, config);
    var cols = [config.linkAColumn || 0, config.linkBColumn || 0];
    var written = [];
    record.slots.forEach(function (slot, i) {
      var colNum = cols[i] || 0;
      if (colNum > 0 && slot.signerEmail) {
        sheet.getRange(record.rowNumber, colNum).setValue(_buildSignUrl(record, slot));
        written.push({ slot: slot.slot, column: colNum, value: _buildSignUrl(record, slot) });
      }
    });
    if (written.length === 0) {
      var hdrList = sheet.getRange(config.headerRow || 1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String).join(', ');
      return { ok: false, error: 'No link columns configured (linkAColumn/linkBColumn). Sheet "' + record.dataSheetName + '" headers: ' + hdrList };
    }
    LOG_AUDIT_EVENT('LINK_WRITE', {
      docId: record.jobId,
      docName: record.docName,
      status: 'Written',
      details: 'Sign links written to sheet row ' + record.rowNumber + ' (' + written.length + ' columns). Type: ' + (config.id || '')
    });
    return { ok: true, written: written };
  } catch (err) {
    Logger.log('_writeSignLinks error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Dispatches signature-request emails for all slots of a job.
 * @param {Object} payload { jobId, config }
 * @return {Object} { ok, links: [{slot, label, signUrl, sentTo}] }
 */
function RUN_DISPATCH(payload) {
  try {
    payload = payload || {};
    var record = _getJobRecord(payload.jobId);
    if (!record) {
      return { ok: false, error: 'Job not found.' };
    }
    var config = payload.config || readConfig();
    var results = [];
    var failed = [];

    record.slots.forEach(function (slot, i) {
      var isSeqR2 = (record.signing && record.signing.sequentialSigning === true) && record.slots.length > 1;
      if (isSeqR2 && i > 0) return; // defer sequential
      var res = _dispatchSlot(record, slot, config);
      if (res.ok) {
        results.push(res);
      } else {
        failed.push(slot.label + ': ' + res.error);
      }
    });

    return {
      ok: failed.length === 0,
      links: results,
      errors: failed,
      partial: results.length > 0 && failed.length > 0
    };
  } catch (err) {
    Logger.log('RUN_DISPATCH error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Builds the one-time signer URL for a slot.
 * @return {String} the tokenized web-app URL.
 */
function _buildSignUrl(record, slot) {
  var serviceUrl = _serviceBaseUrl();
  return serviceUrl +
    '?job=' + encodeURIComponent(record.jobId) +
    '&signToken=' + encodeURIComponent(slot.signToken) +
    '&nonce=' + encodeURIComponent(slot.nonce);
}

function _dispatchSlot(record, slot, config) {
  try {
    if (!slot.signerEmail) {
      return { ok: false, error: 'No email for slot ' + slot.label };
    }
    var signUrl = _buildSignUrl(record, slot);
    var tplVars = {
      docName: record.docName,
      signUrl: signUrl,
      signerName: slot.signerName || 'there',
      signerDesignation: slot.signerDesignation || '',
      signerEmail: slot.signerEmail || '',
      slotLabel: slot.label,
      companyName: config.companyName || ''
    };

    var subject = _renderEmailTemplate(config.emailSubject || 'Please sign: {docName}', tplVars);
    var bodyText = _renderEmailTemplate(config.emailBody || 'Hi {signerName}, please review and sign {docName}. Link: {signUrl}', tplVars);

    var opts = {
      name: config.companyName ? config.companyName + ' — DocuPDF Sign' : 'DocuPDF Sign'
    };
    if (config.replyToEmail) {
      opts.replyTo = config.replyToEmail;
    }
    var hasAttachment = false;
    // Prefer working PDF if available (sequential B after A signed)
    if (record.workingPdfId) {
      try {
        var w = _driveReadPdf(record.workingPdfId);
        if (w.ok) {
          opts.attachments = [Utilities.newBlob(w.bytes, 'application/pdf', (w.name || (record.docName.replace(/\.[^.]*$/, '') + '_WORKING')) + '.pdf')];
          hasAttachment = true;
        }
      } catch (e) {
        Logger.log('_dispatchSlot attach working warning: %s', e.message);
      }
    }
    if (!hasAttachment && config.attachSourcePdf !== false && record.sourcePdfId) {
      try {
        var srcRead = _driveReadPdf(record.sourcePdfId);
        if (srcRead.ok) {
          opts.attachments = [Utilities.newBlob(srcRead.bytes, 'application/pdf', (srcRead.name || 'document') + '.pdf')];
          hasAttachment = true;
        }
      } catch (e) {
        Logger.log('_dispatchSlot attach warning: %s', e.message);
      }
    }

    // B6 branding + B8 QR inline image in the HTML email.
    var logoUrl = config.logoUrl || '';
    var displayLabel = slot.label === 'Party A' ? 'Signer A'
      : slot.label === 'Party B' ? 'Signer B'
      : slot.label;
    var hasB = record.slots.length > 1;
    var roleText;
    if (displayLabel === 'Signer B') {
      roleText = 'You are Signer B. The document will be finalized after you sign.';
    } else if (hasB) {
      roleText = 'You are Signer A, and without your sign, the file cannot be sent to Signer B for signing.';
    } else {
      roleText = 'You are Signer A.';
    }
    var htmlOpts = {
      signerName: slot.signerName || 'there',
      signerDesignation: slot.signerDesignation || '',
      docName: record.docName,
      slotLabel: displayLabel,
      roleText: roleText,
      signUrl: signUrl,
      companyName: config.companyName || '',
      brandColor: config.brandColor || '#1a73e8',
      hasAttachment: hasAttachment,
      logoHtml: /^https?:\/\//.test(logoUrl)
        ? '<img src="' + logoUrl + '" alt="' + (config.companyName || '') + '" style="max-height:48px;max-width:220px;display:block;margin:0 0 8px">'
        : ''
    };
    if (config.qrInEmail !== false) {
      try {
        var qrBytes = _fetchQrPng('https://quickchart.io/qr?text=' + encodeURIComponent(signUrl) + '&size=120&margin=0&qzone=1');
        if (qrBytes) {
          opts.inlineImages = { qr: Utilities.newBlob(qrBytes, 'image/png', 'qr.png') };
          htmlOpts.qrHtml = '<tr><td style="padding:8px 24px">' +
            '<img src="cid:qr" width="120" height="120" alt="Scan to sign" style="border:1px solid #e0e0e0;border-radius:6px">' +
            '<div style="color:#80868b;font-size:11px;margin-top:4px">Scan the QR code to Review &amp; Sign the document on your phone.</div></td></tr>';
        }
      } catch (e) {
        Logger.log('_dispatchSlot qr warning: %s', e.message);
      }
    }
    var htmlBody = _buildHtmlEmail(htmlOpts);
    bodyText = _buildRequestEmailText(htmlOpts);
    opts.htmlBody = htmlBody;
    GmailApp.sendEmail(slot.signerEmail, subject, bodyText, opts);

    LOG_AUDIT_EVENT('DISPATCH', {
      docId: record.jobId,
      docName: record.docName,
      signer: slot.signerEmail,
      status: 'Sent',
      details: 'Slot ' + slot.slot + ' (' + slot.label + '). Mode: native. Attach: ' + (opts.attachments ? 'yes' : 'no') + '. Type: ' + (config.id || '')
    });

    return {
      ok: true,
      slot: slot.slot,
      label: slot.label,
      sentTo: slot.signerEmail,
      signUrl: signUrl,
      expiresAt: new Date(record.expiresAt).toISOString()
    };
  } catch (err) {
    Logger.log('_dispatchSlot error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Standalone mode: emails each slot the sign link (and the unsigned PDF).
 * DocuMail mode: no-op (DocuMail sends; DocuPDF only writes links).
 * @return {Array} results from _dispatchSlot
 */
function _maybeAutoSend(record, config) {
  if (config.autoSendEmail !== true || config.sourceMode === 'documail') {
    return [];
  }
  var results = [];
  var seq = config.sequentialSigning === true && record.slots.length > 1;
  record.slots.forEach(function (slot, i) {
    if (seq && i > 0) return; // Party B deferred until A signs (B5)
    results.push(_dispatchSlot(record, slot, config));
  });
  return results;
}

/**
 * Builds a minimal config object from the record's email/brand snapshot, so
 * _dispatchSlot / reminders can run from web-app context (execute-as-ME).
 */
function _cfgFromRecord(record) {
  var e = record.email || {};
  var b = record.brand || {};
  return {
    id: record.typeId || '',
    name: record.typeName || '',
    sourceMode: 'standalone',
    autoSendEmail: true,
    emailSubject: e.subject || 'Please sign: {docName}',
    emailBody: e.body || 'Hi {signerName}, please review and sign {docName}. Link: {signUrl}',
    companyName: e.companyName || '',
    replyToEmail: e.replyTo || '',
    attachSourcePdf: e.attachSourcePdf !== false,
    qrInEmail: e.qrInEmail !== false,
    logoUrl: b.logoUrl || '',
    brandColor: b.brandColor || '#1a73e8',
    emailWorkingToSigners: true,
    emailFinalToSigners: true
  };
}

/* ------------------------------------------------------------------ *
 * Email rendering helpers.
 * ------------------------------------------------------------------ */

/**
 * Emails the owner when the signed PDF is ready. Runs in web-app context
 * (execute-as-ME), so it uses only data already on the job record.
 * @param {Object} record
 * @param {Object} finalFile { id, name, url } from the Drive REST write
 * @param {Array<number>} finalBytes In-memory PDF bytes (attached as-is, so the
 *   file is not re-downloaded from Drive).
 */
function _notifyOwnerSigned(record, finalFile, finalBytes) {
  try {
    if (record.notifyOwner === false) {
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: record.ownerEmail || '',
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification skipped: notifyOwner is false.'
        });
      } catch (e) {}
      return;
    }
    var to = record.ownerEmail || '';
    if (!to) {
      try {
        var cfgFallback = typeof readConfig === 'function' ? readConfig() : {};
        if (cfgFallback && cfgFallback.notifyOwnerEmail) {
          to = cfgFallback.notifyOwnerEmail;
        }
      } catch (e) {}
    }
    if (!to) {
      try {
        to = Session.getActiveUser().getEmail() || '';
      } catch (e) {}
    }
    if (!to) {
      Logger.log('_notifyOwnerSigned skipped: no owner email on record.');
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: to,
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification skipped: no owner email available.'
        });
      } catch (e) {}
      return;
    }
    var signedUrl = finalFile.url;
    var subject = 'DocuPDF Sign — ' + record.docName + ' is signed';
    var integrityHash = record.finalHash || record.audit && record.audit.hash || '';
    var verifyLink = WEB_APP_BASE_URL + '?action=verify&job=' +
      encodeURIComponent(record.jobId) + '&hash=' + integrityHash;
    var bodyText =
      'Your document "' + record.docName + '" has been signed by all parties.\n\n' +
      'Signed PDF: ' + signedUrl + '\n\n' +
      'Job: ' + record.jobId + '\n' +
      'Signers: ' + record.slots.map(function (s) { return s.signerEmail; }).join(', ') + '\n\n' +
      'Integrity (tamper-evidence):\n' +
      'SHA-256 of the final signed PDF: ' + integrityHash + '\n' +
      'Verify: ' + verifyLink + '\n' +
      'Keep this hash in a safe place. If the PDF is ever edited, its SHA-256 will change and will no longer match this value.';
    var htmlBody =
      '<p>Your document <strong>' + record.docName + '</strong> has been signed by all parties.</p>' +
      '<p><a href="' + signedUrl + '" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">Open signed PDF</a></p>' +
      '<p style="color:#5f6368;font-size:13px">Job: ' + record.jobId +
      '<br>Signers: ' + record.slots.map(function (s) { return s.signerEmail; }).join(', ') + '</p>' +
      '<p style="color:#5f6368;font-size:13px;border:1px solid #dadce0;border-radius:6px;padding:8px 12px">' +
      '<strong>Tamper-evidence (SHA-256):</strong><br>' + integrityHash +
      '<br><a href="' + verifyLink + '">Verify this document online</a> — keep this hash; any edit to the PDF changes it.</p>';
    var opts = { htmlBody: htmlBody, name: 'DocuPDF Sign' };
    try {
      if (finalBytes && finalBytes.length) {
        opts.attachments = [Utilities.newBlob(finalBytes, 'application/pdf', finalFile.name || 'signed.pdf')];
      }
    } catch (e) {
      Logger.log('_notifyOwnerSigned attach warning: %s', e.message);
    }
    try {
      GmailApp.sendEmail(to, subject, bodyText, opts);
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: to,
        status: 'Notified',
        spreadsheetId: record.spreadsheetId,
        details: 'Owner notified that the signed PDF is ready.'
      });
    } catch (sendErr) {
      Logger.log('_notifyOwnerSigned error: %s', sendErr.message);
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: to,
          status: 'Failed',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification failed: ' + sendErr.message
        });
      } catch (e) {}
    }
  } catch (err) {
    Logger.log('_notifyOwnerSigned error: %s', err.message);
    try {
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: record.ownerEmail || '',
        status: 'Failed',
        spreadsheetId: record.spreadsheetId,
        details: 'Owner notification failed: ' + err.message
      });
    } catch (e) {}
  }
}

function _notifyOwnerDeclined(record, slot, reason) {
  try {
    if (record.notifyOwner === false) {
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: record.ownerEmail || '',
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification skipped: notifyOwner is false.'
        });
      } catch (e) {}
      return;
    }
    var to = record.ownerEmail || '';
    if (!to) {
      // Fallback chain: record snapshot from _cfgFromRecord not stored; try to resolve from type config? but we don't have type here
      // Try to read from config if available via readConfig? but may not have sheet context; fallback to empty
      try {
        var cfgFallback = typeof readConfig === 'function' ? readConfig() : {};
        if (cfgFallback && cfgFallback.notifyOwnerEmail) {
          to = cfgFallback.notifyOwnerEmail;
        }
      } catch (e) {}
    }
    if (!to) {
      try {
        to = Session.getActiveUser().getEmail() || '';
      } catch (e) {}
    }
    if (!to) {
      Logger.log('_notifyOwnerDeclined skipped: no owner email on record.');
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: to,
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification skipped: no owner email available.'
        });
      } catch (e) {}
      return;
    }
    var declinedBy = slot.signerEmail || slot.label || 'A signer';
    var subject = 'DocuPDF Sign — ' + record.docName + ' was declined';
    var bodyText =
      'A signer declined to sign "' + record.docName + '".\n\n' +
      'Declined by: ' + declinedBy + '\n' +
      'Reason: ' + reason + '\n\n' +
      'Job: ' + record.jobId + '\n' +
      'The row is marked "Declined" in the data sheet; clear the row\'s sign link before sending a new request.';
    var htmlBody =
      '<p>A signer declined to sign <strong>' + _esc(record.docName) + '</strong>.</p>' +
      '<p><strong>Declined by:</strong> ' + _esc(declinedBy) + '<br>' +
      '<strong>Reason:</strong> ' + _esc(reason) + '</p>' +
      '<p style="color:#5f6368;font-size:13px">Job: ' + _esc(record.jobId) +
      '<br>The row is marked "Declined" in the data sheet; clear the row\'s sign link before sending a new request.</p>';
    try {
      GmailApp.sendEmail(to, subject, bodyText, { htmlBody: htmlBody, name: 'DocuPDF Sign' });
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: to,
        status: 'Notified',
        spreadsheetId: record.spreadsheetId,
        details: 'Owner notified that ' + declinedBy + ' declined. Reason: ' + reason
      });
    } catch (sendErr) {
      Logger.log('_notifyOwnerDeclined error: %s', sendErr.message);
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: to,
          status: 'Failed',
          spreadsheetId: record.spreadsheetId,
          details: 'Owner notification failed: ' + sendErr.message
        });
      } catch (e) {}
    }
  } catch (err) {
    Logger.log('_notifyOwnerDeclined error: %s', err.message);
    try {
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: record.ownerEmail || '',
        status: 'Failed',
        spreadsheetId: record.spreadsheetId,
        details: 'Owner notification failed: ' + err.message
      });
    } catch (e) {}
  }
}

function _renderEmailTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (m, key) {
    return vars[key] !== undefined ? vars[key] : m;
  });
}

/**
 * Plain-text version of the sign-request email (matches the HTML body).
 * @param {Object} o { signerName, signerDesignation, docName, roleText, signUrl }
 */
function _buildRequestEmailText(o) {
  var lines = [
    'Dear ' + (o.signerName || 'there') + (o.signerDesignation ? ' (' + o.signerDesignation + ')' : '') + ',',
    '',
    'You are requested to review and sign the PDF Document ' + (o.docName || 'your document') + '.',
    '',
    o.roleText || '',
    ''
  ];
  if (o.hasAttachment) {
    lines.push('The original unsigned document is attached to this email for your review, before you proceed to sign.');
    lines.push('');
  }
  lines = lines.concat([
    'Review & Sign: ' + o.signUrl,
    '',
    'If you are not able to click the button, use the link above or scan the QR Code to Review & Sign the document.',
    '',
    'Note: This link is single-use and expires in 7 days. Your signature is applied to the document by the sender. If you did not expect this request, ignore or delete this email.',
    '',
    'Legal notice: Documents signed through this service are electronically signed and are legally recognized and admissible as evidence under applicable law, including the Information Technology Act, 2000 (India), the Bharatiya Sakshya Adhiniyam, 2023, the U.S. ESIGN Act, and the EU eIDAS Regulation. Please retain this email and the signed PDF for your records.',
    '',
    'Powered by DocuPDF Sign — https://apps.pwmai.com/docupdf-sign/',
    'Privacy Policy — https://apps.pwmai.com/privacy-policy/',
    'Data stays in your Google Workspace, nothing stored externally.'
  ]);
  return lines.join('\n');
}

/**
 * Structured HTML sign-request email: salutation, document, signer role,
 * a Review & Sign button, the plain link fallback, the QR code, and a footer.
 * @param {Object} o { signerName, signerDesignation, docName, roleText,
 *                     signUrl, companyName, brandColor, logoHtml, qrHtml }
 */
function _buildHtmlEmail(o) {
  var signerName = o.signerName || 'there';
  var desig = o.signerDesignation ? ' (' + o.signerDesignation + ')' : '';
  var docName = o.docName || 'your document';
  var roleText = o.roleText || '';
  var signUrl = o.signUrl || '';
  var companyName = o.companyName || '';
  var brandColor = o.brandColor || '#1a73e8';
  var logoHtml = o.logoHtml || '';
  var qrHtml = o.qrHtml || '';
  var attachNote = o.hasAttachment
    ? '<p style="margin:0 0 24px;background:#e6f4ea;border:1px solid #b7dfbf;border-radius:6px;padding:10px 14px;color:#137333;font-size:13px;line-height:1.5">The original unsigned document is attached to this email for your review, before you proceed to sign.</p>'
    : '';
  var cta = '<a href="' + signUrl + '" style="display:inline-block;background:' + brandColor + ';color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">Review &amp; Sign</a>';
  return [
    '<!DOCTYPE html><html><body style="font-family:Roboto,Arial,sans-serif;background:#f8f9fa;margin:0;padding:24px;color:#202124">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 1px 3px rgba(60,64,67,.3);overflow:hidden">',
    '<tr><td style="padding:24px;border-bottom:1px solid #e0e0e0">',
    logoHtml,
    '<h2 style="margin:0;color:' + brandColor + '">DocuPDF Sign</h2>',
    '<div style="color:#5f6368;font-size:13px">' + (companyName ? companyName + ' · ' : '') + 'Signature request</div>',
    '</td></tr>',
    '<tr><td style="padding:24px">',
    '<p style="margin:0 0 16px;font-size:14px">Dear <strong>' + signerName + '</strong>' + desig + ',</p>',
    '<p style="margin:0 0 16px;font-size:14px;line-height:1.6">You are requested to review and sign the PDF Document <strong>' + docName + '</strong>.</p>',
    attachNote,
    '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">' + roleText + '</p>',
    '<p style="margin:0 0 24px">' + cta + '</p>',
    qrHtml,
    '<p style="margin:16px 0 8px;font-size:13px;color:#202124">If you are not able to click the button, use the link below or scan the QR Code to Review &amp; Sign the document:</p>',
    '<p style="margin:0 0 16px;font-size:12px"><a href="' + signUrl + '" style="color:#1a73e8;word-break:break-all">' + signUrl + '</a></p>',
    '<p style="margin:0 0 16px;color:#80868b;font-size:12px;line-height:1.5">Note: This link is single-use and expires in 7 days. Your signature is applied to the document by the sender. If you did not expect this request, ignore or delete this email.</p>',
    '<p style="margin:0 0 0;background:#fef7e0;border:1px solid #fde293;border-radius:6px;padding:10px 14px;color:#8a6d00;font-size:11px;line-height:1.5">Legal notice: Documents signed through this service are electronically signed and are legally recognized and admissible as evidence under applicable law, including the Information Technology Act, 2000 (India), the Bharatiya Sakshya Adhiniyam, 2023, the U.S. ESIGN Act, and the EU eIDAS Regulation. Please retain this email and the signed PDF for your records.</p>',
    '</td></tr>',
    '<tr><td style="padding:12px 24px;background:#f1f3f4;color:#80868b;font-size:11px">Powered by <a href="https://apps.pwmai.com/docupdf-sign/" style="color:#1a73e8">DocuPDF Sign</a> &middot; &#128274; Data stays in your Google Workspace, nothing stored externally. &middot; <a href="https://apps.pwmai.com/privacy-policy/" style="color:#1a73e8">Privacy Policy</a></td></tr>',
    '</table></td></tr></table></body></html>'
  ].join('');
}

/* ------------------------------------------------------------------ *
 * In-person signing (B7): list pending jobs of a type, open on device.
 * ------------------------------------------------------------------ */

/**
 * Rows of a type's data sheet that are ready to sign (Party A email present,
 * no sign link written yet, not already signed/finalized). Drives the
 * Party B dropdown in the "Sign on this device" dialog.
 * @param {string} typeId
 * @return {Object} { ok, typeName?, sheetName?, candidates: [...], error? }
 */
function GET_SIGN_CANDIDATES(typeId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var type = _findType(_getTypes(), typeId);
    if (!type) {
      return { ok: false, error: 'E-sign type not found.' };
    }
    var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return { ok: false, error: 'Sheet "' + (type.dataSheetName || '') + '" not found.' };
    }
    var cfg = _resolveConfigColumns(sheet, type);
    var headerRow = cfg.headerRow || 1;
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var headers = (lastCol >= 1) ? sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0].map(String) : [];
    var cell = function (r, col) {
      if (!col || col > headers.length) return '';
      return String(sheet.getRange(r, col).getDisplayValue() || '').trim();
    };
    var candidates = [];
    for (var r = headerRow + 1; r <= lastRow; r++) {
      var emailA = cell(r, cfg.signerEmailColumn);
      if (!emailA) continue;
      var status = cell(r, cfg.statusColumn);
      if (status && /signed|finalized|declined/i.test(status)) continue;
      if (cell(r, cfg.linkAColumn)) continue; // already has a link
      candidates.push({
        rowNumber: r,
        partyAEmail: emailA,
        partyAName: cell(r, cfg.signerNameColumn),
        partyBEmail: cell(r, cfg.signerBEmailColumn),
        partyBName: cell(r, cfg.signerBNameColumn),
        docName: cell(r, cfg.docNameColumn) || ''
      });
    }
    return { ok: true, typeName: type.name || typeId, sheetName: sheet.getName(), candidates: candidates };
  } catch (err) {
    Logger.log('GET_SIGN_CANDIDATES error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Creates a signing job for ONE chosen row of a standalone type, using the
 * type's template PDF. Manual-pick path (standalone never auto-signs).
 * @param {string} typeId
 * @param {number} rowNumber
 * @return {Object} result from _createAndWriteJob
 */
function SIGN_SELECTED_ROW(typeId, rowNumber) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var type = _findType(_getTypes(), typeId);
    if (!type) {
      return { ok: false, error: 'E-sign type not found.' };
    }
    if (!type.templateFileId) {
      return { ok: false, error: 'This type has no template PDF — add one in the wizard (Step 3 📂 Browse).' };
    }
    var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return { ok: false, error: 'Sheet "' + (type.dataSheetName || '') + '" not found.' };
    }
    rowNumber = Number(rowNumber);
    if (!rowNumber) {
      return { ok: false, error: 'No row selected.' };
    }
    var cfg = _resolveConfigColumns(sheet, type);
    return _createAndWriteJob(sheet, rowNumber, NORMALIZE_FILE_ID(type.templateFileId), cfg, 'Type template');
  } catch (err) {
    Logger.log('SIGN_SELECTED_ROW error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Returns pending (unsigned) slots for an E-sign type in THIS spreadsheet.
 * @param {string} typeId
 * @return {Object} { ok, jobs: [{ jobId, row, slot, label, docName, signerEmail, url }] }
 */
function GET_PENDING_JOBS(typeId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ssId = ss.getId();
    var type = _findType(_getTypes(), typeId);
    var sheet = null;
    var emailCol = 0;
    if (type) {
      sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
      if (sheet) {
        emailCol = _resolveConfigColumns(sheet, type).signerEmailColumn || 0;
      }
    }
    var store = _getJobStore();
    var props = store.getProperties();
    var out = [];
    Object.keys(props).forEach(function (k) {
      if (k.indexOf(JOB_PREFIX) !== 0) return;
      var rec;
      try { rec = JSON.parse(props[k]); } catch (e) { return; }
      if (!rec || rec.typeId !== typeId || rec.spreadsheetId !== ssId || rec.finalized) return;
      var rowAlive = true;
      if (sheet && rec.rowNumber) {
        if (rec.rowNumber > sheet.getLastRow()) {
          rowAlive = false;
        } else if (emailCol > 0) {
          rowAlive = !!String(sheet.getRange(rec.rowNumber, emailCol).getDisplayValue() || '').trim();
        }
      }
      if (!rowAlive) {
        store.deleteProperty(k);
        return;
      }
      (rec.slots || []).forEach(function (slot) {
        if (slot.status !== 'pending') return;
        out.push({
          jobId: rec.jobId,
          row: rec.rowNumber,
          slot: slot.slot,
          label: slot.label,
          docName: rec.docName,
          signerName: slot.signerName || '',
          signerDesignation: slot.signerDesignation || '',
          signerEmail: slot.signerEmail,
          url: _buildSignUrl(rec, slot)
        });
      });
    });
    return { ok: true, jobs: out };
  } catch (err) {
    Logger.log('GET_PENDING_JOBS error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function DELETE_PENDING_JOB(jobId) {
  try {
    var store = _getJobStore();
    var key = JOB_PREFIX + jobId;
    if (!store.getProperty(key)) {
      return { ok: false, error: 'Sign request not found.' };
    }
    store.deleteProperty(key);
    return { ok: true };
  } catch (err) {
    Logger.log('DELETE_PENDING_JOB error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Deletes ONE slot's sign link from a pending job. If it was the last slot,
 * the whole job record is removed. Also clears the written link cell (and the
 * status cell) for that slot's row. (Per-link "Delete" button.)
 */
function DELETE_PENDING_SLOT(jobId, slotNum) {
  try {
    var store = _getJobStore();
    var key = JOB_PREFIX + jobId;
    var raw = store.getProperty(key);
    if (!raw) {
      return { ok: false, error: 'Sign request not found.' };
    }
    var rec = JSON.parse(raw);
    var removedSlot = null;
    (rec.slots || []).forEach(function (s) {
      if (String(s.slot) === String(slotNum)) { removedSlot = s; }
    });
    rec.slots = (rec.slots || []).filter(function (s) {
      return s.slot !== Number(slotNum);
    });
    if (!rec.slots.length) {
      store.deleteProperty(key);
    } else {
      store.setProperty(key, JSON.stringify(rec));
    }
    if (removedSlot) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var type = _findType(_getTypes(), rec.typeId);
      if (ss && type && rec.rowNumber) {
        var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
        if (sheet) {
          try {
            var cfg = _resolveConfigColumns(sheet, type);
            var col = (removedSlot.label === 'Party B') ? cfg.linkBColumn : cfg.linkAColumn;
            if (col > 0) { sheet.getRange(rec.rowNumber, col).clearContent(); }
            if (cfg.statusColumn > 0) { sheet.getRange(rec.rowNumber, cfg.statusColumn).clearContent(); }
            var stCol = (removedSlot.label === 'Party B') ? cfg.signerBStatusColumn : cfg.signerAStatusColumn;
            if (stCol > 0) { sheet.getRange(rec.rowNumber, stCol).clearContent(); }
            var drCol = (removedSlot.label === 'Party B') ? cfg.signerBDeclineReasonColumn : cfg.signerADeclineReasonColumn;
            if (drCol > 0) { sheet.getRange(rec.rowNumber, drCol).clearContent(); }
            if (cfg.workingPdfColumn > 0) { sheet.getRange(rec.rowNumber, cfg.workingPdfColumn).clearContent(); }
            if (cfg.signedPdfColumn > 0) { sheet.getRange(rec.rowNumber, cfg.signedPdfColumn).clearContent(); }
          } catch (e) {
            Logger.log('DELETE_PENDING_SLOT cell-clear warning: %s', e.message);
          }
        }
      }
    }
    return { ok: true };
  } catch (err) {
    Logger.log('DELETE_PENDING_SLOT error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Re-sends the signing email to ONE pending signer of a job (the "Resend"
 * button on a pending card). Reuses the same dispatch path as the original
 * email, so the signer gets a fresh copy of the same one-time link.
 * @param {string} jobId
 * @param {number} slotNum 1-based slot number.
 * @return {Object} { ok, email?, error? }
 */
function RESEND_SLOT_EMAIL(jobId, slotNum) {
  try {
    var record = _getJobRecord(jobId);
    if (!record) {
      return { ok: false, error: 'Sign request not found.' };
    }
    if (record.finalized) {
      return { ok: false, error: 'This document is already finalized.' };
    }
    var slot = null;
    (record.slots || []).forEach(function (s) {
      if (String(s.slot) === String(slotNum)) { slot = s; }
    });
    if (!slot) {
      return { ok: false, error: 'Signer not found in this request.' };
    }
    if (slot.signedAt) {
      return { ok: false, error: 'This signer already signed.' };
    }
    // Sequential gate: if sequential and resending slot > 0, require slot 0 signed
    var isSeqR = (record.signing && record.signing.sequentialSigning === true) && record.slots.length > 1;
    if (isSeqR) {
      var sidx = record.slots.indexOf(slot);
      if (sidx > 0) {
        var a0 = record.slots[0];
        if (a0 && a0.status !== 'signed') {
          return { ok: false, error: 'Party A must sign first (sequential signing).' };
        }
      }
    }
    var type = _findType(_getTypes(), record.typeId);
    if (!type) {
      return { ok: false, error: 'E-sign type not found.' };
    }
    var ss = _openSpreadsheet(record.spreadsheetId);
    if (!ss) {
      return { ok: false, error: 'Could not open the source spreadsheet.' };
    }
    var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return { ok: false, error: 'Sheet "' + (type.dataSheetName || '') + '" not found.' };
    }
    var cfg = _resolveConfigColumns(sheet, type);
    var res = _dispatchSlot(record, slot, cfg);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    slot.sentAt = new Date().toISOString();
    _saveJobRecord(record);
    LOG_AUDIT_EVENT('RESEND', {
      docId: jobId,
      docName: record.docName,
      signer: slot.signerEmail || '',
      status: 'Email resent',
      spreadsheetId: record.spreadsheetId,
      details: 'Signing email re-sent to ' + slot.label + ' (' + (slot.signerEmail || '') + ').'
    });
    return { ok: true, email: slot.signerEmail };
  } catch (err) {
    Logger.log('RESEND_SLOT_EMAIL error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Deletes all unsigned jobs of a type in THIS spreadsheet (the "Clear all"
 * button in the in-person dialog) AND clears the sign-link (and status) cells
 * that were written into the rows.
 */
function DELETE_ALL_PENDING(typeId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ssId = ss.getId();
    var store = _getJobStore();
    var props = store.getProperties();
    var removed = 0;
    var type = _findType(_getTypes(), typeId);
    var sheet = null;
    var cfg = null;
    if (type) {
      sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
      if (sheet) {
        try { cfg = _resolveConfigColumns(sheet, type); } catch (e) { cfg = null; }
      }
    }
    Object.keys(props).forEach(function (k) {
      if (k.indexOf(JOB_PREFIX) !== 0) return;
      var rec;
      try { rec = JSON.parse(props[k]); } catch (e) { return; }
      if (rec && rec.typeId === typeId && rec.spreadsheetId === ssId && !rec.finalized) {
        store.deleteProperty(k);
        removed++;
        if (sheet && cfg && rec.rowNumber) {
          try {
            var targets = [];
            if (cfg.linkAColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.linkAColumn));
            if (cfg.linkBColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.linkBColumn));
            if (cfg.statusColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.statusColumn));
            if (cfg.signerAStatusColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.signerAStatusColumn));
            if (cfg.signerBStatusColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.signerBStatusColumn));
            if (cfg.signerADeclineReasonColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.signerADeclineReasonColumn));
            if (cfg.signerBDeclineReasonColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.signerBDeclineReasonColumn));
            if (cfg.workingPdfColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.workingPdfColumn));
            if (cfg.signedPdfColumn > 0) targets.push(sheet.getRange(rec.rowNumber, cfg.signedPdfColumn));
            targets.forEach(function (r) { r.clearContent(); });
          } catch (e) {
            Logger.log('DELETE_ALL_PENDING cell-clear warning: %s', e.message);
          }
        }
      }
    });
    return { ok: true, removed: removed };
  } catch (err) {
    Logger.log('DELETE_ALL_PENDING error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Opens the "Sign on this device" dialog for a type (B7 — BoloSign-style
 * in-person signing). The owner opens the pending sign URL on a shared device
 * and the signer draws their signature right there.
 * @param {string} typeId
 * @return {Object} { ok, error? }
 */
function OPEN_IN_PERSON_DIALOG(typeId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var type = _findType(_getTypes(), typeId);
    var html = HtmlService.createTemplateFromFile('InPersonDialog').evaluate()
      .setWidth(480)
      .setHeight(560);
    html.append('<script>window.__TYPE_ID__ = ' + JSON.stringify(typeId) + '; window.__TYPE_NAME__ = ' +
      JSON.stringify(type ? (type.name || typeId) : typeId) + '; init();</script>');
    ss.toast('Sign on this device', 'DocuPDF Sign');
    SpreadsheetApp.getUi().showModelessDialog(html, 'Sign on this device — ' + (type ? (type.name || typeId) : typeId));
    return { ok: true };
  } catch (err) {
    Logger.log('OPEN_IN_PERSON_DIALOG error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _notifySignerSigned(record, slot, bytes, label) {
  try {
    var wsEmail = (record.signing && record.signing.emailWorkingToSigners === false) ? false : true;
    if (!wsEmail) {
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: slot.signerEmail || '',
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'Signer working PDF notification skipped by config.'
        });
      } catch (e) {}
      return;
    }
    var to = slot.signerEmail || '';
    if (!to) {
      try {
        LOG_AUDIT_EVENT('NOTIFY', {
          docId: record.jobId,
          docName: record.docName,
          signer: label || '',
          status: 'Skipped',
          spreadsheetId: record.spreadsheetId,
          details: 'No signer email for working PDF notification.'
        });
      } catch (e) {}
      return;
    }
    var subject = 'DocuPDF Sign — ' + record.docName + ' — signature recorded';
    var bodyText = 'Thanks for signing "' + record.docName + '". Your signature has been recorded. The document will be shared with the other party and finalized once all signatures are complete.';
    var opts = { name: 'DocuPDF Sign' };
    try {
      if (bytes && bytes.length) {
        var namePdf = (record.docName.replace(/\.[^.]*$/, '') + '_WORKING.pdf');
        opts.attachments = [Utilities.newBlob(bytes, 'application/pdf', namePdf)];
      }
    } catch (e) {}
    GmailApp.sendEmail(to, subject, bodyText, opts);
    try {
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: to,
        status: 'Sent',
        spreadsheetId: record.spreadsheetId,
        details: 'Signer notified with working PDF.'
      });
    } catch (e) {}
  } catch (err) {
    Logger.log('_notifySignerSigned error: %s', err.message);
    try {
      LOG_AUDIT_EVENT('NOTIFY', {
        docId: record.jobId,
        docName: record.docName,
        signer: slot.signerEmail || '',
        status: 'Failed',
        spreadsheetId: record.spreadsheetId,
        details: 'Signer working PDF failed: ' + err.message
      });
    } catch (e) {}
  }
}

/* ------------------------------------------------------------------ *
 * Email rendering helpers.
 * ------------------------------------------------------------------ */


function GET_OAUTH_TOKEN() {
  return ScriptApp.getOAuthToken();
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

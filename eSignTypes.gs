/**
 * file name: eSignTypes.gs
 *
 * Multi-type E-sign registry (mirrors DocuMail Pro's template model).
 * A spreadsheet can hold several E-sign types (e.g. "MOU", "Invoice",
 * "PO"), each with its own source mode, row filter, signer mapping,
 * output columns, email template and schedule.
 *
 * Storage: ScriptProperties per spreadsheet  DOCUPDF_TYPES_<ssId> = JSON array.
 * The global single-config (readConfig) is retained only as a fallback /
 * master auto-sync switch.
 */

var TYPES_KEY = 'DOCUPDF_TYPES_';
var SIDEBAR_VERSION_KEY = 'DOCUPDF_SIDEBAR_VERSION_';

/* ------------------------------------------------------------------ *
 * Type registry.
 * ------------------------------------------------------------------ */

function _getTypes() {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var raw = PropertiesService.getScriptProperties().getProperty(TYPES_KEY + ssId);
    var types = raw ? JSON.parse(raw) : [];
    return Array.isArray(types) ? types : [];
  } catch (err) {
    Logger.log('_getTypes error: %s', err.message);
    return [];
  }
}

function _saveTypes(types) {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    PropertiesService.getScriptProperties().setProperty(TYPES_KEY + ssId, JSON.stringify(types || []));
  } catch (err) {
    Logger.log('_saveTypes error: %s', err.message);
  }
}

function _findType(types, typeId) {
  for (var i = 0; i < types.length; i++) {
    if (types[i].id === typeId) return types[i];
  }
  return null;
}

function _defaultType() {
  return {
    id: '',
    name: '',
    dataSheetName: '',
    headerRow: 1,
    sourceMode: 'documail',       // 'documail' | 'standalone'
    enabled: true,
    filterColumn: 0,              // 0 = all rows
    filterOperator: 'NOT_EMPTY',  // 'NOT_EMPTY' | 'CONTAINS'
    filterKeyword: '',
    signingRequiredColumn: 0,
    signerEmailColumn: 0,         // Party A email
    signerNameColumn: 0,          // Party A name
    signerBEmailColumn: 0,        // Party B email (0 = single-party)
    signerBNameColumn: 0,
    signerADesignationColumn: 0,  // 'Signer A Designation'
    signerBDesignationColumn: 0,  // 'Signer B Designation'
    signerACompanyColumn: 0,      // 'Signer A Company'
    signerBCompanyColumn: 0,      // 'Signer B Company'
    docNameColumn: 0,
    statusColumn: 0,              // 'DocuPDF Status'
    signerAStatusColumn: 0,      // 'Signer A Status' (per-slot, 0 = not mapped)
    signerBStatusColumn: 0,      // 'Signer B Status'
    documentSignedColumn: 0,      // 'Document Signed'
    linkAColumn: 0,               // 'Sign Link - Party A'
    linkBColumn: 0,               // 'Sign Link - Party B'
    signerADeclineReasonColumn: 0, // 'Signer A Decline Reason'
    signerBDeclineReasonColumn: 0, // 'Signer B Decline Reason'
    workingPdfColumn: 0,           // 'Working PDF Link'
    signedPdfColumn: 0,            // 'Signed PDF Link'
    sourceColumn: 0,              // 'Source Doc ID/URL' (standalone)
    templateFileId: '',           // per-type template PDF (standalone, Step 3)
    slotPlacement: { A: { page: 0, align: 'center', vOffset: 0.85 }, B: { page: 0, align: 'center', vOffset: 0.85 } },
    signerTextFieldLabel: '',     // optional signer text field (blank = off)
    initialsEnabled: true,
    reminderDays: 0,              // 0 = no reminders
    sequentialSigning: false,     // Party A signs first, then Party B is emailed
    logoUrl: '',
    brandColor: '#1a73e8',
    qrInEmail: true,
    trackOpens: false,
    emailWorkingToSigners: true,
    emailFinalToSigners: true,
    mergedDocStatusColumn: 0,     // DocuMail 'Merged Doc Status'
    mergedDocIdColumn: 0,         // DocuMail 'Merged Doc ID'
    mergedDocUrlColumn: 0,        // DocuMail 'Merged Doc URL'
    shareSourcePdf: true,
    outputFolderId: '',
    autoSendEmail: true,          // standalone: DocuPDF emails the sign link
    attachSourcePdf: true,
    notifyOnFinalize: true,
    notifyOwnerEmail: '',
    esignMode: 'native',
    companyName: '',
    replyToEmail: '',
    emailSubject: 'Please sign: {docName}',
    emailBody: 'Hi {signerName}, please review and sign {docName}.\n\nSigner: {signerName} | {signerDesignation}\nEmail: {signerEmail}\n\nLink: {signUrl}',
    scheduleMinutes: 0,           // 0 = manual
    lastRun: 0,
    created: Date.now(),
    updated: Date.now()
  };
}

/** Seeds a blank type with the current sheet setup (column mapping defaults). */
function _seedTypeFromSetup(type) {
  try {
    var cfg = readConfig();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = _getDataSheet(ss, cfg);
    cfg = _resolveConfigColumns(sheet, cfg);
    var cols = [
      'signingRequiredColumn', 'signerEmailColumn', 'signerNameColumn',
      'signerADesignationColumn', 'signerBEmailColumn', 'signerBNameColumn',
      'signerBDesignationColumn', 'signerACompanyColumn', 'signerBCompanyColumn', 'docNameColumn',
      'statusColumn', 'documentSignedColumn', 'linkAColumn', 'linkBColumn',
      'sourceColumn', 'mergedDocStatusColumn', 'mergedDocIdColumn', 'mergedDocUrlColumn',
      'signerAStatusColumn', 'signerBStatusColumn',
      'signerADeclineReasonColumn', 'signerBDeclineReasonColumn',
      'workingPdfColumn', 'signedPdfColumn', 'emailWorkingToSigners', 'emailFinalToSigners'
    ];
    cols.forEach(function (k) {
      if (cfg[k]) type[k] = cfg[k];
    });
    type.sourceMode = (cfg.sourceMode === 'standalone' || cfg.sourceMode === 'documail') ? cfg.sourceMode : (cfg.mergedDocStatusColumn ? 'documail' : 'standalone');
    type.dataSheetName = cfg.dataSheetName || (sheet ? sheet.getName() : '');
    type.outputFolderId = cfg.outputFolderId || '';
    type.shareSourcePdf = cfg.shareSourcePdf !== false;
    type.autoSendEmail = cfg.autoSendEmail !== false;
    type.attachSourcePdf = cfg.attachSourcePdf !== false;
    type.notifyOnFinalize = cfg.notifyOnFinalize !== false;
    type.notifyOwnerEmail = cfg.notifyOwnerEmail || '';
    type.companyName = cfg.companyName || '';
    type.replyToEmail = cfg.replyToEmail || '';
    type.emailSubject = cfg.emailSubject || type.emailSubject;
    type.emailBody = cfg.emailBody || type.emailBody;
    type.esignMode = cfg.esignMode || 'native';
    return type;
  } catch (err) {
    Logger.log('_seedTypeFromSetup error: %s', err.message);
    return type;
  }
}

/* ------------------------------------------------------------------ *
 * Public: sidebar list + edit payload.
 * ------------------------------------------------------------------ */

function GET_ESIGN_TYPES() {
  try {
    var types = _getTypes();
    return {
      ok: true,
      types: types.map(function (t) {
        return {
          id: t.id,
          name: t.name,
          sourceMode: t.sourceMode,
          enabled: t.enabled !== false,
          scheduleMinutes: t.scheduleMinutes || 0,
          filterColumn: t.filterColumn || 0,
          filterKeyword: t.filterKeyword || '',
          created: t.created || 0
        };
      })
    };
  } catch (err) {
    Logger.log('GET_ESIGN_TYPES error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function GET_ESIGN_TYPE(typeId) {
  try {
    var types = _getTypes();
    var type = typeId ? _findType(types, typeId) : null;
    if (!type) {
      type = _seedTypeFromSetup(_defaultType());
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
    var headers = [];
    if (sheet) {
      var lastCol = sheet.getLastColumn();
      if (lastCol >= 1) {
        headers = sheet.getRange(type.headerRow || 1, 1, 1, lastCol).getValues()[0];
      }
    }
    return {
      ok: true,
      type: type,
      headers: headers,
      sheetMode: _getSheetMode(ss.getId(), sheet ? sheet.getSheetId() : 0),
      activeSheet: ss.getActiveSheet() ? ss.getActiveSheet().getName() : '',
      sheets: ss.getSheets().map(function (s) { return s.getName(); })
    };
  } catch (err) {
    Logger.log('GET_ESIGN_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Returns headers for a named sheet (used when the wizard switches sheets). */
function GET_SHEET_HEADERS_FOR(sheetName) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
    if (!sheet) return { headers: [], sheetMode: 'automatic' };
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) return { headers: [], sheetMode: 'automatic' };
    return {
      headers: sheet.getRange(1, 1, 1, lastCol).getValues()[0],
      sheetMode: _getSheetMode(ss.getId(), sheet.getSheetId())
    };
  } catch (err) {
    Logger.log('GET_SHEET_HEADERS_FOR error: %s', err.message);
    return { headers: [], sheetMode: 'automatic' };
  }
}

/* ------------------------------------------------------------------ *
 * Public: save / delete / toggle.
 * ------------------------------------------------------------------ */

function SAVE_ESIGN_TYPE(typeObj) {
  try {
    typeObj = typeObj || {};
    var name = String(typeObj.name || '').trim();
    if (!name) {
      return { ok: false, error: 'Give this E-sign a name.' };
    }
    if (typeObj.sourceMode !== 'documail' && typeObj.sourceMode !== 'standalone') {
      typeObj.sourceMode = 'standalone';
    }
    if (!typeObj.dataSheetName) {
      return { ok: false, error: 'Choose the sheet that holds the rows.' };
    }
    var modeSS = SpreadsheetApp.getActiveSpreadsheet();
    var modeSheet = modeSS.getSheetByName(typeObj.dataSheetName);
    var sheetMode = _getSheetMode(modeSS.getId(), modeSheet ? modeSheet.getSheetId() : 0);
    if (sheetMode !== 'manual' && !Number(typeObj.signingRequiredColumn)) {
      return { ok: false, error: 'Map the "Signing Required" column (rows gated on Yes/No).' };
    }
    if (typeObj.sourceMode === 'standalone' && !Number(typeObj.signerEmailColumn)) {
      return { ok: false, error: 'Party A email column is required.' };
    }
    if (typeObj.sourceMode === 'standalone' &&
        (!typeObj.emailSubject || !String(typeObj.emailSubject).trim() ||
         !typeObj.emailBody || !String(typeObj.emailBody).trim())) {
      return { ok: false, error: 'Standalone mode needs an email subject and body (email template step).' };
    }

    // A1: validate the template PDF is actually accessible under drive.file so
    // run-time [PBlocked] errors are caught at Save, not after the fact.
    if (typeObj.sourceMode === 'standalone' && typeObj.templateFileId) {
      var tid = NORMALIZE_FILE_ID(typeObj.templateFileId);
      if (!tid) {
        return { ok: false, error: 'Template PDF file id is missing. Pick it with 📂 Browse.' };
      }
      var acc = _fileAccessible(tid);
      if (!acc.ok) {
        return { ok: false, error: 'The template PDF is not accessible under the app\'s secure file scope. Use 📂 Browse to pick it (pasting a link to an arbitrary file does not grant access): ' + acc.error };
      }
      typeObj.templateFileId = tid;
    }

    var types = _getTypes();
    for (var i = 0; i < types.length; i++) {
      if (types[i].id !== typeObj.id && types[i].name.toLowerCase() === name.toLowerCase()) {
        return { ok: false, error: 'Another E-sign named "' + name + '" already exists.' };
      }
    }

    var isNew = !typeObj.id;
    if (isNew) {
      typeObj.id = Utilities.getUuid();
      typeObj.created = Date.now();
      types.push(typeObj);
    } else {
      var existing = _findType(types, typeObj.id);
      if (!existing) {
        return { ok: false, error: 'E-sign not found. It may have been deleted.' };
      }
      var idx = types.indexOf(existing);
      types[idx] = typeObj;
    }

    // DocuMail mode never emails from DocuPDF (DocuMail sends).
    if (typeObj.sourceMode === 'documail') {
      typeObj.autoSendEmail = false;
      typeObj.attachSourcePdf = false;
    }
    typeObj.updated = Date.now();

    _saveTypes(types);
    _bumpSidebarVersion();
    try {
      _ensureTriggersInstalled();
    } catch (e) {
      Logger.log('SAVE_ESIGN_TYPE trigger-install warning: %s', e.message);
    }
    return { ok: true, id: typeObj.id };
  } catch (err) {
    Logger.log('SAVE_ESIGN_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function DELETE_ESIGN_TYPE(typeId) {
  try {
    var types = _getTypes();
    var next = types.filter(function (t) { return t.id !== typeId; });
    if (next.length === types.length) {
      return { ok: false, error: 'E-sign not found.' };
    }
    _saveTypes(next);
    _bumpSidebarVersion();
    return { ok: true };
  } catch (err) {
    Logger.log('DELETE_ESIGN_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Duplicates an E-sign type (new id + "(copy)" name). */
function COPY_ESIGN_TYPE(typeId) {
  try {
    var types = _getTypes();
    var src = _findType(types, typeId);
    if (!src) {
      return { ok: false, error: 'E-sign not found.' };
    }
    var copy = JSON.parse(JSON.stringify(src));
    copy.id = Utilities.getUuid();
    copy.name = src.name + ' (copy)';
    copy.created = Date.now();
    copy.updated = Date.now();
    types.push(copy);
    _saveTypes(types);
    _bumpSidebarVersion();
    return { ok: true, id: copy.id, name: copy.name };
  } catch (err) {
    Logger.log('COPY_ESIGN_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Audit rows related to one E-sign type. Type events carry "Type: <id>" in the
 * Details column (written by LOG_AUDIT_EVENT callers), so rows are filtered by
 * that tag. Falls back to the last 200 rows when nothing is tagged.
 * @return {Object} { ok, rows: [ [ts, event, docId, docName, hash, signer, status, details] ] }
 */
function GET_AUDIT_FOR_TYPE(typeId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var audit = ss.getSheetByName('AuditLog');
    if (!audit || audit.getLastRow() < 2) {
      return { ok: true, rows: [] };
    }
    var lastRow = audit.getLastRow();
    var lastCol = audit.getLastColumn();
    var data = audit.getRange(1, 1, lastRow, lastCol).getValues();
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      if (typeId && String(data[i][7] || '').indexOf('Type: ' + typeId) !== -1) {
        rows.push(data[i]);
      }
    }
    if (!rows.length) {
      rows = data.slice(Math.max(1, data.length - 200));
    }
    return { ok: true, rows: rows };
  } catch (err) {
    Logger.log('GET_AUDIT_FOR_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Opens a modal listing the audit events for one E-sign type. */
function VIEW_TYPE_AUDIT(typeId) {
  try {
    var types = _getTypes();
    var type = _findType(types, typeId);
    var res = GET_AUDIT_FOR_TYPE(typeId);
    var html = HtmlService.createHtmlOutputFromFile('AuditDialog')
      .setWidth(780)
      .setHeight(480);
    html.append('<script>window.__AUDIT__ = ' + JSON.stringify({
      typeName: type ? type.name : '',
      rows: res.ok ? res.rows : [],
      error: res.ok ? '' : (res.error || '')
    }) + ';</script>');
    SpreadsheetApp.getUi().showModalDialog(html, 'Audit Log — ' + (type ? type.name : ''));
  } catch (err) {
    Logger.log('VIEW_TYPE_AUDIT error: %s', err.message);
    SpreadsheetApp.getUi().alert('Could not open the audit log: ' + err.message);
  }
}

function TOGGLE_ESIGN_TYPE(typeId, enabled) {
  try {
    var types = _getTypes();
    var type = _findType(types, typeId);
    if (!type) {
      return { ok: false, error: 'E-sign not found.' };
    }
    type.enabled = enabled !== false;
    _saveTypes(types);
    _bumpSidebarVersion();
    return { ok: true, enabled: type.enabled };
  } catch (err) {
    Logger.log('TOGGLE_ESIGN_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Persistence bridge: a job/type config can carry a type id so
 * auto-created folders persist back into the type store.
 * ------------------------------------------------------------------ */

function _persistConfig(cfg) {
  if (cfg && cfg.id) {
    var types = _getTypes();
    for (var i = 0; i < types.length; i++) {
      if (types[i].id === cfg.id) {
        types[i] = cfg;
        break;
      }
    }
    _saveTypes(types);
  } else {
    saveConfig(cfg);
  }
}

/* ------------------------------------------------------------------ *
 * Sidebar refresh signal (the sidebar polls and reloads when it changes).
 * ------------------------------------------------------------------ */

function _bumpSidebarVersion() {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var props = PropertiesService.getScriptProperties();
    var v = Number(props.getProperty(SIDEBAR_VERSION_KEY + ssId) || 0) + 1;
    props.setProperty(SIDEBAR_VERSION_KEY + ssId, String(v));
  } catch (err) {
    Logger.log('_bumpSidebarVersion error: %s', err.message);
  }
}

function GET_SIDEBAR_REFRESH() {
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var v = PropertiesService.getScriptProperties().getProperty(SIDEBAR_VERSION_KEY + ssId) || '';
    return v;
  } catch (err) {
    Logger.log('GET_SIDEBAR_REFRESH error: %s', err.message);
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Modal opener.
 * ------------------------------------------------------------------ */

function OPEN_NEW_ESIGN() {
  if (!_ensureInitiatedOrPrompt()) {
    return;
  }
  OPEN_ESIGN_MODAL('');
}

function OPEN_ESIGN_MODAL(typeId) {
  try {
    var html = HtmlService.createTemplateFromFile('ESignWizard').evaluate()
      .setTitle(APP_NAME + ' — E-sign Configuration')
      .setWidth(780)
      .setHeight(720);
    html.append('<script>window.__ESIGN_TYPE_ID__ = ' + JSON.stringify(String(typeId || '')) + ';</script>');
    SpreadsheetApp.getUi().showModalDialog(html, 'E-sign Configuration');
  } catch (err) {
    Logger.log('OPEN_ESIGN_MODAL error: %s', err.message);
    SpreadsheetApp.getUi().alert('Could not open the E-sign wizard: ' + err.message);
  }
}

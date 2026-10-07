/**
 * file name: syncEngine.gs
 *
 * Auto-sync engine (multi-type).
 * Each E-sign type (eSignTypes.gs) targets a subset of rows via its row
 * filter and produces token-gated signing links in the configured columns.
 *  - documail mode:    source PDF from DocuMail 'Merged Doc ID' -> URL.
 *  - standalone mode:  source PDF from 'Source Doc ID/URL'; DocuPDF emails.
 *
 * Entry points:
 *  - SYNC_ALL_TYPES:    scheduled (single 1-min trigger) — respects each
 *                       type's scheduleMinutes; also the menu/global sync.
 *  - SYNC_TYPE(id):     sidebar "Run" for one type.
 *  - ON_EDIT:           installable fast path for the edited row.
 *  - ON_SCHEDULED_SYNC: trigger handler -> SYNC_ALL_TYPES.
 */

function _sourceModeOf(cfg) {
  return 'standalone';
}

/**
 * Resolves the source PDF id for a row, per mode.
 * @return {Object} { ok:false } when still waiting; { ok:true, fileId, source }
 *                  or { ok:false, error } when invalid.
 */
function _resolveSourceId(sheet, rowNumber, cfg) {
  var mode = _sourceModeOf(cfg);
  var read = function (colNum) {
    if (!colNum) return '';
    try {
      return String(sheet.getRange(rowNumber, colNum).getDisplayValue() || '').trim();
    } catch (e) {
      return '';
    }
  };

  // documail removed - use template only

  // standalone — the type's template PDF (Picker-picked) is the ONLY source;
  // there is no per-row source column.
  if (cfg.templateFileId) {
    return { ok: true, fileId: NORMALIZE_FILE_ID(cfg.templateFileId), source: 'Type template' };
  }
  return { ok: false, error: 'No template PDF: add one in the E-sign wizard (Step 3 📂 Browse).' };
}

/**
 * True when a row passes the type's row filter (Step 2 of the wizard).
 * filterColumn = 0  -> all rows apply.
 */
function _rowMatchesFilter(sheet, rowNumber, cfg) {
  var col = cfg.filterColumn || 0;
  if (!col) return true;
  var val = '';
  try {
    val = String(sheet.getRange(rowNumber, col).getDisplayValue() || '').trim();
  } catch (e) { /* ignore */ }
  if (cfg.filterOperator === 'CONTAINS') {
    return cfg.filterKeyword ? val.indexOf(String(cfg.filterKeyword)) !== -1 : !!val;
  }
  return !!val; // NOT_EMPTY
}

/**
 * Processes ONE row if it passes the gate. Idempotent.
 * Gate: row filter AND 'Signing Required' = Yes AND source id resolvable
 * AND 'DocuPDF Status' empty (or 'Blocked*' for retry).
 * @return {Object} { processed, reason?, result? }
 */
function _maybeProcessRow(sheet, rowNumber, cfg) {
  try {
    var read = function (colNum) {
      if (!colNum) return '';
      try {
        return String(sheet.getRange(rowNumber, colNum).getDisplayValue() || '').trim();
      } catch (e) {
        return '';
      }
    };

    // Gate 1: Signing Required. 'No' -> mark 'Document Signed' as 'No' and skip.
    var req = read(cfg.signingRequiredColumn).toLowerCase();
    if (req !== 'yes') {
      if (req === 'no' && cfg.documentSignedColumn > 0) {
        var cur = read(cfg.documentSignedColumn);
        if (!cur || cur === 'No') {
          _setRowValue(sheet, rowNumber, cfg.documentSignedColumn, 'No');
        }
      }
      return { processed: false, reason: 'not required' };
    }

    // Gate 2: already signed (Document Signed = "Signed by ...") -> never reprocess.
    if (cfg.documentSignedColumn > 0) {
      var signedFlag = read(cfg.documentSignedColumn);
      if (signedFlag) {
        return { processed: false, reason: 'already signed' };
      }
    }

    // Gate 3: already processed (unless blocked -> allow retry)
    var status = read(cfg.statusColumn);
    if (status && status.indexOf('Blocked') !== 0) {
      return { processed: false, reason: 'already processed (' + status + ')' };
    }

    // Gate 4: source PDF resolvable
    var src = _resolveSourceId(sheet, rowNumber, cfg);
    if (!src.ok) {
      if (src.error) {
        _setRowStatus(sheet, rowNumber, cfg, 'Blocked: ' + src.error);
      }
      return { processed: false, reason: src.error ? src.error : 'no source yet' };
    }

    var result = _createAndWriteJob(sheet, rowNumber, src.fileId, cfg, src.source);
    if (!result.ok && src.usedRow && src.templateFileId && /cannot open/i.test(result.error)) {
      // A3: the row's Source Doc ID/URL is unreadable (e.g. pasted link) but a
      // type template exists -> auto-fallback so the row still signs.
      var fb = _createAndWriteJob(sheet, rowNumber, src.templateFileId, cfg, 'Type template (fallback)');
      if (fb.ok) {
        LOG_AUDIT_EVENT('FALLBACK', {
          docId: fb.jobId || '',
          docName: fb.docName || '',
          status: 'Used template',
          details: 'Row ' + rowNumber + ': Source Doc ID/URL (' + src.fileId + ') unreadable under drive.file; used the type template instead. Type: ' + (cfg.id || '')
        });
        return { processed: true, reason: 'ok (template fallback)', result: fb };
      }
      result = fb;
    }
    if (!result.ok) {
      _setRowStatus(sheet, rowNumber, cfg, 'Blocked: ' + result.error);
      return { processed: true, reason: result.error, result: result };
    }
    return { processed: true, reason: 'ok', result: result };
  } catch (err) {
    Logger.log('_maybeProcessRow error: %s', err.message);
    return { processed: false, reason: err.message };
  }
}

function _setRowStatus(sheet, rowNumber, cfg, text) {
  _setRowValue(sheet, rowNumber, cfg.statusColumn, text);
}

/**
 * B4 — sends automatic reminder emails for pending signing links of a type
 * once they are older than cfg.reminderDays. Idempotent: a reminder is only
 * sent when (now - lastReminderAt|createdAt) >= reminderDays.
 * @return {Object} { sent }
 */
function _sendRemindersForType(ss, cfg) {
  var days = Number(cfg.reminderDays) || 0;
  if (days <= 0 || cfg.sourceMode === 'documail' || cfg.autoSendEmail !== true) {
    return { sent: 0 };
  }
  var interval = days * 86400000;
  var now = Date.now();
  var props = _getJobStore().getProperties();
  var sent = 0;
  Object.keys(props).forEach(function (key) {
    if (key.indexOf(JOB_PREFIX) !== 0) return;
    var rec;
    try { rec = JSON.parse(props[key]); } catch (e) { return; }
    if (!rec || rec.finalized) return;
    if (rec.spreadsheetId !== ss.getId()) return;
    if (rec.dataSheetName !== cfg.dataSheetName) return;
    if (now > rec.expiresAt) return; // link expired; nothing to chase
    if (now - (rec.lastReminderAt || rec.createdAt || now) < interval) return;

    var pending = (rec.slots || []).filter(function (s) { return s.status === 'pending'; });
    if (!pending.length) return;
    // Sequential gate: if sequential, only email first pending slot if A not signed? Wait - A is slot 0; B is slot 1.
    // Only email slots where slot 0 is already signed when sequential? Or don't email B before A.
    var isSeq = (rec.signing && rec.signing.sequentialSigning === true) && rec.slots.length > 1;
    if (isSeq) {
      var aSigned = (rec.slots[0] && rec.slots[0].status === 'signed');
      pending = pending.filter(function (s, idx) { var si = rec.slots.indexOf(s); if (si === 0) return true; if (si > 0 && aSigned) return true; return false; });
      if (!pending.length) return;
    }

    // Only chase rows that are actually still awaiting signature.
    var rowStatus = '';
    try {
      var sheet = cfg.dataSheetName ? ss.getSheetByName(cfg.dataSheetName) : ss.getActiveSheet();
      if (sheet && cfg.statusColumn > 0) {
        rowStatus = String(sheet.getRange(rec.rowNumber, cfg.statusColumn).getDisplayValue() || '').trim();
      }
    } catch (e) { /* ignore */ }
    if (!/^(Awaiting|Opened)/i.test(rowStatus)) return;

    var emailed = false;
    pending.forEach(function (slot) {
      var res = _dispatchSlot(rec, slot, cfg);
      if (res.ok) emailed = true;
    });
    if (!emailed) return;
    rec.lastReminderAt = now;
    _saveJobRecord(rec);
    sent++;
    LOG_AUDIT_EVENT('REMIND', {
      docId: rec.jobId,
      docName: rec.docName,
      status: 'Sent',
      details: 'Reminder after ' + days + ' day(s) for ' + pending.map(function (s) { return s.label; }).join(', ') + '. Type: ' + (cfg.id || '')
    });
  });
  return { sent: sent };
}

function _setRowValue(sheet, rowNumber, colNum, text) {
  try {
    if (colNum) {
      sheet.getRange(rowNumber, colNum).setValue(text);
    }
  } catch (e) {
    Logger.log('_setRowValue error: %s', e.message);
  }
}

/**
 * Scans one type's rows and creates jobs for those that pass the gate.
 * Updates the type's lastRun timestamp in the registry.
 * @return {Object} { ok, processed, skipped, blocked, error? }
 */
function _syncOneType(type) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = type.dataSheetName ? ss.getSheetByName(type.dataSheetName) : ss.getActiveSheet();
    if (!sheet) {
      return { ok: false, processed: 0, skipped: 0, blocked: 0, error: 'Sheet "' + (type.dataSheetName || '') + '" not found.' };
    }
    var cfg = _resolveConfigColumns(sheet, type);
    var headerRow = cfg.headerRow || 1;
    var lastRow = sheet.getLastRow();
    var stats = { ok: true, processed: 0, skipped: 0, blocked: 0 };

    // Auto-sync for template-based types: process rows where required and template exists
    for (var r = headerRow + 1; r <= lastRow; r++) {
      if (!_rowMatchesFilter(sheet, r, cfg)) {
        stats.skipped++;
        continue;
      }
      var res = _maybeProcessRow(sheet, r, cfg);
      if (res.processed) {
        if (res.result && res.result.ok) {
          stats.processed++;
        } else {
          stats.blocked++;
        }
      } else if (res.reason && res.reason.indexOf('Blocked') === 0) {
        stats.blocked++;
      } else {
        stats.skipped++;
      }
    }

    // B4: automatic reminders for pending links older than reminderDays.
    stats.reminders = _sendRemindersForType(ss, cfg).sent;
    return stats;
  } catch (err) {
    Logger.log('_syncOneType error: %s', err.message);
    return { ok: false, processed: 0, skipped: 0, blocked: 0, error: err.message };
  }
}

/** Syncs a single type (sidebar "Run" / manual). */
function SYNC_TYPE(typeId) {
  try {
    var types = _getTypes();
    var type = _findType(types, typeId);
    if (!type) {
      return { ok: false, error: 'E-sign not found.' };
    }
    var res = _syncOneType(type);
    type.lastRun = Date.now();
    _saveTypes(types);
    return { ok: res.ok !== false, typeId: typeId, typeName: type.name, stats: res, error: res.error };
  } catch (err) {
    Logger.log('SYNC_TYPE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Full sync over all enabled, scheduled types (respects each type's
 * scheduleMinutes). Also updates the global lastSync timestamp.
 */
async function SYNC_ALL_TYPES() {
  try {
    var types = _getTypes();
    var now = Date.now();
    var stats = { types: 0, processed: 0, skipped: 0, blocked: 0 };
    var errors = [];

    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      if (type.enabled === false) continue;
      if (type.scheduleMinutes > 0) {
        var due = (now - (type.lastRun || 0)) >= (type.scheduleMinutes * 60000);
        if (!due) continue;
      }
      var res = await _syncOneType(type);
      type.lastRun = now;
      if (res.ok !== false) {
        stats.types++;
        stats.processed += (res.processed || 0);
        stats.skipped += (res.skipped || 0);
        stats.blocked += (res.blocked || 0);
      } else {
        errors.push(type.name + ': ' + res.error);
      }
    }
    _saveTypes(types);

    var cfg = readConfig();
    cfg.lastSync = now;
    saveConfig(cfg);

    return { ok: true, lastSync: now, stats: stats, errors: errors };
  } catch (err) {
    Logger.log('SYNC_ALL_TYPES error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Backward-compatible global sync (any type due regardless of schedule). */
async function SYNC_DOCUMAIL_ROWS() {
  try {
    var types = _getTypes();
    var now = Date.now();
    var stats = { types: 0, processed: 0, skipped: 0, blocked: 0 };

    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      if (type.enabled === false) continue;
      var res = await _syncOneType(type);
      type.lastRun = now;
      if (res.ok !== false) {
        stats.types++;
        stats.processed += (res.processed || 0);
        stats.skipped += (res.skipped || 0);
        stats.blocked += (res.blocked || 0);
      }
    }
    _saveTypes(types);

    var cfg = readConfig();
    cfg.lastSync = now;
    saveConfig(cfg);
    return { ok: true, mode: 'multi', lastSync: now, stats: stats };
  } catch (err) {
    Logger.log('SYNC_DOCUMAIL_ROWS error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Idempotently installs the two auto-sync triggers (ON_EDIT fast path +
 * 1-minute safety net). Called automatically when an E-sign is saved, so no
 * global "Enable Auto-sync" switch is needed — each type's schedule in the
 * wizard controls when it runs.
 * @return {Object} { ok, error? }
 */
function _ensureTriggersInstalled() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var existing = ScriptApp.getProjectTriggers();
    var hasOnEdit = false;
    var hasScheduled = false;
    existing.forEach(function (t) {
      var fn = t.getHandlerFunction();
      if (fn === 'ON_EDIT') hasOnEdit = true;
      if (fn === 'ON_SCHEDULED_SYNC') hasScheduled = true;
    });
    if (!hasOnEdit) {
      ScriptApp.newTrigger('ON_EDIT').forSpreadsheet(ss.getId()).onEdit().create();
    }
    if (!hasScheduled) {
      ScriptApp.newTrigger('ON_SCHEDULED_SYNC')
        .forSpreadsheet(ss.getId())
        .timeBased()
        .everyMinutes(1)
        .create();
    }
    return { ok: true };
  } catch (err) {
    Logger.log('_ensureTriggersInstalled error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Self-healing trigger install for the signer flow. Called from doGet so the
 * moment a signer opens a sign link, the 1-minute ON_SCHEDULED_SYNC trigger
 * exists (it drives PROCESS_PENDING_SIGNATURES). Unlike _ensureTriggersInstalled
 * (spreadsheet-bound, sidebar-only), this is project-scoped so it works from
 * the web-app execute-as-ME context. Never throws — a failure must not break
 * the signer page render.
 * @return {boolean} true if the trigger exists (before or after this call)
 */
function _ensureSignerTriggersInstalled() {
  try {
    var existing = ScriptApp.getProjectTriggers();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].getHandlerFunction() === 'ON_SCHEDULED_SYNC') {
        return true;
      }
    }
    ScriptApp.newTrigger('ON_SCHEDULED_SYNC')
      .timeBased()
      .everyMinutes(1)
      .create();
    Logger.log('_ensureSignerTriggersInstalled: created ON_SCHEDULED_SYNC 1-min trigger.');
    return true;
  } catch (err) {
    Logger.log('_ensureSignerTriggersInstalled error: %s', err.message);
    return false;
  }
}

/**
 * Installable onEdit trigger — fast path: processes the edited row for
 * every enabled type whose row filter matches. Fires on DocuMail merges
 * and on Picker writes.
 */
async function ON_EDIT(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (!sheet) return;
    var rowNumber = e.range.getRow();

    var types = _getTypes();
    if (types.length === 0) return;
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      if (type.enabled === false) continue;
      var tcfg = _resolveConfigColumns(sheet, type);
      var headerRow = tcfg.headerRow || 1;
      if (rowNumber <= headerRow) continue;
      if (!_rowMatchesFilter(sheet, rowNumber, tcfg)) continue;
      await _maybeProcessRow(sheet, rowNumber, tcfg);
    }
  } catch (err) {
    Logger.log('ON_EDIT error: %s', err.message);
  }
}

/**
 * 1-minute safety net (scheduled). No global switch: each type's own
 * scheduleMinutes (set in the wizard, Step 6) decides whether it is due.
 */
async function ON_SCHEDULED_SYNC() {
  try {
    await PROCESS_PENDING_SIGNATURES();
    if (_getTypes().length === 0) return;
    await SYNC_ALL_TYPES();
  } catch (err) {
    Logger.log('ON_SCHEDULED_SYNC error: %s', err.message);
  }
}

/**
 * Applies recorded-but-unreconstructed signatures (slot.status =
 * 'signed_pending') via PLACE_SIGNATURE_ON_PDF. Runs first in every
 * scheduled tick so deferred signatures finalize promptly.
 * @return {Object} { ok, processed }
 */
async function PROCESS_PENDING_SIGNATURES() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, error: 'lock timeout' };
  }
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    var processed = [];
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf(JOB_PREFIX) !== 0) continue;
      var record;
      try { record = JSON.parse(props[key]); } catch (e) { continue; }
      if (!record || record.finalized) continue;
      var fresh = _getJobRecord(record.jobId);
      if (!fresh || fresh.finalized) continue;
      var pending = (fresh.slots || []).filter(function (s) { return s.status === 'signed_pending'; });
      if (!pending.length) continue;
      for (var j = 0; j < pending.length; j++) {
        var slot = pending[j];
        var payload = {
          action: 'sign',
          jobId: fresh.jobId,
          signToken: slot.signToken,
          nonce: slot.nonce,
          base64: slot.signatureBase64 || '',
          width: slot.width || 480,
          height: slot.height || 160,
          signerEmail: slot.signerEmail || '',
          signerName: slot.signerName || '',
          textValue: slot.textValue || '',
          initials: slot.initials || ''
        };
        try {
          await PLACE_SIGNATURE_ON_PDF(payload);
          processed.push({ jobId: fresh.jobId, slot: slot.slot });
        } catch (e) {
          Logger.log('PROCESS_PENDING_SIGNATURES error for %s slot %s: %s', fresh.jobId, slot.slot, e.message);
        }
      }
    }
    return { ok: true, processed: processed };
  } catch (err) {
    Logger.log('PROCESS_PENDING_SIGNATURES error: %s', err.message);
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/** Installs the onEdit + 1-minute triggers (idempotent). */
function ENABLE_AUTO_SYNC() {
  try {
    var res = _ensureTriggersInstalled();
    LOG_AUDIT_EVENT('SYNC', {
      docId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      docName: SpreadsheetApp.getActiveSpreadsheet().getName(),
      status: 'Enabled',
      details: 'Auto-sync ON (onEdit + 1-min safety net).'
    });
    return { ok: res.ok !== false, enabled: true, error: res.error };
  } catch (err) {
    Logger.log('ENABLE_AUTO_SYNC error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/** Removes the onEdit + 1-minute triggers. */
function DISABLE_AUTO_SYNC() {
  try {
    _removeAutoSyncTriggers();
    return { ok: true, enabled: false };
  } catch (err) {
    Logger.log('DISABLE_AUTO_SYNC error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _removeAutoSyncTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'ON_EDIT' || fn === 'ON_SCHEDULED_SYNC') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** Menu wrapper for the status alert. */
function SHOW_AUTO_SYNC_STATUS() {
  try {
    var types = _getTypes();
    var cfg = readConfig();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ui = SpreadsheetApp.getUi();
    var last = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString() : 'never';
    var enabledTypes = types.filter(function (t) { return t.enabled !== false; }).length;
    var scheduled = types.filter(function (t) {
      return t.enabled !== false && t.scheduleMinutes > 0;
    }).length;
    ui.alert(
      'DocuPDF Sign — Auto-sync\n\n' +
      'Auto-sync: ' + (cfg.autoSync ? 'ON' : 'OFF') + '\n' +
      'E-sign types: ' + types.length + ' (enabled ' + enabledTypes + ')\n' +
      'Scheduled types: ' + scheduled + '\n' +
      'Last scan: ' + last + '\n\n' +
      'Open the E-sign Engine to manage types.'
    );
  } catch (err) {
    Logger.log('SHOW_AUTO_SYNC_STATUS error: %s', err.message);
  }
}

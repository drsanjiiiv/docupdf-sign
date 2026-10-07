/** file name: signatureHandler.gs */

/**
 * DocuPDF Sign — signature placement + finalization (PDF edition).
 *
 * Flow: a signer draws in SignatureModal.html (480x160 frame); the server
 * validates their one-time slot token, saves the ink as an app-created Drive
 * temp file, reconstructs the working PDF with all completed slots, and — when
 * every slot is signed — auto-finalizes: audit stamp (SHA-256 + QR) is drawn
 * onto the last page and the _SIGNED.pdf is written to the output folder.
 *
 * Signature PNGs live in Drive (drive.file-safe app-created files) so Script
 * Properties stay small.
 */

var SIG_TMP_PREFIX = 'DPD_SIG_';

/**
 * Records a signer's signature for a slot and reconstructs the working PDF.
 * Auto-finalizes when all slots are signed.
 *
 * Concurrency: the commit + finalize section is serialized with
 * LockService.getScriptLock() so two near-simultaneous submissions cannot both
 * pass the "all slots signed" check and double-finalize. The token is
 * re-validated INSIDE the lock and `record.finalized` is re-checked there too.
 *
 * @param {Object} payload { jobId, signToken, nonce, base64, width, height,
 *                           signerEmail, signerName }
 * @return {Object} { ok, workingPdfUrl?, finalized?, error? }
 */
async function PLACE_SIGNATURE_ON_PDF(payload) {
  var lock = LockService.getScriptLock();
  try {
    payload = payload || {};

    // Fast pre-check (cheap) before waiting on the lock — rejects invalid/
    // expired/used tokens immediately instead of blocking the queue.
    var pre = _validateSigningToken(payload.jobId, payload.signToken, payload.nonce);
    if (!pre.valid) {
      return { ok: false, error: pre.reason };
    }
    if (!payload.base64) {
      return { ok: false, error: 'No signature image was provided.' };
    }

    lock.waitLock(30000);
    try {
      // Re-validate INSIDE the lock: the record may have changed while waiting.
      var state = _validateSigningToken(payload.jobId, payload.signToken, payload.nonce);
      if (!state.valid) {
        return { ok: false, error: state.reason };
      }
      var record = state.record;
      if (record.finalized) {
        return { ok: false, error: 'This document has already been signed and finalized.' };
      }
      var slotIndex = state.slotIndex;
      // Sequential enforcement
      var isSeqEnf = (record.signing && record.signing.sequentialSigning === true) && record.slots.length > 1;
      if (isSeqEnf && slotIndex > 0) {
        if (!(record.slots[0] && record.slots[0].status === 'signed')) {
          return { ok: false, error: 'Party A must sign first (sequential signing).' };
        }
      }
      var slot = record.slots[slotIndex];

      // Persist signature as an app-created Drive temp file.
      var sigFile = _saveSignatureBlob(record.jobId, slotIndex, payload.base64);

      slot.status = 'signed';
      slot.signerEmail = payload.signerEmail || slot.signerEmail || '';
      slot.signerName = payload.signerName || slot.signerName || '';
      slot.signedAt = new Date().toISOString();
      slot.textValue = String(payload.textValue || '').trim();
      slot.initials = String(payload.initials || '').trim();
      slot.sigFileId = sigFile.id;
      slot.used = true;
      _saveJobRecord(record);
      _markSlotTokenUsed(record.jobId, slotIndex); // idempotent store sync
      _updateSignerStatus(record, slotIndex, 'Signed ' + _slotStamp());

      // B5 deferred to after working PDF write (see below)


      // Reconstruct working PDF with all signed slots.
      var workingBytes = await RECONSTRUCT_PDF(record, false);
      var workingName = record.docName.replace(/\.[^.]*$/, '') + '_WORKING';
      var workingFile = _upsertPdfInFolder(record.outputFolderId, workingName, workingBytes, record.workingPdfId);
      // Persist the Drive id INSIDE the lock so the next signer (or a retry)
      // replaces this file in place instead of creating a duplicate.
      record.workingPdfId = workingFile.id;
      _saveJobRecord(record);
      _updatePdfLinkCell(record, 'workingPdfColumn',
        workingFile.url || ('https://drive.google.com/file/d/' + workingFile.id + '/view'));

      // Email working PDF to signer if configured (only when not all signed yet)
      try {
        var allSignedNow = _allSlotsSigned(record);
        if (!allSignedNow) {
          var wsEmail = (record.signing && record.signing.emailWorkingToSigners === false) ? false : true;
          if (wsEmail && (typeof _notifySignerSigned === 'function')) {
            _notifySignerSigned(record, slot, workingBytes, slot.label);
          }
        }
      } catch (e) { Logger.log('working email notify warning: %s', e.message); }

      // B5: sequential signing — once Party A signs, email Party B their link (after working PDF exists)
      if (record.signing && record.signing.sequentialSigning && slotIndex === 0 && record.slots.length > 1) {
        var bSlot = record.slots[1];
        if (bSlot.status === 'pending' && bSlot.signerEmail) {
          var bRes = _dispatchSlot(record, bSlot, _cfgFromRecord(record));
          if (bRes.ok) {
            LOG_AUDIT_EVENT('DISPATCH', {
              docId: record.jobId,
              docName: record.docName,
              signer: bSlot.signerEmail,
              status: 'Sent',
              spreadsheetId: record.spreadsheetId,
              details: 'Sequential: Party B link sent after Party A signed. Slot ' + bSlot.slot + ' (' + bSlot.label + ').'
            });
          } else {
            try {
              LOG_AUDIT_EVENT('DISPATCH', {
                docId: record.jobId,
                docName: record.docName,
                signer: bSlot.signerEmail,
                status: 'Failed',
                spreadsheetId: record.spreadsheetId,
                details: 'Sequential dispatch failed: ' + bRes.error
              });
            } catch (e) {}
            Logger.log('PLACE_SIGNATURE_ON_PDF sequential dispatch warning: %s', bRes.error);
          }
        }
      }

      LOG_AUDIT_EVENT('SIGN', {
        docId: record.jobId,
        docName: record.docName,
        signer: slot.signerEmail,
        status: 'Signed slot ' + slot.slot + ' (' + slot.label + ')',
        spreadsheetId: record.spreadsheetId,
        details: 'Working PDF updated.' + (slot.textValue ? ' Text: ' + slot.textValue : '') + (slot.initials ? ' Initials: ' + slot.initials : '') + ' Type: ' + (record.typeId || '')
      });

      var result = { ok: true, workingPdfUrl: workingFile.url, slot: slot.slot };

      if (_allSlotsSigned(record)) {
        var final = await _finalizeJob(record);
        if (final.ok) {
          result.finalized = true;
          result.signedPdfUrl = final.signedPdfUrl;
          result.hash = final.hash;
          result.finalHash = final.finalHash;
          result.verifyUrl = final.verifyUrl;
        }
      }
      return result;
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('PLACE_SIGNATURE_ON_PDF error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Owner-triggered finalize (sidebar): produces the audit-stamped _SIGNED.pdf.
 * Also serialized under the script lock so a concurrent signer submission
 * cannot finalize at the same time (idempotent: a re-finalize is a no-op).
 * @param {string} jobId
 * @return {Object} finalize result.
 */
async function RUN_FINALIZE(jobId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    try {
      var record = _getJobRecord(jobId);
      if (!record) {
        return { ok: false, error: 'Job not found.' };
      }
      return await _finalizeJob(record);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('RUN_FINALIZE error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Finalizes a job: stamp audit (hash + QR) on last page, write _SIGNED.pdf,
 * flip sheet status, mark finalized, clean up temp signature files.
 */
async function _finalizeJob(record) {
  try {
    if (record.finalized) {
      return { ok: false, error: 'This document is already finalized.' };
    }
    if (!_allSlotsSigned(record)) {
      return { ok: false, error: 'Not all signature slots are signed yet.' };
    }

    // 1. Hash over the signed (pre-stamp) working bytes.
    var preBytes = await RECONSTRUCT_PDF(record, false);
    var signerEmails = record.slots.map(function (s) { return s.signerEmail; });
    var meta = GENERATE_AUDIT_METADATA(record.jobId, {
      docName: record.docName,
      signers: signerEmails
    }, preBytes);

    // 2. Reconstruct WITH the audit stamp drawn on the last page.
    record.audit = meta;
    var finalBytes = await RECONSTRUCT_PDF(record, true);
    var finalName = record.docName.replace(/\.[^.]*$/, '') + '_SIGNED';
    var finalFile = _upsertPdfInFolder(record.outputFolderId, finalName, finalBytes, record.signedPdfId);
    record.signedPdfId = finalFile.id; // persisted by _saveJobRecord below

    // 3. Tamper-evidence anchor: SHA-256 over the FINAL exported bytes,
    //    stored in the job record, the audit log and the owner email.
    //    The printed stamp hash covers the pre-stamp signed bytes, so a
    //    recompute of this final file always matches record.finalHash.
    var finalMeta = GENERATE_AUDIT_METADATA(record.jobId, {
      docName: record.docName,
      signers: signerEmails
    }, finalBytes);
    record.finalHash = finalMeta.hash;
    record.finalStampIso = finalMeta.verifiedStampIso;
    record.verifyUrl = WEB_APP_BASE_URL + '?action=verify&job=' +
      encodeURIComponent(record.jobId) + '&hash=' + record.finalHash;

    record.finalized = true;
    _saveJobRecord(record);

    var statusText = 'Signed on ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm z');
    _updateSheetStatus(record, statusText);
    _markRowDocumentSigned(record);
    _updatePdfLinkCell(record, 'signedPdfColumn',
      finalFile.url || ('https://drive.google.com/file/d/' + finalFile.id + '/view'));

    _notifyOwnerSigned(record, finalFile, finalBytes);

    LOG_AUDIT_EVENT('FINALIZE', {
      docId: record.jobId,
      docName: record.docName,
      hash: meta.hash,
      finalHash: record.finalHash,
      signer: signerEmails.join(', '),
      status: statusText,
      spreadsheetId: record.spreadsheetId,
      details: 'PDF exported as ' + finalFile.name + '. Type: ' + (record.typeId || '') + '. Integrity hash (final bytes): ' + record.finalHash
    });

    // Email final PDF to all signers
    try {
      var ef = (record.signing && record.signing.emailFinalToSigners === false) ? false : true;
      if (ef && finalBytes) {
        (record.slots || []).forEach(function (s) {
          if (s.signerEmail) {
            try {
              var subjF = 'DocuPDF Sign — ' + record.docName + ' is fully signed';
              var bodyF = 'Your signed copy of "' + record.docName + '" is attached.';
              var optsF = { name: 'DocuPDF Sign', attachments: [Utilities.newBlob(finalBytes, 'application/pdf', finalFile.name || 'signed.pdf')] };
              GmailApp.sendEmail(s.signerEmail, subjF, bodyF, optsF);
              try { LOG_AUDIT_EVENT('NOTIFY', { docId: record.jobId, docName: record.docName, signer: s.signerEmail, status: 'Sent', spreadsheetId: record.spreadsheetId, details: 'Signer notified with final PDF.' }); } catch (e2) {}
            } catch (e) {
              try { LOG_AUDIT_EVENT('NOTIFY', { docId: record.jobId, docName: record.docName, signer: s.signerEmail, status: 'Failed', spreadsheetId: record.spreadsheetId, details: 'Signer final PDF failed: ' + e.message }); } catch (e2) {}
            }
          } else {
            try { LOG_AUDIT_EVENT('NOTIFY', { docId: record.jobId, docName: record.docName, signer: s.label || '', status: 'Skipped', spreadsheetId: record.spreadsheetId, details: 'No signer email.' }); } catch (e2) {}
          }
        });
      }
    } catch (e) { Logger.log('final signer emails warning: %s', e.message); }

    _cleanupSigFiles(record);
    return {
      ok: true,
      signedPdfUrl: finalFile.url,
      signedPdfId: finalFile.id,
      hash: meta.hash,
      finalHash: record.finalHash,
      verifiedStamp: meta.verifiedStamp,
      verifyUrl: record.verifyUrl
    };
  } catch (err) {
    Logger.log('_finalizeJob error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Records a signer DECLINE: marks the slot declined, flips status.
 * Serialized under the script lock so a concurrent sign/submit cannot clobber
 * the record (same read-modify-write guard as PLACE_SIGNATURE_ON_PDF).
 * @param {Object} payload { jobId, signToken, nonce, reason? }
 * @return {Object} { ok, status?, error? }
 */
function DECLINE_SIGNING_REQUEST(payload) {
  var lock = LockService.getScriptLock();
  var out = { ok: false, error: 'Decline failed.' };
  var notify = null;
  try {
    payload = payload || {};
    var pre = _validateSigningToken(payload.jobId, payload.signToken, payload.nonce);
    if (!pre.valid) {
      out = { ok: false, error: pre.reason };
    } else {
      var reason = _normalizeDeclineReason(payload.reason);
      if (!reason) {
        out = { ok: false, error: 'A decline reason is required.' };
      } else {
        lock.waitLock(30000);
        try {
          var state = _validateSigningToken(payload.jobId, payload.signToken, payload.nonce);
          if (!state.valid) {
            out = { ok: false, error: state.reason };
          } else {
            var record = state.record;
            var slot = record.slots[state.slotIndex];
            var reasonIn = _normalizeDeclineReason(payload.reason);
            if (!reasonIn) {
              out = { ok: false, error: 'A decline reason is required.' };
            } else {
              slot.status = 'declined';
              slot.signerEmail = payload.signerEmail || slot.signerEmail || '';
              slot.declineReason = reasonIn;
              slot.used = true;
              _saveJobRecord(record);
              _markSlotTokenUsed(record.jobId, state.slotIndex); // idempotent store sync
              _updateSignerStatus(record, state.slotIndex, 'Declined ' + _slotStamp());
              _updateSignerDeclineReason(record, state.slotIndex, reasonIn);

              var statusText = _clip('Declined — ' + reasonIn, 80);
              _updateSheetStatus(record, statusText);

              LOG_AUDIT_EVENT('DECLINE', {
                docId: record.jobId,
                docName: record.docName,
                signer: slot.signerEmail,
                status: statusText,
                spreadsheetId: record.spreadsheetId,
                details: reasonIn + ' (slot ' + slot.slot + ' ' + slot.label + '). Type: ' + (record.typeId || '')
              });

              notify = { record: record, slot: slot, reason: reasonIn };
              out = { ok: true, status: statusText };
            }
          }
        } finally {
          lock.releaseLock();
        }
      }
    }
  } catch (err) {
    Logger.log('DECLINE_SIGNING_REQUEST error: %s', err.message);
    out = { ok: false, error: err.message };
  }
  if (out.ok && notify) {
    _notifyOwnerDeclined(notify.record, notify.slot, notify.reason);
  }
  return out;
}

function _normalizeDeclineReason(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\r?\n/g, ' ').trim().slice(0, 1000);
}

/**
 * Writes a status value into the configured status cell.
 * @param {Object} record Job record (has spreadsheetId, rowNumber, statusColumn).
 * @param {string} statusText
 */
function UPDATE_SHEET_STATUS(record, statusText) {
  try {
    _updateSheetStatus(record || {}, statusText);
    return { ok: true };
  } catch (err) {
    Logger.log('UPDATE_SHEET_STATUS error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _updateSheetStatus(record, statusText) {
  if (!record || !record.rowNumber || !record.statusColumn) {
    Logger.log('_updateSheetStatus skipped: missing rowNumber/statusColumn.');
    return;
  }
  var ss = null;
  if (record.spreadsheetId) {
    ss = _openSpreadsheet(record.spreadsheetId);
  } else {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      ss = null;
    }
  }
  if (!ss) {
    Logger.log('_updateSheetStatus skipped: no spreadsheet context.');
    return;
  }
  var sheet = record.dataSheetName ? ss.getSheetByName(record.dataSheetName) : ss.getSheets()[0];
  if (!sheet) {
    Logger.log('_updateSheetStatus skipped: sheet "%s" not found.', record.dataSheetName);
    return;
  }
  _setCellText(sheet.getRange(record.rowNumber, record.statusColumn), statusText);
}

/**
 * Timestamp format used by the per-slot 'Signer A/B Status' cells.
 * @return {string} e.g. '2026-10-01 14:32'
 */
function _slotStamp() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');
}

/**
 * Writes a per-signer state into that slot's 'Signer A Status' / 'Signer B
 * Status' cell. Slot 1 -> A, slot 2 -> B.
 *
 * Silent no-op when the column is not mapped (0) or the sheet/spreadsheet is
 * unavailable, so a missing column can never break the signing flow. DocuPDF
 * Status is a separate, untouched concern (see _updateSheetStatus).
 * @param {Object} record Job record (spreadsheetId, dataSheetName, rowNumber,
 *                           signerAStatusColumn, signerBStatusColumn).
 * @param {number} slotIndex Zero-based slot index (0 = Party A).
 * @param {string} statusText Cell value, e.g. 'Awaiting', 'Signed 2026-10-01 14:32'.
 * @return {boolean} true when a cell was written.
 */
function _updateSignerStatus(record, slotIndex, statusText) {
  try {
    if (!record || !record.rowNumber) {
      return false;
    }
    var col = Number(slotIndex) === 0
      ? Number(record.signerAStatusColumn || 0)
      : Number(record.signerBStatusColumn || 0);
    if (!col) {
      Logger.log('_updateSignerStatus skipped: signer status column not mapped (slot %s).', String(slotIndex + 1));
      return false;
    }
    var ss = record.spreadsheetId
      ? _openSpreadsheet(record.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return false;
    }
    var sheet = record.dataSheetName ? ss.getSheetByName(record.dataSheetName) : ss.getSheets()[0];
    if (!sheet) {
      return false;
    }
    sheet.getRange(record.rowNumber, col).setValue(statusText);
    return true;
  } catch (e) {
    Logger.log('_updateSignerStatus warning: %s', e.message);
    return false;
  }
}

function _updateSignerDeclineReason(record, slotIndex, text) {
  try {
    if (!record || !record.rowNumber) {
      return false;
    }
    var col = Number(slotIndex) === 0
      ? Number(record.signerADeclineReasonColumn || 0)
      : Number(record.signerBDeclineReasonColumn || 0);
    if (!col) {
      Logger.log('_updateSignerDeclineReason skipped: decline reason column not mapped (slot %s).', String(slotIndex + 1));
      return false;
    }
    var ss = record.spreadsheetId
      ? _openSpreadsheet(record.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return false;
    }
    var sheet = record.dataSheetName ? ss.getSheetByName(record.dataSheetName) : ss.getSheets()[0];
    if (!sheet) {
      return false;
    }
    _setCellText(sheet.getRange(record.rowNumber, col), text);
    return true;
  } catch (e) {
    Logger.log('_updateSignerDeclineReason warning: %s', e.message);
    return false;
  }
}

function _updatePdfLinkCell(record, colKey, url) {
  try {
    if (!record || !record.rowNumber || !colKey || !url) {
      return false;
    }
    var ss = record.spreadsheetId
      ? _openSpreadsheet(record.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return false;
    }
    var sheet = record.dataSheetName ? ss.getSheetByName(record.dataSheetName) : ss.getSheets()[0];
    if (!sheet) {
      return false;
    }
    var col = Number(record[colKey] || 0);
    if (!col) {
      var header = colKey === 'signedPdfColumn' ? COL_HEADER.signedPdfLink : COL_HEADER.workingPdfLink;
      col = _findHeaderCol(sheet, header);
      if (col) {
        record[colKey] = col;
        _saveJobRecord(record);
      }
    }
    if (!col) {
      return false;
    }
    _setCellText(sheet.getRange(record.rowNumber, col), url);
    return true;
  } catch (e) {
    Logger.log('_updatePdfLinkCell warning: %s', e.message);
    return false;
  }
}

/** Marks the 'Document Signed' cell with the signers + timestamp once finalized. */
function _markRowDocumentSigned(record) {
  try {
    if (!record || !record.rowNumber || !record.documentSignedColumn) {
      return;
    }
    var ss = record.spreadsheetId
      ? _openSpreadsheet(record.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return;
    }
    var sheet = record.dataSheetName ? ss.getSheetByName(record.dataSheetName) : ss.getSheets()[0];
    if (!sheet) {
      return;
    }
    var signers = record.slots.map(function (s) { return s.signerEmail || ''; }).filter(Boolean).join(', ');
    var when = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm z');
    sheet.getRange(record.rowNumber, record.documentSignedColumn)
      .setValue('Signed by ' + signers + ' on ' + when);
  } catch (err) {
    Logger.log('_markRowDocumentSigned error: %s', err.message);
  }
}

function _allSlotsSigned(record) {
  return (record.slots || []).length > 0 &&
    record.slots.every(function (s) { return s.status === 'signed'; });
}

/**
 * Returns the id of the app-created folder holding signature PNGs, creating it
 * on first use and caching the id in Script Properties. Falls back to '' (My
 * Drive root) if the folder cannot be created — these are throwaway temp files
 * that are trashed on finalize.
 * @return {string} folder id ('' = root)
 */
function _sigFolderId() {
  try {
    var props = PropertiesService.getScriptProperties();
    var cached = String(props.getProperty(SIG_FOLDER_PROP) || '');
    if (cached) {
      return cached;
    }
    var folder = _driveCreateFolder(APP_NAME + ' — Signatures');
    if (!folder.ok) {
      Logger.log('_sigFolderId: folder creation failed (%s) — using My Drive root.', folder.error);
      return '';
    }
    props.setProperty(SIG_FOLDER_PROP, folder.id);
    Logger.log('_sigFolderId: created signature folder %s.', folder.id);
    return folder.id;
  } catch (e) {
    Logger.log('_sigFolderId error: %s', e.message);
    return '';
  }
}

/**
 * Saves the base64 signature PNG as an app-created Drive temp file
 * (Drive REST API — DriveApp.createFile would require the full drive scope).
 * @return {Object} { ok, id } or { ok:false, code?, error }
 */
function _saveSignatureBlob(jobId, slotIndex, base64) {
  var b64 = String(base64 || '');
  if (b64.indexOf('base64,') !== -1) {
    b64 = b64.substring(b64.indexOf('base64,') + 7);
  }
  var bytes = Utilities.base64Decode(b64);
  if (!bytes || !bytes.length) {
    throw new Error('Signature image data is empty.');
  }
  var name = SIG_TMP_PREFIX + jobId + '_' + slotIndex + '.png';
  var res = _driveUploadFile(name, bytes, 'image/png', _sigFolderId());
  if (!res.ok) {
    throw new Error('Cannot save the signature image: ' + (res.error || 'Drive upload failed'));
  }
  return { ok: true, id: res.id, name: res.name, url: res.url };
}

function _cleanupSigFiles(record) {
  (record.slots || []).forEach(function (slot) {
    if (slot.sigFileId) {
      var res = _driveTrashFile(slot.sigFileId);
      if (!res.ok) {
        Logger.log('_cleanupSigFiles: %s', res.error);
      }
    }
  });
}

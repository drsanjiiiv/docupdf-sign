/** file name: auditStampEngine.gs */

/**
 * DocuPDF Sign — audit & verification stamp engine (PDF edition).
 * SHA-256 fingerprint + verified-stamp metadata used to stamp the final PDF.
 * Drawing of the stamp (text + QR) lives in pdfSignEngine._drawAuditStamp.
 */

var QR_ENDPOINT = 'https://quickchart.io/qr?text=';

/**
 * Generates audit metadata for a document.
 * If optBytes is provided, the SHA-256 digest is computed over the actual PDF
 * bytes (true file fingerprint). Otherwise over a canonical JSON of docId +
 * row data + timestamp.
 *
 * @param {string} docId Drive file id being signed.
 * @param {Object|Array} rowData Signer / row data to fingerprint.
 * @param {Array<number>|null} optBytes PDF bytes (optional).
 * @return {Object} { hash, verifiedStamp, verifiedStampIso, qrUrl, fingerprintInput }
 */
function GENERATE_AUDIT_METADATA(docId, rowData, optBytes) {
  try {
    if (!docId) {
      throw new Error('docId is required for audit metadata.');
    }
    var digest;
    if (optBytes) {
      digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        optBytes,
        Utilities.Charset.UTF_8
      );
    } else {
      var canonical = JSON.stringify({
        docId: docId,
        data: rowData || {},
        ts: new Date().toISOString()
      });
      digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        canonical,
        Utilities.Charset.UTF_8
      );
    }
    var hash = digest.map(function (byte) {
      return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
    }).join('').toUpperCase();

    var now = new Date();
    var verifiedStamp = Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss z');

    var verifyUrl = WEB_APP_BASE_URL +
      '?action=verify&job=' + encodeURIComponent(docId) +
      '&hash=' + hash;
    var qrUrl = QR_ENDPOINT + encodeURIComponent(verifyUrl) + '&size=96&margin=0&qzone=1';

    return {
      hash: hash,
      verifiedStamp: verifiedStamp,
      verifiedStampIso: now.toISOString(),
      qrUrl: qrUrl,
      fingerprintInput: optBytes ? 'file-bytes' : canonical
    };
  } catch (err) {
    Logger.log('GENERATE_AUDIT_METADATA error: %s', err.message);
    throw err;
  }
}

/**
 * Records an audit event row on the AuditLog sheet (lazy-created).
 * @param {string} event  Event type (JOB / DISPATCH / SIGN / DECLINE / FINALIZE).
 * @param {Object} meta   { docId, docName, hash, signer, status, details }.
 */
function LOG_AUDIT_EVENT(event, meta) {
  try {
    var ss = null;
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    // Web-app context (execute-as-ME) has no active spreadsheet; fall back to
    // the job's spreadsheet when the caller passes meta.spreadsheetId.
    if (!ss && meta && meta.spreadsheetId) {
      try { ss = _openSpreadsheet(meta.spreadsheetId); } catch (e) { ss = null; }
    }
    if (!ss) {
      Logger.log('LOG_AUDIT_EVENT skipped: no spreadsheet context.');
      return;
    }
    var audit = ss.getSheetByName('AuditLog') || _createAuditSheet(ss);
    meta = meta || {};
    audit.appendRow([
      new Date(),
      event,
      meta.docId || '',
      meta.docName || '',
      meta.hash || '',
      meta.signer || '',
      meta.status || '',
      meta.details || ''
    ]);
  } catch (err) {
    Logger.log('LOG_AUDIT_EVENT error: %s', err.message);
  }
}

function _createAuditSheet(ss) {
  var audit = ss.insertSheet('AuditLog');
  audit.appendRow(['Timestamp', 'Event', 'DocId', 'DocName', 'Hash', 'Signer', 'Status', 'Details']);
  audit.setFrozenRows(1);
  _protectAuditSheet(audit);
  return audit;
}

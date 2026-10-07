/** file name: pdfSignEngine.gs */

/**
 * DocuPDF Sign — PDF overlay signing engine.
 *
 * Signs EXISTING flattened PDFs (invoices, MOUs) by overlaying signature
 * images + audit text/QR onto pages using the vendored pdf-lib bundle
 * (global PDFLibBundle, see vendor/pdf-lib-bundle.gs).
 *
 * Signing model (PLAN.md 0b-A / 0b-C):
 *   - Remote signers draw in the token-gated modal; the doc OWNER's session
 *     (web app executes-as-ME) reconstructs the working PDF server-side.
 *   - Signatures are stored as app-created Drive temp files (drive.file-safe)
 *     and referenced by file id — keeps Script Properties small.
 *   - A two-slot document finalizes only when BOTH parties have signed.
 *
 * Coordinate convention: page is 1-based; x/y are in POINTS measured from the
 * TOP-LEFT of the page (converted to pdf-lib's bottom-left origin internally).
 */

// pdfSignEngine.gs may be loaded BEFORE vendor/pdf-lib-bundle.gs, so resolving
// PDFLibBundle at script-load time (var PDF = PDFLibBundle) yields undefined and
// breaks every pdf-lib call. Resolve lazily via getters at access time instead.
var PDF = {};
['PDFDocument', 'StandardFonts', 'rgb', 'degrees'].forEach(function (key) {
  Object.defineProperty(PDF, key, {
    configurable: true,
    get: function () { return PDFLibBundle[key]; }
  });
});
var SIG_FRAME_W = 480;
var SIG_FRAME_H = 160;
// ScriptProperties key caching the id of the app-created folder that holds the
// signature PNG temp files (created on first need).
var SIG_FOLDER_PROP = 'DPD_SIG_FOLDER_ID';

/**
 * Downloads a PDF file and returns { bytes, name, folderId }.
 * Works for any file the app was given access to (picked / created).
 */
function _loadPdfFile(pdfId) {
  var r = _driveReadPdf(pdfId);
  if (!r.ok) {
    throw new Error(r.error || 'Cannot read the source PDF.');
  }
  var mime = r.mime || 'application/pdf';
  if (mime && mime !== 'application/pdf') {
    throw new Error('Selected file is not a PDF (' + mime + ').');
  }
  return {
    bytes: r.bytes,
    name: String(r.name || '').replace(/\.[^.]*$/, '') || 'document',
    folderId: ''
  };
}

/**
 * Loads the vendored pdf-lib PDFDocument from a byte array.
 */
async function _loadPdf(bytes) {
  return PDF.PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
}

/**
 * Saves a PDFDocument back to a GAS byte array.
 */
async function _savePdf(doc) {
  return Array.from(await doc.save());
}

/**
 * Writes a PDF byte array to the given Drive folder via the Drive REST API v3.
 * @param {string} folderId Destination folder ('' = My Drive root).
 * @param {string} name File name WITHOUT the .pdf suffix.
 * @param {Array<number>} bytes
 * @return {Object} { ok, id, name, url } or { ok:false, code?, error }
 */
function _writePdfToFolder(folderId, name, bytes) {
  var res = _driveUploadFile(name + '.pdf', bytes, 'application/pdf', folderId);
  if (!res.ok) {
    return res;
  }
  return { ok: true, id: res.id, name: name + '.pdf', url: res.url };
}

/**
 * Writes (or replaces) a PDF in a folder. drive.file cannot list/search Drive
 * (a `q` query needs the full drive scope), so "upsert by name" is impossible:
 * the caller passes the id of the file it created last time and the bytes are
 * replaced in place. Only when no id is stored (first write, or the previous
 * file was deleted outside the app) is a fresh file created.
 * @param {string} folderId Destination folder ('' = My Drive root).
 * @param {string} name File name WITHOUT the .pdf suffix.
 * @param {Array<number>} bytes
 * @param {string} [existingFileId] Id returned by a previous call.
 * @return {Object} { ok, id, name, url } — url is the Drive webViewLink.
 * @throws {Error} when the file can be neither replaced nor created.
 */
function _upsertPdfInFolder(folderId, name, bytes, existingFileId) {
  if (existingFileId) {
    var rep = _driveReplaceFileContent(existingFileId, bytes, 'application/pdf');
    if (rep.ok) {
      return { ok: true, id: rep.id, name: name + '.pdf', url: rep.url };
    }
    // Stale id (file deleted / access lost) — fall back to a fresh create.
    Logger.log('_upsertPdfInFolder replace failed for %s: %s', existingFileId, rep.error);
  }
  var created = _writePdfToFolder(folderId, name, bytes);
  if (!created.ok) {
    throw new Error(created.error || ('Cannot write ' + name + '.pdf to Drive.'));
  }
  return created;
}

/**
 * Embeds a base64 PNG into a PDFDocument, returning { image, w, h }.
 */
async function _embedPng(doc, base64) {
  var b64 = String(base64 || '');
  if (b64.indexOf('base64,') !== -1) {
    b64 = b64.substring(b64.indexOf('base64,') + 7);
  }
  return _embedPngBytes(doc, Utilities.base64Decode(b64));
}

/**
 * Embeds PNG bytes into a PDFDocument, returning { image, w, h }.
 */
async function _embedPngBytes(doc, bytes) {
  var image = await doc.embedPng(new Uint8Array(bytes));
  return { image: image, w: image.width || SIG_FRAME_W, h: image.height || SIG_FRAME_H };
}

/**
 * Fits the signature frame (3:1) inside the configured box, preserving aspect.
 * @return {Object} { drawX, drawY, drawW, drawH } in pdf-lib (bottom-left) coords.
 */
function _fitSignatureBox(page, slot) {
  var pageW = page.getWidth();
  var pageH = page.getHeight();
  var boxW = Number(slot.width) || 160;
  var boxH = Number(slot.height) || 60;
  var scale = Math.min(boxW / SIG_FRAME_W, boxH / SIG_FRAME_H, 1);
  var drawW = SIG_FRAME_W * scale;
  var drawH = SIG_FRAME_H * scale;
  var hasX = Number(slot.x) > 0;
  var hasY = Number(slot.y) > 0;
  var align = slot.align || 'center';
  var vOffset = Number(slot.vOffset) || 0.85;
  var topLeftX = hasX ? Number(slot.x)
    : align === 'left' ? 40
    : align === 'right' ? Math.max(pageW - drawW - 40, 40)
    : (pageW - drawW) / 2;
  var topLeftY = hasY ? Number(slot.y)
    : vOffset > 0 ? Math.max(pageH * Math.min(vOffset, 1) - drawH, 20)
    : (pageH - drawH - 60);
  var drawX = topLeftX;
  var drawY = pageH - topLeftY - drawH; // top-left -> bottom-left origin
  return { drawX: drawX, drawY: drawY, drawW: drawW, drawH: drawH };
}

/**
 * Draws one signature slot (ink + "Signed by <name> on <date>" caption).
 * The ink is loaded from the app-created Drive temp file referenced by
 * slot.sigFileId.
 * @return {Promise} resolves after drawing.
 */
async function _drawSignatureSlot(doc, page, slot) {
  var box = _fitSignatureBox(page, slot);
  var sig;
  if (slot.sigFileId) {
    sig = await _embedPngBytes(doc, _driveFetchBytesOrThrow(slot.sigFileId));
  } else if (slot.signatureBase64) {
    sig = await _embedPng(doc, slot.signatureBase64);
  } else {
    throw new Error('Slot ' + (slot.slot || '?') + ' has no signature image.');
  }
  page.drawImage(sig.image, {
    x: box.drawX,
    y: box.drawY,
    width: box.drawW,
    height: box.drawH
  });

  var font = await doc.embedFont(PDF.StandardFonts.Helvetica);
  var lines = ['Signed by ' + (slot.signerName || slot.signerEmail || 'Signer')];
  if (slot.signedAt) {
    lines[0] += ' on ' + Utilities.formatDate(new Date(slot.signedAt), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm z');
  }
  if (slot.signerDesignation) {
    lines.push('Designation: ' + slot.signerDesignation);
  }
  if (slot.signerEmail) {
    lines.push('Email: ' + slot.signerEmail);
  }
  if (slot.initials) {
    lines.push('Initials: ' + slot.initials);
  }
  if (slot.textValue) {
    lines.push(slot.textValue);
  }
  var textX = box.drawX;
  var size = 8;
  var lineH = 10;
  for (var li = 0; li < lines.length; li++) {
    page.drawText(lines[li], {
      x: textX,
      y: Math.max(box.drawY - 12 - (li * lineH), 4),
      size: size,
      font: font,
      color: PDF.rgb(0.13, 0.13, 0.13)
    });
  }
}

/**
 * Draws the audit stamp block (verified text + QR) onto a page (default last).
 * @param {Object} meta from GENERATE_AUDIT_METADATA.
 */
async function _drawAuditStamp(doc, page, meta, signerEmails) {
  var pageW = page.getWidth();
  var pageH = page.getHeight();
  var font = await doc.embedFont(PDF.StandardFonts.Helvetica);

  var lines = [
    'DocuPDF Sign ID: ' + meta.hash,
    'Verified Stamp: ' + meta.verifiedStamp,
    'PWMAI Security Engine',
    'Signer(s): ' + (signerEmails.join(', ') || '—')
  ];
  var size = 8;
  var lineH = 12;
  var blockW = 300;
  var qrW = 60;
  var margin = 24;
  var startX = margin;
  var textTop = pageH - margin;

  page.drawText('— End of Document —', {
    x: startX, y: textTop, size: 9, font: font, color: PDF.rgb(0.3, 0.3, 0.3)
  });
  textTop -= lineH + 6;

  for (var i = 0; i < lines.length; i++) {
    page.drawText(lines[i], {
      x: startX, y: textTop, size: size, font: font, color: PDF.rgb(0.5, 0.5, 0.5)
    });
    textTop -= lineH;
  }

  if (meta.qrUrl) {
    var qrPng = _fetchQrPng(meta.qrUrl);
    if (qrPng) {
      var qr = await doc.embedPng(new Uint8Array(qrPng));
      var qrX = Math.max(startX + blockW, pageW - qrW - margin);
      page.drawImage(qr, { x: qrX, y: pageH - qrW - margin, width: qrW, height: qrW });
    }
  }
}

/**
 * Fetches QR PNG bytes from the whitelisted quickchart.io endpoint.
 * @return {Array<number>|null}
 */
function _fetchQrPng(qrUrl) {
  try {
    var resp = UrlFetchApp.fetch(qrUrl, { muteHttpExceptions: true, timeoutSeconds: 15 });
    if (resp.getResponseCode() !== 200) {
      Logger.log('_fetchQrPng status %s', resp.getResponseCode());
      return null;
    }
    return resp.getContent();
  } catch (err) {
    Logger.log('_fetchQrPng error: %s', err.message);
    return null;
  }
}

/**
 * Reconstructs the working PDF = source + all completed slots + (optional) audit.
 * @param {Object} job Token/job record (see Code.gs token registry).
 * @param {boolean} withAudit Also stamp the audit footer.
 * @return {Array<number>} PDF bytes.
 */
async function RECONSTRUCT_PDF(job, withAudit) {
  try {
    var source = _loadPdfFile(job.sourcePdfId);
    var doc = await _loadPdf(source.bytes);
    var pages = doc.getPages();

    for (var i = 0; i < (job.slots || []).length; i++) {
      var slot = job.slots[i];
      if (slot.status === 'signed' && (slot.sigFileId || slot.signatureBase64)) {
        var pageIdx = Math.min(Math.max(1, Number(slot.page) || pages.length), pages.length) - 1;
        await _drawSignatureSlot(doc, pages[pageIdx], slot);
      }
    }

    if (withAudit && job.audit) {
      var last = pages[pages.length - 1];
      var signerEmails = (job.slots || [])
        .filter(function (s) { return s.status === 'signed'; })
        .map(function (s) { return s.signerEmail; });
      await _drawAuditStamp(doc, last, job.audit, signerEmails);
    }

    return await _savePdf(doc);
  } catch (err) {
    Logger.log('RECONSTRUCT_PDF error: %s', err.message);
    throw err;
  }
}

/**
 * Scope probe: verifies DocuPDF can actually open a given Drive file id under
 * its current scopes (drive.file). Gates the sheet-id fallback path.
 * @param {string} fileId
 * @return {Object} { ok, mimeType, name, error? }
 */
async function PROBE_DOC_ACCESS(fileId) {
  try {
    var r = _driveReadPdf(fileId);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    var probe = await _loadPdf(r.bytes); // if it throws, not a usable PDF
    return {
      ok: true,
      mimeType: 'application/pdf',
      name: r.name,
      bytes: r.bytes.length,
      pages: probe.getPageCount()
    };
  } catch (err) {
    Logger.log('PROBE_DOC_ACCESS error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _probeDocSync(fileId) {
  try {
    var r = _driveReadPdf(fileId);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    var bytes = r.bytes || [];
    if (!bytes.length) {
      return { ok: false, error: 'The source PDF is empty.' };
    }
    var limit = Math.min(bytes.length, 1024);
    var head = '';
    for (var i = 0; i < limit; i++) {
      head += String.fromCharCode(bytes[i]);
    }
    if (head.indexOf('%PDF') === -1) {
      return { ok: false, error: 'The selected file is not a readable PDF.' };
    }
    return { ok: true, mimeType: 'application/pdf', name: r.name, bytes: bytes.length };
  } catch (err) {
    Logger.log('_probeDocSync error: %s', err.message);
    return { ok: false, error: err.message };
  }
}

function _clip(text, max) {
  var s = String(text === undefined || text === null ? '' : text);
  var m = Number(max) || 0;
  if (m > 0 && s.length > m) {
    return s.substring(0, m - 1) + '\u2026';
  }
  return s;
}

function _setCellText(range, text) {
  var v = String(text === undefined || text === null ? '' : text);
  if (/^[=+\-@]/.test(v)) {
    v = "'" + v;
  }
  range.setValue(v);
}

/** Converts an A1-style or plain file id to a plain file id (URL tolerance). */
function NORMALIZE_FILE_ID(input) {
  var s = String(input || '').trim();
  var m = /[-\w]{20,}/.exec(s);
  return m ? m[0] : s;
}

/**
 * Fetches Drive file metadata via the Drive REST API v3, using the app's own
 * drive.file token. drive.file-only apps CANNOT read picked files through
 * DriveApp.getFileById (that service requires drive.readonly/drive); the REST
 * API honors the per-file grants the Picker creates, so this is the reliable
 * read path for a picked template or a DocuMail-created PDF.
 * @return {Object} { ok, id?, name?, mime?, size?, code?, error? }
 */
function _driveFetchMeta(fileId) {
  try {
    var token = ScriptApp.getOAuthToken();
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?fields=id,name,mimeType,size&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code !== 200) {
      return { ok: false, code: code, error: 'Drive API HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 160) };
    }
    var meta = JSON.parse(res.getContentText());
    return { ok: true, id: meta.id, name: meta.name, mime: meta.mimeType, size: meta.size || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Downloads a file's bytes via the Drive REST API v3. Native PDFs use
 * alt=media; Google-native files (Docs/Sheets) are exported to application/pdf
 * so DocuMail-created documents work too.
 * @return {Object} { ok, name?, mime?, bytes?, code?, error? }
 */
function _driveReadPdf(fileId) {
  try {
    var meta = _driveFetchMeta(fileId);
    if (!meta.ok) {
      return meta;
    }
    var token = ScriptApp.getOAuthToken();
    var base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId);
    var isPdf = meta.mime === 'application/pdf' || meta.mime === 'application/octet-stream';
    var url = isPdf
      ? base + '?alt=media&supportsAllDrives=true'
      : base + '/export?mimeType=application/pdf&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code !== 200) {
      return { ok: false, code: code, error: 'Drive API HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 160) };
    }
    return { ok: true, name: meta.name, mime: 'application/pdf', bytes: res.getContent() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Lightweight Drive access probe for a file id under the app's scopes
 * (drive.file). Does NOT load pdf-lib — used for cheap save-time validation.
 * @return {Object} { ok, name?, mime?, error? }
 */
function _fileAccessible(fileId) {
  var m = _driveFetchMeta(fileId);
  if (m.ok) {
    return { ok: true, name: m.name, mime: m.mime };
  }
  return { ok: false, error: m.error };
}

/* ------------------------------------------------------------------ *
 * Drive REST API v3 — WRITE path.
 *
 * DriveApp.createFile / createFolder require the full `drive` scope, which this
 * app deliberately does not declare. Every write therefore goes through
 * UrlFetchApp with the app's drive.file token: files and folders the app
 * creates are app-created, so drive.file grants full control over them.
 * Anything the app does NOT own and was not granted (a folder the user pasted
 * by id) stays invisible to these calls — probe with _driveFetchMeta first.
 * ------------------------------------------------------------------ */

/** Shared Authorization header for Drive REST calls. */
function _driveAuthHeaders() {
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
}

/** Folder mimeType used by files.create. */
var DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * POST a Drive file via multipart upload (JSON metadata part + one media part).
 * Used by _driveUploadFile only — folders go through the metadata-only path in
 * _driveCreateFolder.
 *
 * The body MUST be assembled as a flat byte array. Apps Script coerces
 * arguments to the declared parameter type, so passing a mixed/nested array
 * literal (strings + a nested number[]) to a byte[] parameter throws
 * "The parameters (number[],String) don't match the method signature for
 * Utilities.newBlob". Text parts therefore go through Blob.getBytes(), which
 * also yields correct UTF-8 for non-ASCII names (the folder name contains an
 * em dash; charCodeAt & 0xff would corrupt it). Parts are CRLF-terminated per
 * RFC 2046.
 * @param {Object} metadata files.create resource (name, mimeType, parents).
 * @param {Array<number>} bytes Media bytes.
 * @param {string} mediaType MimeType declared for the media part.
 * @return {Object} { ok, id, name, url } or { ok:false, code?, error }
 */
function _driveMultipartUpload(metadata, bytes, mediaType) {
  try {
    var boundary = 'docupdf_' + String(Utilities.getUuid()).replace(/-/g, '');
    var head =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mediaType + '\r\n\r\n';
    var tail = '\r\n--' + boundary + '--\r\n';
    var bodyBytes = Utilities.newBlob(head, 'text/plain; charset=UTF-8').getBytes()
      .concat(bytes || [])
      .concat(Utilities.newBlob(tail, 'text/plain; charset=UTF-8').getBytes());
    var body = Utilities.newBlob(bodyBytes, 'multipart/related; boundary=' + boundary);
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
      {
        method: 'post',
        contentType: 'multipart/related; boundary=' + boundary,
        headers: _driveAuthHeaders(),
        payload: body,
        muteHttpExceptions: true
      }
    );
    var code = res.getResponseCode();
    if (code !== 200 && code !== 201) {
      return { ok: false, code: code, error: 'Drive upload HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 200) };
    }
    var json = JSON.parse(res.getContentText());
    return { ok: true, id: json.id, name: json.name, url: json.webViewLink || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Creates a file in Drive via the REST API (drive.file-safe: the file becomes
 * app-created). Replaces DriveApp.createFile / Folder.createFile.
 * @param {string} name File name incl. extension.
 * @param {Array<number>} bytes
 * @param {string} mimeType
 * @param {string} [folderId] Parent folder ('' or omitted = My Drive root).
 * @return {Object} { ok, id, name, url } or { ok:false, code?, error }
 */
function _driveUploadFile(name, bytes, mimeType, folderId) {
  var metadata = { name: name, mimeType: mimeType };
  if (folderId) {
    metadata.parents = [folderId];
  }
  return _driveMultipartUpload(metadata, bytes || [], mimeType || 'application/octet-stream');
}

/**
 * Creates a folder in Drive via a metadata-only files.create POST. Replaces
 * DriveApp.createFolder. No multipart is involved: a folder has no media part,
 * and the Drive API does not require `uploadType` for metadata-only creates.
 * @param {string} name
 * @param {string} [parentId] Parent folder ('' = My Drive root).
 * @return {Object} { ok, id, name, url } or { ok:false, code?, error }
 */
function _driveCreateFolder(name, parentId) {
  try {
    var metadata = { name: name, mimeType: DRIVE_FOLDER_MIME };
    if (parentId) {
      metadata.parents = [parentId];
    }
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
      {
        method: 'post',
        contentType: 'application/json',
        headers: _driveAuthHeaders(),
        payload: JSON.stringify(metadata),
        muteHttpExceptions: true
      }
    );
    var code = res.getResponseCode();
    if (code !== 200 && code !== 201) {
      return { ok: false, code: code, error: 'Drive folder create HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 200) };
    }
    var json = JSON.parse(res.getContentText());
    return { ok: true, id: json.id, name: json.name, url: json.webViewLink || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Replaces the CONTENT of an existing file in place (no new version, no new
 * file id). This is how the _WORKING.pdf / _SIGNED.pdf "upsert" works: the id
 * from the previous write is stored on the job record and patched, because
 * drive.file cannot search for a file by name.
 * @param {string} fileId
 * @param {Array<number>} bytes
 * @param {string} mimeType
 * @return {Object} { ok, id, name, url } or { ok:false, code?, error }
 */
function _driveReplaceFileContent(fileId, bytes, mimeType) {
  try {
    var url = 'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) +
      '?uploadType=media&supportsAllDrives=true&fields=id,name,webViewLink';
    var res = UrlFetchApp.fetch(url, {
      method: 'patch',
      contentType: mimeType || 'application/octet-stream',
      headers: _driveAuthHeaders(),
      payload: Utilities.newBlob(bytes, mimeType || 'application/octet-stream'),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      return { ok: false, code: code, error: 'Drive replace HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 200) };
    }
    var json = JSON.parse(res.getContentText());
    return { ok: true, id: json.id, name: json.name, url: json.webViewLink || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Trashes a file. Replaces DriveApp File.setTrashed(true).
 * @param {string} fileId
 * @return {Object} { ok, id } or { ok:false, code?, error }
 */
function _driveTrashFile(fileId) {
  try {
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?fields=id&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: _driveAuthHeaders(),
      payload: JSON.stringify({ trashed: true }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      return { ok: false, code: code, error: 'Drive trash HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 200) };
    }
    return { ok: true, id: JSON.parse(res.getContentText()).id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Downloads any file's raw bytes via the REST API (alt=media), keeping the real
 * mimeType. _driveReadPdf is PDF-specific (it exports Google-native docs and
 * force-labels the mime) — use this for binary assets like signature PNGs.
 * @param {string} fileId
 * @return {Object} { ok, name?, mime?, bytes? } or { ok:false, code?, error }
 */
function _driveFetchBytes(fileId) {
  try {
    var meta = _driveFetchMeta(fileId);
    if (!meta.ok) {
      return meta;
    }
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?alt=media&supportsAllDrives=true',
      { headers: _driveAuthHeaders(), muteHttpExceptions: true }
    );
    var code = res.getResponseCode();
    if (code !== 200) {
      return { ok: false, code: code, error: 'Drive download HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 160) };
    }
    return { ok: true, name: meta.name, mime: meta.mime, bytes: res.getContent() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** _driveFetchBytes that throws instead of returning (call sites want bytes). */
function _driveFetchBytesOrThrow(fileId) {
  var r = _driveFetchBytes(fileId);
  if (!r.ok || !r.bytes || !r.bytes.length) {
    throw new Error('Cannot read the stored signature file ' + fileId + ': ' + (r.error || 'empty response'));
  }
  return r.bytes;
}

/**
 * Grants "anyone with the link" VIEW access. Equivalent of
 * DriveApp.Access.ANYONE_WITH_LINK + DriveApp.Permission.VIEW, but via the
 * Drive REST permissions endpoint, which works under the app's drive.file
 * scope (DriveApp's ANYONE_WITH_LINK requires the full drive scope and threw).
 *
 * Called by _createAndWriteJob, but ONLY for documents over
 * PREVIEW_INLINE_MAX_BYTES — everything smaller is previewed inline by pdf.js
 * and never needs the file to be public.
 * @param {string} fileId
 * @return {Object} { ok, id } or { ok:false, code?, error }
 */
function _driveSetViewerPermission(fileId) {
  try {
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '/permissions?fields=id&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: _driveAuthHeaders(),
      payload: JSON.stringify({ role: 'reader', type: 'anyone' }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200 && code !== 201) {
      return { ok: false, code: code, error: 'Drive share HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 200) };
    }
    return { ok: true, id: JSON.parse(res.getContentText()).id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
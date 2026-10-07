/** file name: eSignService.gs */

/**
 * DocuPDF Sign — signature request dispatch.
 *
 * Mode A (native): handled in Code.gs (_dispatchSlot) — token-gated email via
 * GmailApp.sendEmail. Per-slot links carry job + signToken + nonce.
 *
 * Mode B (external / Lumin): no email is sent from this add-on. A payload is
 * prepared for hand-off to an external provider, with an explicit warning that
 * the document leaves Google Workspace (opt-in required in the UI).
 */

var EXTERNAL_TTL_DAYS = 7;

/**
 * Mode B — prepares an external (Lumin) payload for a signing job.
 * @param {string} jobId
 * @param {Object} config App config.
 * @return {Object} { ok, mode: 'external', payload, warning, error? }
 */
function PREPARE_EXTERNAL_PAYLOAD(jobId, config) {
  try {
    var record = _getJobRecord(jobId);
    if (!record) {
      return { ok: false, error: 'Job not found.' };
    }
    config = config || {};
    var provider = config.externalProvider || 'lumin';
    var sourceFile = DriveApp.getFileById(record.sourcePdfId);
    var payload = {
      provider: provider,
      jobId: jobId,
      documentId: record.sourcePdfId,
      documentUrl: sourceFile.getUrl(),
      documentName: record.docName,
      signers: record.slots.map(function (s) {
        return { label: s.label, email: s.signerEmail, name: s.signerName };
      }),
      callbackUrl: _serviceBaseUrl() +
        '?job=' + encodeURIComponent(jobId) + '&callback=external',
      companyName: config.companyName || '',
      expiresInDays: EXTERNAL_TTL_DAYS,
      timestamp: new Date().toISOString()
    };

    LOG_AUDIT_EVENT('DISPATCH', {
      docId: jobId,
      docName: record.docName,
      status: 'Prepared',
      details: 'Mode B (external: ' + provider + '). Payload prepared; NOT sent. Type: ' + (record.typeId || '')
    });

    return {
      ok: true,
      mode: 'external',
      provider: provider,
      payload: payload,
      warning: 'Mode B hands the document to an external e-sign provider. The document content will leave Google Workspace. Continue only with signer consent.'
    };
  } catch (err) {
    Logger.log('PREPARE_EXTERNAL_PAYLOAD error: %s', err.message);
    return { ok: false, error: err.message, mode: 'external' };
  }
}

/**
 * Cancels a job and revokes all of its tokens.
 * @param {string} jobId
 * @return {boolean}
 */
function REVOKE_JOB(jobId) {
  return _revokeJob(jobId);
}

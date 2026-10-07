const fs = require('fs');
const s = fs.readFileSync('SignatureModal.html','utf8');
try { new (require('vm').Script)(s, {filename:'SignatureModal.html'}); console.log('OK'); }
catch (e) { console.error('ERR:'+e.message); }

const fs = require('fs');
try { const vm = require('vm'); new vm.Script(fs.readFileSync('ESignWizard.html','utf8'), {filename:'ESignWizard.html'}); console.log('OK'); }
catch (e) { console.error('ERR:'+e.message); }

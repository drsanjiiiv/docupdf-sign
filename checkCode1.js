const fs = require('fs');
try { const vm = require('vm'); new vm.Script(fs.readFileSync('Code.gs','utf8'), {filename:'Code.gs'}); console.log('OK'); }
catch (e) { console.error('ERR:'+e.message); }

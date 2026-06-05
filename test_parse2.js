const XLSX = require('xlsx');
const fs = require('fs');
const buf = fs.readFileSync('c:/Users/Administrator/WorkBuddy/20260605135655/test_hn.xlsx');
const wb = XLSX.read(buf, {type:'buffer'});
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
console.log('Total rows:', data.length);
console.log('Row 0:', JSON.stringify(data[0]).slice(0,200));
console.log('Row 1 (header):', JSON.stringify(data[1]).slice(0,300));
console.log('Row 2:', JSON.stringify(data[2]).slice(0,300));
const header = data[1];
const fields = ['配送单号','物品编码*','物品名称','发货数量*','收货人','收货电话','收货地址'];
for (const f of fields) {
  const idx = header.findIndex(h => String(h).trim() === f);
  console.log('Field "'+f+'" at col:', idx);
}
let count = 0;
for (let i=2; i<data.length; i++) {
  if (data[i].some(c => c !== '')) count++;
}
console.log('Non-empty rows:', count);
console.log('First data row:', JSON.stringify(data[2].slice(0,10)));

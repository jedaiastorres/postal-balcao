const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const server = fs.readFileSync(require.resolve('../server'), 'utf8');
const app = fs.readFileSync(require.resolve('../public/app'), 'utf8');
function extract(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
test('cookies tolerate malformed input and preserve values containing equals', () => {
  const context = vm.createContext({});
  vm.runInContext(extract(server, 'function parseCookies', 'function signSession'), context);
  const cookies = context.parseCookies({headers:{cookie:'bad=%ZZ; flag; postal_session=valid; value=a=b; __proto__=test'}});
  assert.equal(cookies.postal_session, 'valid');
  assert.equal(cookies.value, 'a=b');
  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies.bad, undefined);
});
test('corrupt, inaccessible or incorrectly shaped history does not prevent initialization', () => {
  for (const value of ['{broken', '{}', 'null', '[null,1,{"price":12}]']) {
    const context = vm.createContext({localStorage:{getItem:()=>value}});
    vm.runInContext(extract(app, 'function loadRecentQuotes', 'const state'), context);
    const result = context.loadRecentQuotes();
    assert.ok(Array.isArray(result));
    assert.equal(result.length, value.startsWith('[null') ? 1 : 0);
  }
  const context = vm.createContext({localStorage:{getItem:()=>{throw Error('denied');}}});
  vm.runInContext(extract(app, 'function loadRecentQuotes', 'const state'), context);
  assert.equal(context.loadRecentQuotes().length, 0);
});
test('ExcelJS conditional formatting works with the patched uuid dependency', async () => {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Teste');
  sheet.addRow([1]);
  sheet.addConditionalFormatting({ref:'A1',rules:[{type:'dataBar',minLength:0,maxLength:100,cfvo:[{type:'min'},{type:'max'}],color:{argb:'FFD7083B'}}]});
  const buffer = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.equal(restored.getWorksheet('Teste').getCell('A1').value, 1);
});

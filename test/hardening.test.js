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
test('point operations reject revoked users, changed roles and inactive stores',async()=>{
  for(const scenario of [
    {record:{active:false,role:'STORE_OWNER',store_id:'store'},allowed:false},
    {record:{active:true,role:'OPS',store_id:'store'},allowed:false},
    {record:{active:true,role:'STORE_OWNER',store_id:'other'},allowed:false},
    {record:{active:true,role:'STORE_OWNER',store_id:'store'},storeActive:false,allowed:false},
    {record:{active:true,role:'STORE_OWNER',store_id:'store'},storeActive:true,allowed:true}
  ]){
    const context=vm.createContext({db:{getUserById:async()=>scenario.record,getStore:async()=>({active:scenario.storeActive})}});
    vm.runInContext(extract(server,'async function requireCurrentUser','function requireIntegrationAuth'),context);
    let next=false,status=0;
    const res={status(value){status=value;return this;},json(){return this;}};
    await context.requireCurrentUser({user:{userId:'user',role:'STORE_OWNER',storeId:'store'}},res,()=>{next=true;});
    assert.equal(next,scenario.allowed);if(!scenario.allowed)assert.equal(status,403);
  }
});
test('clerk and operations collection responses omit point earnings and splits',()=>{
  const context=vm.createContext({});
  vm.runInContext(extract(server,'function collectionForRole','app.post("/api/store/collections"'),context);
  const data={id:'pickup',total_fee:10,point_rate:3,point_compensation:6,postal_compensation:4};
  for(const role of ['STORE_CLERK','OPS']){
    const result=context.collectionForRole(data,role);
    assert.equal(result.point_rate,undefined);assert.equal(result.point_compensation,undefined);assert.equal(result.postal_compensation,undefined);assert.equal(result.total_fee,10);
  }
  assert.equal(context.collectionForRole(data,'STORE_OWNER').point_compensation,6);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app'), 'utf8');
function renderer(width) {
  const context = vm.createContext({state:{config:{receiptWidthMm:width}},
    escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    money:value=>`R$ ${Number(value||0).toFixed(2)}`,
    maskCep:value=>String(value||'')});
  vm.runInContext(source.slice(source.indexOf('function addressText'),source.indexOf('function showReceiptPreview')),context);
  return context.buildReceiptHtml;
}
test('thermal receipts preserve multiple tracking codes and escape customer content',()=>{
  for (const width of [58,80]) {
    const html=renderer(width)({paymentStatus:'PAID',trackingCodes:['BR001','BR002'],sender:{name:'<script>bad</script>'},storeName:'Ponto & Postal'});
    assert.ok(html.includes(`size:${width}mm auto`));
    assert.ok(html.includes('BR001')&&html.includes('BR002'));
    assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(html.includes('Ponto &amp; Postal'));
    assert.ok(html.includes('receipt-brand'));
    assert.ok(html.includes('TOTAL PAGO'));
    assert.ok(!html.includes('<img'));
  }
});
test('missing payment confirmation, previews and simulation are explicitly identified',()=>{
  const render=renderer(80);
  assert.ok(render({}).includes('PENDENTE'));
  assert.ok(!render({}).includes('TOTAL PAGO'));
  assert.ok(render({preview:true,paymentStatus:'PAID'}).includes('PRÉVIA — NÃO PAGO'));
  assert.ok(!render({preview:true,paymentStatus:'PAID'}).includes('TOTAL PAGO'));
  assert.ok(render({isSimulation:true,paymentStatus:'PAID'}).includes('HOMOLOGAÇÃO — SEM VALIDADE LOGÍSTICA'));
  assert.ok(renderer(999)({}).includes('size:80mm auto'));
});

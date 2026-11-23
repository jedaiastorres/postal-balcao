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
  vm.runInContext(fs.readFileSync(require.resolve('../public/branding'), 'utf8'),context);
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
    assert.ok(html.includes('data:image/svg+xml;base64,'));
    assert.ok(!/<img[^>]+src="https?:/.test(html));
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
test('comprovante discrimina todos os custos extras e valores efetivamente cobrados',()=>{
  const html=renderer(80)({
    paymentStatus:'PAID',salePrice:50.20,freightPrice:33.51,hubTransferTotal:5,
    paymentFee:2.69,addons:[
      {name:'Manuseio especial',quantity:1,totalPrice:9,isManualExtra:true},
      {name:'Caixa reforçada',quantity:1,totalPrice:4,isManualExtra:false}
    ],sender:{name:'Remetente'},recipient:{name:'Destinatário'}
  });
  assert.match(html,/Custo extra: Manuseio especial/);
  assert.match(html,/Caixa reforçada/);
  assert.match(html,/Transferência ao hub/);
  assert.match(html,/R\$ 33\.51/);
  assert.match(html,/R\$ 50\.20/);
  assert.ok(!html.includes('<span>Adicionais</span>'),"não exibir subtotal genérico em vez da discriminação");
});
test('segunda via usa os valores e as descrições persistidos no pedido',()=>{
  const context=vm.createContext({state:{user:{storeName:'Ponto Postal'}},paymentMethodLabel:method=>method});
  vm.runInContext(source.slice(source.indexOf('function postalTrackingPath'),source.indexOf('async function payCashRemittance')),context);
  const receipt=context.receiptPayloadFromOrder({
    id:'123',salePrice:39.50,hubTransferTotal:5,addonsTotal:7.50,
    totalToCustomer:48.90,paymentSurcharge:1.90,
    paymentStatus:'PAID',paymentMethod:'PIX',
    addons:[{itemName:'Manuseio com cuidado',quantity:1,totalPrice:7.50,isManualExtra:true}],
    sender:{name:'Cliente'},recipient:{name:'Destinatário'},packageData:{}
  });
  assert.equal(receipt.freightPrice,34.5);
  assert.equal(receipt.hubTransferTotal,5);
  assert.equal(receipt.salePrice,48.9);
  assert.equal(receipt.addons[0].name,'Manuseio com cuidado');
  assert.equal(receipt.addons[0].isManualExtra,true);
});

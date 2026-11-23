const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const corrections=require("../shipment_corrections");

const baseOrder={
  status:"SHIPMENT_ERROR",payment_status:"PAID",
  provider_payment_status:"ERROR",provider_payment_attempts:1,
  conect_cart_id:null,conect_package_id:null,tracking_code:null,
  shipped_at:null,is_simulation:false,label_a4_url:null,label_a6_url:null
};
const party={
  name:"Exemplo",document:"52998224725",phone:"11999999999",
  cep:"68515000",address:"Rua Central",number:"10",
  neighborhood:"Centro",city:"Parauapebas",email:"",complement:""
};
test("validação de CPF/CNPJ identifica dígitos verificadores incorretos",()=>{
  assert.equal(corrections.validDocument("529.982.247-25"),true);
  assert.equal(corrections.validDocument("11.222.333/0001-81"),true);
  assert.equal(corrections.validDocument("529.982.247-26"),false);
  assert.equal(corrections.validDocument("11111111111"),false);
  assert.equal(corrections.validDocument("11.222.333/0001-82"),false);
});
test("edição preserva CEP e recusa documento inválido",()=>{
  const fixed=corrections.correctedParty(party,{name:"Novo remetente",cep:"01001000",document:"52998224725"},"remetente");
  assert.equal(fixed.cep,"68515000");
  assert.equal(fixed.name,"Novo remetente");
  assert.throws(()=>corrections.correctedParty(party,{document:"12345678900"},"remetente"),/CPF\/CNPJ/);
  assert.throws(()=>corrections.correctedParty(party,{phone:"123"},"remetente"),/Telefone/);
});
test("pedido pago permite corrigir cadastro, mas não dados financeiros",()=>{
  assert.equal(corrections.canEditOrder(baseOrder),true);
  for(const patch of [
    {conect_cart_id:"cart-1"},{conect_package_id:"pkg-2"},{tracking_code:"BR123"},
    {status:"LABEL_AVAILABLE"},{provider_payment_status:"PROCESSING"},{shipped_at:new Date().toISOString()}
  ]) assert.equal(corrections.canEditOrder({...baseOrder,...patch}),false);
});
test("não reprocessa quando retorno remoto é incerto, mas permite erro 422 comprovado",()=>{
  assert.equal(corrections.canRetryShipment(baseOrder),false);
  assert.equal(corrections.canRetryShipment({...baseOrder,provider_payment_status:"REJECTED_INPUT"}),true);
  assert.equal(corrections.canRetryShipment({...baseOrder,conect_cart_id:"cart-1"}),true);
  assert.equal(corrections.canRetryShipment({...baseOrder,provider_payment_attempts:0}),true);
  assert.equal(corrections.canRetryShipment({...baseOrder,payment_status:"PENDING",provider_payment_attempts:0}),false);
});
test("resposta pública oculta detalhes sensíveis do erro do prestador",()=>{
  assert.match(corrections.providerErrorSummary("400 O campo cpfCnpj é inválido"),/CPF\/CNPJ/);
  assert.ok(!corrections.providerErrorSummary("CPF 52998224725 rejeitado").includes("52998224725"));
  assert.ok(!corrections.providerErrorSummary("https://api.exemplo.com/token/SEGREDO").includes("SEGREDO"));
});
test("rota de correção exige escopo, bloqueia etiqueta existente e não altera pagamento",()=>{
  const server=fs.readFileSync(require.resolve("../server"),"utf8");
  const db=fs.readFileSync(require.resolve("../db"),"utf8");
  const html=fs.readFileSync(require.resolve("../public/index.html"),"utf8");
  const client=fs.readFileSync(require.resolve("../public/app.js"),"utf8");
  assert.match(server,/app\.patch\("\/api\/orders\/:id\/shipping-details",requireAuth,requireRole\("ADMIN","STORE_OWNER","STORE_CLERK"\)/);
  assert.match(server,/db\.getOrder\(req\.params\.id,scopeForUser\(req\.user\)\)/);
  const sql=db.slice(db.indexOf("async function updateOrderShippingParties"),db.indexOf("async function getOrder(id, scope"));
  assert.match(sql,/store_id=\$2::uuid/);
  assert.match(sql,/conect_cart_id IS NULL AND conect_package_id IS NULL/);
  assert.doesNotMatch(sql,/sale_price=|payment_status=|postal_revenue_total=|partner_commission=/);
  assert.match(html,/id="editOrderModal"/);
  assert.match(client,/editOrderForm/);
});

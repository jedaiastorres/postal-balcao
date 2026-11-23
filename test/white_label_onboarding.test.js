"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const whiteLabel=require("../white_label");
const input={
  code:"  empresa-regional ",brandName:"Transportadora Regional",
  legalName:"Exemplo Ltda",cnpj:"11.222.333/0001-81",
  adminName:"Administrador Teste",adminEmail:"RESPONSAVEL@EXEMPLO.COM",
  adminPhone:"(94) 99999-9999",baseCity:"Parauapebas",baseState:"pa",
  postalFeePercent:5,postalFeeFixed:0,brandPrimary:"#d7083b",
  brandSecondary:"#222638",logoUrl:"https://example.com/logo.png",notes:"piloto",
  asaasWalletId:"carteira-teste"
};
test("cadastro White Label normaliza CNPJ, cidade, contato e remuneração",()=>{
  const saved=whiteLabel.normalizeWhiteLabelCarrier(input);
  assert.equal(saved.code,"EMPRESA-REGIONAL");
  assert.equal(saved.cnpj,"11222333000181");
  assert.equal(saved.adminEmail,"responsavel@exemplo.com");
  assert.equal(saved.adminPhone,"94999999999");
  assert.equal(saved.baseState,"PA");
  assert.equal(saved.postalFeePercent,5);
});
test("cadastro rejeita CNPJ inválido, taxa Postal zero e URLs inseguras",()=>{
  assert.throws(()=>whiteLabel.normalizeWhiteLabelCarrier({...input,cnpj:"00000000000000"}),/CNPJ/);
  assert.throws(()=>whiteLabel.normalizeWhiteLabelCarrier({...input,postalFeePercent:0,postalFeeFixed:0}),/[Tt]axa Postal/);
  assert.throws(()=>whiteLabel.normalizeWhiteLabelCarrier({...input,logoUrl:"javascript:alert(1)"}),/HTTPS/);
  assert.throws(()=>whiteLabel.normalizeWhiteLabelCarrier({...input,postalFeePercent:75}),/[Tt]axa Postal/);
  assert.throws(()=>whiteLabel.normalizeWhiteLabelCarrier({...input,code:"../master"}),/Código/);
});
test("cadastro retorna operacional desativado e não cria usuários ou pontos",()=>{
  const dto=whiteLabel.whiteLabelCarrierDTO({
    id:"uuid",code:"TRANSPORTADORA",
    brand_name:"Transportadora Regional",cnpj:"11222333000181",
    admin_name:"Teste",admin_email:"teste@example.com",
    admin_phone:"94999999999",base_city:"Parauapebas",base_state:"PA",
    postal_fee_percent:"5",postal_fee_fixed:"0",status:"DRAFT"
  });
  assert.equal(dto.operationalEnabled,false);
  assert.equal(dto.status,"DRAFT");
  assert.equal(dto.postalFeePercent,5);
});
test("apenas MASTER pode consultar, criar e editar transportadoras White Label",()=>{
  const server=fs.readFileSync(require.resolve("../server"),"utf8");
  for(const verb of ["get","post"]){
    assert.match(server,new RegExp("app\\."+verb+'\\("/api/admin/white-label-carriers",requireAuth,requireRole\\("ADMIN"\\)'));
  }
  assert.match(server,/app\.patch\("\/api\/admin\/white-label-carriers\/:id",requireAuth,requireRole\("ADMIN"\)/);
  assert.match(server,/operationalEnabled:false/);
  assert.doesNotMatch(server,/app\.post\("\/api\/white-label-carriers/);
});
test("banco White Label possui chave própria e bloqueia ativação prematura",()=>{
  const db=fs.readFileSync(require.resolve("../db"),"utf8");
  const start=db.indexOf("CREATE TABLE IF NOT EXISTS white_label_carriers");
  const end=db.indexOf("CREATE INDEX IF NOT EXISTS white_label_carriers_created_idx");
  const schema=db.slice(start,end);
  assert.ok(start>=0);
  assert.match(schema,/cnpj TEXT NOT NULL UNIQUE/);
  assert.match(schema,/code TEXT NOT NULL UNIQUE/);
  assert.match(schema,/CHECK \(status = 'DRAFT'\)/);
  assert.match(schema,/white_label_postal_fee_required CHECK/);
  assert.doesNotMatch(schema,/store_id|app_users|freight_orders/);
  const update=db.slice(db.indexOf("async function updateWhiteLabelCarrier"),db.indexOf("async function createStore"));
  assert.match(update,/WHERE id=\$1 AND status='DRAFT'/);
  assert.doesNotMatch(update,/status=\$|payment_|sale_price/);
});
test("modal de correção usa overlay centralizado e scripts compilam",()=>{
  const html=fs.readFileSync(require.resolve("../public/index.html"),"utf8");
  const css=fs.readFileSync(require.resolve("../public/styles.css"),"utf8");
  const app=fs.readFileSync(require.resolve("../public/app.js"),"utf8");
  new vm.Script(app);
  new vm.Script(fs.readFileSync(require.resolve("../server"),"utf8"));
  assert.match(html,/id="editOrderModal" class="modal hidden"/);
  assert.match(html,/class="modal-card order-edit-card"/);
  assert.match(css,/\.modal\{position:fixed;inset:0;z-index:300/);
  assert.match(css,/\.modal-body\{[^}]*overflow-y:auto/);
  assert.match(html,/id="whiteLabelForm"/);
  assert.match(app,/loadWhiteLabels\(\)/);
});

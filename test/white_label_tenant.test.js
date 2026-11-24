"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const logic=require("../white_label_tenant");
const wlDb=require("../white_label_tenant_db");
const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");
const portal=read("white_label_portal.js");
const server=read("server.js");
const ui=read("public/white-label.js");
const html=read("public/white-label.html");

test("tarifas validam CEP, pesos, preço e prazo sem liberar postagem",()=>{
 const valid={
  name:"Marabá - Parauapebas",originStart:"68500000",originEnd:"68599999",
  destinationStart:"68515000",destinationEnd:"68515999",
  minWeight:1,maxWeight:30000,price:20,perKg:3,days:2,active:true};
 const normalized=logic.normalizeTariff(valid);
 assert.equal(normalized.price,20);
 assert.equal(normalized.active,true);
 assert.throws(()=>logic.normalizeTariff({...valid,originStart:"99999999"}),/faixa/i);
 assert.throws(()=>logic.normalizeTariff({...valid,maxWeight:30001}),/Peso/);
 assert.throws(()=>logic.normalizeTariff({...valid,price:-1}),/Tarifa/);
 assert.throws(()=>logic.normalizeTariff({...valid,days:0}),/Prazo/);
 const q=logic.validateQuote({origin:"68500-000",destination:"68515-000",weight:"1250"});
 assert.deepEqual(q,{origin:"68500000",destination:"68515000",weight:1250});
 assert.throws(()=>logic.validateQuote({origin:"",destination:"68515000",weight:1000}),/CEPs/);
});
test("unidades válidas exigem CEP e endereço e operador só entra em ponto do próprio tenant",async()=>{
  const point=logic.normalizePoint({code:"MAB-01",name:"Ponto Marabá",
    cep:"68500-000",city:"Marabá",state:"PA",address:"Rua Central",number:"22"});
  assert.equal(point.cep,"68500000");
  assert.throws(()=>logic.normalizePoint({...point,cep:"123"}),/CEP/);
  assert.throws(()=>logic.normalizePoint({...point,state:"PAA"}),/cidade e UF/);
  const dbCode=read("white_label_tenant_db.js");
  assert.match(dbCode,/FOREIGN KEY\(carrier_id,point_id\) REFERENCES wl_points\(carrier_id,id\)/);
  assert.match(dbCode,/WHERE p.carrier_id=\$2 AND p.id=\$6 AND p.active=TRUE/);
  assert.match(portal,/if\(account.role==="WL_OPERATOR"\)/);
  assert.match(portal,/if\(!linkedPoint\[0\]\?\.active\)/);
  assert.match(portal,/wlDb\.listPoints\(pool,req\.wl\.carrier\.id/);
  const tenant="12345678-1234-1234-1234-123456789012";
  let actualSql="";
  const dbMock={query:async(sql,params)=>{actualSql=sql;return {rows:[]}}};
  await assert.rejects(()=>wlDb.createOperator(dbMock,tenant,{
    name:"Operador",email:"teste@example.com",passwordHash:"x",pointId:"12345678-1234-1234-1234-123456789012"
  }),/Selecione uma unidade ativa/);
  assert.match(actualSql,/INSERT INTO wl_accounts/);
  assert.match(actualSql,/p.carrier_id=\$2/);
  assert.match(read("public/white-label.js"),/pointId:\$\("#employeePoint"\)\.value/);
});
test("parceiro edita só nome e cores sem acessar carteira ou condições comerciais",async()=>{
 const brand=logic.normalizeBrand({name:"Empresa Regional",logoUrl:"https://example.com/logo.png",
  primary:"#ff0055",secondary:"#132442",postalFeePercent:0,asaasWalletId:"fake"});
 assert.equal(brand.name,"Empresa Regional");
 assert.equal("asaasWalletId" in brand,false);
 assert.throws(()=>logic.normalizeBrand({...brand,primary:"red"}),/Cores/);
 assert.throws(()=>logic.normalizeBrand({...brand,logoUrl:"http://example.com/x"}),/HTTPS/);
 let query="";
 await wlDb.updateBrand({query:async(sql)=>{query=sql;return {rows:[{id:"ok"}]}}},"id",brand);
 assert.match(query,/WHERE id=\$1/);
 assert.doesNotMatch(query,/asaas_wallet_id|postal_fee_percent|postal_fee_fixed/);
 assert.match(portal,/app.patch\("\/api\/wl\/brand",authenticate,wlMaster,blockNewUsersUntilPasswordChanged/);
});
test("cálculo do repasse é feito no servidor, nunca abaixo de zero",()=>{
 const carrier={postal_fee_percent:20,postal_fee_fixed:1};
 const tariff={id:"x",name:"Rota",price:30,per_kg:2,days:3};
 const result=logic.pricedTariff(tariff,carrier,1500);
 assert.equal(result.total,33);
 assert.equal(result.postalShare,7.6);
 assert.equal(result.partnerShare,25.4);
 assert.equal(logic.pricedTariff({...tariff,price:1}, {...carrier,postal_fee_fixed:100},1000),null);
});
test("marca pública não revela carteira ou comissões",()=>{
 const brand=logic.publicBrand({code:"TEST",brand_name:"Empresa",base_city:"Marabá",base_state:"PA",
  asaas_wallet_id:"SECRET",postal_fee_percent:20,postal_fee_fixed:1});
 assert.equal(brand.name,"Empresa");
 assert.equal(brand.shippingEnabled,false);
 assert.equal(brand.paymentEnabled,false);
 assert.equal(JSON.stringify(brand).includes("SECRET"),false);
 assert.equal(JSON.stringify(brand).includes("postal_fee"),false);
});
test("consultas e alterações passam sempre o ID da transportadora ao banco",async()=>{
 const tenantA="11111111-1111-1111-1111-111111111111",tenantB="22222222-2222-2222-2222-222222222222";
 const calls=[];
 const pool={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]}}};
 await wlDb.listTariffs(pool,tenantA);
 await wlDb.quoteTariffs(pool,tenantA,{origin:"68500000",destination:"68515000",weight:1000});
 await wlDb.listAccounts(pool,tenantB);
 await wlDb.setOperatorStatus(pool,tenantA,"33333333-3333-3333-3333-333333333333",false);
 for(const call of calls){
   assert.ok(call.sql.includes("carrier_id=$1"),"Query must include tenant scope: "+call.sql);
   assert.ok(call.params[0]===tenantA||call.params[0]===tenantB);
 }
});
test("acesso White Label usa cookie próprio, valida audiência, versão, CSRF e vínculo da conta",()=>{
 for(const fragment of [
  'aud:"white-label"', 'session.aud!=="white-label"',
  'account.carrier_id!==carrier.id', 'session.role!==account.role',
  'session.version', 'crypto.timingSafeEqual',
  'cookie("",0)', '"WL_MASTER"', 'must_change_password'
 ])assert.ok(portal.includes(fragment),fragment);
 assert.ok(server.includes('req.path.startsWith("/wl/")'));
 assert.ok(server.includes('whiteLabelTenantDb.init(db.pool)'));
 assert.ok(!portal.includes('app.post("/api/orders"'));
 assert.ok(portal.includes('shippingEnabled:false'));
 assert.ok(portal.includes('paymentsEnabled:false'));
});
test("painel de cliente e Master Postal estão separados por permissão",()=>{
 assert.ok(html.includes('id="loginPanel"'));
 assert.ok(html.includes('id="tariffForm"'));
 assert.ok(html.includes('id="quoteForm"'));
 assert.ok(html.includes('id="userForm"'));
 assert.ok(ui.includes('"/api/wl/quote?"'));
 assert.ok(ui.includes('"/api/wl/users"'));
 assert.ok(read("public/app.js").includes('data-provision-white-label'));
 assert.ok(portal.includes('requireRole("ADMIN")'));
 for(const content of [portal,ui,server])new vm.Script(content);
});

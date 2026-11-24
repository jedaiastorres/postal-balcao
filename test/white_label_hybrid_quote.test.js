"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const hybrid=require("../white_label_hybrid_quote");
const pricing=require("../quote_pricing");
const logic=require("../white_label_tenant");

const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");

test("cotação híbrida exige CEP, peso e medidas reais; não inventa dados",()=>{
  const quote=hybrid.validateHybridQuote({origin:"68500-000",destination:"68515-000",
    weight:"1200",length:"20",width:"15",height:"10",declaredValue:"150"});
  assert.deepEqual(quote,{origin:"68500000",destination:"68515000",weight:1200,
    length:20,width:15,height:10,declaredValue:150});
  assert.throws(()=>hybrid.validateHybridQuote({origin:"68500000",destination:"68515000",weight:1200}),/comprimento/i);
  assert.throws(()=>hybrid.validateHybridQuote({...quote,length:150}),/comprimento/i);
  assert.throws(()=>hybrid.validateHybridQuote({...quote,length:100,width:100,height:1}),/soma/i);
  assert.throws(()=>hybrid.validateHybridQuote({...quote,declaredValue:50001}),/Valor declarado/i);
  assert.throws(()=>hybrid.validateHybridQuote({...quote,weight:30001}),/Peso/i);
});

test("comissão específica é aplicada no preço final sem usar a taxa da rota própria",()=>{
  const partnerRate=pricing.pointCommissionRate({commission_percent:10},0);
  const sell=pricing.sellPriceFromCost(50,partnerRate,0.12);
  assert.ok(sell.salePrice>50);
  const clean=hybrid.sanitizeIntegratedOptions([{
    transportadora:"Loggi",produto:"Econômico",precoVenda:sell.salePrice,
    providerCost:50,postalMargin:sell.postalMargin,comissaoParceiro:sell.partnerCommission,
    codigoServico:"FREIGHT_TYPE_ECONOMIC",postalCompanyId:44,prazoEntrega:4
  }]);
  assert.equal(clean.length,1);
  assert.equal(clean[0].carrier,"Loggi");
  assert.equal(clean[0].total,sell.salePrice);
  assert.equal(clean[0].partnerShare,sell.partnerCommission);
  assert.doesNotMatch(JSON.stringify(clean),/providerCost|postalMargin|codigoServico|postalCompanyId|FREIGHT_TYPE/);
  assert.equal(pricing.sellPriceFromCost(50,0,0.12).partnerCommission,0);
  const own=logic.pricedTariff({id:"x",name:"Própria",price:80,per_kg:0,days:2},
    {postal_fee_percent:20,postal_fee_fixed:1},1200);
  assert.equal(own.postalShare,17);
});

test("integradas e próprias aparecem na mesma comparação ordenada, sem vazar margem",()=>{
  const own=[{id:"1",name:"Rota própria",total:100,days:2,postalShare:21,partnerShare:79}];
  const integrated=[{id:"REDE-01",source:"INTEGRATED",carrier:"Jadlog",name:"Package",
    total:65,days:5,partnerShare:7}];
  const brand={name:"Transporte Regional"};
  const master=hybrid.mergeHybridOptions(own,integrated,brand,true);
  assert.deepEqual(master.map(v=>v.source),["INTEGRATED","OWN"]);
  assert.equal(master[0].total,65);
  assert.equal(master[0].partnerShare,7);
  assert.equal(master[0].postalShare,undefined);
  const operator=hybrid.mergeHybridOptions(own,integrated,brand,false);
  assert.deepEqual(operator.map(v=>v.total),[65,100]);
  assert.equal(operator[0].partnerShare,undefined);
  assert.equal(operator[1].postalShare,undefined);
  assert.equal(operator[1].carrier,"Transporte Regional");
});
test("não exibe nome da integradora em respostas visíveis e filtra tarifas inválidas",()=>{
  const options=hybrid.sanitizeIntegratedOptions([
    {transportadora:"ConectEnvios",produto:"conectenvios serviço",precoVenda:45,prazoEntrega:5,comissaoParceiro:0},
    {transportadora:"Transportadora",produto:"Inválido",precoVenda:-7},
    {transportadora:"Outra",produto:"Válido",precoVenda:20,prazoEntrega:2}
  ]);
  assert.equal(options.length,2);
  assert.doesNotMatch(JSON.stringify(options),/ConectEnvios/i);
  assert.ok(options.every(v=>v.total>0));
});
test("projeto usa integração real e não chama simulador nem disponibiliza checkout no White Label",()=>{
  const server=read("server.js"),portal=read("white_label_portal.js"),html=read("public/white-label.html"),ui=read("public/white-label.js");
  assert.match(server,/quoteIntegrated:async \(args,carrier\)=>/);
  assert.match(server,/fetchProviderQuoteCached\(args\.origin,args\.destination/);
  assert.match(server,/normalizeQuote\(quoted\.data,partnerCommissionRate\)/);
  assert.match(server,/whiteLabelHybrid\.sanitizeIntegratedOptions\(priced\)/);
  assert.match(portal,/hybrid\.validateHybridQuote\(req\.query\)/);
  assert.match(portal,/wlDb\.quoteTariffs\(pool,req\.wl\.carrier\.id,args\)/);
  assert.match(portal,/hybrid\.mergeHybridOptions\(own,networkOptions,brand/);
  assert.match(portal,/shippingEnabled:false,paymentsEnabled:false/);
  assert.doesNotMatch(portal.slice(portal.indexOf('app.get("/api/wl/quote"'),portal.indexOf('app.get("/api/wl/users"')),/signSelectionToken|checkout|paymentLink|providerCost/);
  for(const id of ["quoteLength","quoteWidth","quoteHeight","quoteComparisonStatus"])assert.ok(html.includes('id="'+id+'"'));
  assert.ok(ui.includes("source===\"OWN\""));
  assert.doesNotMatch(html+ui,/conect\s*envios/i);
  for(const code of [server,portal,ui])new vm.Script(code);
});

test("somente MASTER Postal altera a comissão integrada e existe migração idempotente",()=>{
  const db=read("db.js");
  const admin=read("public/app.js");
  const whiteLabel=read("white_label.js");
  assert.match(db,/ADD COLUMN IF NOT EXISTS integrated_commission_percent/);
  assert.match(db,/integrated_commission_percent=\$18/);
  assert.match(whiteLabel,/integratedCommissionPercent>40/);
  assert.match(admin,/IntegratedCommissionPercent:"integratedCommissionPercent"/);
  assert.match(admin,/integratedCommissionPercent:Number\(value\("IntegratedCommissionPercent"\)\|\|0\)/);
  const server=read("server.js");
  assert.match(server,/app\.patch\("\/api\/admin\/white-label-carriers\/:id",requireAuth,requireRole\("ADMIN"\)/);
});

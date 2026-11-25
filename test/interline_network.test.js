"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const rules=require("../interline_network");
const data=require("../interline_network_db");
const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");
const tenantA="11111111-1111-4111-8111-111111111111";
const tenantB="22222222-2222-4222-8222-222222222222";
const wlA=rules.ownerKey("WHITE_LABEL",tenantA);
const wlB=rules.ownerKey("WHITE_LABEL",tenantB);
const requestKey="33333333-3333-4333-8333-333333333333";
const asLane=(stage,key,price)=>({
 id:stage==="COLLECTION"?"44444444-4444-4444-8444-444444444444":
    stage==="TRANSFER"?"55555555-5555-4555-8555-555555555555":
    "66666666-6666-4666-8666-666666666666",
 stage,operator_key:key,price_cents:price,active:true,
 origin_start:"68000000",origin_end:"68999999",
 destination_start:"68000000",destination_end:"68999999",
 min_weight:1,max_weight:30000
});
test("comissão Postal uma única vez e saldo imutável por etapa",()=>{
 const stages=[asLane("COLLECTION",wlA,1500),
   asLane("TRANSFER","POSTAL",2000),asLane("DELIVERY",wlB,2500)];
 const plan=rules.snapshotSale({sellerKey:wlA,selectedLanes:stages,
   grossCents:12000,postalFeePercent:20,postalFeeFixed:1});
 assert.equal(plan.grossCents,12000);
 assert.equal(plan.postalFeeCents,2500);
 assert.equal(plan.stageTotalCents,6000);
 assert.equal(plan.sellerMarginCents,3500);
 assert.equal(plan.allocations.length,3);
 assert.equal(plan.postalFeeCents+plan.stageTotalCents+plan.sellerMarginCents,12000);
 assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.allocations[0]));
 assert.throws(()=>rules.snapshotSale({sellerKey:wlA,selectedLanes:stages,
   grossCents:7500,postalFeePercent:20,postalFeeFixed:1}),/sem saldo/);
 assert.throws(()=>rules.snapshotSale({sellerKey:wlA,
   selectedLanes:[asLane("COLLECTION",wlA,100),asLane("DELIVERY",wlA,100)],
   grossCents:10000,postalFeePercent:20,postalFeeFixed:1}),/outra empresa/);
 const postalSeller=rules.snapshotSale({sellerKey:"POSTAL",
   selectedLanes:[asLane("COLLECTION",wlA,1500),asLane("DELIVERY",wlB,2500)],
   grossCents:10000,postalFeePercent:20,postalFeeFixed:1});
 assert.equal(postalSeller.postalFeeCents,0);
 assert.equal(postalSeller.sellerMarginCents,6000);
});
test("divergência Asaas bloqueia split acima do líquido e carteira emissora",()=>{
 const plan=rules.verifySplitPlan({issuerWalletId:"CARTEIRA_EMISSORA",
   netAvailableCents:9800,splits:[
     {walletId:"OPERADOR_1",fixedCents:3000},
     {walletId:"OPERADOR_2",fixedCents:2500},
     {walletId:"POSTAL_RECEBEDORA",fixedCents:2000}]});
 assert.equal(plan.splitTotalCents,7500);
 assert.equal(plan.issuerRemainderCents,2300);
 assert.throws(()=>rules.verifySplitPlan({issuerWalletId:"A",netAvailableCents:10000,
   splits:[{walletId:"A",fixedCents:100}]}),/igual/);
 assert.throws(()=>rules.verifySplitPlan({issuerWalletId:"A",netAvailableCents:3000,
   splits:[{walletId:"B",fixedCents:3001}]}),/excedem/);
 assert.throws(()=>rules.verifySplitPlan({issuerWalletId:"A",netAvailableCents:10000,
   splits:[{walletId:"B",fixedCents:100},{walletId:"B",fixedCents:100}]}),/repetida/);
});
test("aceite, coleta, transferência e entrega seguem estados controlados",()=>{
 assert.equal(rules.completeAllowed("OFFERED","ACCEPTED"),true);
 assert.equal(rules.completeAllowed("ACCEPTED","IN_PROGRESS"),true);
 assert.equal(rules.completeAllowed("IN_PROGRESS","COMPLETED"),true);
 assert.throws(()=>rules.completeAllowed("OFFERED","COMPLETED"),/Transição/);
 assert.throws(()=>rules.completeAllowed("COMPLETED","IN_PROGRESS"),/Transição/);
 assert.throws(()=>rules.normalizeRequest({requestKey,origin:"68515000",
   destination:"68500000",weight:1000,priceCents:5000,
   senderName:"Origem",recipientName:"Destino",laneIds:[]}),/ao menos/);
 const form=rules.normalizeLane({stage:"DELIVERY",name:"Entrega urbana",
   originStart:"68000000",originEnd:"68999999",
   destinationStart:"68500000",destinationEnd:"68599999",
   minWeight:1,maxWeight:30000,priceCents:1000,leadHours:24});
 assert.equal(form.active,true);
 assert.equal(rules.offerMatches({...form},{origin:"01001000",destination:"68515000",weight:1000}),true);
 assert.equal(rules.offerMatches({...form},{origin:"01001000",destination:"01001000",weight:1000}),false);
});
test("testa inserções, aceitações e bloqueio de operação usando PostgreSQL real em memória",async()=>{
 const {PGlite}=require("@electric-sql/pglite");
 const database=new PGlite();
 const pool={
   query:async(q,params)=>{
     if(!params&&q.includes(";"))return database.exec(q);
     return database.query(q,params||[]);
   },
   connect:async()=>({query:(q,p)=>database.query(q,p||[]),release(){}})
 };
 try{
   await database.exec("CREATE TABLE white_label_carriers(id UUID PRIMARY KEY);");
   await database.query("INSERT INTO white_label_carriers(id) VALUES($1),($2)",[tenantA,tenantB]);
   await data.init(pool);
   await data.ensureMember(pool,wlA,"Transportadora A",tenantA);
   await data.ensureMember(pool,wlB,"Transportadora B",tenantB);
   const list=await data.listLanes(pool,wlA);
   assert.equal(list.length,0);
   await data.setOptIn(pool,wlA,true);
   await data.setOptIn(pool,wlB,true);
   await data.setOptIn(pool,"POSTAL",true);
   const laneForm=(stage,price)=>rules.normalizeLane({
     stage,name:stage+" regional",originStart:"68000000",originEnd:"68999999",
     destinationStart:"68000000",destinationEnd:"68999999",
     minWeight:1,maxWeight:30000,priceCents:price,leadHours:24});
   const first=await data.addLane(pool,wlA,laneForm("COLLECTION",1500));
   const middle=await data.addLane(pool,"POSTAL",laneForm("TRANSFER",2000));
   const last=await data.addLane(pool,wlB,laneForm("DELIVERY",2500));
   const offers=await data.discover(pool,{origin:"68515000",destination:"68500000",weight:1000});
   assert.equal(offers.length,3);
   const request=rules.normalizeRequest({requestKey,origin:"68515000",destination:"68500000",weight:1000,
     senderName:"Remetente",recipientName:"Destinatário",priceCents:12000,
     laneIds:[first.id,middle.id,last.id]});
   const created=await data.requestService(pool,wlA,"usuario-a",request,{percent:20,fixed:1});
   assert.equal(created.created,true);
   assert.equal(created.paymentEnabled,false);
   assert.equal(created.quote.postalCommissionCents,2500);
   const second=await data.requestService(pool,wlA,"usuario-a",request,{percent:20,fixed:1});
   assert.equal(second.created,false);
   assert.equal(second.id,created.id);
   const order=(await data.listOrders(pool,wlA))[0];
   const postal=(await data.listOrders(pool,"POSTAL"))[0];
   assert.equal(postal.id,order.id);
   assert.equal(order.legs.length,3);
   assert.equal(order.status,"PENDING_ACCEPTANCE");
   const assigned=(await data.listOrders(pool,wlB))[0];
   assert.equal(data.publicOrder(assigned,wlB).legs.length,1);
   assert.equal(data.publicOrder(assigned,wlB).grossCents,undefined);
   const transfer=order.legs.find(x=>x.stage==="TRANSFER");
   const delivery=order.legs.find(x=>x.stage==="DELIVERY");
   await assert.rejects(()=>data.updateLeg(pool,wlB,"b",transfer.id,"ACCEPTED"),/não pertence/);
   await data.updateLeg(pool,wlB,"b",delivery.id,"ACCEPTED");
   const ready=await data.updateLeg(pool,"POSTAL","master",transfer.id,"ACCEPTED");
   assert.equal(ready.orderStatus,"READY");
   await assert.rejects(()=>data.updateLeg(pool,wlA,"a",order.legs[0].id,"IN_PROGRESS"),
     /cobrança e conciliação/);
   const values=await database.query(
     "SELECT purpose,amount_cents,settlement_state FROM interline_allocations WHERE order_id=$1",[created.id]);
   assert.equal(values.rows.length,5);
   assert.ok(values.rows.every(x=>x.settlement_state==="NOT_FUNDED"));
   assert.equal(values.rows.reduce((n,x)=>n+Number(x.amount_cents),0),12000);
   const cancelled=await data.cancelOrder(pool,wlA,"a",created.id);
   assert.equal(cancelled.status,"CANCELED");
   await assert.rejects(()=>data.updateLeg(pool,wlB,"b",delivery.id,"IN_PROGRESS"),
     /suspensa|cancelada/);
 }finally{await database.close();}
});
test("rede só permite escopos do servidor e mantém operação monetária bloqueada",()=>{
 const api=read("interline_network_api.js"),db=read("interline_network_db.js");
 const server=read("server.js"),portal=read("white_label_portal.js");
 assert.match(server,/auth:\[requireAuth,requireRole\("ADMIN"\)\]/);
 assert.match(portal,/auth:\[authenticate,wlMaster,blockNewUsersUntilPasswordChanged\]/);
 assert.match(portal,/ownerKey\("WHITE_LABEL",req.wl.carrier.id\)/);
 assert.match(api,/resolve\(req\)/);
 assert.match(api,/paymentsEnabled:false/);
 assert.match(api,/charging:false,splitActive:false/);
 assert.match(db,/leg.payment_status!=="RECEIVED"/);
 assert.match(db,/UNIQUE\(seller_key,request_key\)/);
 assert.match(db,/CHECK\(gross_cents=postal_commission_cents\+seller_margin_cents\+stage_total_cents\)/);
 assert.match(db,/INSERT INTO interline_audit/);
 assert.doesNotMatch(api,/createCheckout\(|issueLabel\(|asaasFetch\(/);
 new vm.Script(api);new vm.Script(db);new vm.Script(read("public/interline-network.js"));
});
test("J&T Express tem logo local nos três painéis sem confundir outras marcas",()=>{
 const branding=read("public/branding.js");
 const asset=read("public/assets/brands/jt-express.svg");
 const global={};vm.runInNewContext(branding,global,{timeout:2000});
 for(const carrier of ["J&T Express","J&T","JET EXPRESS","J T Express"])
   assert.equal(global.PostalBrand.carrierLogo(carrier),"/assets/brands/jt-express.svg");
 assert.equal(global.PostalBrand.carrierLogo("Jadlog"),"/assets/brands/jadlog.svg");
 assert.equal(global.PostalBrand.carrierLogo("Loggi"),"/assets/brands/loggi.svg");
 assert.match(asset,/viewBox="0 0 571 138"/);
 assert.match(asset,/fill="#e60000"/);
});

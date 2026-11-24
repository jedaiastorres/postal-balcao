"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const collection=require("../white_label_collection");
const collectionDb=require("../white_label_collection_db");

const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");
const carrierA="11111111-1111-1111-1111-111111111111";
const carrierB="22222222-2222-2222-2222-222222222222";
const pointA="33333333-3333-3333-3333-333333333333";
const actor="44444444-4444-4444-4444-444444444444";
function valid(extra={}){
  return {
    requestKey:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    pointId:pointA,requesterName:"Cliente teste",requesterPhone:"(94) 99999-1234",
    requesterDocument:"",packageCount:2,
    address:{street:"Rua de Exemplo",number:"45",neighborhood:"Centro",
      complement:"Sala 2",cep:"68500-000",city:"Marabá",state:"PA"},
    notes:"Ligar antes da coleta",...extra
  };
}
test("valida dados da coleta antes de gravar e mantém agendamento seguro",()=>{
  const normalized=collection.normalizeCollection(valid({
    scheduledFor:new Date(Date.now()+60*60*1000).toISOString()
  }));
  assert.equal(normalized.requesterPhone,"94999991234");
  assert.equal(normalized.address.cep,"68500000");
  assert.equal(normalized.packageCount,2);
  assert.ok(normalized.scheduledFor.endsWith("Z"));
  assert.throws(()=>collection.normalizeCollection(valid({requesterName:"a"})),/nome do cliente/);
  assert.throws(()=>collection.normalizeCollection(valid({requesterPhone:"123"})),/Telefone/);
  assert.throws(()=>collection.normalizeCollection(valid({packageCount:201})),/Quantidade/);
  assert.throws(()=>collection.normalizeCollection(valid({pointId:"outro-ponto"})),/Unidade/);
  assert.throws(()=>collection.normalizeCollection(valid({requestKey:"invalido"})),/Identificador/);
  assert.throws(()=>collection.normalizeCollection(valid({scheduledFor:"2020-01-01T00:00:00Z"})),/Agendamento/);
  assert.throws(()=>collection.normalizeCollection(valid({address:{...valid().address,cep:"000"}})),/endereço completo/);
  assert.throws(()=>collection.normalizeCollection(valid({notes:"X".repeat(1001)})),/Observações/);
});
test("somente MASTER cancela e transições concluídas não voltam para abertas",()=>{
  assert.deepEqual(collection.allowedPrior("IN_ROUTE","WL_OPERATOR"),["ASSIGNED"]);
  assert.deepEqual(collection.allowedPrior("COLLECTED","WL_OPERATOR"),["ASSIGNED","IN_ROUTE"]);
  assert.deepEqual(collection.allowedPrior("CANCELED","WL_MASTER"),["REQUESTED","ASSIGNED","IN_ROUTE"]);
  assert.throws(()=>collection.allowedPrior("CANCELED","WL_OPERATOR"),/MASTER/);
  assert.throws(()=>collection.allowedPrior("ASSIGNED","WL_OPERATOR"),/Situação/);
  assert.equal(collection.transitions.COLLECTED.length,0);
  assert.equal(collection.transitions.CANCELED.length,0);
});
test("coleta sem atribuição usa status REQUESTED e unidade atribuída usa ASSIGNED",async()=>{
  const queries=[];
  const pool={query:async(sql,params)=>{queries.push({sql,params});return {rows:[{id:"created"}]}}};
  const data=collection.normalizeCollection(valid({pointId:null}));
  const newRequest=await collectionDb.createCollection(pool,carrierA,actor,data,null);
  const assigned=await collectionDb.createCollection(pool,carrierA,actor,data,pointA);
  assert.equal(newRequest.created,true);
  assert.equal(assigned.created,true);
  assert.equal(queries[0].params[1],carrierA);
  assert.equal(queries[0].params[2],null);
  assert.equal(queries[0].params.at(-1),"REQUESTED");
  assert.equal(queries[1].params[2],pointA);
  assert.equal(queries[1].params.at(-1),"ASSIGNED");
  assert.match(queries[0].sql,/SELECT 1 FROM wl_points p WHERE p.carrier_id=\$2 AND p.id=\$3 AND p.active=TRUE/);
  assert.match(queries[0].sql,/ON CONFLICT \(carrier_id,request_key\) DO NOTHING/);
});
test("nova tentativa usa a mesma ordem sem criar coletas duplicadas",async()=>{
  let n=0;
  const pool={query:async(sql,params)=>{
    n++;
    if(n===1)return {rows:[]};
    assert.match(sql,/WHERE carrier_id=\$1 AND request_key=\$2 AND created_by=\$3/);
    return {rows:[{id:"existing"}]};
  }};
  const result=await collectionDb.createCollection(pool,carrierB,actor,collection.normalizeCollection(valid()),pointA);
  assert.equal(result.created,false);
  assert.equal(result.row.id,"existing");
  assert.equal(n,2);
});
test("leitura, atribuição e atualização de situação ficam sempre no tenant e ponto",async()=>{
  const calls=[];
  const pool={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]}}};
  await collectionDb.listCollections(pool,carrierA,pointA,150);
  await collectionDb.assignCollection(pool,carrierA,actor,pointA,"Motorista Exemplo");
  await collectionDb.transitionCollection(pool,carrierB,actor,pointA,"COLLECTED",["ASSIGNED","IN_ROUTE"]);
  assert.equal(calls.length,3);
  assert.ok(calls.every(c=>c.params[0]===carrierA||c.params[0]===carrierB));
  assert.match(calls[0].sql,/WHERE carrier_id=\$1[\s\S]*?point_id=\$2/);
  assert.match(calls[1].sql,/c.carrier_id=\$1/);
  assert.match(calls[1].sql,/p.carrier_id=\$1 AND p.id=\$3 AND p.active=TRUE/);
  assert.match(calls[1].sql,/c.status IN \('REQUESTED','ASSIGNED'\)/);
  assert.match(calls[2].sql,/WHERE carrier_id=\$1 AND id=\$2 AND \(\$3::uuid IS NULL OR point_id=\$3\)/);
  assert.match(calls[2].sql,/status=ANY\(\$5::text\[\]\)/);
  assert.deepEqual(calls[2].params,[carrierB,actor,pointA,"COLLECTED",["ASSIGNED","IN_ROUTE"]]);
  const dbSql=read("white_label_collection_db.js");
  assert.match(dbSql,/FOREIGN KEY\(carrier_id,point_id\) REFERENCES wl_points\(carrier_id,id\)/);
  assert.match(dbSql,/UNIQUE\(carrier_id,request_key\)/);
});
test("API White Label exige sessão, CSRF e controla escopo de ponto sem usar entrada do navegador",()=>{
  const portal=read("white_label_portal.js");
  assert.match(portal,/app.get\("\/api\/wl\/collections",authenticate/);
  assert.match(portal,/app.post\("\/api\/wl\/collections",authenticate,blockNewUsersUntilPasswordChanged/);
  assert.match(portal,/app.patch\("\/api\/wl\/collections\/:id\/assign",\s*authenticate,wlMaster/);
  assert.match(portal,/app.patch\("\/api\/wl\/collections\/:id\/status",\s*authenticate/);
  assert.match(portal,/req.wl.account.role==="WL_OPERATOR"\?req.wl.account.point_id:data.pointId/);
  assert.match(portal,/wlCollection.allowedPrior\(status,req.wl.account.role\)/);
  assert.match(portal,/financialEnabled:false/);
  assert.match(portal,/crypto.timingSafeEqual/);
  assert.match(read("white_label_tenant_db.js"),/await wlCollectionDb.init\(pool\)/);
});
test("resposta da coleta é operacional e não revela chave técnica nem credenciais",()=>{
  const obj=collection.publicCollection({
    id:"id",request_key:"private",created_by:"private",point_id:pointA,
    requester_name:"Teste",requester_phone:"94999991234",package_count:"2",
    address:{city:"Marabá"},status:"REQUESTED",created_at:"2026-11-24T14:00:00Z",
    updated_at:"2026-11-24T14:00:00Z"
  });
  assert.equal(obj.packageCount,2);
  assert.equal(obj.paymentStatus,"NOT_LINKED");
  assert.equal(obj.financialAmount,null);
  assert.ok(!JSON.stringify(obj).includes("request_key"));
  assert.ok(!JSON.stringify(obj).includes("created_by"));
  assert.doesNotMatch(read("white_label_collection_db.js"),/api\.asaas|emission|checkout|splitPayment/i);
});
test("menu Coletas e formulário estão no White Label e mantêm compatibilidade com login",()=>{
  const html=read("public/white-label.html"),js=read("public/white-label.js");
  for(const field of ["wlCollectionForm","wlCollectionsList","wlCollectionName","wlCollectionPhone",
    "wlCollectionStreet","wlCollectionPackages","wlCollectionPoint","wlCollectionSchedule",
    "wlCollectionStatusFilter","wlQuoteCollectionShortcut"])assert.ok(html.includes('id="'+field+'"'),field);
  assert.match(html,/data-tab="collections"/);
  assert.match(html,/data-panel="collections"/);
  assert.match(js,/api\("\/api\/wl\/collections"/);
  assert.match(js,/function renderCollections\(\)/);
  assert.match(js,/globalThis.crypto\?\.randomUUID/);
  assert.doesNotMatch(html+js,/ConectEnvios/i);
  new vm.Script(js);
  new vm.Script(read("white_label_portal.js"));
  new vm.Script(read("white_label_collection_db.js"));
});

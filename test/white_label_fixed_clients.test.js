"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const logic=require("../white_label_clients");
const db=require("../white_label_clients_db");
const quote=require("../white_label_tenant");
const hybrid=require("../white_label_hybrid_quote");
const read=p=>fs.readFileSync(require.resolve("../"+p),"utf8");
const carrier="11111111-1111-1111-1111-111111111111";
const another="22222222-2222-2222-2222-222222222222";
const point="33333333-3333-3333-3333-333333333333";
const clientId="44444444-4444-4444-4444-444444444444";
const actor="55555555-5555-5555-5555-555555555555";
function validClient(overrides={}){
 return {name:"Loja Parceira Exemplo",document:"11.222.333/0001-44",
    phone:"(94) 99999-9999",email:"financeiro@example.com",pointId:point,
    street:"Rua das Entregas",number:"45",neighborhood:"Centro",
    cep:"68500-000",city:"Marabá",state:"PA",
    pointCommissionOverride:15,...overrides};
}
test("cliente fixo normaliza endereço, documento e comissão especial",()=>{
 const normalized=logic.normalizeClient(validClient());
 assert.equal(normalized.document,"11222333000144");
 assert.equal(normalized.phone,"94999999999");
 assert.equal(normalized.cep,"68500000");
 assert.equal(normalized.pointCommissionOverride,15);
 assert.throws(()=>logic.normalizeClient(validClient({pointCommissionOverride:101})),/entre 0% e 100%/);
 assert.throws(()=>logic.normalizeClient(validClient({pointId:null})),/Vincule o cliente/);
 assert.throws(()=>logic.normalizeClient(validClient({email:"incorreto"})),/E-mail/);
 assert.throws(()=>logic.normalizeClient(validClient({cep:"123"})),/Endereço/);
 assert.throws(()=>logic.normalizeClient(validClient({phone:"99"})),/Telefone/);
 assert.equal(logic.percent(0),0);
 assert.equal(logic.percent(100),100);
});
test("rota própria preserva taxa Postal e distribui apenas parcela White Label",()=>{
 const priced=quote.pricedTariff({id:"rota",name:"Rota",price:100,per_kg:0,days:3},
   {postal_fee_percent:20,postal_fee_fixed:1},1000);
 assert.equal(priced.total,100);
 assert.equal(priced.postalShare,21);
 assert.equal(priced.partnerShare,79);
 const [option]=hybrid.mergeHybridOptions([priced],[],{name:"White Label"},true);
 const split=logic.allocateCommission(option,20,true);
 assert.equal(split.whiteLabelShare,79);
 assert.equal(split.pointShare,15.8);
 assert.equal(split.masterShare,63.2);
 assert.equal(split.postalShare,21);
 assert.equal(split.pointShare+split.masterShare+split.postalShare,100);
 assert.equal("partnerShare" in split,false);
});
test("frete integrado reparte comissão da empresa e não afirma que o custo do provedor é Postal",()=>{
 const integrated={source:"INTEGRATED",id:"REDE-01",carrier:"Loggi",total:60,days:5,
    partnerShare:6};
 const split=logic.allocateCommission(integrated,40,true);
 assert.equal(split.pointShare,2.4);
 assert.equal(split.masterShare,3.6);
 assert.equal(split.whiteLabelShare,6);
 assert.equal(split.postalShare,null);
 assert.equal(split.total,60);
 const operator=logic.allocateCommission(integrated,40,false);
 assert.equal(operator.pointShare,undefined);
 assert.equal(operator.masterShare,undefined);
 assert.equal(operator.whiteLabelShare,undefined);
 assert.equal(operator.postalShare,undefined);
 assert.equal(operator.total,60);
 assert.throws(()=>logic.allocateCommission({...integrated,partnerShare:61},30,true),/parcela/);
});
test("novo cliente, edição e consultas sempre filtram transportadora e ponto",async()=>{
 const calls=[];
 const pool={query:async(sql,params)=>{
   calls.push({sql,params});
   if(sql.includes("INSERT INTO wl_clients"))return {rows:[{id:clientId}]};
   if(sql.includes("UPDATE wl_clients"))return {rows:[{id:clientId}]};
   if(sql.includes("FROM wl_clients c"))return {rows:[{id:clientId,carrier_id:carrier,
     name:"Teste",point_id:point,point_commission_percent:"20",point_commission_override:null}]};
   return {rows:[]};
 }};
 const client=logic.normalizeClient(validClient());
 await db.listClients(pool,carrier,point);
 await db.getClient(pool,carrier,clientId,point);
 await db.createClient(pool,carrier,actor,client,point,false);
 await db.updateClient(pool,carrier,clientId,point,client,point,false);
 await db.setClientActive(pool,carrier,clientId,false);
 await db.setPointCommission(pool,carrier,point,20);
 assert.ok(calls.every(c=>c.params.includes(carrier)));
 assert.ok(calls.filter(c=>!c.sql.includes("INSERT INTO wl_clients")).every(c=>c.params[0]===carrier));
 const reads=calls.filter(c=>c.sql.includes("FROM wl_clients c"));
 assert.ok(reads.every(c=>c.sql.includes("c.carrier_id=$1")));
 assert.ok(reads.every(c=>c.sql.includes("c.point_id=$2")||c.sql.includes("c.point_id=$3")));
 const create=calls.find(c=>c.sql.includes("INSERT INTO wl_clients"));
 assert.match(create.sql,/p.carrier_id=\$2 AND p.id=\$3 AND p.active=TRUE/);
 assert.equal(create.params[2],point);
 assert.equal(create.params[15],null,"operador não pode configurar comissão especial");
 const update=calls.find(c=>c.sql.includes("UPDATE wl_clients c"));
 assert.match(update.sql,/c.carrier_id=\$1 AND c.id=\$2/);
 assert.match(update.sql,/c.point_id=\$3/);
 assert.equal(update.params[17],false);
 const pointRate=calls.find(c=>c.sql.includes("UPDATE wl_points"));
 assert.match(pointRate.sql,/WHERE carrier_id=\$1 AND id=\$2 AND active=TRUE/);
});
test("comissão padrão de clientes é herdada do ponto e especial é somente MASTER",()=>{
 const data={id:clientId,name:"Exemplo",point_id:point,point_name:"Ponto Marabá",
  point_commission_percent:"20.00",point_commission_override:"12.50"};
 const master=logic.publicClient(data,true);
 const operator=logic.publicClient(data,false);
 assert.equal(master.pointCommissionOverride,12.5);
 assert.equal(master.pointCommissionDefault,20);
 assert.equal(operator.pointCommissionOverride,undefined);
 assert.equal(operator.pointCommissionDefault,undefined);
 const portal=read("white_label_portal.js");
 assert.match(portal,/if\(!master&&req.body\?\.pointCommissionOverride!=null/);
 assert.match(portal,/req.wl.account.point_id,pointCommissionOverride:null,active:true/);
 assert.match(portal,/app.patch\("\/api\/wl\/points\/:id\/commission",authenticate,wlMaster/);
 assert.match(portal,/app.patch\("\/api\/wl\/clients\/:id\/status",authenticate,wlMaster/);
 assert.match(portal,/client\?\.point_commission_override!=null/);
 assert.match(portal,/wlClients\.allocateCommission\(option,pointId\?commission:0,master\)/);
 assert.match(portal,/master\?null:req.wl.account.point_id/);
 assert.match(portal,/req.wl.carrier.id/);
});
test("migração tem chave estrangeira composta e unicidade do CPF/CNPJ por transportadora",()=>{
 const schema=read("white_label_clients_db.js");
 assert.match(schema,/FOREIGN KEY\(carrier_id,point_id\) REFERENCES wl_points\(carrier_id,id\)/);
 assert.match(schema,/ON wl_clients\(carrier_id,document\) WHERE document<>''/);
 assert.match(schema,/ALTER TABLE wl_points ADD COLUMN IF NOT EXISTS commission_percent/);
 assert.match(read("white_label_tenant_db.js"),/await wlClientsDb.init\(pool\)/);
});
test("telas reutilizam cliente na cotação e na coleta, mantendo recebimento bloqueado",()=>{
 const html=read("public/white-label.html");
 const ui=read("public/white-label.js");
 for(const id of ["wlClientForm","wlClientName","wlClientPoint","wlClientCommissionOverride",
   "wlClientsList","wlPointCommissionPoint","wlPointCommissionRate",
   "wlQuoteClient","wlQuotePoint","wlCollectionClient"])
   assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(html,/data-tab="clients"/);
 assert.match(html,/data-panel="clients"/);
 assert.match(ui,/function renderClients\(\)/);
 assert.match(ui,/async function loadClients\(\)/);
 assert.match(ui,/option\.masterShare/);
 assert.match(ui,/option\.pointShare/);
 assert.match(html,/Transações financeiras desativadas/);
 for(const source of ["public/white-label.js","white_label_portal.js","white_label_clients_db.js"])
   new vm.Script(read(source));
});

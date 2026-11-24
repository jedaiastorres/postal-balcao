"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const customer=require("../white_label_customer");
const db=require("../white_label_customer_db");
const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");
const carrier="11111111-1111-1111-1111-111111111111";
const client="22222222-2222-2222-2222-222222222222";
const account="33333333-3333-3333-3333-333333333333";
const point="44444444-4444-4444-4444-444444444444";

test("endereço de cliente usa mesmas informações do Postal e valida CEP e campos",()=>{
 const a=customer.normalizeSavedAddress({
   label:"Meu escritório",kind:"SENDER",
   data:{name:"Cliente teste",document:"12.345.678/0001-99",
     cep:"68515-000",address:"Rua São João",number:"71",city:"Parauapebas/PA"}
 });
 assert.equal(a.data.cep,"68515000");
 assert.equal(a.data.document,"12345678000199");
 assert.equal(a.kind,"SENDER");
 assert.throws(()=>customer.normalizeSavedAddress({label:"Meu",kind:"OTHER",data:{}}),/tipo/);
 assert.throws(()=>customer.normalizeSavedAddress({
   label:"Teste",kind:"RECIPIENT",data:{name:"Alguém",cep:"000",address:"Rua Um",number:"1"}
 }),/CEP/);
});
test("cotações de múltiplos volumes validam tamanhos e não permitem volume inventado",()=>{
 const volume={weight:1200,length:20,width:15,height:10,declaredValue:100};
 const result=customer.normalizeVolumes({
   origin:"68515-000",destination:"01001-000",volumes:[volume,volume]
 });
 assert.equal(result.volumes.length,2);
 assert.equal(result.volumes[0].weight,1200);
 assert.throws(()=>customer.normalizeVolumes({
   origin:"68515000",destination:"01001000",volumes:[]
 }),/1 a 5/);
 assert.throws(()=>customer.normalizeVolumes({
   origin:"68515000",destination:"01001000",volumes:Array(6).fill(volume)
 }),/1 a 5/);
 assert.throws(()=>customer.normalizeVolumes({
   origin:"68515000",destination:"01001000",volumes:[{...volume,length:400}]
 }),/comprimento/);
});
test("tarifa própria de cada volume inclui taxa Postal, sem duplicar comissão do ponto",()=>{
 const p1={own:[{id:"rota",name:"Regional",total:40,days:2,partnerShare:30,postalShare:10}],integrated:[]};
 const p2={own:[{id:"rota",name:"Regional",total:60,days:3,partnerShare:45,postalShare:15}],integrated:[]};
 const options=customer.foldQuotes([p1,p2],{name:"Transportadora Regional"},true,20);
 assert.equal(options.length,1);
 assert.equal(options[0].total,100);
 assert.equal(options[0].postalShare,25);
 assert.equal(options[0].whiteLabelShare,75);
 assert.equal(options[0].pointShare,15);
 assert.equal(options[0].masterShare,60);
 assert.equal(options[0].volumeCount,2);
 const clientView=customer.foldQuotes([p1,p2],{name:"Regional"},false,20);
 assert.equal(clientView[0].total,100);
 for(const field of ["postalShare","whiteLabelShare","pointShare","masterShare","partnerShare"])
   assert.equal(clientView[0][field],undefined,field);
});
test("frete integrado exige cobertura real de todos os volumes e preserva despesas internas",()=>{
 const a={own:[],integrated:[
   {carrier:"Loggi",name:"Expresso",total:25,days:2,partnerShare:4},
   {carrier:"Jadlog",name:"Package",total:30,days:3,partnerShare:5}]};
 const b={own:[],integrated:[
   {carrier:"Loggi",name:"Expresso",total:26,days:4,partnerShare:4.1}]};
 const both=customer.foldQuotes([a,b],{name:"Regional"},true,50);
 assert.equal(both.length,1);
 assert.equal(both[0].carrier,"Loggi");
 assert.equal(both[0].total,51);
 assert.equal(both[0].whiteLabelShare,8.1);
 assert.equal(both[0].pointShare,4.05);
 assert.equal(both[0].masterShare,4.05);
 assert.equal(both[0].postalShare,null);
 const none=customer.foldQuotes([a,{own:[],integrated:[]}],{name:"Regional"},false,50);
 assert.equal(none.length,0);
});
test("contas do cliente são por tenant, com chave composta de cliente e senha revogável",async()=>{
 const sql=read("white_label_customer_db.js");
 assert.match(sql,/FOREIGN KEY\(carrier_id,client_id\) REFERENCES wl_clients\(carrier_id,id\)/);
 assert.match(sql,/UNIQUE\(carrier_id,email\)/);
 assert.match(sql,/session_version=wl_customer_accounts.session_version\+1/);
 assert.match(sql,/LOWER\(c.email\)=LOWER\(\$5\)/);
 assert.match(sql,/ON wl_customer_addresses\(carrier_id,client_id,created_at DESC\)/);
 assert.match(sql,/AND client_id=\$2 AND id=\$3/);
 const mock={query:async(q,values)=>{
   if(q.includes("UPDATE wl_customer_accounts"))assert.deepEqual(values,[carrier,account,"hash"]);
   return {rows:[{id:account}],rowCount:1};
 }};
 await db.updatePassword(mock,carrier,account,"hash");
 const r=await db.deleteAddress(mock,carrier,client,account);
 assert.equal(r,true);
});
test("clientes White Label nunca recebem login Postal nem acessam operações de outra empresa",()=>{
 const server=read("server.js"),portal=read("white_label_portal.js"),html=read("public/white-label-customer.html");
 assert.match(portal,/white-label-customer/);
 assert.match(portal,/wl_customer_session/);
 assert.match(portal,/Path=\/api\/wl\/customer/);
 assert.match(portal,/account\.carrier_id/); // current admin auth still checks tenant
 assert.match(portal,/getClient\(pool,req\.wlCustomer\.carrier\.id,account\.client_id\)/);
 assert.match(portal,/client\.point_commission_override!=null/);
 assert.match(portal,/authenticateCustomer/);
 assert.match(portal,/!crypto\.timingSafeEqual/);
 assert.match(portal,/fiscal-lookup",authenticateCustomer/);
 assert.match(portal,/lookupFiscalDocument\(req,res,req\.wlCustomer\.account\.document/);
 assert.match(portal,/bulkShipping\.parseUpload/);
 assert.match(server,/lookupFiscalDocument\(req,res,wlCustomerDocument\)/);
 assert.match(server,/personalDocument=cleanDigits\(document\)/);
 assert.match(html,/src="\/fiscal_document\.js\?v=1\.17\.0"/);
 for(const str of ["wlcQuoteForm","wlcXmlFile","wlcFiscalKey","wlcAddVolume",
  "wlcAddressForm","wlcBulkTemplate","wlcBulkFile","wlcPasswordForm"])
   assert.ok(html.includes('id="'+str+'"'),str);
});
test("cliente vê operações pendentes claramente, não finge ativação financeira",()=>{
 const html=read("public/white-label-customer.html");
 const js=read("public/white-label-customer.js");
 const portal=read("white_label_portal.js");
 for(const name of ["orders","collections","wallet","connections"])assert.match(html,new RegExp('data-client-panel="'+name+'"'));
 assert.match(html,/Em homologação financeira/);
 assert.match(html,/a emissão de postagens em lote permanece bloqueada/);
 assert.match(portal,/issuance:false,payment:false,shippingLabels:false,wallet:false/);
 assert.match(portal,/previewOnly:true,issueEnabled:false/);
 assert.doesNotMatch(js, /\/api\/client\/orders|\/api\/orders|\/api\/payment-preview/);
 new vm.Script(js);
 new vm.Script(portal);
 new vm.Script(serverlessCode());
 function serverlessCode(){return read("white_label_customer_db.js");}
});

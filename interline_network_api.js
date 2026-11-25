"use strict";
const network=require("./interline_network");
const ledger=require("./interline_network_db");

function install({app,pool,prefix,auth,resolve}){
 if(!app||!pool||!prefix||!Array.isArray(auth)||typeof resolve!=="function")
   throw new Error("Configuração da rede intertransportadoras incompleta.");
 // O JWT/cookie e a identidade vêm dos mecanismos existentes de cada portal.
 // Cada endpoint valida o operador no servidor, nunca no corpo enviado pelo cliente.
 const wrap=fn=>async(req,res)=>{
   try{
     res.setHeader("Cache-Control","private,no-store");
     const owner=await resolve(req);
     if(!owner||!owner.key||!owner.userId)
       return res.status(403).json({error:"Perfil sem acesso à rede."});
     const result=await fn(req,owner);
     res.status(result?.status||200).json(result?.body??result);
   }catch(error){
     const code=[400,403,404,409,422].includes(error.status)?error.status:500;
     if(code===500)console.error("INTERLINE_API_ERROR",String(error.code||error.name||"unknown"));
     res.status(code).json({error:code===500?"Não foi possível concluir a operação de rede.":error.message});
   }
 };
 const makeIdentity=async owner=>ledger.ensureMember(pool,owner.key,owner.name,owner.carrierId||null);
 const route=(method,suffix,fn)=>app[method](prefix+suffix,...auth,wrap(fn));
 route("get","/overview",async(req,owner)=>{
   const member=await makeIdentity(owner);
   const [lanes,orders]=await Promise.all([
     ledger.listLanes(pool,owner.key),ledger.listOrders(pool,owner.key)]);
   return {membership:{operatorKey:member.operator_key,displayName:member.display_name,
     enabled:member.opted_in===true},lanes:lanes.map(network.publicLane),
     orders:orders.map(row=>ledger.publicOrder(row,owner.key)),
     limits:{maxLanes:150,maxOrders:150},paymentsEnabled:false,
     merchantCheckoutEnabled:false,settlementsEnabled:false,
     financialReason:"Necessária conta Asaas emissora individual, split validado e webhook confirmado."};
 });
 route("post","/membership",async(req,owner)=>{
   if(typeof req.body?.enabled!=="boolean")
     throw Object.assign(new Error("Informe ativação verdadeira ou falsa."),{status:400});
   await makeIdentity(owner);
   const state=await ledger.setOptIn(pool,owner.key,req.body.enabled);
   return {ok:true,membership:{operatorKey:state.operator_key,enabled:state.opted_in},
     note:"A participação na rede não autoriza novos pagamentos ou repasses."};
 });
 route("get","/match",async(req,owner)=>{
   const origin=String(req.query.origin||"").replace(/\D/g,"");
   const destination=String(req.query.destination||"").replace(/\D/g,"");
   const weight=Number(req.query.weight);
   if(origin.length!==8||destination.length!==8||!Number.isSafeInteger(weight)||
       weight<1||weight>30000)throw Object.assign(new Error("Informe CEPs e peso válidos."),{status:400});
   const member=await makeIdentity(owner);
   if(!member.opted_in)return {offers:[],reason:"Ative primeiro a participação na rede."};
   const offers=await ledger.discover(pool,{origin,destination,weight});
   return {offers:offers.map(network.publicLane),quoteOnly:true,
     note:"Preços informados pelos operadores; contratação requer aceite de cada etapa."};
 });
 route("post","/lanes",async(req,owner)=>{
   await makeIdentity(owner);
   const count=await ledger.listLanes(pool,owner.key);
   if(count.length>=150)throw Object.assign(new Error("Limite de serviços de rede atingido."),{status:409});
   const form=network.normalizeLane(req.body);
   const row=await ledger.addLane(pool,owner.key,form);
   return {status:201,body:{ok:true,lane:network.publicLane({...row,operator_name:owner.name})}};
 });
 route("patch","/lanes/:id",async(req,owner)=>{
   const id=network.requiredUuid(req.params.id,"Serviço");
   if(typeof req.body?.active!=="boolean")
     throw Object.assign(new Error("Informe a situação do serviço."),{status:400});
   const row=await ledger.toggleLane(pool,owner.key,id,req.body.active);
   if(!row)throw Object.assign(new Error("Este serviço não pertence à sua empresa."),{status:404});
   return {ok:true,id,active:row.active};
 });
 route("post","/orders",async(req,owner)=>{
   await makeIdentity(owner);
   const input=network.normalizeRequest(req.body);
   const terms=owner.key==="POSTAL"?{percent:0,fixed:0}:
     {percent:owner.postalFeePercent,fixed:owner.postalFeeFixed};
   const result=await ledger.requestService(pool,owner.key,owner.userId,input,terms);
   return {status:result.created?201:200,body:{ok:true,...result,
     warning:"Solicitação operacional sem cobrança. Repasse condicionado a pagamento, execução e conciliação."}};
 });
 route("get","/orders",async(req,owner)=>{
   await makeIdentity(owner);
   const orders=await ledger.listOrders(pool,owner.key);
   return {orders:orders.map(row=>ledger.publicOrder(row,owner.key)),
     moneyMovementsEnabled:false};
 });
 route("patch","/legs/:id",async(req,owner)=>{
   const id=network.requiredUuid(req.params.id,"Etapa");
   const action=String(req.body?.status||"").toUpperCase();
   if(!["ACCEPTED","REJECTED","IN_PROGRESS","COMPLETED"].includes(action))
     throw Object.assign(new Error("Situação não reconhecida."),{status:400});
   const result=await ledger.updateLeg(pool,owner.key,owner.userId,id,action,req.body?.proof);
   return {ok:true,...result,settled:false};
 });
 route("post","/orders/:id/cancel",async(req,owner)=>{
   const id=network.requiredUuid(req.params.id,"Frete");
   const result=await ledger.cancelOrder(pool,owner.key,owner.userId,id);
   return {ok:true,...result};
 });
 route("get","/finance",async(req,owner)=>{
   await makeIdentity(owner);
   return {ready:false,charging:false,splitActive:false,
     checkoutAccountOwner:owner.key,
     requirements:[
       "Asaas habilitado e credenciais específicas da empresa vendedora",
       "Wallet IDs dos participantes com consentimento de cada recebedor",
       "Habilitação do split e comparação com o líquido pós-tarifas",
       "Idempotência de cobranças e webhooks autenticados",
       "Fluxos de cancelamento, estorno, divergência e reconciliação",
       "Contrato e remuneração confirmados antes do pagamento"
     ]};
 });
}
module.exports={install};

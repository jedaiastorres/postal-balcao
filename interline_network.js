"use strict";

const STAGES=Object.freeze(["COLLECTION","TRANSFER","DELIVERY"]);
const KINDS=Object.freeze(["POSTAL","WHITE_LABEL"]);
const MONEY_MAX=10_000_000_00;
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||""));
const digits=value=>String(value??"").replace(/\D/g,"");
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const cents=(value,label="Valor")=>{
  if(!Number.isSafeInteger(Number(value))||Number(value)<0||Number(value)>MONEY_MAX)
    throw bad(label+" inválido (use centavos inteiros).");
  return Number(value);
};
const requiredUuid=(value,label="Identificador")=>{
  if(!uuid(value))throw bad(label+" inválido.");
  return String(value).toLowerCase();
};
const ownerKey=(kind,tenantId)=>{
  if(kind==="POSTAL")return "POSTAL";
  if(kind==="WHITE_LABEL"&&uuid(tenantId))return "WL:"+String(tenantId).toLowerCase();
  throw bad("Operador de rede inválido.");
};
const normalizeLane=(input={})=>{
  const stage=String(input.stage||"").toUpperCase();
  if(!STAGES.includes(stage))throw bad("Serviço deve ser coleta, transferência ou entrega.");
  const name=String(input.name||"").trim();
  if(name.length<3||name.length>100)throw bad("Informe uma descrição do serviço (3 a 100 caracteres).");
  const originStart=digits(input.originStart),originEnd=digits(input.originEnd);
  const destinationStart=digits(input.destinationStart),destinationEnd=digits(input.destinationEnd);
  if([originStart,originEnd,destinationStart,destinationEnd].some(x=>x.length!==8)||
     originStart>originEnd||destinationStart>destinationEnd)
    throw bad("Informe faixas de CEP válidas para origem e destino.");
  const minWeight=Number(input.minWeight),maxWeight=Number(input.maxWeight);
  if(!Number.isSafeInteger(minWeight)||!Number.isSafeInteger(maxWeight)||minWeight<1||
    maxWeight<minWeight||maxWeight>30000)throw bad("Informe peso de 1 a 30.000 gramas.");
  const priceCents=cents(input.priceCents,"Preço do serviço");
  if(priceCents<100)throw bad("Preço mínimo da etapa: R$ 1,00.");
  const leadHours=Number(input.leadHours);
  if(!Number.isSafeInteger(leadHours)||leadHours<1||leadHours>2160)
    throw bad("Prazo da etapa deve ser de 1 a 2160 horas.");
  return {stage,name,originStart,originEnd,destinationStart,destinationEnd,
    minWeight,maxWeight,priceCents,leadHours,active:input.active!==false};
};
const offerMatches=(lane,route)=>{
  const origin=digits(route.origin),destination=digits(route.destination);
  const weight=Number(route.weight);
  if(origin.length!==8||destination.length!==8||!Number.isSafeInteger(weight)||weight<1||weight>30000)
    throw bad("Informe CEPs válidos e peso real.");
  const between=(v,start,end)=>v>=start&&v<=end;
  const stage=lane.stage;
  return lane.active===true&&weight>=Number(lane.min_weight??lane.minWeight)&&
    weight<=Number(lane.max_weight??lane.maxWeight)&&
    (stage==="COLLECTION"?between(origin,lane.origin_start??lane.originStart,lane.origin_end??lane.originEnd):
      stage==="DELIVERY"?between(destination,lane.destination_start??lane.destinationStart,lane.destination_end??lane.destinationEnd):
        between(origin,lane.origin_start??lane.originStart,lane.origin_end??lane.originEnd)&&
        between(destination,lane.destination_start??lane.destinationStart,lane.destination_end??lane.destinationEnd));
};
const normalizeRequest=(input={})=>{
  const requestKey=requiredUuid(input.requestKey,"Chave de confirmação");
  const customerReference=String(input.customerReference||"").trim();
  const senderName=String(input.senderName||"").trim();
  const recipientName=String(input.recipientName||"").trim();
  if(customerReference.length>100||senderName.length<2||senderName.length>160||
    recipientName.length<2||recipientName.length>160)
    throw bad("Informe remetente, destinatário e referência válida.");
  const origin=digits(input.origin),destination=digits(input.destination);
  const weight=Number(input.weight);
  if(origin.length!==8||destination.length!==8||!Number.isSafeInteger(weight)||weight<1||weight>30000)
    throw bad("Informe CEPs e peso reais.");
  const priceCents=cents(input.priceCents,"Preço comercial");
  if(priceCents<100)throw bad("Preço comercial mínimo: R$ 1,00.");
  if(!Array.isArray(input.laneIds)||input.laneIds.length<2||input.laneIds.length>3)
    throw bad("Selecione ao menos coleta e entrega; transferência é opcional.");
  const laneIds=input.laneIds.map(x=>requiredUuid(x,"Serviço"));
  if(new Set(laneIds).size!==laneIds.length)throw bad("Não repita serviços no mesmo frete.");
  return {requestKey,customerReference,senderName,recipientName,origin,destination,
    weight,priceCents,laneIds};
};
function snapshotSale({sellerKey,selectedLanes,grossCents,postalFeePercent=0,postalFeeFixed=0}){
  if(!Array.isArray(selectedLanes)||selectedLanes.length<2||selectedLanes.length>3)
    throw bad("A rede exige etapas de coleta e entrega.");
  const stages=selectedLanes.map(x=>x.stage);
  if(stages[0]!=="COLLECTION"||stages.at(-1)!=="DELIVERY"||
    (stages.length===3&&stages[1]!=="TRANSFER"))
    throw bad("Etapas fora da sequência: coleta, transferência, entrega.");
  if(!selectedLanes.some(lane=>lane.operator_key!==sellerKey))
    throw bad("Selecione ao menos um operador de outra empresa.");
  const gross=cents(grossCents,"Preço comercial");
  const commissionPercent=Number(postalFeePercent),fixed=Number(postalFeeFixed);
  if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>50||
     !Number.isFinite(fixed)||fixed<0||fixed>10000)
    throw bad("Contrato Postal sem comissão válida.");
  const postalFee=sellerKey==="POSTAL"?0:Math.round(gross*commissionPercent/100)+
    Math.round(fixed*100);
  let legs=0;
  const breakdown=selectedLanes.map(lane=>{
    const amount=cents(lane.price_cents??lane.priceCents,"Remuneração da etapa");
    if(amount<100)throw bad("Etapa com preço inválido.");
    legs+=amount;
    return {operatorKey:lane.operator_key,stage:lane.stage,laneId:lane.id,amountCents:amount};
  });
  const sellerMargin=gross-postalFee-legs;
  if(sellerMargin<0)throw bad("Frete sem saldo: preço menor que comissão Postal e remuneração das etapas.");
  if(sellerMargin<100)throw bad("Deixe ao menos R$ 1,00 de margem comercial para a empresa vendedora.");
  return Object.freeze({grossCents:gross,postalFeeCents:postalFee,
    sellerMarginCents:sellerMargin,stageTotalCents:legs,
    allocations:Object.freeze(breakdown.map(x=>Object.freeze(x)))});
}
const verifySplitPlan=({issuerWalletId,splits,netAvailableCents})=>{
  if(!issuerWalletId||typeof issuerWalletId!=="string")throw bad("Carteira emissora não validada.");
  const available=cents(netAvailableCents,"Líquido da cobrança");
  const seen=new Set();
  let total=0;
  for(const split of splits){
    const wallet=String(split.walletId||"").trim();
    const amount=cents(split.fixedCents,"Repasse");
    if(!wallet||wallet===issuerWalletId||seen.has(wallet))throw bad("Carteira de split repetida ou igual à emissora.");
    seen.add(wallet);total+=amount;
  }
  if(total>available)throw bad("Splits excedem o valor líquido disponível após tarifas do Asaas.");
  return {splitTotalCents:total,issuerRemainderCents:available-total};
};
const completeAllowed=(status,action)=>{
  const rules={OFFERED:["ACCEPTED","REJECTED"],ACCEPTED:["IN_PROGRESS"],
    IN_PROGRESS:["COMPLETED"],COMPLETED:[],REJECTED:[]};
  if(!rules[status]?.includes(action))throw bad("Transição não permitida para a etapa.");
  return true;
};
const publicLane=row=>({id:row.id,operatorKey:row.operator_key,operatorName:row.operator_name,
  stage:row.stage,name:row.name,originStart:row.origin_start,originEnd:row.origin_end,
  destinationStart:row.destination_start,destinationEnd:row.destination_end,
  minWeight:Number(row.min_weight),maxWeight:Number(row.max_weight),
  priceCents:Number(row.price_cents),leadHours:Number(row.lead_hours),active:row.active===true});
module.exports={STAGES,KINDS,ownerKey,normalizeLane,normalizeRequest,snapshotSale,
  offerMatches,verifySplitPlan,completeAllowed,publicLane,requiredUuid};

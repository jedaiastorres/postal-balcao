"use strict";
const hybrid=require("./white_label_hybrid_quote");
const tariff=require("./white_label_tenant");
const commissions=require("./white_label_clients");
const bad=message=>Object.assign(new Error(message),{status:400});
const digits=value=>String(value||"").replace(/\D/g,"");
const round=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
function normalizeAddress(value={}){
  if(!value||typeof value!=="object"||Array.isArray(value))throw bad("Endereço inválido.");
  const result={name:String(value.name||"").trim().slice(0,160),
    document:digits(value.document),phone:digits(value.phone),
    email:String(value.email||"").trim().toLowerCase().slice(0,160),
    cep:digits(value.cep),address:String(value.address||"").trim().slice(0,160),
    number:String(value.number||"").trim().slice(0,20),
    neighborhood:String(value.neighborhood||"").trim().slice(0,100),
    complement:String(value.complement||"").trim().slice(0,100),
    city:String(value.city||"").trim().slice(0,100)};
  if(result.name.length<2||result.cep.length!==8||result.address.length<3||!result.number)
    throw bad("Informe nome, CEP e logradouro com número.");
  if(result.document&&![11,14].includes(result.document.length))throw bad("CPF/CNPJ inválido.");
  if(result.phone&&![10,11].includes(result.phone.length))throw bad("Telefone deve ter DDD.");
  return result;
}
function normalizeSavedAddress(input={}){
  const label=String(input.label||"").trim();
  const kind=String(input.kind||"").toUpperCase();
  if(label.length<2||label.length>100||!["SENDER","RECIPIENT"].includes(kind))
    throw bad("Informe identificação e tipo válido do endereço.");
  return {label,kind,data:normalizeAddress(input.data)};
}
function normalizeVolumes(input={}){
  const origin=digits(input.origin),destination=digits(input.destination);
  if(origin.length!==8||destination.length!==8)throw bad("Informe CEPs válidos.");
  if(!Array.isArray(input.volumes)||input.volumes.length<1||input.volumes.length>5)
    throw bad("Informe de 1 a 5 volumes nesta simulação.");
  const volumes=input.volumes.map(volume=>hybrid.validateHybridQuote({...volume,origin,destination}));
  const totalWeight=volumes.reduce((sum,v)=>sum+v.weight,0);
  if(totalWeight>150000)throw bad("Peso total acima de 150 kg.");
  return {origin,destination,volumes};
}
function foldQuotes(parts,brand,master,pointPercent){
  const totalVolumes=parts.length;
  if(!totalVolumes)return [];
  const perVolume=parts.map(part=>{
    const own=(part.own||[]).map(v=>({source:"OWN",key:"OWN:"+v.id,
      carrier:brand.name,name:v.name,total:v.total,days:v.days,
      partnerShare:v.partnerShare,postalShare:v.postalShare}));
    const integrated=(part.integrated||[]).map(v=>({source:"INTEGRATED",
      key:"INTEGRATED:"+String(v.carrier||"").toLowerCase()+"|"+String(v.name||"").toLowerCase(),
      carrier:v.carrier,name:v.name,total:v.total,days:v.days,
      partnerShare:v.partnerShare,postalShare:null}));
    const unique=new Map();
    // Mesmo produto devolvido em duplicidade: só oferecer menor valor por volume.
    for(const entry of [...own,...integrated]){
      if(!Number.isFinite(Number(entry.total))||entry.total<=0)continue;
      const earlier=unique.get(entry.key);
      if(!earlier||entry.total<earlier.total)unique.set(entry.key,entry);
    }
    return unique;
  });
  const options=[];
  for(const [key,first] of perVolume[0]){
    const matches=perVolume.map(row=>row.get(key));
    if(matches.some(v=>!v))continue; // não inventar tarifa de volume sem cobertura
    const total=round(matches.reduce((s,v)=>s+v.total,0));
    const partnerShare=round(matches.reduce((s,v)=>s+Number(v.partnerShare||0),0));
    const postalShare=first.source==="OWN"
      ?round(matches.reduce((s,v)=>s+Number(v.postalShare||0),0)):null;
    if(total<=0||partnerShare>total||postalShare!==null&&postalShare+partnerShare>total+.01)continue;
    const original={source:first.source,id:first.key,carrier:first.carrier,name:first.name,total,
      days:matches.every(v=>Number(v.days)>0)?Math.max(...matches.map(v=>Number(v.days))):null,
      partnerShare,postalShare,volumeCount:totalVolumes,estimated:true};
    options.push(commissions.allocateCommission(original,pointPercent,master));
  }
  return options.sort((a,b)=>a.total-b.total).slice(0,40);
}
module.exports={normalizeAddress,normalizeSavedAddress,normalizeVolumes,foldQuotes};

"use strict";

function invalid(message){
  return Object.assign(new Error(message),{status:400});
}

function buildPublicQuote(selections,now=Date.now()){
  if(!Array.isArray(selections)||!selections.length||selections.length>12){
    throw invalid("Compartilhe de 1 a 12 opções de uma mesma cotação.");
  }
  const first=selections[0]?.package||{};
  if(!/^[0-9]{8}$/.test(String(first.cepFrom||""))||
     !/^[0-9]{8}$/.test(String(first.cepTo||""))){
    throw invalid("CEPs da cotação inválidos.");
  }
  const count=Number(first.volumeCount||0);
  if(!Number.isInteger(count)||count<1||count>50)throw invalid("Número de volumes inválido.");
  const routeKeys=["cepFrom","cepTo","volumeCount","weightGrams","declaredValue","providerCepFrom","width","height","length"];
  const volumeSignature=JSON.stringify(first.volumes||[]);
  const demo=Boolean(selections[0]?.demo);
  if(selections.some(p=>!p?.package||
    routeKeys.some(key=>String(p.package[key]??"")!==String(first[key]??""))||
    JSON.stringify(p.package.volumes||[])!==volumeSignature||
    Boolean(p.demo)!==demo)){
    throw invalid("Selecione somente fretes da mesma cotação.");
  }
  const found=new Set();
  const options=selections.map(p=>{
    const price=Number(p.salePrice);
    if(!Number.isFinite(price)||price<=0||price>100000)throw invalid("Valor de frete inválido para compartilhar.");
    const key=String(p.postalCompanyId)+"|"+String(p.service)+"|"+String(price);
    if(found.has(key))throw invalid("Não repita a mesma opção de frete.");
    found.add(key);
    return {
      carrier:String(p.carrierName||"Transportadora parceira").slice(0,100),
      service:String(p.service||"Envio").slice(0,100),
      deadline:p.deadline!=null&&p.deadline!==""&&Number.isFinite(Number(p.deadline))&&Number(p.deadline)>=0
        ?Number(p.deadline):null,
      price
    };
  });
  return {
    originCep:String(first.cepFrom),destinationCep:String(first.cepTo),
    volumeCount:count,
    generatedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+24*60*60*1000).toISOString(),
    demo,options:options.sort((a,b)=>a.price-b.price)
  };
}

module.exports={buildPublicQuote};

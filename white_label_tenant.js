"use strict";

const digit = value => String(value ?? "").replace(/\D/g, "");
const fail = message => Object.assign(new Error(message), {status:400});
const round = value => Math.round((Number(value)+Number.EPSILON)*100)/100;

function normalizeTariff(value={}) {
  if(!value||typeof value!=="object"||Array.isArray(value))throw fail("Tarifa inválida.");
  const originStart=digit(value.originStart);
  const originEnd=digit(value.originEnd);
  const destinationStart=digit(value.destinationStart);
  const destinationEnd=digit(value.destinationEnd);
  const name=String(value.name||"").trim();
  const minWeight=Number(value.minWeight);
  const maxWeight=Number(value.maxWeight);
  const price=Number(value.price);
  const perKg=Number(value.perKg ?? 0);
  const days=Number(value.days);
  if(!name||name.length>100)throw fail("Informe o nome da rota (até 100 caracteres).");
  if([originStart,originEnd,destinationStart,destinationEnd].some(cep=>cep.length!==8))
    throw fail("Informe quatro CEPs de 8 dígitos para as faixas de origem e destino.");
  if(originStart>originEnd||destinationStart>destinationEnd)throw fail("A faixa de CEP está invertida.");
  if(!Number.isInteger(minWeight)||!Number.isInteger(maxWeight)||minWeight<1||maxWeight<minWeight||maxWeight>30000)
    throw fail("Peso válido de 1 a 30.000 gramas.");
  if(!Number.isFinite(price)||price<=0||price>100000||!Number.isFinite(perKg)||perKg<0||perKg>10000)
    throw fail("Tarifa inválida. Informe preço positivo e adicional por kg não negativo.");
  if(!Number.isInteger(days)||days<1||days>90)throw fail("Prazo deve ser de 1 a 90 dias.");
  return {name,originStart,originEnd,destinationStart,destinationEnd,
    minWeight,maxWeight,price:round(price),perKg:round(perKg),days,active:value.active!==false};
}
function validateQuote(input={}) {
  const origin=digit(input.origin);
  const destination=digit(input.destination);
  const weight=Number(input.weight);
  if(origin.length!==8||destination.length!==8)throw fail("Informe CEPs de origem e destino com oito dígitos.");
  if(!Number.isInteger(weight)||weight<1||weight>30000)throw fail("Peso deve ser de 1 a 30.000 gramas.");
  return {origin,destination,weight};
}
function pricedTariff(rate,carrier,weight) {
  const total=round(Number(rate.price)+Number(rate.per_kg)*weight/1000);
  const postal=round(total*Number(carrier.postal_fee_percent||0)/100+Number(carrier.postal_fee_fixed||0));
  if(!Number.isFinite(total)||!Number.isFinite(postal)||postal>total) return null;
  return {id:rate.id,name:rate.name,total,days:Number(rate.days),
    partnerShare:round(total-postal),postalShare:postal,estimated:true};
}
function normalizePoint(value={}) {
  const code=String(value.code||"").trim().toUpperCase();
  const name=String(value.name||"").trim();
  const cep=digit(value.cep);
  const city=String(value.city||"").trim();
  const state=String(value.state||"").trim().toUpperCase();
  const address=String(value.address||"").trim();
  const number=String(value.number||"").trim();
  if(!/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code))throw fail("Código da unidade inválido.");
  if(name.length<3||name.length>100)throw fail("Nome da unidade deve conter 3 a 100 caracteres.");
  if(cep.length!==8)throw fail("CEP da unidade deve conter 8 dígitos.");
  if(city.length<2||city.length>100||!/^[A-Z]{2}$/.test(state))throw fail("Informe cidade e UF da unidade.");
  if(address.length<3||address.length>160||number.length>20)throw fail("Informe endereço e número válidos.");
  return {code,name,cep,city,state,address,number,active:value.active!==false};
}
function normalizeBrand(value={}) {
  const name=String(value.name||"").trim();
  const logoUrl=String(value.logoUrl||"").trim();
  const primary=String(value.primary||"").trim();
  const secondary=String(value.secondary||"").trim();
  if(name.length<3||name.length>90)throw fail("Nome comercial deve ter 3 a 90 caracteres.");
  if(!/^#[A-Fa-f0-9]{6}$/.test(primary)||!/^#[A-Fa-f0-9]{6}$/.test(secondary))
    throw fail("Cores devem utilizar o formato #RRGGBB.");
  if(logoUrl && (logoUrl.length>500 || !/^https:\/\/[^\s/@]+(?:\/[^\s]*)?$/i.test(logoUrl)))
    throw fail("Informe URL de logomarca HTTPS válida, sem credenciais.");
  return {name,logoUrl,primary,secondary};
}
function publicBrand(carrier){
  return {code:carrier.code,name:carrier.brand_name,
    logoUrl:carrier.logo_url||"",primary:carrier.brand_primary||"#d7083b",
    secondary:carrier.brand_secondary||"#222638",
    baseCity:carrier.base_city,baseState:carrier.base_state,
    homologation:true,shippingEnabled:false,paymentEnabled:false};
}
module.exports={normalizeTariff,validateQuote,pricedTariff,publicBrand,normalizeBrand,normalizePoint};

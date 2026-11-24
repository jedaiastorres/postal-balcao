"use strict";

const { validateQuote } = require("./white_label_tenant");
const digits = value => String(value ?? "").replace(/\D/g, "");
const bad = message => Object.assign(new Error(message), {status:400});
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Serviço integrado exige medidas reais: jamais estimar peso/dimensões nem
// fabricar tarifa quando a API logística não estiver disponível.
function validateHybridQuote(input = {}) {
  const base = validateQuote(input);
  const dimensions = ["length", "width", "height"].map(key => Number(input[key]));
  if (dimensions.some(value => !Number.isInteger(value) || value < 1 || value > 100) ||
      dimensions.reduce((total, value) => total + value, 0) > 200) {
    throw bad("Informe comprimento, largura e altura entre 1 e 100 cm, com soma máxima de 200 cm.");
  }
  const declaredValue = input.declaredValue == null || input.declaredValue === ""
    ? 0 : Number(input.declaredValue);
  if (!Number.isFinite(declaredValue) || declaredValue < 0 || declaredValue > 50000)
    throw bad("Valor declarado deve estar entre R$ 0,00 e R$ 50.000,00.");
  return {...base, length:dimensions[0], width:dimensions[1], height:dimensions[2],
    declaredValue:round(declaredValue)};
}
function neutralName(value, fallback) {
  const name = String(value || "").trim()
    .replace(/conect\s*envios/ig, "rede logística")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 90);
  return name || fallback;
}
function sanitizeIntegratedOptions(normalizedOptions) {
  if (!Array.isArray(normalizedOptions)) return [];
  return normalizedOptions
    .filter(option => Number.isFinite(Number(option.precoVenda)) && Number(option.precoVenda) > 0)
    .slice(0, 20)
    .map((option, index) => ({
      id:"REDE-"+String(index + 1).padStart(2,"0"),
      source:"INTEGRATED",
      carrier:neutralName(option.transportadora, "Transportadora parceira"),
      name:neutralName(option.produto, "Serviço de transporte"),
      total:round(option.precoVenda),
      days:Number.isFinite(Number(option.prazoEntrega)) && Number(option.prazoEntrega) > 0
        ? Math.round(Number(option.prazoEntrega)) : null,
      partnerShare:round(Math.max(0,Number(option.comissaoParceiro||0))),
      estimated:true
    }));
}
function mergeHybridOptions(own, integrated, brand, master) {
  const ownOptions=(Array.isArray(own)?own:[]).map(option => {
    const result={
      id:option.id,source:"OWN",carrier:brand.name,
      name:option.name,total:Number(option.total),days:option.days,estimated:true
    };
    if (master) {
      result.partnerShare=Number(option.partnerShare);
      result.postalShare=Number(option.postalShare);
    }
    return result;
  });
  const integratedOptions=(Array.isArray(integrated)?integrated:[]).map(option=>{
    const result={id:option.id,source:"INTEGRATED",carrier:option.carrier,
      name:option.name,total:option.total,days:option.days,estimated:true};
    if(master)result.partnerShare=option.partnerShare;
    return result;
  });
  return [...ownOptions,...integratedOptions].sort((a,b)=>a.total-b.total).slice(0,40);
}
module.exports={validateHybridQuote,sanitizeIntegratedOptions,mergeHybridOptions};

"use strict";
const {validDocument}=require("./shipment_corrections");
const digits=value=>String(value??"").replace(/\D/g,"");
const bad=(message)=>Object.assign(new Error(message),{status:400});
function normalizeWhiteLabelCarrier(input){
  const data=input&&typeof input==="object"&&!Array.isArray(input)?input:{};
  const code=String(data.code||"").trim().toUpperCase();
  const brandName=String(data.brandName||"").trim();
  const legalName=String(data.legalName||"").trim();
  const cnpj=digits(data.cnpj);
  const adminName=String(data.adminName||"").trim();
  const adminEmail=String(data.adminEmail||"").trim().toLowerCase();
  const adminPhone=digits(data.adminPhone);
  const baseCity=String(data.baseCity||"").trim();
  const baseState=String(data.baseState||"").trim().toUpperCase();
  const asaasWalletId=String(data.asaasWalletId||"").trim();
  const postalFeePercent=Number(data.postalFeePercent??0);
  const postalFeeFixed=Number(data.postalFeeFixed??0);
  const integratedCommissionPercent=Number(data.integratedCommissionPercent??0);
  const logoUrl=String(data.logoUrl||"").trim();
  const brandPrimary=String(data.brandPrimary||"#d7083b").trim();
  const brandSecondary=String(data.brandSecondary||"#222638").trim();
  const notes=String(data.notes||"").trim();
  if(!/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code))throw bad("Código White Label: utilize 3 a 30 letras, números, hífen ou sublinhado.");
  if(brandName.length<3||brandName.length>90)throw bad("Informe a marca comercial (3 a 90 caracteres).");
  if(legalName.length>130)throw bad("Razão social muito longa.");
  if(cnpj.length!==14||!validDocument(cnpj))throw bad("CNPJ inválido. Confira os 14 dígitos.");
  if(adminName.length<2||adminName.length>100)throw bad("Informe o responsável pela transportadora.");
  if(adminEmail.length>160||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))throw bad("E-mail do responsável inválido.");
  if(![10,11].includes(adminPhone.length))throw bad("Informe telefone com DDD (10 ou 11 dígitos).");
  if(baseCity.length<2||baseCity.length>100||!/^[A-Z]{2}$/.test(baseState))throw bad("Informe cidade-base e UF válidas.");
  if(asaasWalletId&&!/^[A-Za-z0-9_-]{4,128}$/.test(asaasWalletId))throw bad("Identificador da carteira Asaas inválido.");
  if(!Number.isFinite(postalFeePercent)||postalFeePercent<0||postalFeePercent>50||
     !Number.isFinite(postalFeeFixed)||postalFeeFixed<0||postalFeeFixed>10000)throw bad("Taxa Postal fora do intervalo permitido.");
  if(!Number.isFinite(integratedCommissionPercent)||integratedCommissionPercent<0||integratedCommissionPercent>40)throw bad("Comissão integrada deve estar entre 0% e 40%.");
  if(Math.round(postalFeePercent*100)===0&&Math.round(postalFeeFixed*100)===0)throw bad("Configure uma taxa Postal maior que zero (percentual ou valor fixo).");
  if(!/^(#[0-9a-fA-F]{6})$/.test(brandPrimary)||!/^(#[0-9a-fA-F]{6})$/.test(brandSecondary))throw bad("As cores devem ser códigos hexadecimais.");
  if(logoUrl&&(!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(logoUrl)||logoUrl.length>500))throw bad("A logomarca precisa ter uma URL HTTPS válida.");
  if(notes.length>1000)throw bad("Observações excedem mil caracteres.");
  return {code,brandName,legalName,cnpj,adminName,adminEmail,adminPhone,baseCity,baseState,
    asaasWalletId,postalFeePercent:Math.round(postalFeePercent*100)/100,
    postalFeeFixed:Math.round(postalFeeFixed*100)/100,
    integratedCommissionPercent:Math.round(integratedCommissionPercent*100)/100,
    logoUrl,brandPrimary,brandSecondary,notes};
}
function whiteLabelCarrierDTO(row){
  return {
    id:row.id,code:row.code,brandName:row.brand_name,legalName:row.legal_name||"",
    cnpj:row.cnpj,adminName:row.admin_name,adminEmail:row.admin_email,
    adminPhone:row.admin_phone,baseCity:row.base_city,baseState:row.base_state,
    asaasWalletId:row.asaas_wallet_id||"",
    postalFeePercent:Number(row.postal_fee_percent||0),
    postalFeeFixed:Number(row.postal_fee_fixed||0),
    integratedCommissionPercent:Number(row.integrated_commission_percent||0),
    logoUrl:row.logo_url||"",brandPrimary:row.brand_primary||"#d7083b",
    brandSecondary:row.brand_secondary||"#222638",notes:row.notes||"",
    status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,
    operationalEnabled:false
  };
}
module.exports={normalizeWhiteLabelCarrier,whiteLabelCarrierDTO};

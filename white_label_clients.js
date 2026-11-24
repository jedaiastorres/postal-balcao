"use strict";
const digit=value=>String(value??"").replace(/\D/g,"");
const err=message=>Object.assign(new Error(message),{status:400});
const round=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
function percent(value,field="Comissão"){
  const x=Number(value);
  if(!Number.isFinite(x)||x<0||x>100)throw err(field+" deve estar entre 0% e 100%.");
  return round(x);
}
function normalizeClient(raw={}){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw err("Cadastro inválido.");
  const name=String(raw.name||"").trim();
  const document=digit(raw.document);
  const phone=digit(raw.phone);
  const email=String(raw.email||"").trim().toLowerCase();
  const street=String(raw.street||"").trim(),number=String(raw.number||"").trim();
  const neighborhood=String(raw.neighborhood||"").trim();
  const city=String(raw.city||"").trim(),state=String(raw.state||"").trim().toUpperCase();
  const cep=digit(raw.cep);
  const notes=String(raw.notes||"").trim();
  const pointId=raw.pointId==null||raw.pointId===""?null:String(raw.pointId);
  const pointOverride=raw.pointCommissionOverride==null||raw.pointCommissionOverride===""
    ?null:percent(raw.pointCommissionOverride,"Comissão especial do ponto");
  if(name.length<2||name.length>160)throw err("Informe nome ou razão social (2 a 160 caracteres).");
  if(document&&![11,14].includes(document.length))throw err("CPF/CNPJ deve ter 11 ou 14 dígitos.");
  if(phone&&![10,11].includes(phone.length))throw err("Telefone deve ter DDD.");
  if(email&&(email.length>160||!/^\S+@\S+\.\S+$/.test(email)))throw err("E-mail inválido.");
  if(pointId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pointId))
    throw err("Unidade inválida.");
  if(pointOverride!==null&&!pointId)throw err("Vincule o cliente a um ponto para configurar comissão especial.");
  if(street.length>160||number.length>20||neighborhood.length>100||city.length>100||
     (cep&&cep.length!==8)||(state&&!/^[A-Z]{2}$/.test(state))||notes.length>1000)
    throw err("Endereço ou observações inválidos.");
  return {name,document,phone,email,pointId,pointCommissionOverride:pointOverride,
    street,number,neighborhood,city,state,cep,notes,active:raw.active!==false};
}
function publicClient(row,master){
  const obj={id:row.id,name:row.name,document:row.document||"",phone:row.phone||"",
    email:row.email||"",pointId:row.point_id||null,pointName:row.point_name||"",
    street:row.street||"",number:row.number||"",neighborhood:row.neighborhood||"",
    city:row.city||"",state:row.state||"",cep:row.cep||"",
    notes:row.notes||"",active:row.active!==false};
  if(master){
    obj.pointCommissionOverride=row.point_commission_override==null?null:Number(row.point_commission_override);
    obj.pointCommissionDefault=Number(row.point_commission_percent||0);
  }
  return obj;
}
// A comissão do ponto incide somente sobre a PARCELA já atribuída ao White Label.
// O saldo da Postal e o custo de terceiros não sofrem desconto adicional.
function allocateCommission(option,pointPercent,master){
  const partner=Number(option.partnerShare);
  const price=Number(option.total);
  if(!Number.isFinite(partner)||partner<0||!Number.isFinite(price)||price<partner)throw err("Cotação sem parcela comercial válida.");
  const rate=percent(pointPercent,"Comissão do ponto");
  const point=round(Math.min(partner,round(partner*rate/100)));
  const masterAmount=round(partner-point);
  const base={...option};
  delete base.partnerShare;
  delete base.postalShare;
  if(master){
    base.pointShare=point;
    base.masterShare=masterAmount;
    base.whiteLabelShare=round(partner);
    base.postalShare=option.source==="OWN"?Number(option.postalShare):null;
    base.pointCommissionPercent=rate;
  }
  return base;
}
module.exports={normalizeClient,publicClient,allocateCommission,percent};

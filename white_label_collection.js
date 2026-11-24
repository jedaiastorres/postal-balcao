"use strict";

const digit=value=>String(value??"").replace(/\D/g,"");
const text=(value,max=200)=>String(value??"").trim().slice(0,max+1);
const fail=message=>Object.assign(new Error(message),{status:400});
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||""));
const transitions=Object.freeze({
  REQUESTED:Object.freeze(["CANCELED"]),
  ASSIGNED:Object.freeze(["IN_ROUTE","COLLECTED","CANCELED"]),
  IN_ROUTE:Object.freeze(["COLLECTED","CANCELED"]),
  COLLECTED:Object.freeze([]),
  CANCELED:Object.freeze([])
});
function normalizeCollection(input={}){
  if(!input||typeof input!=="object"||Array.isArray(input))throw fail("Solicitação de coleta inválida.");
  const requesterName=text(input.requesterName,160);
  const requesterPhone=digit(input.requesterPhone);
  const requesterDocument=digit(input.requesterDocument);
  const packageCount=Number(input.packageCount);
  const address=input.address&&typeof input.address==="object"&&!Array.isArray(input.address)?input.address:{};
  const street=text(address.street,160),number=text(address.number,20);
  const complement=text(address.complement,100),neighborhood=text(address.neighborhood,100);
  const cep=digit(address.cep),city=text(address.city,100),state=text(address.state,2).toUpperCase();
  const notes=text(input.notes,1000);
  const key=String(input.requestKey||"").trim();
  const pointId=input.pointId===null||input.pointId===""||input.pointId===undefined?null:String(input.pointId);
  if(!uuid(key))throw fail("Identificador da solicitação inválido. Atualize a página.");
  if(pointId&&!uuid(pointId))throw fail("Unidade de coleta inválida.");
  if(requesterName.length<2||requesterName.length>160)throw fail("Informe o nome do cliente (2 a 160 caracteres).");
  if(![10,11].includes(requesterPhone.length))throw fail("Telefone do cliente deve conter DDD e 10 ou 11 dígitos.");
  if(requesterDocument&&![11,14].includes(requesterDocument.length))throw fail("CPF/CNPJ deve conter 11 ou 14 dígitos.");
  if(!Number.isInteger(packageCount)||packageCount<1||packageCount>200)throw fail("Quantidade de pacotes deve ser de 1 a 200.");
  if(street.length<3||street.length>160||!number||number.length>20||cep.length!==8||
     city.length<2||city.length>100||!(/^[A-Z]{2}$/).test(state)||
     complement.length>100||neighborhood.length>100)
    throw fail("Informe endereço completo com rua, número, CEP, cidade e UF.");
  if(notes.length>1000)throw fail("Observações podem conter no máximo 1.000 caracteres.");
  let scheduledFor=null;
  if(input.scheduledFor){
    const date=new Date(input.scheduledFor);
    if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now()||
       date.getTime()>Date.now()+90*86400000)throw fail("Agendamento deve ser futuro, no máximo em 90 dias.");
    scheduledFor=date.toISOString();
  }
  return {requestKey:key,pointId,requesterName,requesterPhone,requesterDocument,packageCount,
    address:{street,number,complement,neighborhood,cep,city,state},scheduledFor,notes};
}
function allowedPrior(next,role){
  const nextStatus=String(next||"").toUpperCase();
  if(!["WL_MASTER","WL_OPERATOR"].includes(role))throw fail("Perfil sem permissão para coletas.");
  if(!["IN_ROUTE","COLLECTED","CANCELED"].includes(nextStatus))throw fail("Situação de coleta inválida.");
  if(nextStatus==="CANCELED"&&role!=="WL_MASTER")throw Object.assign(new Error("Somente o MASTER pode cancelar coletas."),{status:403});
  return Object.keys(transitions).filter(current=>transitions[current].includes(nextStatus));
}
function publicCollection(row){
  return {id:row.id,pointId:row.point_id||null,
    requesterName:row.requester_name,requesterPhone:row.requester_phone,
    requesterDocument:row.requester_document||"",
    packageCount:Number(row.package_count),address:row.address||{},
    scheduledFor:row.scheduled_for||null,notes:row.notes||"",driverName:row.driver_name||"",
    status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,
    paymentStatus:"NOT_LINKED",financialAmount:null};
}
module.exports={normalizeCollection,allowedPrior,publicCollection,uuid,transitions};

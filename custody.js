"use strict";

const stages = Object.freeze({
  RECEIVED_POINT: { label:"Recebido no ponto", next:["TRANSFERRED","OUT_FOR_DELIVERY"] },
  TRANSFERRED: { label:"Em transferência", next:["RECEIVED_HUB","OUT_FOR_DELIVERY"] },
  RECEIVED_HUB: { label:"Recebido no hub", next:["OUT_FOR_DELIVERY"] },
  OUT_FOR_DELIVERY: { label:"Saiu para entrega", next:["DELIVERY_RECORDED"] },
  DELIVERY_RECORDED: { label:"Entrega registrada internamente", next:[] }
});

function validateScan({code,stage,idempotencyKey,recipientName},previous=null){
  const trackingCode=String(code||"").trim();
  if(!/^[A-Za-z0-9]{6,40}$/.test(trackingCode))throw Object.assign(new Error("Código de rastreio inválido."),{status:400});
  if(!Object.hasOwn(stages,stage))throw Object.assign(new Error("Etapa operacional inválida."),{status:400});
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(String(idempotencyKey||"")))throw Object.assign(new Error("Identificador da leitura inválido."),{status:400});
  if(previous===null && stage!=="RECEIVED_POINT")throw Object.assign(new Error("Registre primeiro o recebimento no ponto."),{status:409});
  if(previous!==null && !stages[previous]?.next.includes(stage))throw Object.assign(new Error("Etapa fora da sequência operacional ou já registrada."),{status:409});
  const proofName=String(recipientName||"").trim().slice(0,120);
  if(stage==="DELIVERY_RECORDED" && proofName.length<3)throw Object.assign(new Error("Informe o nome de quem recebeu para registrar a entrega interna."),{status:400});
  return {trackingCode,stage,idempotencyKey,proofName};
}

module.exports={stages,validateScan};

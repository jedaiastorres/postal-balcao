"use strict";

const stages = Object.freeze({
  RECEIVED_POINT: { label:"Recebido no ponto", next:["TRANSFERRED","OUT_FOR_DELIVERY"] },
  TRANSFERRED: { label:"Em transferência", next:["RECEIVED_HUB"] },
  RECEIVED_HUB: { label:"Recebido na unidade de destino", next:["TRANSFERRED","OUT_FOR_DELIVERY"] },
  OUT_FOR_DELIVERY: { label:"Saiu para entrega", next:["DELIVERY_RECORDED"] },
  DELIVERY_RECORDED: { label:"Entrega registrada internamente", next:[] }
});

function validateScan({code,stage,idempotencyKey,recipientName,latitude,longitude,photo},previous=null){
  const trackingCode=String(code||"").trim();
  if(!/^[A-Za-z0-9]{6,40}$/.test(trackingCode))throw Object.assign(new Error("Código de rastreio inválido."),{status:400});
  if(!Object.hasOwn(stages,stage))throw Object.assign(new Error("Etapa operacional inválida."),{status:400});
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(String(idempotencyKey||"")))throw Object.assign(new Error("Identificador da leitura inválido."),{status:400});
  if(previous===null && stage!=="RECEIVED_POINT")throw Object.assign(new Error("Registre primeiro o recebimento no ponto."),{status:409});
  if(previous!==null && !stages[previous]?.next.includes(stage))throw Object.assign(new Error("Etapa fora da sequência operacional ou já registrada."),{status:409});
  const proofName=String(recipientName||"").trim().slice(0,120);
  if(stage==="DELIVERY_RECORDED" && proofName.length<3)throw Object.assign(new Error("Informe o nome de quem recebeu para registrar a entrega interna."),{status:400});
  const hasGeo=latitude!=null||longitude!=null;
  const lat=latitude==null?null:Number(latitude),lng=longitude==null?null:Number(longitude);
  if(hasGeo&&(lat===null||lng===null||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180))
    throw Object.assign(new Error("Coordenadas da entrega inválidas."),{status:400});
  const picture=String(photo||"");
  if(picture && (stage!=="DELIVERY_RECORDED"||picture.length>200000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(picture)))
    throw Object.assign(new Error("Foto inválida. Use uma imagem JPG com até 150 KB."),{status:400});
  return {trackingCode,stage,idempotencyKey,proofName,latitude:lat,longitude:lng,photo:picture};
}

module.exports={stages,validateScan};

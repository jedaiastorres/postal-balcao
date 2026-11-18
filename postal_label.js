"use strict";

const {PDFDocument,StandardFonts,rgb} = require("pdf-lib");
const QRCode = require("qrcode");

async function generate(order,volume) {
  const code=String(volume.trackingCode||volume.tracking_code||order.tracking_code||"");
  if(!/^[A-Z0-9]{6,40}$/.test(code))throw new Error("Rastreio próprio inválido para impressão.");
  const pdf=await PDFDocument.create();
  const page=pdf.addPage([283.46,425.2]); // A6
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const put=(text,x,y,size=9,isBold=false,color=rgb(0.12,0.12,0.12))=>page.drawText(String(text||"").slice(0,48),{
    x,y,size,font:isBold?bold:font,color
  });
  page.drawRectangle({x:0,y:400,width:283.46,height:25,color:rgb(0.73,0.05,0.14)});
  put("POSTAL SERVIÇOS  |  REGIONAL",15,409,11,true,rgb(1,1,1));
  put("CÓDIGO DE RASTREIO",15,385,8,true);
  put(code,15,369,11,true);
  const image=await pdf.embedPng(await QRCode.toBuffer(code,{type:"png",width:240,margin:1,errorCorrectionLevel:"M"}));
  page.drawImage(image,{x:180,y:283,width:85,height:85});
  const sender=order.sender||{},recipient=order.recipient||{};
  put("REMETENTE",15,342,9,true);
  put(sender.name,15,328,9);
  put(`${sender.city||""} · ${sender.cep||""}`,15,313,8);
  put("DESTINATÁRIO",15,279,9,true);
  put(recipient.name,15,265,9);
  put(`${recipient.address||""}, ${recipient.number||""}`,15,249,8);
  put(recipient.neighborhood,15,235,8);
  put(`${recipient.city||""} · ${recipient.cep||""}`,15,221,8);
  put("TRECHO OPERACIONAL",15,188,8,true);
  const route=order.package_data?.ownRoute||{};
  put(`${route.originCity||""} - ${route.destinationCity||""}`,15,172,8);
  put(`Volume ${volume.index||1}/${Math.max(1,Number(order.package_count||1))}`,15,146,9,true);
  put("Leia o QR Code para registrar movimentações.",15,108,7);
  put(`Pedido ${String(order.id||"").slice(0,18).toUpperCase()}`,15,79,8);
  put("Etiqueta da rede própria Postal Serviços",15,52,7);
  return Buffer.from(await pdf.save());
}

module.exports={generate};

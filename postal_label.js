"use strict";

const {PDFDocument,StandardFonts,rgb} = require("pdf-lib");
const QRCode = require("qrcode");
const fs = require("node:fs");
const path = require("node:path");
const code39 = require("./code39");

// Usa os vetores da marca oficial que já é exibida no Portal Postal.
const logoSvg = fs.readFileSync(path.join(__dirname,"public/assets/brands/postal.svg"),"utf8");
const logoColors = {fil1:rgb(0.855,0.047,0.231),fil2:rgb(0.718,0.106,0.094),fil3:rgb(0.918,0.404,0.165),fil4:rgb(0.004,0.004,0.004)};
const logoPaths = [...logoSvg.matchAll(/<path class="(fil\d+)" d="([^"]+)"\s*\/>/g)];

function drawPostalLogo(page) {
  for(const [,style,svgPath] of logoPaths){
    if(!logoColors[style]) continue;
    page.drawSvgPath(svgPath,{x:12,y:407,scale:0.66,color:logoColors[style]});
  }
}

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
  page.drawRectangle({x:0,y:417,width:283.46,height:8,color:rgb(0.73,0.05,0.14)});
  drawPostalLogo(page);
  put("POSTAL REGIONAL",119,385,12,true);
  put("ETIQUETA DE ENVIO",119,369,8,true);
  page.drawLine({start:{x:15,y:339},end:{x:268,y:339},thickness:0.8,color:rgb(0.73,0.05,0.14)});
  put("CÓDIGO DE RASTREIO",15,325,8,true);
  put(code,15,310,10,true);
  const image=await pdf.embedPng(await QRCode.toBuffer(code,{type:"png",width:240,margin:1,errorCorrectionLevel:"M"}));
  page.drawImage(image,{x:189,y:240,width:78,height:78});
  const sender=order.sender||{},recipient=order.recipient||{};
  put("REMETENTE",15,288,9,true);
  put(sender.name,15,274,9);
  put(`${sender.city||""} · ${sender.cep||""}`,15,260,8);
  put("DESTINATÁRIO",15,232,9,true);
  put(recipient.name,15,218,9);
  put(`${recipient.address||""}, ${recipient.number||""}`,15,204,8);
  put(recipient.neighborhood,15,190,8);
  put(`${recipient.city||""} · ${recipient.cep||""}`,15,176,8);
  put("TRECHO OPERACIONAL",15,151,8,true);
  const route=order.package_data?.ownRoute||{};
  put(`${route.originCity||""} - ${route.destinationCity||""}`,15,138,8);
  put(`Volume ${volume.index||1}/${Math.max(1,Number(order.package_count||1))}`,15,121,9,true);
  // Mesmo código no QR e no padrão Code 39, com margem livre para leitores laser.
  code39.draw(page,code,{x:19,y:67,width:245,height:45});
  put(code,62,54,9,true);
  put(`Pedido ${String(order.id||"").slice(0,18).toUpperCase()}`,15,36,8);
  put("Postal Serviços • Leitura QR ou código de barras",15,20,7);
  return Buffer.from(await pdf.save());
}

module.exports={generate};

"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const app=fs.readFileSync(require.resolve("../public/app"),"utf8");
const server=fs.readFileSync(require.resolve("../server"),"utf8");

test("Meus Fretes sempre abre rastreio da Postal, nunca link externo salvo no pedido",()=>{
  const index=app.indexOf('trackBtn.textContent="Rastrear"');
  assert.notEqual(index,-1);
  const snippet=app.slice(index,index+360);
  assert.match(snippet,/window\.open\(postalTrackingPath\(order\.trackingCode\)/);
  assert.doesNotMatch(snippet,/order\.publicTrackingUrl/);
});
test("comprovante gera URL da Postal pelo código, ignorando URL armazenada",()=>{
  const start=app.indexOf("function receiptPayloadFromOrder(order)");
  const end=app.indexOf("function ",start+30);
  const snippet=app.slice(start,end===-1?start+3000:end);
  assert.match(snippet,/publicTrackingUrl: postalTrackingPath\(order\.trackingCode/);
  assert.doesNotMatch(snippet,/publicTrackingUrl: order\.publicTrackingUrl/);
});
test("servidor normaliza URLs para pedidos antigos e volumes",()=>{
  assert.match(server,/publicTrackingUrl: order\.tracking_code \? "\/rastreio\?codigo="/);
  assert.match(server,/publicTrackingUrl:\(v\.trackingCode \|\| v\.tracking_code\) \? "\/rastreio\?codigo="/);
  const dto=server.slice(server.indexOf("function publicOrder(order)"),server.indexOf("function publicOrderForUser"));
  assert.doesNotMatch(dto,/publicTrackingUrl: order\.public_tracking_url/);
});
test("interface mantém endereço local em qualquer domínio e não permite rastreio arbitrário",()=>{
  const match=app.match(/function postalTrackingPath\(trackingCode\) \{([\s\S]*?)\n\}/);
  assert.ok(match);
  const context={};
  vm.runInNewContext(match[0]+"\nthis.getPath=postalTrackingPath;",context);
  assert.equal(context.getPath("QX7RAIED"),"/rastreio?codigo=QX7RAIED");
  assert.equal(context.getPath(""),"/rastreio");
  assert.equal(context.getPath("https://external.example/"),"/rastreio");
  new vm.Script(app);
  new vm.Script(server);
});

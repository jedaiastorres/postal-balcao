"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const html=fs.readFileSync(require.resolve("../public/index.html"),"utf8");
const app=fs.readFileSync(require.resolve("../public/app.js"),"utf8");
const server=fs.readFileSync(require.resolve("../server.js"),"utf8");

test("cadastro White Label fica dentro da tela MASTER e não na carteira de clientes",()=>{
  const wallet=html.slice(html.indexOf('<section id="walletView"'),html.indexOf('<section id="masterView"'));
  const master=html.slice(html.indexOf('<section id="masterView"'),html.indexOf('<section id="inventoryView"'));
  assert.ok(!wallet.includes('id="whiteLabelSection"'),"White Label não deve ficar na carteira do cliente");
  assert.ok(master.includes('id="whiteLabelSection"'),"White Label deve ser renderizado no MASTER");
  assert.equal((html.match(/id="whiteLabelSection"/g)||[]).length,1);
  for(const id of ["whiteLabelForm","whiteLabelsList","refreshWhiteLabelsBtn","wlBrandName"])assert.ok(master.includes('id="'+id+'"'));
});

test("menu White Label é exclusivo do MASTER com navegação funcional",()=>{
  assert.match(html, /class="nav-item master-only hidden" data-view="whiteLabel"/);
  assert.match(app, /whiteLabel: \{ el: "#masterView", title: "Transportadoras White Label" \}/);
  assert.match(app, /\["master","whiteLabel"\]\.includes\(name\) && state\.user\?\.role !== "ADMIN"/);
  assert.match(app, /\["master","whiteLabel"\]\.includes\(name\) && state\.user\?\.role === "ADMIN"\) loadMaster\(\)/);
  assert.match(app, /name === "whiteLabel"[\s\S]*?whiteLabelSection/);
  assert.match(app, /params\.get\("view"\)==="whiteLabel"/);
  assert.match(app, /void loadWhiteLabels\(\)/);
});
test("servidor só permite leitura e cadastro de transportadoras ao ADMIN",()=>{
  assert.match(server,/app\.get\("\/api\/admin\/white-label-carriers",requireAuth,requireRole\("ADMIN"\)/);
  assert.match(server,/app\.post\("\/api\/admin\/white-label-carriers",requireAuth,requireRole\("ADMIN"\)/);
});

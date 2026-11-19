"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { summarizeCustody, custodyCsv } = require("../operational_metrics");

const now = Date.parse("2026-11-18T15:00:00.000Z");
const base = { created_at:"2026-11-17T00:00:00.000Z", store_name:"Parauapebas",carrier:"Loggi" };

test("indicadores de custódia contabilizam volumes distintos e não confundem ausência de leitura com atraso",()=>{
  const data=summarizeCustody([
    {...base,id:"not-scanned",package_count:2,scanned_codes:0,delivered_codes:0},
    {...base,id:"stale",tracking_code:"AA00001",package_count:1,scanned_codes:1,delivered_codes:0,last_scan_at:"2026-11-17T13:00:00.000Z"},
    {...base,id:"complete",package_count:2,scanned_codes:2,delivered_codes:2,last_scan_at:"2026-11-15T00:00:00.000Z"},
    {...base,id:"active",package_count:1,scanned_codes:1,delivered_codes:0,last_scan_at:"2026-11-18T13:00:00.000Z"}
  ],{now,inactivityHours:24});
  assert.equal(data.summary.shipments,4);
  assert.equal(data.summary.packages,6);
  assert.equal(data.summary.scannedPackages,4);
  assert.equal(data.summary.deliveredInternally,2);
  assert.equal(data.summary.scanCoveragePercent,66.7);
  assert.equal(data.summary.noFirstScan,1);
  assert.equal(data.summary.inactiveShipments,1);
  assert.deepEqual(data.attention.map(x=>x.id),["stale","not-scanned"]);
  assert.equal(data.items.find(x=>x.id==="complete").attention,"CONCLUIDO_INTERNO");
});

test("relatório CSV protege contra fórmulas e contém apenas colunas operacionais",()=>{
  const data=summarizeCustody([{...base,id:"id",tracking_code:"=SUM(A1:A2)",store_name:'Ponto "Central"',package_count:1,scanned_codes:0}],{now});
  const csv=custodyCsv(data.items);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv,/"'=SUM\(A1:A2\)"/);
  assert.match(csv,/"Ponto ""Central"""/);
  assert.doesNotMatch(csv,/CPF|CNPJ|Endereço completo|Valor declarado/);
});

test("API e painel de operações restringem acesso e explicitam a diferença para SLA de transportadora",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const page=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
  const client=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
  assert.match(server,/app\.get\("\/api\/analytics\/custody",requireAuth,requireRole\("ADMIN","SUPERVISOR","STORE_OWNER"\)/);
  assert.match(server,/app\.get\("\/api\/analytics\/custody\.csv",requireAuth,requireRole\("ADMIN","SUPERVISOR","STORE_OWNER"\)/);
  assert.match(server,/const storeId=reportStoreForUser\(req\.user,req\.query\.storeId\)/);
  assert.match(page,/o SLA contratual exige eventos de entrega confirmados/);
  assert.match(client,/\/api\/analytics\/custody\?/);
});

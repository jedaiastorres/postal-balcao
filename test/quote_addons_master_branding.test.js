const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = name => fs.readFileSync(require.resolve("../"+name), "utf8");
const app = read("public/app.js");
const html = read("public/index.html");
const server = read("server.js");
const db = read("db.js");
const tracking = read("public/rastreio.html");
const trackingJs = read("public/rastreio.js");

test("caixas, envelopes e serviço são oferecidos na própria cotação", () => {
  assert.match(html, /id="quoteExtrasPanel"/);
  assert.match(html, /id="quoteAddonsCatalog"/);
  assert.match(html, /id="quoteAddonsTotal"/);
  assert.match(app, /if \(name === "quote"\)[\s\S]*?loadShipmentCatalog\(\)/);
  assert.match(app, /selectedAddonsAmount\(\)/);
  assert.match(app, /Number\(option.precoVenda\|\|0\)\+selectedAddonsAmount\(\)/);
  assert.match(app, /addons: selectedAddonPayload\(\)/);
  assert.doesNotMatch(app, /state\.selectedAddons = new Map\(\);[\s\S]{0,400}loadShipmentCatalog\(\)/);
});
test("catálogo MASTER é fonte de preços e custos; ponto só recebe quantidades", () => {
  assert.match(html, /id="adminCatalogCost"/);
  assert.match(html, /id="adminCatalogActive"/);
  assert.doesNotMatch(html, /id="inventoryUnitCost"|id="inventorySalePrice"/);
  assert.match(server, /costPrice=Number\(body\.costPrice \?\? 0\)/);
  assert.match(server, /Object\.hasOwn\(req\.body \|\| \{\}, "unitCost"\)/);
  assert.match(server, /Number\(item\.cost_price \|\| 0\)/);
  assert.match(db, /c\.unit_price AS effective_unit_price/);
  assert.doesNotMatch(db, /COALESCE\(i\.sale_price,c\.unit_price\) AS effective_unit_price/);
});
test("itens modelo dependem de preço e ativação explícita pelo MASTER", () => {
  assert.match(db, /'SERVICO_MANUSEIO','SERVICE'/);
  assert.match(db, /'ENVELOPE_BOLHA','PRODUCT'/);
  assert.match(db, /ON CONFLICT \(code\) DO NOTHING/);
  assert.match(app, /Number\(item.unitPrice\|\|0\)>0/);
});
test("rastreamento restaura identidade postal e permite copiar código", () => {
  assert.match(tracking, /RASTREIO OFICIAL POSTAL SERVIÇOS/);
  assert.match(tracking, /id="copyTrackingBtn"/);
  assert.match(trackingJs, /navigator\.clipboard\.writeText\(code\)/);
  new vm.Script(trackingJs);
  new vm.Script(app);
  new vm.Script(server);
});
test("nome do integrador não aparece em telas do usuário", () => {
  for (const file of ["public/index.html","public/app.js","public/rastreio.html","public/rastreio.js","shipment_corrections.js"]) {
    assert.doesNotMatch(read(file), /conect\s*envios/i, file);
  }
});

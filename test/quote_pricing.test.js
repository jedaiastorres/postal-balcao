"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pointCommissionRate, sellPriceFromCost } = require("../quote_pricing");
const { publicQuoteResponse } = require("../public_quote");

test("a cotação pública e a do balcão usam a mesma tabela do ponto e a mesma transferência", () => {
  const postalMargin = 0.12;
  for (const commissionPercent of [0, 10, 20, 35, 50]) {
    const store = { commission_percent: commissionPercent };
    const publicRate = pointCommissionRate(store, 0.20);
    const counterRate = pointCommissionRate(store, 0.20);
    for (const hubTransferTotal of [0, 5, 10]) {
      const publicPrice = sellPriceFromCost(32.85, publicRate, postalMargin).salePrice;
      const counterPrice = sellPriceFromCost(32.85, counterRate, postalMargin).salePrice;
      const result = publicQuoteResponse([{
        transportadora: "Jadlog", produto: "Package", precoVenda: publicPrice, prazoEntrega: 4
      }], { volumes: [{ weightGrams: 1000 }], cepFrom: "68515000", cepTo: "01310100", hubTransferTotal });
      assert.equal(result.options[0].price, Math.round((counterPrice + hubTransferTotal) * 100) / 100);
    }
  }
});

test("a comissão padrão cobre origens sem ponto e zero por cento é uma comissão válida", () => {
  assert.equal(pointCommissionRate(null, 0.20), 0.20);
  assert.equal(pointCommissionRate({}, 0.20), 0.20);
  assert.equal(pointCommissionRate({ commission_percent: 0 }, 0.20), 0);
  assert.equal(pointCommissionRate({ commission_percent: 27.5 }, 0.20), 0.275);
  assert.equal(pointCommissionRate({ commission_percent: "invalid" }, 0.20), 0.20);
});

test("ambos os endpoints usam a mesma comissão e a cotação pública não a zera", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const publicHandler = server.split('app.post("/api/public/cotacao"')[1].split('// CSRF para mutações')[0];
  const privateHandler = server.split('app.post("/api/cotacao"')[1].split('app.')[0];
  assert.match(publicHandler, /pointCommissionRate\(origin\.store,PARTNER_COMMISSION\)/);
  assert.match(publicHandler, /normalizeQuote\(quoted\.data,partnerCommissionRate\)/);
  assert.match(privateHandler, /pointCommissionRate\(store,PARTNER_COMMISSION\)/);
  assert.match(privateHandler, /normalizeQuote\(providerData, partnerCommissionRate\)/);
  assert.doesNotMatch(publicHandler, /normalizeQuote\(quoted\.data,0\)/);
});

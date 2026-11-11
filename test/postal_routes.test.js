"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { quotePostalRoutes } = require("../postal_routes");

const route = {
  id: "parauapebas-maraba", active: true,
  origin: { city: "Parauapebas", uf: "PA" },
  destination: { city: "Marabá", uf: "PA" },
  maxWeightKg: 30, basePrice: 20, pricePerKg: 2, deadlineDays: 1
};
const input = {
  origin: { city: "PARAUAPEBAS", uf: "pa", cep: "68515-000" },
  destination: { city: "Maraba", uf: "PA", cep: "68500-000" },
  packages: [{ weightKg: 5 }, { weightKg: 2 }]
};
test("quotes only explicitly enabled eligible routes", () => {
  assert.deepEqual(quotePostalRoutes({ routes: [route], ...input }), [{
    routeId: "parauapebas-maraba", carrier: "Postal Serviços",
    service: "Transporte Postal", price: 34, deadlineDays: 1,
    weightKg: 7, integrationStatus: "AWAITING_SSW_INTEGRATION"
  }]);
});
test("no routes configured => no Postal quote", () => {
  assert.deepEqual(quotePostalRoutes({ ...input }), []);
});
test("inactive, wrong lane and excessive weight do not appear", () => {
  assert.deepEqual(quotePostalRoutes({ routes: [{...route, active: false}], ...input }), []);
  assert.deepEqual(quotePostalRoutes({ routes: [route], ...input, destination: {...input.destination, city: "Santarém"} }), []);
  assert.deepEqual(quotePostalRoutes({ routes: [route], ...input, packages: [{weightKg: 31}] }), []);
});
test("invalid package weight never creates an offer", () => {
  assert.deepEqual(quotePostalRoutes({ routes: [route], ...input, packages: [{weightKg: -1}] }), []);
});
test("optional CEP boundaries are enforced", () => {
  const bounded = {...route, origin: {...route.origin, cepStart: "68510000", cepEnd:"68519999"}};
  assert.equal(quotePostalRoutes({ routes:[bounded], ...input }).length, 1);
  assert.equal(quotePostalRoutes({ routes:[bounded], ...input, origin: {...input.origin,cep:"68000-000"} }).length, 0);
});

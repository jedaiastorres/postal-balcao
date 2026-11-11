"use strict";

/**
 * Motor de elegibilidade das rotas próprias Postal.
 * Sem chamadas externas ou efeito sobre o fluxo atual da ConectEnvios.
 * Uma rota só pode ser cotada quando for explicitamente cadastrada e ativada.
 */
function cepDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}
function normalizeCity(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().replace(/\s+/g, " ").toUpperCase();
}
function validateRoute(route) {
  if (!route || route.active !== true) return false;
  if (!route.origin || !route.destination) return false;
  if (!Number.isFinite(Number(route.maxWeightKg)) || Number(route.maxWeightKg) <= 0) return false;
  if (!Number.isFinite(Number(route.basePrice)) || Number(route.basePrice) < 0) return false;
  if (!Number.isInteger(Number(route.deadlineDays)) || Number(route.deadlineDays) < 0) return false;
  return true;
}
function matchEndpoint(endpoint, input) {
  if (normalizeCity(endpoint.city) !== normalizeCity(input.city)) return false;
  if (String(endpoint.uf ?? "").toUpperCase() !== String(input.uf ?? "").toUpperCase()) return false;
  const cep = cepDigits(input.cep);
  if (endpoint.cepStart != null || endpoint.cepEnd != null) {
    const start = cepDigits(endpoint.cepStart);
    const end = cepDigits(endpoint.cepEnd);
    if (start.length !== 8 || end.length !== 8 || cep.length !== 8 || cep < start || cep > end) return false;
  }
  return true;
}
function quotePostalRoutes({ routes = [], origin, destination, packages = [] }) {
  if (!origin || !destination || !Array.isArray(packages) || packages.length === 0) return [];
  const weightKg = packages.reduce((sum, pkg) => {
    const kg = Number(pkg.weightKg);
    return sum + (Number.isFinite(kg) && kg > 0 ? kg : NaN);
  }, 0);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return [];
  return routes.filter(validateRoute)
    .filter(route => matchEndpoint(route.origin, origin) && matchEndpoint(route.destination, destination))
    .filter(route => weightKg <= Number(route.maxWeightKg))
    .map(route => {
      const perKg = Number(route.pricePerKg ?? 0);
      if (!Number.isFinite(perKg) || perKg < 0) return null;
      const price = Math.round((Number(route.basePrice) + weightKg * perKg) * 100) / 100;
      return {
        routeId: String(route.id),
        carrier: "Postal Serviços",
        service: String(route.serviceName || "Transporte Postal"),
        price,
        deadlineDays: Number(route.deadlineDays),
        weightKg: Math.round(weightKg * 1000) / 1000,
        integrationStatus: "AWAITING_SSW_INTEGRATION"
      };
    }).filter(Boolean);
}
module.exports = { cepDigits, normalizeCity, validateRoute, matchEndpoint, quotePostalRoutes };

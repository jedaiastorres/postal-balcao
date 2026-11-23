"use strict";

// O endpoint POST /cart recebe o NOME do serviço, não o código técnico
// (ex.: FREIGHT_TYPE_ECONOMIC). Preserva o texto retornado pela cotação.
function canonicalServiceName(item = {}) {
  if (!item || typeof item !== "object") return "";
  return [item.postal_service_name, item.service_name, item.name, item.service, item.postal_service]
    .map(value => String(value ?? "").trim())
    .find(Boolean) || "";
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function quoteCompanyId(item = {}) {
  return Number(item.postal_company_id ?? item.company_id ?? 0);
}

// Resolve envios legados (cotados antes da mudança) consultando novamente a
// cotação original. O código técnico pode ajudar a IDENTIFICAR a linha,
// mas nunca é enviado no campo postal_service_name do carrinho.
function resolveServiceNameFromQuote(rawOptions, selection = {}) {
  if (!Array.isArray(rawOptions)) return "";
  const companyId = Number(selection.postalCompanyId || 0);
  const companyOptions = companyId
    ? rawOptions.filter(item => quoteCompanyId(item) === companyId)
    : rawOptions;
  if (!companyOptions.length) return "";
  const product = normalizeName(selection.serviceName);
  const carrier = normalizeName(selection.carrierName);
  const code = String(selection.serviceCode ?? "").trim();
  const matchesCarrier = item => {
    if (!carrier) return true;
    const itemCarrier = normalizeName(item.company_name ?? item.postal_company_name ?? item.company);
    return !itemCarrier || itemCarrier.includes(carrier) || carrier.includes(itemCarrier);
  };
  const names = item => [item.postal_service_name, item.service_name, item.name, item.service, item.postal_service]
    .map(normalizeName).filter(Boolean);
  const pool = companyOptions.filter(matchesCarrier);
  if (!pool.length) return "";
  const exact = product && pool.find(item => names(item).some(name => name === product));
  const byCode = code && pool.find(item => String(item.code ?? "") === code);
  const partial = product && pool.find(item => names(item).some(name =>
    name.includes(product) || product.includes(name)
  ));
  const single = pool.length === 1 ? pool[0] : null;
  return canonicalServiceName(exact || byCode || partial || single || null);
}

module.exports = { canonicalServiceName, resolveServiceNameFromQuote };

"use strict";

/**
 * Cadastro de conectores por transportadora.
 * Separação: carrierId identifica a empresa operadora; provider identifica o TMS/API.
 * Nenhum segredo deve ser persistido em configuração pública ou enviado ao frontend.
 */
const PROVIDERS = Object.freeze(["SSW", "CONECTENVIOS", "CUSTOM_API", "EDI"]);
const CAPABILITIES = Object.freeze(["quote", "createShipment", "requestPickup", "track", "label"]);
function normalizeCarrier(row) {
  if (!row || typeof row !== "object") throw new TypeError("Transportadora inválida");
  const id = String(row.id || "").trim();
  const name = String(row.name || "").trim();
  const provider = String(row.provider || "").toUpperCase();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(id) || !name || !PROVIDERS.includes(provider)) {
    throw new TypeError("Identificador, nome ou provedor inválido");
  }
  const capabilities = [...new Set(Array.isArray(row.capabilities) ? row.capabilities : [])];
  if (!capabilities.every(c => CAPABILITIES.includes(c))) throw new TypeError("Capacidade desconhecida");
  return Object.freeze({
    id, name, provider, active: row.active === true,
    capabilities: Object.freeze(capabilities),
    // Credential reference only; never the credential itself.
    credentialRef: String(row.credentialRef || "").trim() || null
  });
}
function listEligibleCarriers(carriers, capability) {
  if (!CAPABILITIES.includes(capability)) throw new TypeError("Capacidade desconhecida");
  return (carriers || []).map(normalizeCarrier)
    .filter(c => c.active && c.capabilities.includes(capability));
}
function resolveCarrier(carriers, carrierId, capability) {
  const match = listEligibleCarriers(carriers, capability).find(c => c.id === carrierId);
  if (!match) throw new Error("Transportadora indisponível para esta operação");
  return match;
}
module.exports = { PROVIDERS, CAPABILITIES, normalizeCarrier, listEligibleCarriers, resolveCarrier };

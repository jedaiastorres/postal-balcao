"use strict";

// A Postal Regional atende somente pares origem/destino confirmados no PA.
// A grafia enviada pelo serviço de CEP pode variar na acentuação.
const cities = Object.freeze([
  "Parauapebas", "Canaã dos Carajás", "Curionópolis", "Eldorado dos Carajás",
  "Sapucaia", "Xinguara", "Água Azul do Norte", "Tucumã", "Ourilândia do Norte",
  "São Félix do Xingu", "Rio Maria", "Bannach", "Floresta do Araguaia",
  "Pau D'Arco", "Redenção", "Conceição do Araguaia", "Cumaru do Norte",
  "Santa Maria das Barreiras", "Santana do Araguaia"
]);

function canonical(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
const supported = new Map(cities.map(name => [canonical(name), name]));

function parseLocation(raw) {
  const candidates = [raw?.data?.data, raw?.data, raw?.address, raw];
  for (const item of candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const city = item.city ?? item.cidade ?? item.localidade ?? item.municipio ?? item.city_name;
    const state = item.uf ?? item.state_code ?? item.estado_sigla ?? item.state ?? item.estado;
    if (!city || !state) continue;
    const uf = canonical(state);
    return {city: String(city), uf: uf === "pa" || uf === "para" ? "PA" : String(state).toUpperCase()};
  }
  return null;
}

function coveredRoute(origin, destination) {
  if (origin?.uf !== "PA" || destination?.uf !== "PA") return null;
  const from = supported.get(canonical(origin.city));
  const to = supported.get(canonical(destination.city));
  return from && to ? {originCity: from, destinationCity: to} : null;
}

function matchesCity(value,expected) {
  const raw=String(value||"").replace(/\s*[,/-]\s*PA\s*$/i,"");
  return Boolean(expected) && canonical(raw)===canonical(expected);
}

function eligibleVolumes(volumes) {
  return Array.isArray(volumes) && volumes.length>0 && volumes.length<=50 && volumes.every(volume=>{
    const weight=Number(volume.weightGrams||0);
    const dims=[Number(volume.width),Number(volume.height),Number(volume.length)];
    return weight>0 && weight<=30000 && dims.every(d=>Number.isFinite(d)&&d>0&&d<=100) &&
      dims.reduce((sum,d)=>sum+d,0)<=200;
  });
}

function regionalOption(options, route, extra = {}) {
  if (!route || !Array.isArray(options) || !options.length) return null;
  const sorted = options.filter(option => Number.isFinite(Number(option.precoVenda)) && Number(option.precoVenda) > 0);
  if (!sorted.length) return null;
  const minimumPrice = Math.min(...sorted.map(option => Number(option.precoVenda) + Number(extra.hubTransferTotal || 0)));
  const deadlines = sorted.map(option => Number(option.prazoEntrega)).filter(deadline => Number.isInteger(deadline) && deadline > 0);
  if (!deadlines.length) return null; // Não fabricar prazo se o comparador não o forneceu.
  const fastest = Math.min(...deadlines);
  const cheapest = sorted.find(option => Math.abs(Number(option.precoVenda) + Number(extra.hubTransferTotal || 0) - minimumPrice) < 0.005);
  const commission = Math.min(minimumPrice, Math.max(0, Number(cheapest.comissaoParceiro || 0)));
  return {
    carrierMode: "POSTAL_OWN", postalCompanyId: -1, transportadora: "Postal Serviços",
    produto: "Postal Regional", codigoServico: "POSTAL_REGIONAL",
    prazoEntrega: fastest, prazoEstimado: true, prazoReferencia: "Melhor prazo de parceiro, sujeito à validação operacional",
    precoVenda: Math.round((minimumPrice + Number.EPSILON) * 100) / 100,
    comissaoParceiro: commission, providerCost: 0,
    postalMargin: Math.round((minimumPrice - commission + Number.EPSILON) * 100) / 100,
    route, recommended: true, hubTransferIncluded: Boolean(Number(extra.hubTransferTotal))
  };
}

function isOwnSelection(selection) {
  return selection?.carrierMode === "POSTAL_OWN" &&
    selection?.service === "Postal Regional" && Number(selection?.postalCompanyId) === -1;
}

module.exports = {cities, canonical, parseLocation, coveredRoute, matchesCity, eligibleVolumes, regionalOption, isOwnSelection};

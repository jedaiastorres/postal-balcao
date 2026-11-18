"use strict";

// The public quote flow is deliberately read-only. A visitor cannot carry a
// quotation token into checkout; authenticated checkout must re-quote.
function validatePublicQuote(body, parseVolumes) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Informe os dados do pacote.");
  const cepFrom = String(body.cepOrigem || "").replace(/\D/g, "");
  const cepTo = String(body.cepDestino || "").replace(/\D/g, "");
  if (cepFrom.length !== 8 || cepTo.length !== 8) throw new Error("Informe CEPs de origem e destino com 8 dígitos.");
  const volumes = parseVolumes(body);
  if (volumes.length > 3) throw new Error("A cotação sem cadastro aceita até 3 volumes. Crie uma conta para envios maiores.");
  const totalWeightGrams = volumes.reduce((sum, volume) => sum + volume.weightGrams, 0);
  if (totalWeightGrams > 30000) throw new Error("Para envios acima de 30 kg, entre em contato com a Postal Serviços.");
  for (const volume of volumes) {
    if (volume.weightGrams > 30000 || volume.width + volume.height + volume.length > 200 ||
      Math.max(volume.width, volume.height, volume.length) > 100 ||
      !Number.isFinite(volume.declaredValue) || volume.declaredValue > 50000) {
      throw new Error("Confira as medidas (soma máxima 200 cm e lado máximo 100 cm) e o valor declarado de cada volume.");
    }
  }
  return { cepFrom, cepTo, volumes, totalWeightGrams };
}

// No provider prices, commissions, HMAC selection tokens or store metadata.
function publicQuoteResponse(aggregated, { volumes, cepFrom, cepTo, hubTransferTotal, demo }) {
  return {
    provider: "Postal Serviços",
    demo: Boolean(demo),
    originCep: cepFrom,
    destinationCep: cepTo,
    volumeCount: volumes.length,
    totalWeightKg: Math.round(volumes.reduce((sum, volume) => sum + volume.weightGrams, 0) / 10) / 100,
    options: aggregated.slice(0, 20).map(option => ({
      carrier: String(option.transportadora || "Transportadora").slice(0, 90),
      service: String(option.produto || "Serviço").slice(0, 90),
      recommended: Boolean(option.recommended),
      estimatedDeadline: Boolean(option.prazoEstimado),
      deadline: Number(option.prazoEntrega) || null,
      price: Math.round((Number(option.precoVenda || 0) + (option.carrierMode==="POSTAL_OWN"?0:hubTransferTotal) + Number.EPSILON) * 100) / 100
    }))
  };
}

// In-memory protection is a first layer; network/WAF quotas are recommended
// for horizontally scaled deployments.
function makeVisitorLimiter({ windowMs = 15 * 60 * 1000, windowLimit = 10, dayLimit = 60, maxKeys = 5000 } = {}) {
  const visits = new Map();
  return function check(key, now = Date.now()) {
    if (visits.size >= maxKeys) {
      for (const [id, row] of visits) if (row.dayEnd <= now) visits.delete(id);
      if (visits.size >= maxKeys && !visits.has(key)) return { ok: false, retryAfter: 60 };
    }
    let row = visits.get(key);
    if (!row || row.dayEnd <= now) row = { windowEnd: now + windowMs, windowCount: 0, dayEnd: now + 86400000, dayCount: 0 };
    if (row.windowEnd <= now) { row.windowEnd = now + windowMs; row.windowCount = 0; }
    if (row.windowCount >= windowLimit || row.dayCount >= dayLimit) {
      visits.set(key, row);
      const expires = row.dayCount >= dayLimit ? row.dayEnd : row.windowEnd;
      return { ok: false, retryAfter: Math.max(1, Math.ceil((expires - now) / 1000)) };
    }
    row.windowCount++;
    row.dayCount++;
    visits.set(key, row);
    return { ok: true };
  };
}

module.exports = { validatePublicQuote, publicQuoteResponse, makeVisitorLimiter };

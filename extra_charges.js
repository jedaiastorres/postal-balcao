"use strict";

// Cobranças avulsas criadas no balcão. Valores sempre são recalculados no servidor.
// Representadas como serviços do pedido para usar o split financeiro e o comprovante existentes.
const MAX_LINES = 8;
const MAX_CENTS = 100000; // R$ 1.000 por serviço; evita cobranças acidentais.

function cents(value) {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Valor adicional inválido.");
  if (typeof value === "string" && !/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) throw new Error("Use valores em reais, com até duas casas decimais.");
  const num = Number(String(value).replace(",", "."));
  const valueCents = Math.round(num * 100);
  if (!Number.isFinite(num) || Math.abs(num * 100 - valueCents) > 0.00001 || valueCents < 1 || valueCents > MAX_CENTS) {
    throw new Error("Cada custo adicional deve ficar entre R$ 0,01 e R$ 1.000,00.");
  }
  return valueCents;
}

function resolveExtraCharges(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LINES) throw new Error("Informe no máximo oito serviços adicionais.");
  return raw.map((line, index) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error("Serviço adicional inválido.");
    const name = String(line.description ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.length > 100) throw new Error("Descreva o serviço adicional em 3 a 100 caracteres.");
    const amountCents = cents(line.amount);
    // Arredondamento por linha, com o residual de centavos destinado à Postal.
    const pointCents = Math.round(amountCents * 0.9);
    return {
      itemId: null, itemCode: `EXTRA_${index + 1}`, itemType: "SERVICE",
      itemName: name, quantity: 1, unitPrice: amountCents / 100,
      totalPrice: amountCents / 100, pointRevenue: pointCents / 100,
      postalRevenue: (amountCents - pointCents) / 100, providerRevenue: 0,
      trackStock: false, metadata: { source: "POINT_MANUAL_EXTRA", pointPercent: 90, postalPercent: 10 }
    };
  });
}

module.exports = { resolveExtraCharges, MAX_LINES };

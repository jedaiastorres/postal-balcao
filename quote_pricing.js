"use strict";

function pointCommissionRate(store, defaultRate) {
  const configured = store?.commission_percent;
  if (configured == null) return defaultRate;
  const percentage = Number(configured);
  if (!Number.isFinite(percentage)) return defaultRate;
  return Math.max(0, Math.min(0.50, percentage / 100));
}

function sellPriceFromCost(cost, partnerCommissionRate, postalMarginRate) {
  // Comissão do ponto e margem Postal são percentuais do preço final.
  const partnerRate = Math.min(0.50, Math.max(0, Number(partnerCommissionRate || 0)));
  const retainedShare = 1 - partnerRate - postalMarginRate;
  if (retainedShare <= 0) throw new Error("Configuração de margens inválida.");
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const finalPrice = cost / retainedShare;
  return {
    salePrice: round2(finalPrice),
    partnerCommission: round2(finalPrice * partnerRate),
    postalMargin: round2(finalPrice * postalMarginRate)
  };
}

module.exports = { pointCommissionRate, sellPriceFromCost };

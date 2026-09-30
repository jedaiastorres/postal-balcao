const ASAAS_API_KEY = String(process.env.ASAAS_API_KEY || "").trim();
const CONFIGURED_API_URL = String(process.env.ASAAS_API_URL || "").trim().replace(/\/$/, "");
function resolveApiUrl() {
  if (/^\$aact_hmlg_/i.test(ASAAS_API_KEY)) return "https://api-sandbox.asaas.com/v3";
  if (/^\$aact_prod_/i.test(ASAAS_API_KEY)) return "https://api.asaas.com/v3";
  return CONFIGURED_API_URL || "https://api-sandbox.asaas.com/v3";
}
const ASAAS_API_URL = resolveApiUrl();
const ASAAS_WEBHOOK_TOKEN = String(process.env.ASAAS_WEBHOOK_TOKEN || "").trim();
const ASAAS_PREFERRED_PIX_KEY = String(process.env.ASAAS_PREFERRED_PIX_KEY || "").trim();
const APP_PUBLIC_URL = String(
  process.env.APP_PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "http://localhost:3000")
).replace(/\/$/, "");

const PIX_FEE_FIXED = Math.max(0, Number(process.env.ASAAS_PIX_FEE_FIXED || 1.99));
const CARD_FEE_PERCENT = Math.max(0, Number(process.env.ASAAS_CARD_FEE_PERCENT || 2.99)) / 100;
const CARD_FEE_FIXED = Math.max(0, Number(process.env.ASAAS_CARD_FEE_FIXED || 0.49));

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function ceil2(n) {
  return Math.ceil((Number(n) - Number.EPSILON) * 100) / 100;
}

function configured() {
  return Boolean(ASAAS_API_KEY);
}

function isSandbox() {
  return /sandbox/i.test(ASAAS_API_URL) || /^\$aact_hmlg_/i.test(ASAAS_API_KEY);
}

function webhookConfigured() {
  return Boolean(ASAAS_WEBHOOK_TOKEN);
}

function environmentInfo() {
  const keyEnvironment = /^\$aact_prod_/i.test(ASAAS_API_KEY)
    ? "production"
    : (/^\$aact_hmlg_/i.test(ASAAS_API_KEY) ? "sandbox" : "unknown");
  const urlEnvironment = /api-sandbox/i.test(ASAAS_API_URL) ? "sandbox" : "production";
  return {
    keyEnvironment,
    urlEnvironment,
    baseUrl: ASAAS_API_URL,
    corrected: Boolean(CONFIGURED_API_URL && CONFIGURED_API_URL !== ASAAS_API_URL),
    preferredPixKeyConfigured: Boolean(ASAAS_PREFERRED_PIX_KEY)
  };
}

function providerErrorMessage(body, fallback = "O Asaas não conseguiu concluir a operação.") {
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const descriptions = body.errors
      .map(item => String(item?.description || item?.message || item?.code || "").trim())
      .filter(Boolean);
    if (descriptions.length) return descriptions.join(" | ");
  }
  if (body && typeof body === "object") {
    const msg = body.message || body.error_description || body.description || body.error;
    if (msg) return String(msg);
  }
  return fallback;
}

function grossUp(baseAmount, method) {
  const base = round2(baseAmount);
  const normalized = String(method || "").toUpperCase();

  if (normalized === "PIX" || normalized === "CASH_REMITTANCE") {
    const gross = round2(base + PIX_FEE_FIXED);
    return {
      baseAmount: base,
      grossAmount: gross,
      surcharge: round2(gross - base),
      feeModel: { fixed: PIX_FEE_FIXED, percent: 0 }
    };
  }

  if (normalized === "CREDIT_CARD" || normalized === "CARTAO") {
    if (CARD_FEE_PERCENT >= 0.99) throw new Error("Taxa de cartão inválida.");
    const gross = ceil2((base + CARD_FEE_FIXED) / (1 - CARD_FEE_PERCENT));
    return {
      baseAmount: base,
      grossAmount: gross,
      surcharge: round2(gross - base),
      feeModel: { fixed: CARD_FEE_FIXED, percent: round2(CARD_FEE_PERCENT * 100) }
    };
  }

  return {
    baseAmount: base,
    grossAmount: base,
    surcharge: 0,
    feeModel: { fixed: 0, percent: 0 }
  };
}

function buildCheckoutUrl(id, apiResponse = {}) {
  if (apiResponse.link) return apiResponse.link;
  return `https://asaas.com/checkoutSession/show?id=${encodeURIComponent(id)}`;
}

async function asaasFetch(pathname, options = {}) {
  if (!ASAAS_API_KEY) {
    const error = new Error("Asaas ainda não configurado.");
    error.code = "ASAAS_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(ASAAS_API_URL + (pathname.startsWith("/") ? pathname : "/" + pathname), {
    ...options,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "access_token": ASAAS_API_KEY,
      "user-agent": "PostalBalcao/1.3 (Node.js)",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 25000)
  });

  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(providerErrorMessage(body));
    error.status = response.status;
    error.providerData = body;
    throw error;
  }

  return body;
}

async function createCheckout({
  orderId,
  billingType,
  amount,
  itemName,
  itemDescription,
  partnerWalletId,
  reserveWalletId,
  partnerCommission,
  providerCost,
  customerData
}) {
  const pricing = grossUp(amount, billingType);

  const splits = [];
  if (partnerWalletId && Number(partnerCommission) > 0) {
    splits.push({
      walletId: partnerWalletId,
      fixedValue: round2(partnerCommission)
    });
  }
  if (reserveWalletId && Number(providerCost) > 0) {
    splits.push({
      walletId: reserveWalletId,
      fixedValue: round2(providerCost)
    });
  }

  const payload = {
    billingTypes: [billingType === "CARTAO" ? "CREDIT_CARD" : billingType],
    chargeTypes: ["DETACHED"],
    minutesToExpire: 60,
    externalReference: orderId,
    callback: {
      successUrl: `${APP_PUBLIC_URL}/?payment=success&order=${encodeURIComponent(orderId)}`,
      cancelUrl: `${APP_PUBLIC_URL}/?payment=cancel&order=${encodeURIComponent(orderId)}`,
      expiredUrl: `${APP_PUBLIC_URL}/?payment=expired&order=${encodeURIComponent(orderId)}`
    },
    items: [
      {
        externalReference: orderId,
        name: itemName || "Frete Postal Serviços",
        description: itemDescription || "Pagamento de frete",
        quantity: 1,
        value: pricing.grossAmount
      }
    ]
  };

  if (splits.length) payload.splits = splits;

  if (customerData && customerData.name && customerData.cpfCnpj) {
    payload.customerData = {
      name: customerData.name,
      cpfCnpj: String(customerData.cpfCnpj).replace(/\D/g, ""),
      email: customerData.email || undefined,
      phone: String(customerData.phone || "").replace(/\D/g, "") || undefined
    };
  }

  const result = await asaasFetch("/checkouts", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  return {
    id: result.id,
    url: buildCheckoutUrl(result.id, result),
    status: result.status || "ACTIVE",
    grossAmount: pricing.grossAmount,
    surcharge: pricing.surcharge,
    raw: result
  };
}

async function ensurePixKey({ waitForActiveMs = 60000 } = {}) {
  if (!ASAAS_API_KEY) return { ok: false, reason: "not_configured" };

  const listKeys = async () => {
    const listed = await asaasFetch("/pix/addressKeys?limit=20", { method: "GET" });
    return Array.isArray(listed) ? listed : (Array.isArray(listed?.data) ? listed.data : []);
  };

  let rows = await listKeys();
  const keyValue = item => String(item?.key || item?.value || item?.addressKey || item?.pixAddressKey || "").trim();
  const matchesPreferred = item => keyValue(item) === ASAAS_PREFERRED_PIX_KEY || String(item?.id || "").trim() === ASAAS_PREFERRED_PIX_KEY;
  let preferred = ASAAS_PREFERRED_PIX_KEY
    ? rows.find(item => matchesPreferred(item) && String(item?.status || "").toUpperCase() === "ACTIVE")
    : null;
  if (preferred) return { ok: true, created: false, id: preferred.id || null, status: "ACTIVE", preferredMatched: true };
  let active = rows.find(item => String(item?.status || "").toUpperCase() === "ACTIVE");
  if (active) return { ok: true, created: false, id: active.id || null, status: "ACTIVE", preferredMatched: !ASAAS_PREFERRED_PIX_KEY };

  let pending = rows.find(item => String(item?.status || "").toUpperCase() === "AWAITING_ACTIVATION");
  let created = false;
  if (!pending) {
    pending = await asaasFetch("/pix/addressKeys", {
      method: "POST",
      body: JSON.stringify({ type: "EVP" })
    });
    created = true;
  }

  const deadline = Date.now() + Math.max(0, Number(waitForActiveMs || 0));
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    rows = await listKeys();
    active = rows.find(item => String(item?.status || "").toUpperCase() === "ACTIVE");
    if (active) return { ok: true, created, id: active.id || null, status: "ACTIVE" };

    const failed = rows.find(item => String(item?.id || "") === String(pending?.id || "") && String(item?.status || "").toUpperCase() === "ERROR");
    if (failed) {
      const error = new Error("A chave Pix criada no Asaas entrou em estado de erro.");
      error.providerData = failed;
      throw error;
    }
  }

  rows = await listKeys();
  pending = rows.find(item => ["AWAITING_ACTIVATION","ACTIVE"].includes(String(item?.status || "").toUpperCase())) || pending;
  return {
    ok: String(pending?.status || "").toUpperCase() === "ACTIVE",
    created,
    id: pending?.id || null,
    status: pending?.status || "AWAITING_ACTIVATION",
    reason: "activation_pending"
  };
}

async function cancelCheckout(checkoutId) {
  if (!checkoutId) return null;
  return asaasFetch("/checkouts/" + encodeURIComponent(checkoutId) + "/cancel", {
    method: "POST",
    body: "{}"
  });
}

async function selfTestCheckout() {
  const result = await createCheckout({
    orderId: "SELFTEST-" + Date.now(),
    billingType: "PIX",
    amount: 10,
    itemName: "Teste técnico Postal",
    itemDescription: "Checkout temporário de validação da integração",
    partnerWalletId: null,
    reserveWalletId: null,
    partnerCommission: 0,
    providerCost: 0,
    customerData: null
  });
  try { await cancelCheckout(result.id); } catch {}
  return { ok: true, id: result.id, status: result.status };
}

function safeCompareToken(received) {
  if (!ASAAS_WEBHOOK_TOKEN || !received) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(ASAAS_WEBHOOK_TOKEN);
  if (a.length !== b.length) return false;
  return require("crypto").timingSafeEqual(a, b);
}

module.exports = {
  configured,
  isSandbox,
  webhookConfigured,
  safeCompareToken,
  grossUp,
  createCheckout,
  ensurePixKey,
  cancelCheckout,
  selfTestCheckout,
  asaasFetch,
  environmentInfo,
  providerErrorMessage,
  ASAAS_API_URL,
  APP_PUBLIC_URL
};

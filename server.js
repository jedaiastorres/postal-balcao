require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const asaas = require("./asaas");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const API_URL = (process.env.CONECTENVIOS_API_URL || "https://app.conectenvios.com.br/api/v1").replace(/\/$/, "");
const TOKEN = (process.env.CONECTENVIOS_TOKEN || "").trim();

const APP_USER = process.env.APP_USER || "parceiro@postalservicos.com.br";
const APP_PASSWORD = process.env.APP_PASSWORD || "postal123";
const SESSION_SECRET = process.env.APP_SESSION_SECRET || "postal-v1-dev-secret-change-me";
const DEMO_AUTH = String(process.env.APP_DEMO_AUTH || "true").toLowerCase() === "true";
const ENABLE_SHIPMENT_CREATION = String(process.env.ENABLE_SHIPMENT_CREATION || "false").toLowerCase() === "true";

const POSTAL_MARGIN = Math.min(0.50, Math.max(0, Number(process.env.POSTAL_MARKUP_PERCENT || 12) / 100));
const PARTNER_COMMISSION = Math.min(0.20, Math.max(0, Number(process.env.PARTNER_COMMISSION_PERCENT || 20) / 100));
const RECEIPT_WIDTH_MM = [58, 80].includes(Number(process.env.THERMAL_RECEIPT_WIDTH_MM)) ? Number(process.env.THERMAL_RECEIPT_WIDTH_MM) : 80;
const ASAAS_RESERVE_WALLET_ID = String(process.env.ASAAS_CONNECTENVIOS_RESERVE_WALLET_ID || "").trim();
const ASAAS_DEFAULT_PARTNER_WALLET_ID = String(process.env.ASAAS_DEFAULT_PARTNER_WALLET_ID || "").trim();
const INTEGRATION_API_KEY = String(process.env.INTEGRATION_API_KEY || "").trim();
const PAYMENT_SIMULATOR_ENABLED = String(process.env.PAYMENT_SIMULATOR_ENABLED || "true").toLowerCase() === "true";

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(
    raw.split(";").map(v => v.trim()).filter(Boolean).map(part => {
      const idx = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
    })
  );
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function signSelectionToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update("quote." + body).digest("base64url");
  return body + "." + sig;
}

function verifySelectionToken(token) {
  if (!token || !token.includes(".")) return null;
  const parts = token.split(".");
  const body = parts[0];
  const sig = parts[1] || "";
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update("quote." + body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return "pbkdf2$120000$" + salt + "$" + hash;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], "hex");
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, "sha256");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const loginAttempts = new Map();
function loginRateKey(req, email) {
  return String(req.ip || req.socket?.remoteAddress || "unknown") + "|" + String(email || "").toLowerCase();
}
function checkLoginRate(req, email) {
  const key = loginRateKey(req, email);
  const current = loginAttempts.get(key);
  if (!current) return { ok: true, key };
  if (Date.now() > current.resetAt) {
    loginAttempts.delete(key);
    return { ok: true, key };
  }
  return { ok: current.count < 7, key, retryAfter: Math.ceil((current.resetAt - Date.now()) / 1000) };
}
function recordLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || Date.now() > current.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  } else {
    current.count += 1;
  }
}
function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Você não tem permissão para esta ação." });
    }
    next();
  };
}

function scopeForUser(user) {
  if (user?.role === "ADMIN") return {};
  if (user?.storeId) return { storeId: user.storeId };
  return { partnerEmail: user?.email };
}

function inventoryOwner(user) {
  return user?.storeId ? "store:" + user.storeId : String(user?.email || "");
}

function inventoryOwnerFromOrder(order) {
  return order?.store_id ? "store:" + order.store_id : String(order?.partner_email || "");
}

async function audit(req, action, entityType, entityId, metadata = {}) {
  try {
    await db.insertAudit({
      userId: req?.user?.userId || null,
      storeId: req?.user?.storeId || null,
      userEmail: req?.user?.email || null,
      action, entityType, entityId, metadata
    });
  } catch (error) {
    console.error("audit error:", error.message);
  }
}
function requireAuth(req, res, next) {
  const session = verifySession(parseCookies(req).postal_session);
  if (!session) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  req.user = session;
  next();
}

function requireIntegrationAuth(req, res, next) {
  if (!INTEGRATION_API_KEY) return res.status(503).json({ error: "API de integração ainda não configurada." });
  const received = String(req.get("x-api-key") || "");
  const a = Buffer.from(received);
  const b = Buffer.from(INTEGRATION_API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Chave de integração inválida." });
  }
  next();
}

function providerHeaders(extra = {}) {
  return {
    "Accept": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
    ...extra
  };
}

async function providerFetch(pathname, options = {}) {
  if (!TOKEN) throw new Error("CONECTENVIOS_TOKEN não configurado.");
  const url = `${API_URL}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...providerHeaders(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });

  const type = response.headers.get("content-type") || "";
  let data;
  if (type.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const err = new Error("A ConectEnvios não conseguiu concluir a solicitação.");
    err.status = response.status;
    err.providerData = data;
    throw err;
  }

  return { response, data, contentType: type };
}

function parseMoney(value) {
  if (typeof value === "number") return value;
  if (value == null) return NaN;
  const raw = String(value).trim().replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(raw)) return Number(raw.replace(/\./g, "").replace(",", "."));
  if (/^\d+,\d+$/.test(raw)) return Number(raw.replace(",", "."));
  return Number(raw.replace(/[^\d.-]/g, ""));
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sellPriceFromCost(cost, partnerCommissionRate = PARTNER_COMMISSION) {
  // Comissão do ponto e margem Postal são percentuais do preço final.
  const partnerRate = Math.min(0.50, Math.max(0, Number(partnerCommissionRate || 0)));
  const retainedShare = 1 - partnerRate - POSTAL_MARGIN;
  if (retainedShare <= 0) throw new Error("Configuração de margens inválida.");
  const finalPrice = cost / retainedShare;
  const partnerCommission = finalPrice * partnerRate;
  const postalMargin = finalPrice * POSTAL_MARGIN;
  return {
    salePrice: round2(finalPrice),
    partnerCommission: round2(partnerCommission),
    postalMargin: round2(postalMargin)
  };
}

function demoQuote(body) {
  const destination = String(body.cepDestino || "").replace(/\D/g, "");
  const seed = Number(destination.slice(-2) || 27);
  const base = 31 + (seed % 19);
  return [
    { postal_company_id: 1, company_name: "Correios", service_name: "PAC", price: base + 8, deadline: 8 },
    { postal_company_id: 2, company_name: "Jadlog", service_name: ".Package", price: base + 4.5, deadline: 6 },
    { postal_company_id: 3, company_name: "Azul Cargo", service_name: "E-commerce", price: base + 15, deadline: 4 }
  ];
}

function extractShippingItems(payload) {
  // Formato documentado: { error:false, data:[...] }.
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && Array.isArray(payload.data.services)) return payload.data.services;
  return [];
}

function normalizeQuote(payload, partnerCommissionRate = PARTNER_COMMISSION) {
  const items = extractShippingItems(payload);

  return items.map(item => {
    const cost = parseMoney(item.price_discounted ?? item.price ?? item.postal_service_price ?? item.value);
    if (!Number.isFinite(cost) || cost <= 0) return null;

    const pricing = sellPriceFromCost(cost, partnerCommissionRate);
    return {
      postalCompanyId: Number(item.postal_company_id ?? item.company_id ?? item.id ?? 0),
      transportadora: item.company_name ?? item.postal_company_name ?? item.company ?? "Transportadora",
      produto: item.name ?? item.service_name ?? item.postal_service_name ?? item.service ?? "Serviço",
      codigoServico: item.code ?? "",
      prazoEntrega: Number(item.deadline ?? item.postal_service_deadline ?? 0),
      precoVenda: pricing.salePrice,
      comissaoParceiro: pricing.partnerCommission,
      providerCost: round2(cost),
      postalMargin: pricing.postalMargin
    };
  }).filter(Boolean).sort((a, b) => a.precoVenda - b.precoVenda);
}

function toPositiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} deve ser maior que zero.`);
  return Math.max(1, Math.round(n));
}

async function createShipmentFromOrder(order) {
  if (!order) throw new Error("Pedido não encontrado.");

  if (order.tracking_code || order.conect_package_id) {
    return {
      cartId: order.conect_cart_id || null,
      packageId: order.conect_package_id || null,
      trackingCode: order.tracking_code || "",
      labelA4Url: order.label_a4_url || "",
      labelA6Url: order.label_a6_url || "",
      declarationUrl: order.declaration_url || "",
      publicTrackingUrl: order.public_tracking_url || ""
    };
  }

  if (!ENABLE_SHIPMENT_CREATION) {
    await db.updateStatus(order.id, "PAID_WAITING_SHIPMENT", "PAID");
    return null;
  }
  if (!TOKEN) throw new Error("CONECTENVIOS_TOKEN não configurado.");

  const packageData = order.package_data || {};
  const sender = order.sender || {};
  const recipient = order.recipient || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const declaredFallback = items.reduce((sum, item) => sum + Number(item.value || 0) * Number(item.quantity || 1), 0);

  const packageItem = {
    name: String("Envio Postal - " + (sender.name || "") + " para " + (recipient.name || "")).slice(0, 120),
    type: "box",
    weight: Number(packageData.weightGrams || 0),
    width: Number(packageData.width || 0),
    height: Number(packageData.height || 0),
    length: Number(packageData.length || 0),
    extra_notify: true,
    extra_in_hand: false,
    extra_declared_value: round2(Number(packageData.declaredValue || declaredFallback)),

    addr_from_document: cleanDigits(sender.document),
    addr_from_phone: cleanDigits(sender.phone),
    addr_from_name: String(sender.name || "").trim(),
    addr_from_cep: cleanDigits(sender.cep),
    addr_from_number: String(sender.number || "").trim(),
    addr_from_address: String(sender.address || "").trim(),
    addr_from_neighborhood: String(sender.neighborhood || "").trim(),
    addr_from_complement: String(sender.complement || "").trim(),

    addr_to_document: cleanDigits(recipient.document),
    addr_to_phone: cleanDigits(recipient.phone),
    addr_to_name: String(recipient.name || "").trim(),
    addr_to_cep: cleanDigits(recipient.cep),
    addr_to_number: String(recipient.number || "").trim(),
    addr_to_address: String(recipient.address || "").trim(),
    addr_to_neighborhood: String(recipient.neighborhood || "").trim(),
    addr_to_complement: String(recipient.complement || "").trim(),

    postal_service_name: String(order.service_name || ""),
    postal_company_id: Number(order.postal_company_id || 0)
  };

  if (order.invoice_number) {
    packageItem.receipt = String(order.invoice_number);
  } else {
    packageItem.declaration = items.map(item => ({
      description: String(item.description || "").trim(),
      quantity: Math.max(1, Math.round(Number(item.quantity || 1))),
      value: round2(Number(item.value || 0))
    }));
  }

  const result = await providerFetch("/cart", {
    method: "POST",
    body: JSON.stringify({ package: [packageItem] }),
    timeout: 45000
  });

  const providerPayload = result.data || {};
  if (providerPayload.error === true) {
    const err = new Error("A ConectEnvios recusou a postagem.");
    err.providerData = providerPayload;
    throw err;
  }

  const cart = providerPayload.data || providerPayload;
  const pkg = Array.isArray(cart.packages) ? cart.packages[0] : null;
  if (!pkg) throw new Error("A ConectEnvios não retornou os dados do pacote.");

  const shipment = {
    cartId: cart.id || pkg.cart_id || null,
    packageId: pkg.id || null,
    trackingCode: pkg.postal_service_track || "",
    labelA4Url: pkg.api_print_url || cart.public_print_url || "",
    labelA6Url: pkg.api_print_url_a6 || "",
    declarationUrl: pkg.api_declaration_url || "",
    publicTrackingUrl: pkg.public_tracking_url || ""
  };

  await db.saveShipment(order.id, shipment);
  return shipment;
}

function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    paymentProvider: order.payment_provider,
    paymentCheckoutUrl: order.payment_checkout_url || "",
    paymentAmount: Number(order.payment_amount || 0),
    paymentSurcharge: Number(order.payment_surcharge || 0),
    cashRemittanceAmount: Number(order.cash_remittance_amount || 0),
    cashRemittanceTotal: round2(Number(order.cash_remittance_amount || 0) + Number(order.payment_surcharge || 0)),
    salePrice: Number(order.sale_price || 0),
    addonsTotal: Number(order.addons_total || 0),
    customerSubtotal: Number(order.customer_subtotal || order.sale_price || 0),
    totalToCustomer: round2(Number(order.customer_subtotal || order.sale_price || 0) + Number(order.payment_surcharge || 0)),
    pointRevenueTotal: Number(order.point_revenue_total || order.partner_commission || 0),
    partnerCommission: Number(order.partner_commission || 0),
    addons: Array.isArray(order.addons) ? order.addons.map(addon => ({
      itemCode: addon.item_code,
      itemType: addon.item_type,
      itemName: addon.item_name,
      quantity: Number(addon.quantity || 0),
      unitPrice: Number(addon.unit_price || 0),
      totalPrice: Number(addon.total_price || 0),
      pointRevenue: Number(addon.point_revenue || 0)
    })) : [],
    carrier: order.carrier || "",
    serviceName: order.service_name || "",
    deadline: Number(order.deadline || 0),
    sender: order.sender || {},
    recipient: order.recipient || {},
    items: order.items || [],
    invoiceNumber: order.invoice_number || "",
    packageData: order.package_data || {},
    trackingCode: order.tracking_code || "",
    labelA4Url: order.label_a4_url || "",
    labelA6Url: order.label_a6_url || "",
    declarationUrl: order.declaration_url || "",
    publicTrackingUrl: order.public_tracking_url || "",
    isSimulation: Boolean(order.is_simulation),
    events: Array.isArray(order.events) ? order.events.map(event => ({
      id: event.id,
      type: event.event_type,
      title: event.title,
      detail: event.detail || "",
      createdAt: event.created_at
    })) : [],
    createdAt: order.created_at,
    paidAt: order.paid_at,
    shippedAt: order.shipped_at
  };
}

function validateFreightParties(sender, recipient, items) {
  const required = ["name", "document", "phone", "cep", "address", "number", "neighborhood", "city"];
  for (const pair of [["remetente", sender], ["destinatário", recipient]]) {
    const label = pair[0];
    const party = pair[1] || {};
    const missing = required.filter(key => !String(party[key] || "").trim());
    if (missing.length) throw new Error("Preencha os dados obrigatórios do " + label + ".");
  }
  if (!Array.isArray(items) || !items.length) throw new Error("Informe ao menos um item da encomenda.");
  if (items.some(item => !String(item.description || "").trim() || Number(item.quantity) <= 0 || Number(item.value) < 0)) {
    throw new Error("Revise os itens da encomenda.");
  }
}

async function resolveRequestedAddons(partnerEmail, requestedAddons) {
  const requested = Array.isArray(requestedAddons) ? requestedAddons : [];
  if (!requested.length) return [];

  const catalog = await db.getPartnerCatalog(partnerEmail);
  const byCode = new Map(catalog.map(item => [String(item.code), item]));
  const resolved = [];

  for (const request of requested) {
    const code = String(request.code || "").trim();
    const quantity = Math.max(0, Number(request.quantity || 0));
    if (!code || quantity <= 0) continue;

    const item = byCode.get(code);
    if (!item || item.active !== true) throw new Error("Produto ou serviço não disponível: " + code);

    if (item.track_stock && Number(item.available_quantity || 0) < quantity) {
      throw new Error("Estoque insuficiente para " + item.name + ".");
    }

    const unitPrice = round2(Number(item.effective_unit_price ?? item.unit_price ?? 0));
    if (unitPrice < 0) throw new Error("Preço inválido para " + item.name + ".");

    const totalPrice = round2(unitPrice * quantity);
    const pointPct = Math.max(0, Number(item.point_share_percent || 0)) / 100;
    const postalPct = Math.max(0, Number(item.postal_share_percent || 0)) / 100;
    const providerPct = Math.max(0, Number(item.provider_share_percent || 0)) / 100;
    if (pointPct + postalPct + providerPct > 1.00001) {
      throw new Error("Divisão financeira inválida no item " + item.name + ".");
    }

    resolved.push({
      itemId: item.id,
      itemCode: item.code,
      itemType: item.item_type,
      itemName: item.name,
      quantity,
      unitPrice,
      totalPrice,
      pointRevenue: round2(totalPrice * pointPct),
      postalRevenue: round2(totalPrice * postalPct),
      providerRevenue: round2(totalPrice * providerPct),
      trackStock: Boolean(item.track_stock),
      metadata: item.metadata || {}
    });
  }

  return resolved;
}

function summarizeFinancials(selection, addons, paymentMethod) {
  const freightPrice = round2(Number(selection.salePrice || 0));
  const freightPoint = round2(Number(selection.partnerCommission || 0));
  const freightProvider = round2(Number(selection.providerCost || 0));
  const freightPostal = round2(Math.max(0, freightPrice - freightPoint - freightProvider));

  const addonsTotal = round2(addons.reduce((s, a) => s + Number(a.totalPrice || 0), 0));
  const addonPoint = round2(addons.reduce((s, a) => s + Number(a.pointRevenue || 0), 0));
  const addonPostal = round2(addons.reduce((s, a) => s + Number(a.postalRevenue || 0), 0));
  const addonProvider = round2(addons.reduce((s, a) => s + Number(a.providerRevenue || 0), 0));

  const customerSubtotal = round2(freightPrice + addonsTotal);
  const pointRevenueTotal = round2(freightPoint + addonPoint);
  const postalRevenueTotal = round2(freightPostal + addonPostal);
  const providerRevenueTotal = round2(freightProvider + addonProvider);

  let feeBase = customerSubtotal;
  let feeMethod = paymentMethod;
  if (paymentMethod === "DINHEIRO") {
    feeBase = round2(customerSubtotal - pointRevenueTotal);
    feeMethod = "CASH_REMITTANCE";
  }

  const grossed = asaas.grossUp(feeBase, feeMethod);
  const paymentSurcharge = round2(grossed.surcharge);
  const totalToCustomer = round2(customerSubtotal + paymentSurcharge);
  const cashRemittanceBase = paymentMethod === "DINHEIRO"
    ? round2(customerSubtotal - pointRevenueTotal)
    : 0;

  return {
    freightPrice,
    addonsTotal,
    customerSubtotal,
    pointRevenueTotal,
    postalRevenueTotal,
    providerRevenueTotal,
    paymentSurcharge,
    totalToCustomer,
    cashRemittanceBase
  };
}

async function processAsaasWebhookEvent(eventRow) {
  const payload = eventRow.payload || {};
  const eventType = String(eventRow.event_type || payload.event || "");
  const checkoutId = String(eventRow.checkout_id || payload.checkout?.id || "");
  const order = checkoutId ? await db.getOrderByCheckoutId(checkoutId) : null;

  if (!order) {
    await db.markWebhookProcessed(eventRow.id, "Pedido não encontrado para o checkout.");
    return;
  }

  try {
    if (eventType === "CHECKOUT_PAID") {
      const paidOrder = await db.markPaid(order.id, ENABLE_SHIPMENT_CREATION ? "PAYMENT_CONFIRMED" : "PAID_WAITING_SHIPMENT");
      if (order.payment_method !== "DINHEIRO") {
        await db.consumeOrderInventory(order.id, inventoryOwnerFromOrder(order));
      }
      if (ENABLE_SHIPMENT_CREATION) {
        try {
          await createShipmentFromOrder(paidOrder);
        } catch (shipmentError) {
          console.error("shipment after payment error:", shipmentError.providerData || shipmentError.message);
          await db.updateStatus(order.id, "SHIPMENT_ERROR", "PAID");
        }
      }
    } else if (eventType === "CHECKOUT_CANCELED") {
      if (order.payment_method !== "DINHEIRO") await db.releaseOrderInventory(order.id, inventoryOwnerFromOrder(order));
      await db.updateStatus(order.id, "PAYMENT_CANCELED", "CANCELED");
    } else if (eventType === "CHECKOUT_EXPIRED") {
      if (order.payment_method !== "DINHEIRO") await db.releaseOrderInventory(order.id, inventoryOwnerFromOrder(order));
      await db.updateStatus(order.id, "PAYMENT_EXPIRED", "EXPIRED");
    }

    await db.markWebhookProcessed(eventRow.id, null);
  } catch (error) {
    await db.markWebhookProcessed(eventRow.id, String(error.message || error));
    throw error;
  }
}

async function processPendingAsaasEvents() {
  if (!process.env.DATABASE_URL) return;
  try {
    const events = await db.getPendingWebhookEvents("ASAAS", 20);
    for (const eventRow of events) {
      try {
        await processAsaasWebhookEvent(eventRow);
      } catch (error) {
        console.error("Asaas event processing error:", eventRow.id, error.message);
      }
    }
  } catch (error) {
    console.error("pending webhook processor error:", error.message);
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "ConectEnvios API V1",
    providerConfigured: Boolean(TOKEN)
  });
});

app.get("/api/public-config", (_req, res) => {
  res.json({
    provider: "ConectEnvios",
    providerConfigured: Boolean(TOKEN),
    demoAuth: DEMO_AUTH,
    commissionPercent: round2(PARTNER_COMMISSION * 100),
    receiptWidthMm: RECEIPT_WIDTH_MM,
    shipmentCreationEnabled: ENABLE_SHIPMENT_CREATION,
    paymentsProvider: "ASAAS",
    paymentsConfigured: asaas.configured(),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    paymentSimulatorEnabled: PAYMENT_SIMULATOR_ENABLED && !asaas.configured()
  });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rate = checkLoginRate(req, normalizedEmail);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfter || 900));
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
  }

  try {
    const user = await db.findUserByEmail(normalizedEmail);
    if (!user || !user.active || user.store_active === false || !verifyPassword(password, user.password_hash)) {
      recordLoginFailure(rate.key);
      return res.status(401).json({ error: "E-mail ou senha inválidos." });
    }

    clearLoginFailures(rate.key);
    await db.touchUserLogin(user.id);
    const csrf = crypto.randomBytes(24).toString("base64url");
    const token = signSession({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      storeId: user.store_id || null,
      storeName: user.store_name || null,
      storeCode: user.store_code || null,
      storeCommissionPercent: user.store_commission_percent == null ? null : Number(user.store_commission_percent),
      csrf,
      exp: Date.now() + 12 * 60 * 60 * 1000
    });
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `postal_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`
    );
    await audit({ user: { userId:user.id, storeId:user.store_id, email:user.email } }, "LOGIN", "USER", user.id);
    res.json({
      ok: true,
      csrfToken: csrf,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        storeId: user.store_id || null,
        storeName: user.store_name || null
      }
    });
  } catch (error) {
    console.error("login error:", error.message);
    res.status(500).json({ error: "Não foi possível entrar no sistema." });
  }
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "postal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => {
  res.json({
    ok: true,
    csrfToken: req.user.csrf,
    user: {
      id: req.user.userId,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      storeId: req.user.storeId || null,
      storeName: req.user.storeName || null,
      storeCode: req.user.storeCode || null
    }
  });
});

// CSRF para mutações autenticadas do painel. Webhooks e API externa usam autenticação própria.
app.use("/api", (req, res, next) => {
  if (!["POST","PUT","PATCH","DELETE"].includes(req.method)) return next();
  if (req.path.startsWith("/webhooks/") || req.path.startsWith("/integrations/")) return next();

  const session = verifySession(parseCookies(req).postal_session);
  if (!session) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  const received = String(req.get("x-csrf-token") || "");
  const expected = String(session.csrf || "");
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (!received || a.length !== b.length || !crypto.timingSafeEqual(a,b)) {
    return res.status(403).json({ error: "Sessão de segurança inválida. Atualize a página e tente novamente." });
  }
  req.user = session;
  next();
});

app.get("/api/admin/overview", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    const overview = await db.adminOverview();
    res.json({
      activeStores: Number(overview.active_stores || 0),
      activeUsers: Number(overview.active_users || 0),
      totalOrders: Number(overview.total_orders || 0),
      pendingPayments: Number(overview.pending_payments || 0),
      labelsAvailable: Number(overview.labels_available || 0),
      grossSales: Number(overview.gross_sales || 0),
      pointRevenue: Number(overview.point_revenue || 0),
      postalRevenue: Number(overview.postal_revenue || 0)
    });
  } catch (error) {
    res.status(500).json({ error: "Não foi possível carregar o painel master." });
  }
});

app.get("/api/admin/stores", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    const stores = await db.listStores();
    res.json({ stores: stores.map(store => ({
      id: store.id, code: store.code, name: store.name, legalName: store.legal_name || "",
      cnpj: store.cnpj || "", phone: store.phone || "", email: store.email || "",
      address: store.address || {}, commissionPercent: Number(store.commission_percent || 0),
      active: Boolean(store.active), activeUsers: Number(store.active_users || 0),
      totalOrders: Number(store.total_orders || 0), grossSales: Number(store.gross_sales || 0)
    })) });
  } catch (error) {
    res.status(500).json({ error: "Não foi possível carregar os pontos." });
  }
});

app.post("/api/admin/stores", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g,"");
    const name = String(body.name || "").trim();
    const commissionPercent = Number(body.commissionPercent ?? 20);
    if (!code || !name) return res.status(400).json({ error: "Código e nome do ponto são obrigatórios." });
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50) {
      return res.status(400).json({ error: "A comissão do ponto deve estar entre 0% e 50%." });
    }
    const store = await db.createStore({
      code,name,legalName:body.legalName,cnpj:cleanDigits(body.cnpj),phone:body.phone,email:body.email,
      address:body.address||{},commissionPercent,active:body.active!==false
    });
    await audit(req,"CREATE_STORE","STORE",store.id,{code:store.code});
    res.status(201).json({ store });
  } catch (error) {
    if (String(error.message).includes("duplicate key")) return res.status(409).json({ error: "Já existe um ponto com esse código." });
    res.status(500).json({ error: "Não foi possível cadastrar o ponto." });
  }
});

app.patch("/api/admin/stores/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const commissionPercent = req.body.commissionPercent == null ? undefined : Number(req.body.commissionPercent);
    if (commissionPercent != null && (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50)) {
      return res.status(400).json({ error: "Comissão inválida." });
    }
    const store = await db.updateStore(req.params.id,{...req.body,commissionPercent});
    if(!store) return res.status(404).json({error:"Ponto não encontrado."});
    await audit(req,"UPDATE_STORE","STORE",store.id,{active:store.active,commissionPercent:Number(store.commission_percent)});
    res.json({store});
  } catch(error){ res.status(500).json({error:"Não foi possível atualizar o ponto."}); }
});

app.get("/api/admin/users", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  try { res.json({users:await db.listUsers()}); }
  catch(error){ res.status(500).json({error:"Não foi possível carregar os usuários."}); }
});

app.post("/api/admin/users", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const body=req.body||{};
    const email=String(body.email||"").trim().toLowerCase();
    const name=String(body.name||"").trim();
    const role=String(body.role||"STORE_CLERK").toUpperCase();
    const password=String(body.password||"");
    if(!email||!name||password.length<6) return res.status(400).json({error:"Nome, e-mail e senha com ao menos 6 caracteres são obrigatórios."});
    if(!["ADMIN","STORE_OWNER","STORE_CLERK","OPS"].includes(role)) return res.status(400).json({error:"Perfil inválido."});
    if(role!=="ADMIN" && !body.storeId) return res.status(400).json({error:"Selecione o ponto deste usuário."});
    const user=await db.createUser({
      storeId:role==="ADMIN"?null:body.storeId,email,name,passwordHash:hashPassword(password),role,active:body.active!==false
    });
    await audit(req,"CREATE_USER","USER",user.id,{email:user.email,role:user.role,storeId:user.store_id});
    res.status(201).json({user:{id:user.id,email:user.email,name:user.name,role:user.role,storeId:user.store_id,active:user.active}});
  } catch(error){
    if(String(error.message).includes("duplicate key")) return res.status(409).json({error:"Já existe usuário com esse e-mail."});
    res.status(500).json({error:"Não foi possível cadastrar o usuário."});
  }
});

app.get("/api/admin/audit", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try { res.json({logs:await db.listAudit(Number(req.query.limit||100))}); }
  catch(error){ res.status(500).json({error:"Não foi possível carregar a auditoria."}); }
});

app.get("/api/admin/catalog", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  try { res.json({items:await db.listCatalogItems({activeOnly:false})}); }
  catch(error){ res.status(500).json({error:"Não foi possível carregar o catálogo central."}); }
});

app.put("/api/admin/catalog/:code", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const body=req.body||{};
    const itemType=String(body.itemType||"PRODUCT").toUpperCase();
    const name=String(body.name||"").trim();
    const code=String(req.params.code||"").trim().toUpperCase();
    if(!name||!code||!["PRODUCT","SERVICE"].includes(itemType)) return res.status(400).json({error:"Código, nome e tipo válidos são obrigatórios."});
    const shares=[Number(body.pointSharePercent||0),Number(body.postalSharePercent||0),Number(body.providerSharePercent||0)];
    if(shares.some(v=>!Number.isFinite(v)||v<0)||shares.reduce((a,b)=>a+b,0)>100.0001) return res.status(400).json({error:"Divisão financeira inválida."});
    const item=await db.upsertCatalogItem({
      code,itemType,category:String(body.category||"OUTROS").toUpperCase(),name,description:body.description||"",
      unitPrice:Number(body.unitPrice||0),costPrice:Number(body.costPrice||0),trackStock:Boolean(body.trackStock),
      pointSharePercent:shares[0],postalSharePercent:shares[1],providerSharePercent:shares[2],
      externalProvider:body.externalProvider||null,externalRef:body.externalRef||null,active:body.active!==false,metadata:body.metadata||{}
    });
    await audit(req,"UPSERT_CATALOG_ITEM","CATALOG_ITEM",item.id,{code:item.code,itemType:item.item_type});
    res.json({item});
  } catch(error){ res.status(500).json({error:"Não foi possível salvar o item."}); }
});

app.get("/api/admin/credit/partners", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  try { res.json({partners:await db.listCreditPartners()}); }
  catch(error){ res.status(500).json({error:"Não foi possível carregar parceiros de crédito."}); }
});

app.post("/api/admin/credit/partners", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const body=req.body||{};
    if(!body.code||!body.name) return res.status(400).json({error:"Código e nome são obrigatórios."});
    const partner=await db.upsertCreditPartner({
      code:String(body.code).trim().toUpperCase(),name:String(body.name).trim(),
      integrationMode:String(body.integrationMode||"MANUAL").toUpperCase(),apiBaseUrl:body.apiBaseUrl||null,
      active:body.active!==false,metadata:body.metadata||{}
    });
    await audit(req,"UPSERT_CREDIT_PARTNER","CREDIT_PARTNER",partner.id,{code:partner.code});
    res.json({partner});
  } catch(error){ res.status(500).json({error:"Não foi possível salvar o parceiro."}); }
});

app.get("/api/admin/credit/products", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  try { res.json({products:await db.listCreditProducts(false)}); }
  catch(error){ res.status(500).json({error:"Não foi possível carregar produtos de crédito."}); }
});

app.post("/api/admin/credit/products", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const body=req.body||{};
    if(!body.partnerId||!body.code||!body.name) return res.status(400).json({error:"Parceiro, código e nome são obrigatórios."});
    const product=await db.upsertCreditProduct({
      partnerId:body.partnerId,code:String(body.code).trim().toUpperCase(),name:String(body.name).trim(),
      description:body.description||"",minAmount:Number(body.minAmount||0)||null,maxAmount:Number(body.maxAmount||0)||null,
      pointCommissionPercent:Number(body.pointCommissionPercent||0),postalCommissionPercent:Number(body.postalCommissionPercent||0),
      active:body.active!==false,metadata:body.metadata||{}
    });
    await audit(req,"UPSERT_CREDIT_PRODUCT","CREDIT_PRODUCT",product.id,{code:product.code});
    res.json({product});
  } catch(error){ res.status(500).json({error:"Não foi possível salvar o produto de crédito."}); }
});

app.get("/api/credit/products", requireAuth, async (_req,res)=>{
  try {
    const products=await db.listCreditProducts(true);
    res.json({products:products.map(p=>({
      id:p.id,code:p.code,name:p.name,description:p.description||"",partnerName:p.partner_name,
      minAmount:Number(p.min_amount||0),maxAmount:Number(p.max_amount||0),
      pointCommissionPercent:Number(p.point_commission_percent||0)
    }))});
  } catch(error){ res.status(500).json({error:"Não foi possível carregar as ofertas."}); }
});

app.get("/api/credit/proposals", requireAuth, async (req,res)=>{
  try {
    const proposals=await db.listCreditProposals(req.user.role==="ADMIN"?{}:{storeId:req.user.storeId||null});
    res.json({proposals});
  } catch(error){ res.status(500).json({error:"Não foi possível carregar as propostas."}); }
});

app.post("/api/credit/proposals", requireAuth, async (req,res)=>{
  try {
    const body=req.body||{};
    const applicantName=String(body.applicantName||"").trim();
    const document=cleanDigits(body.document);
    const requestedAmount=Number(body.requestedAmount||0);
    if(!body.productId||!applicantName||document.length<11||!Number.isFinite(requestedAmount)||requestedAmount<=0||body.consent!==true){
      return res.status(400).json({error:"Preencha os dados da proposta e confirme o consentimento."});
    }
    const documentHash=crypto.createHash("sha256").update(document).digest("hex");
    const proposal=await db.createCreditProposal({
      storeId:req.user.storeId||null,userId:req.user.userId||null,productId:body.productId,
      applicantName,documentHash,documentLast4:document.slice(-4),phone:String(body.phone||""),
      requestedAmount,status:"LEAD",metadata:{source:"BALCAO"}
    });
    await audit(req,"CREATE_CREDIT_LEAD","CREDIT_PROPOSAL",proposal.id,{productId:body.productId,requestedAmount});
    res.status(201).json({proposal:{id:proposal.id,status:proposal.status,createdAt:proposal.created_at}});
  } catch(error){ res.status(500).json({error:"Não foi possível registrar a proposta."}); }
});

/**
 * COTAÇÃO
 * ConectEnvios:
 * POST /package/shipping
 * {
 *   type: "box",
 *   weight: 1000,  // gramas
 *   width: 15,
 *   height: 10,
 *   length: 20,
 *   cep_from: "68515000",
 *   cep_to: "01310100"
 * }
 */
app.post("/api/cotacao", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const required = ["cepOrigem", "cepDestino", "peso", "comprimento", "largura", "altura"];
    const missing = required.filter(k => body[k] == null || String(body[k]).trim() === "");
    if (missing.length) return res.status(400).json({ error: `Preencha: ${missing.join(", ")}` });

    const cepFrom = String(body.cepOrigem).replace(/\D/g, "");
    const cepTo = String(body.cepDestino).replace(/\D/g, "");
    if (cepFrom.length !== 8 || cepTo.length !== 8) {
      return res.status(400).json({ error: "CEP de origem e destino devem ter 8 dígitos." });
    }

    // A interface trabalha em kg; a ConectEnvios espera gramas.
    const weightGrams = toPositiveInteger(Number(body.peso) * 1000, "Peso");
    const width = toPositiveInteger(body.largura, "Largura");
    const height = toPositiveInteger(body.altura, "Altura");
    const length = toPositiveInteger(body.comprimento, "Comprimento");

    let providerData;
    let demo = false;

    if (!TOKEN) {
      providerData = { error: false, data: demoQuote(body) };
      demo = true;
    } else {
      const result = await providerFetch("/package/shipping", {
        method: "POST",
        body: JSON.stringify({
          type: "box",
          weight: weightGrams,
          width,
          height,
          length,
          cep_from: cepFrom,
          cep_to: cepTo,
          addr_from_cep: cepFrom,
          addr_to_cep: cepTo
        }),
        timeout: 25000
      });
      providerData = result.data;

      if (providerData && providerData.error === true) {
        console.error("ConectEnvios quote error:", providerData);
        return res.status(422).json({ error: "A unidade de frete retornou erro ao calcular." });
      }
    }

    let partnerCommissionRate = PARTNER_COMMISSION;
    if (req.user.storeId) {
      const store = await db.getStore(req.user.storeId);
      if (store?.commission_percent != null) {
        partnerCommissionRate = Math.max(0, Math.min(0.50, Number(store.commission_percent) / 100));
      }
    }
    const options = normalizeQuote(providerData, partnerCommissionRate).map(option => {
      const selectionToken = signSelectionToken({
        exp: Date.now() + 2 * 60 * 60 * 1000,
        postalCompanyId: option.postalCompanyId,
        service: option.produto,
        deadline: option.prazoEntrega,
        salePrice: option.precoVenda,
        partnerCommission: option.comissaoParceiro,
        providerCost: option.providerCost,
        postalMargin: option.postalMargin,
        package: {
          weightGrams, width, height, length, cepFrom, cepTo,
          declaredValue: Number(body.vlDeclarado || 0)
        }
      });

      return {
        postalCompanyId: option.postalCompanyId,
        transportadora: option.transportadora,
        produto: option.produto,
        codigoServico: option.codigoServico,
        prazoEntrega: option.prazoEntrega,
        precoVenda: option.precoVenda,
        comissaoParceiro: option.comissaoParceiro,
        selectionToken
      };
    });
    if (!options.length) {
      return res.status(422).json({ error: "Nenhuma opção de envio disponível para os dados informados." });
    }

    res.json({
      demo,
      provider: "ConectEnvios",
      commissionPercent: round2(partnerCommissionRate * 100),
      options
    });
  } catch (error) {
    console.error("quote error:", error.status, error.providerData || error.message);
    res.status(error.status === 401 ? 502 : 502).json({
      error: error.status === 401
        ? "Token da ConectEnvios nao autorizado."
        : (error.message || "Falha ao consultar os servicos de frete.")
    });
  }
});

// Consulta endereco por CEP.
app.get("/api/cep/:cep", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const cep = String(req.params.cep || "").replace(/\D/g, "");
    const result = await providerFetch(`/cep/address/?cep=${encodeURIComponent(cep)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("cep error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar CEP." });
  }
});

// Lista transportadoras habilitadas para a conta.
app.get("/api/transportadoras", requireAuth, async (_req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const result = await providerFetch("/postal_company", { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("postal company error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao listar transportadoras." });
  }
});

// Simulacao isolada de prazo.
app.post("/api/prazo", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const cepFrom = String(req.body.cepOrigem || "").replace(/\D/g, "");
    const cepTo = String(req.body.cepDestino || "").replace(/\D/g, "");
    const result = await providerFetch("/package/deadline", {
      method: "POST",
      body: JSON.stringify({ cep_from: cepFrom, cep_to: cepTo })
    });
    res.json(result.data);
  } catch (error) {
    console.error("deadline error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar prazo." });
  }
});

app.get("/api/catalog", requireAuth, async (req, res) => {
  try {
    const items = await db.getPartnerCatalog(inventoryOwner(req.user));
    res.json({
      items: items.map(item => ({
        code: item.code,
        itemType: item.item_type,
        category: item.category,
        name: item.name,
        description: item.description || "",
        unitPrice: Number(item.effective_unit_price ?? item.unit_price ?? 0),
        trackStock: Boolean(item.track_stock),
        stockQuantity: Number(item.stock_quantity || 0),
        reservedQuantity: Number(item.reserved_quantity || 0),
        availableQuantity: Number(item.available_quantity || 0),
        minQuantity: Number(item.min_quantity || 0),
        externalProvider: item.external_provider || "",
        metadata: item.metadata || {}
      }))
    });
  } catch (error) {
    console.error("catalog error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar produtos e serviços." });
  }
});

app.post("/api/payment-preview", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const selection = verifySelectionToken(body.selectionToken);
    if (!selection || !Number.isFinite(Number(selection.providerCost))) {
      return res.status(400).json({ error: "A cotação expirou. Calcule o frete novamente." });
    }

    const paymentMethod = String(body.paymentMethod || "").toUpperCase();
    if (!["PIX", "CARTAO", "DINHEIRO"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Selecione a forma de pagamento." });
    }

    const addons = await resolveRequestedAddons(inventoryOwner(req.user), body.addons);
    const financials = summarizeFinancials(selection, addons, paymentMethod);

    res.json({
      freightPrice: financials.freightPrice,
      addonsTotal: financials.addonsTotal,
      subtotal: financials.customerSubtotal,
      paymentFee: financials.paymentSurcharge,
      total: financials.totalToCustomer,
      pointRevenue: financials.pointRevenueTotal,
      cashRemittance: paymentMethod === "DINHEIRO"
        ? round2(financials.cashRemittanceBase + financials.paymentSurcharge)
        : 0
    });
  } catch (error) {
    console.error("payment preview error:", error.message);
    res.status(400).json({ error: error.message || "Não foi possível calcular o pagamento." });
  }
});

app.get("/api/inventory", requireAuth, async (req, res) => {
  try {
    const items = await db.getPartnerCatalog(inventoryOwner(req.user));
    res.json({
      items: items.map(item => ({
        code: item.code,
        itemType: item.item_type,
        category: item.category,
        name: item.name,
        description: item.description || "",
        trackStock: Boolean(item.track_stock),
        unitPrice: Number(item.effective_unit_price ?? item.unit_price ?? 0),
        stockQuantity: Number(item.stock_quantity || 0),
        reservedQuantity: Number(item.reserved_quantity || 0),
        availableQuantity: Number(item.available_quantity || 0),
        minQuantity: Number(item.min_quantity || 0)
      }))
    });
  } catch (error) {
    console.error("inventory error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar o estoque." });
  }
});

app.post("/api/inventory/receive", requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const quantity = Number(req.body.quantity || 0);
    const salePrice = req.body.salePrice === "" || req.body.salePrice == null ? null : Number(req.body.salePrice);
    if (!code || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Informe produto e quantidade válida." });
    }
    if (salePrice != null && (!Number.isFinite(salePrice) || salePrice < 0)) {
      return res.status(400).json({ error: "Preço de venda inválido." });
    }

    const item = await db.getCatalogItemByCode(code);
    if (!item || !item.active) return res.status(404).json({ error: "Produto não encontrado." });
    if (!item.track_stock) return res.status(400).json({ error: "Este item não controla estoque físico." });

    const inventory = await db.receiveInventory(
      inventoryOwner(req.user),
      item.id,
      quantity,
      String(req.body.note || "Recebimento pelo ponto"),
      salePrice
    );
    res.json({ ok: true, inventory });
  } catch (error) {
    console.error("receive inventory error:", error.message);
    res.status(500).json({ error: "Não foi possível receber o estoque." });
  }
});

app.post("/api/inventory/adjust", requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const quantity = Number(req.body.quantity || 0);
    const minQuantity = Math.max(0, Number(req.body.minQuantity || 0));
    const salePrice = req.body.salePrice === "" || req.body.salePrice == null ? null : Number(req.body.salePrice);
    if (!code || !Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ error: "Informe produto e estoque atual válido." });
    }

    const item = await db.getCatalogItemByCode(code);
    if (!item || !item.active) return res.status(404).json({ error: "Produto não encontrado." });
    if (!item.track_stock) return res.status(400).json({ error: "Este item não controla estoque físico." });

    const inventory = await db.setInventory(
      inventoryOwner(req.user),
      item.id,
      quantity,
      minQuantity,
      String(req.body.note || "Ajuste pelo ponto"),
      salePrice
    );
    res.json({ ok: true, inventory });
  } catch (error) {
    console.error("adjust inventory error:", error.message);
    res.status(500).json({ error: "Não foi possível ajustar o estoque." });
  }
});

// API versionada para futuras integrações de produtos, serviços e ofertas financeiras.
app.get("/api/integrations/v1/catalog/items", requireIntegrationAuth, async (req, res) => {
  try {
    const itemType = req.query.type ? String(req.query.type).toUpperCase() : null;
    const items = await db.listCatalogItems({ itemType, activeOnly: false });
    res.json({ version: "v1", items });
  } catch (error) {
    res.status(500).json({ error: "Falha ao consultar catálogo." });
  }
});

app.put("/api/integrations/v1/catalog/items/:code", requireIntegrationAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(req.params.code || "").trim();
    const name = String(body.name || "").trim();
    if (!code || !name) {
      return res.status(400).json({ error: "Código e nome são obrigatórios." });
    }
    const itemType = String(body.itemType || "PRODUCT").toUpperCase();
    if (!["PRODUCT", "SERVICE"].includes(itemType)) {
      return res.status(400).json({ error: "itemType deve ser PRODUCT ou SERVICE." });
    }
    const pointShare = Number(body.pointSharePercent ?? (itemType === "PRODUCT" ? 100 : 0));
    const postalShare = Number(body.postalSharePercent ?? 0);
    const providerShare = Number(body.providerSharePercent ?? 0);
    if ([pointShare, postalShare, providerShare].some(v => !Number.isFinite(v) || v < 0) ||
        pointShare + postalShare + providerShare > 100.0001) {
      return res.status(400).json({ error: "Divisão financeira inválida." });
    }

    const item = await db.upsertCatalogItem({
      code,
      itemType,
      category: String(body.category || "OUTROS").toUpperCase(),
      name,
      description: String(body.description || ""),
      unitPrice: Number(body.unitPrice || 0),
      costPrice: Number(body.costPrice || 0),
      trackStock: Boolean(body.trackStock),
      pointSharePercent: pointShare,
      postalSharePercent: postalShare,
      providerSharePercent: providerShare,
      externalProvider: body.externalProvider || null,
      externalRef: body.externalRef || null,
      active: body.active !== false,
      metadata: body.metadata || {}
    });
    res.json({ ok: true, version: "v1", item });
  } catch (error) {
    console.error("integration catalog upsert error:", error.message);
    res.status(500).json({ error: "Falha ao salvar item." });
  }
});

app.post("/api/integrations/v1/inventory/receive", requireIntegrationAuth, async (req, res) => {
  try {
    const partnerEmail = String(req.body.partnerEmail || "").trim();
    const code = String(req.body.code || "").trim();
    const quantity = Number(req.body.quantity || 0);
    if (!partnerEmail || !code || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "partnerEmail, code e quantity são obrigatórios." });
    }
    const item = await db.getCatalogItemByCode(code);
    if (!item || !item.track_stock) return res.status(404).json({ error: "Produto de estoque não encontrado." });
    const inventory = await db.receiveInventory(
      partnerEmail,
      item.id,
      quantity,
      String(req.body.note || "Recebimento via integração"),
      req.body.salePrice == null ? null : Number(req.body.salePrice)
    );
    res.json({ ok: true, version: "v1", inventory });
  } catch (error) {
    console.error("integration inventory receive error:", error.message);
    res.status(500).json({ error: "Falha ao registrar estoque." });
  }
});

app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const orders = await db.listOrdersScoped(scopeForUser(req.user), Number(req.query.limit || 100));
    res.json({ orders: orders.map(publicOrder) });
  } catch (error) {
    console.error("list orders error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar Meus Fretes." });
  }
});

app.get("/api/orders/:id", requireAuth, async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id, scopeForUser(req.user));
    if (!order) return res.status(404).json({ error: "Frete não encontrado." });
    res.json({ order: publicOrder(order) });
  } catch (error) {
    console.error("get order error:", error.message);
    res.status(503).json({ error: "Não foi possível consultar o frete." });
  }
});

app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const selection = verifySelectionToken(body.selectionToken);
    if (!selection || !Number.isFinite(Number(selection.providerCost))) {
      return res.status(400).json({ error: "A cotação expirou. Calcule o frete novamente." });
    }

    const paymentMethod = String(body.paymentMethod || "").toUpperCase();
    if (!["PIX", "CARTAO", "DINHEIRO"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Selecione PIX, cartão ou dinheiro." });
    }

    const sender = body.sender || {};
    const recipient = body.recipient || {};
    const items = Array.isArray(body.items) ? body.items : [];
    validateFreightParties(sender, recipient, items);

    if (cleanDigits(sender.cep) !== selection.package.cepFrom || cleanDigits(recipient.cep) !== selection.package.cepTo) {
      return res.status(400).json({ error: "Os CEPs mudaram após a cotação. Calcule novamente." });
    }

    const addons = await resolveRequestedAddons(inventoryOwner(req.user), body.addons);
    const financials = summarizeFinancials(selection, addons, paymentMethod);

    const salePrice = round2(Number(selection.salePrice));
    const partnerCommission = round2(Number(selection.partnerCommission));
    const providerCost = round2(Number(selection.providerCost));
    const postalMargin = round2(Math.max(0, salePrice - partnerCommission - providerCost));
    const orderId = crypto.randomUUID();
    const invoiceNumber = String(body.invoiceNumber || "").trim();
    const partner = await db.ensurePartner(req.user.email);
    const partnerWalletId = String(partner?.asaas_wallet_id || ASAAS_DEFAULT_PARTNER_WALLET_ID || "").trim();

    const baseOrder = {
      id: orderId,
      storeId: req.user.storeId || null,
      partnerEmail: req.user.email,
      paymentMethod,
      paymentProvider: paymentMethod === "DINHEIRO" ? "CASH" : "ASAAS",
      salePrice,
      addonsTotal: financials.addonsTotal,
      customerSubtotal: financials.customerSubtotal,
      pointRevenueTotal: financials.pointRevenueTotal,
      postalRevenueTotal: financials.postalRevenueTotal,
      providerRevenueTotal: financials.providerRevenueTotal,
      partnerCommission,
      postalMargin,
      providerCost,
      postalCompanyId: selection.postalCompanyId,
      carrier: String(body.carrier || ""),
      serviceName: String(selection.service || ""),
      deadline: Number(selection.deadline || 0),
      quoteToken: body.selectionToken,
      sender,
      recipient,
      items,
      invoiceNumber,
      packageData: selection.package
    };

    if (paymentMethod === "DINHEIRO") {
      const order = await db.insertOrder({
        ...baseOrder,
        status: "CASH_REMITTANCE_PENDING",
        paymentStatus: "CASH_AT_POINT",
        paymentAmount: financials.totalToCustomer,
        paymentSurcharge: financials.paymentSurcharge,
        cashRemittanceAmount: financials.cashRemittanceBase
      });

      await db.insertOrderAddons(order.id, inventoryOwner(req.user), addons);
      await db.consumeOrderInventory(order.id, inventoryOwner(req.user));
      await db.addOrderEvent(order.id, "ORDER_CREATED", "Frete registrado", "Pagamento em dinheiro recebido pelo ponto.");

      const complete = await db.getOrder(order.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrder(complete),
        nextAction: "PAY_REMITTANCE",
        message: "Dinheiro registrado. A comissão do ponto foi preservada e a etiqueta aguarda o repasse."
      });
    }

    const order = await db.insertOrder({
      ...baseOrder,
      status: "PAYMENT_SETUP_PENDING",
      paymentStatus: "PENDING",
      paymentAmount: financials.totalToCustomer,
      paymentSurcharge: financials.paymentSurcharge,
      cashRemittanceAmount: 0
    });

    await db.insertOrderAddons(order.id, inventoryOwner(req.user), addons);
    await db.addOrderEvent(order.id, "ORDER_CREATED", "Frete registrado", "Aguardando confirmação financeira.");

    if (!asaas.configured()) {
      if (PAYMENT_SIMULATOR_ENABLED) {
        await db.updateStatus(order.id, "SIMULATED_PAYMENT_PENDING", "PENDING");
        await db.addOrderEvent(order.id, "PAYMENT_SIMULATOR", "Pagamento de homologação pendente", "Use o simulador para confirmar o pagamento sem movimentar dinheiro.");
        const complete = await db.getOrder(order.id, scopeForUser(req.user));
        return res.status(201).json({
          order: publicOrder(complete),
          nextAction: "SIMULATE_PAYMENT",
          message: "Pagamento salvo em modo homologação."
        });
      }
      const complete = await db.getOrder(order.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrder(complete),
        paymentSetupRequired: true,
        message: "Asaas ainda precisa da chave de API para liberar cobranças."
      });
    }

    if (!partnerWalletId) {
      const pending = await db.updateStatus(order.id, "PARTNER_FINANCIAL_SETUP_REQUIRED", "PENDING");
      const complete = await db.getOrder(pending.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrder(complete),
        paymentSetupRequired: true,
        message: "Este ponto ainda não possui carteira Asaas vinculada para receber sua parte automaticamente."
      });
    }

    const checkout = await asaas.createCheckout({
      orderId,
      billingType: paymentMethod,
      amount: financials.customerSubtotal,
      itemName: "Postal Balcão",
      itemDescription: String(body.carrier || "") + " - " + String(selection.service || ""),
      partnerWalletId,
      reserveWalletId: ASAAS_RESERVE_WALLET_ID || null,
      partnerCommission: financials.pointRevenueTotal,
      providerCost: financials.providerRevenueTotal,
      customerData: {
        name: sender.name,
        cpfCnpj: sender.document,
        email: sender.email,
        phone: sender.phone
      }
    });

    const updated = await db.setCheckout(order.id, {
      checkoutId: checkout.id,
      checkoutUrl: checkout.url,
      paymentAmount: checkout.grossAmount,
      surcharge: checkout.surcharge,
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING"
    });

    const complete = await db.getOrder(updated.id, req.user.email);
    res.status(201).json({
      order: publicOrder(complete),
      checkoutUrl: checkout.url,
      nextAction: "OPEN_CHECKOUT"
    });
  } catch (error) {
    console.error("create order error:", error.status, error.providerData || error.message);
    res.status(error.status && error.status < 500 ? error.status : 500).json({
      error: error.message || "Não foi possível iniciar o pagamento do frete."
    });
  }
});

app.post("/api/orders/:id/remittance", requireAuth, async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id, req.user.email);
    if (!order) return res.status(404).json({ error: "Frete não encontrado." });
    if (order.payment_method !== "DINHEIRO") return res.status(400).json({ error: "Este frete não é de pagamento em dinheiro." });
    if (order.status === "LABEL_AVAILABLE") return res.json({ order: publicOrder(order), alreadyPaid: true });
    if (order.payment_checkout_url && order.payment_status === "PENDING") {
      return res.json({ order: publicOrder(order), checkoutUrl: order.payment_checkout_url });
    }
    if (!asaas.configured()) {
      if (PAYMENT_SIMULATOR_ENABLED) {
        const updated = await db.updateStatus(order.id, "SIMULATED_REMITTANCE_PENDING", "PENDING");
        await db.addOrderEvent(order.id, "REMITTANCE_SIMULATOR", "Repasse de homologação pendente", "Use o simulador para confirmar o repasse sem movimentar dinheiro.");
        const complete = await db.getOrder(updated.id, scopeForUser(req.user));
        return res.json({ order: publicOrder(complete), simulator: true });
      }
      return res.status(503).json({ error: "Asaas ainda não configurado." });
    }

    const remittanceBase = round2(Number(order.cash_remittance_amount || 0));
    const checkout = await asaas.createCheckout({
      orderId: order.id,
      billingType: "PIX",
      amount: remittanceBase,
      itemName: "Repasse de frete Postal",
      itemDescription: "Repasse do ponto com comissão já descontada",
      partnerWalletId: null,
      reserveWalletId: ASAAS_RESERVE_WALLET_ID || null,
      partnerCommission: 0,
      providerCost: Number(order.provider_revenue_total || order.provider_cost || 0),
      customerData: null
    });

    const updated = await db.setCheckout(order.id, {
      checkoutId: checkout.id,
      checkoutUrl: checkout.url,
      paymentAmount: checkout.grossAmount,
      surcharge: checkout.surcharge,
      status: "CASH_REMITTANCE_PAYMENT_PENDING",
      paymentStatus: "PENDING"
    });

    res.json({ order: publicOrder(updated), checkoutUrl: checkout.url });
  } catch (error) {
    console.error("cash remittance error:", error.status, error.providerData || error.message);
    res.status(500).json({ error: error.message || "Não foi possível gerar o repasse." });
  }
});

app.post("/api/orders/:id/simulate-payment", requireAuth, async (req, res) => {
  try {
    if (!PAYMENT_SIMULATOR_ENABLED || asaas.configured()) {
      return res.status(403).json({ error: "Simulador indisponível fora do ambiente de homologação." });
    }

    const order = await db.getOrder(req.params.id, scopeForUser(req.user));
    if (!order) return res.status(404).json({ error: "Frete não encontrado." });
    const allowed = new Set([
      "SIMULATED_PAYMENT_PENDING",
      "SIMULATED_REMITTANCE_PENDING",
      "PAYMENT_SETUP_PENDING",
      "CASH_REMITTANCE_PENDING"
    ]);
    if (!allowed.has(order.status)) {
      return res.status(400).json({ error: "Este frete não está aguardando um pagamento simulável." });
    }

    const paid = await db.markPaid(order.id, "PAYMENT_CONFIRMED");
    if (order.payment_method !== "DINHEIRO") {
      await db.consumeOrderInventory(order.id, inventoryOwnerFromOrder(order));
    }
    await db.addOrderEvent(order.id, "PAYMENT_CONFIRMED", "Pagamento homologado", "Confirmação simulada, sem movimentação financeira real.");

    const tracking = "SIM" + order.id.replace(/-/g,"").slice(0,10).toUpperCase();
    await db.saveSimulatedShipment(order.id, tracking);
    await db.addOrderEvent(order.id, "LABEL_AVAILABLE_SIMULATED", "Etiqueta de teste liberada", "Documento somente para homologação; não é uma postagem real.");

    const complete = await db.getOrder(order.id, scopeForUser(req.user));
    await audit(req, "SIMULATE_PAYMENT", "FREIGHT_ORDER", order.id, { paymentMethod: order.payment_method });
    res.json({ ok:true, order: publicOrder(complete) });
  } catch (error) {
    console.error("simulate payment error:", error.message);
    res.status(500).json({ error: error.message || "Não foi possível simular o pagamento." });
  }
});

/**
 * CRIACAO DO ENVIO
 * POST /cart
 *
 * Mantido bloqueado por padrao ate homologacao.
 * O body recebido pelo frontend deve seguir o formato ConectEnvios:
 * { package: [ ... ] }
 */
app.post("/api/envios", requireAuth, (_req, res) => {
  res.status(410).json({
    error: "A geração direta de etiqueta foi desativada. Crie o frete em Meus Fretes e conclua o pagamento primeiro."
  });
});


// Consulta carrinho.
app.get("/api/carrinhos/:id", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const result = await providerFetch(`/cart/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("cart detail error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar carrinho." });
  }
});

// Consulta pacote individual.
app.get("/api/envios/:id", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const result = await providerFetch(`/package/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("package detail error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar envio." });
  }
});

// Rastreamento pelo ID interno do pacote.
app.get("/api/rastreio/id/:id", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const result = await providerFetch(`/package/track/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("track by id error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao rastrear envio." });
  }
});

// Rastreamento pelo codigo da etiqueta.
app.get("/api/rastreio/codigo/:stamp", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });
  try {
    const result = await providerFetch(`/package/track/stamp/${encodeURIComponent(req.params.stamp)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("track by stamp error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao rastrear envio." });
  }
});

app.post("/api/webhooks/asaas", async (req, res) => {
  try {
    const receivedToken = req.get("asaas-access-token");
    if (!asaas.webhookConfigured() || !asaas.safeCompareToken(receivedToken)) {
      return res.status(401).json({ error: "Webhook não autorizado." });
    }

    const payload = req.body || {};
    const eventId = String(payload.id || "");
    const eventType = String(payload.event || "");
    const checkoutId = String(payload.checkout?.id || "");
    if (!eventId || !eventType) return res.status(400).json({ error: "Evento inválido." });

    const inserted = await db.insertWebhookEvent({
      id: eventId,
      provider: "ASAAS",
      eventType,
      checkoutId,
      payload
    });

    res.status(200).json({ ok: true, duplicate: !inserted });

    if (inserted) {
      setImmediate(() => {
        processPendingAsaasEvents().catch(error => console.error("webhook async error:", error.message));
      });
    }
  } catch (error) {
    console.error("Asaas webhook receive error:", error.message);
    res.status(500).json({ error: "Falha ao registrar webhook." });
  }
});

/**
 * Proxy seguro para URLs de impressao/declaracao retornadas pela ConectEnvios.
 * Em vez de expor o Bearer Token no navegador, o servidor busca o arquivo.
 */
app.post("/api/documento-proxy", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });

  try {
    const rawUrl = String(req.body.url || "");
    const allowedPrefix = `${API_URL}/package/`;

    if (!rawUrl.startsWith(allowedPrefix)) {
      return res.status(400).json({ error: "URL de documento invalida." });
    }

    const response = await fetch(rawUrl, {
      method: "GET",
      headers: providerHeaders(),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Nao foi possivel obter o documento." });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/pdf";
    res.type(contentType).send(buffer);
  } catch (error) {
    console.error("document proxy error:", error.message);
    res.status(502).json({ error: "Falha ao obter etiqueta ou declaracao." });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function seedDefaultCatalog() {
  const defaults = [
    { code: "CX-P", name: "Caixa pequena", category: "EMBALAGENS" },
    { code: "CX-M", name: "Caixa média", category: "EMBALAGENS" },
    { code: "CX-G", name: "Caixa grande", category: "EMBALAGENS" },
    { code: "ENV-PLASTICO", name: "Envelope plástico", category: "EMBALAGENS" },
    { code: "ENV-BOLHA", name: "Envelope com bolha", category: "EMBALAGENS" }
  ];

  for (const item of defaults) {
    const existing = await db.getCatalogItemByCode(item.code);
    if (existing) continue;
    await db.upsertCatalogItem({
      code: item.code,
      itemType: "PRODUCT",
      category: item.category,
      name: item.name,
      description: "Item de balcão com preço e estoque definidos pelo ponto.",
      unitPrice: 0,
      costPrice: 0,
      trackStock: true,
      pointSharePercent: 100,
      postalSharePercent: 0,
      providerSharePercent: 0,
      active: true,
      metadata: { source: "postal-default" }
    });
  }
}

async function start() {
  await db.initDb();
  await seedDefaultCatalog();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Postal Balcao V1.4 disponivel na porta ${PORT}`);
    console.log(`ConectEnvios: ${TOKEN ? "configurada" : "modo demonstracao"}`);
    console.log(`Asaas: ${asaas.configured() ? "configurado" : "aguardando chave"}`);
    console.log(`Banco: ${process.env.DATABASE_URL ? "PostgreSQL configurado" : "nao configurado"}`);
  });

  setInterval(() => {
    processPendingAsaasEvents().catch(error => console.error("webhook worker error:", error.message));
  }, 10000).unref();
}

start().catch(error => {
  console.error("Falha ao iniciar Postal Balcao:", error);
  process.exit(1);
});

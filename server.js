require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");

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
function requireAuth(req, res, next) {
  const session = verifySession(parseCookies(req).postal_session);
  if (!session) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  req.user = session;
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

function sellPriceFromCost(cost) {
  // A comissão do ponto e a margem Postal são percentuais do preço final.
  // Ex.: custo 68%, ponto 20%, Postal 12% = 100% do preço ao consumidor.
  const retainedShare = 1 - PARTNER_COMMISSION - POSTAL_MARGIN;
  if (retainedShare <= 0) throw new Error("Configuração de margens inválida.");
  const finalPrice = cost / retainedShare;
  const partnerCommission = finalPrice * PARTNER_COMMISSION;
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

function normalizeQuote(payload) {
  const items = extractShippingItems(payload);

  return items.map(item => {
    const cost = parseMoney(item.price_discounted ?? item.price ?? item.postal_service_price ?? item.value);
    if (!Number.isFinite(cost) || cost <= 0) return null;

    const pricing = sellPriceFromCost(cost);
    return {
      postalCompanyId: Number(item.postal_company_id ?? item.company_id ?? item.id ?? 0),
      transportadora: item.company_name ?? item.postal_company_name ?? item.company ?? "Transportadora",
      produto: item.name ?? item.service_name ?? item.postal_service_name ?? item.service ?? "Serviço",
      codigoServico: item.code ?? "",
      prazoEntrega: Number(item.deadline ?? item.postal_service_deadline ?? 0),
      precoVenda: pricing.salePrice,
      comissaoParceiro: pricing.partnerCommission
    };
  }).filter(Boolean).sort((a, b) => a.precoVenda - b.precoVenda);
}

function toPositiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} deve ser maior que zero.`);
  return Math.max(1, Math.round(n));
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
    shipmentCreationEnabled: ENABLE_SHIPMENT_CREATION
  });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (email !== APP_USER || password !== APP_PASSWORD) {
    return res.status(401).json({ error: "E-mail ou senha inválidos." });
  }

  const token = signSession({ email, exp: Date.now() + 12 * 60 * 60 * 1000 });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `postal_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`
  );
  res.json({ ok: true, user: { email } });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "postal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => {
  res.json({ ok: true, user: { email: req.user.email } });
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

    const options = normalizeQuote(providerData).map(option => ({
      ...option,
      selectionToken: signSelectionToken({
        exp: Date.now() + 2 * 60 * 60 * 1000,
        postalCompanyId: option.postalCompanyId,
        service: option.produto,
        deadline: option.prazoEntrega,
        salePrice: option.precoVenda,
        partnerCommission: option.comissaoParceiro,
        package: {
          weightGrams, width, height, length, cepFrom, cepTo,
          declaredValue: Number(body.vlDeclarado || 0)
        }
      })
    }));
    if (!options.length) {
      return res.status(422).json({ error: "Nenhuma opção de envio disponível para os dados informados." });
    }

    res.json({
      demo,
      provider: "ConectEnvios",
      commissionPercent: round2(PARTNER_COMMISSION * 100),
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

/**
 * CRIACAO DO ENVIO
 * POST /cart
 *
 * Mantido bloqueado por padrao ate homologacao.
 * O body recebido pelo frontend deve seguir o formato ConectEnvios:
 * { package: [ ... ] }
 */
app.post("/api/envios", requireAuth, async (req, res) => {
  if (!ENABLE_SHIPMENT_CREATION) {
    return res.status(403).json({
      error: "A emissão real ainda está em homologação."
    });
  }
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN não configurado." });

  try {
    const body = req.body || {};
    const selection = verifySelectionToken(body.selectionToken);
    if (!selection) {
      return res.status(400).json({ error: "A cotação expirou ou foi alterada. Calcule o frete novamente." });
    }

    if (!body.paymentConfirmed || !String(body.paymentMethod || "").trim()) {
      return res.status(400).json({ error: "Confirme o recebimento e a forma de pagamento antes de gerar a postagem." });
    }

    const sender = body.sender || {};
    const recipient = body.recipient || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const paymentMethod = String(body.paymentMethod || "").toUpperCase();
    const allowedPaymentMethods = ["PIX", "CARTAO", "DINHEIRO", "OUTRO"];
    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ error: "Selecione uma forma de pagamento valida." });
    }
    if (body.paymentConfirmed !== true) {
      return res.status(400).json({ error: "Confirme o recebimento do pagamento antes de gerar a postagem." });
    }
    const requiredPartyFields = ["name", "document", "phone", "cep", "address", "number", "neighborhood"];

    for (const [label, party] of [["remetente", sender], ["destinatário", recipient]]) {
      const missing = requiredPartyFields.filter(key => !String(party[key] || "").trim());
      if (missing.length) {
        return res.status(400).json({ error: "Preencha os dados obrigatórios do " + label + "." });
      }
    }

    if (!items.length || items.some(item => !String(item.description || "").trim() || Number(item.quantity) <= 0 || Number(item.value) < 0)) {
      return res.status(400).json({ error: "Informe ao menos um item válido no conteúdo da encomenda." });
    }

    if (cleanDigits(sender.cep) !== selection.package.cepFrom || cleanDigits(recipient.cep) !== selection.package.cepTo) {
      return res.status(400).json({ error: "Os CEPs mudaram depois da cotação. Calcule o frete novamente." });
    }

    const invoiceNumber = String(body.invoiceNumber || "").trim();
    const declaration = items.map(item => ({
      description: String(item.description).trim(),
      quantity: Math.max(1, Math.round(Number(item.quantity))),
      value: round2(Number(item.value || 0))
    }));

    const declaredFallback = declaration.reduce((sum, item) => sum + item.value * item.quantity, 0);
    const packageItem = {
      name: String(body.packageName || ("Envio Postal - " + sender.name + " para " + recipient.name)).slice(0, 120),
      type: "box",
      weight: selection.package.weightGrams,
      width: selection.package.width,
      height: selection.package.height,
      length: selection.package.length,
      extra_notify: true,
      extra_in_hand: false,
      extra_declared_value: round2(Number(selection.package.declaredValue || declaredFallback)),

      addr_from_document: cleanDigits(sender.document),
      addr_from_phone: cleanDigits(sender.phone),
      addr_from_name: String(sender.name).trim(),
      addr_from_cep: cleanDigits(sender.cep),
      addr_from_number: String(sender.number).trim(),
      addr_from_address: String(sender.address).trim(),
      addr_from_neighborhood: String(sender.neighborhood).trim(),
      addr_from_complement: String(sender.complement || "").trim(),

      addr_to_document: cleanDigits(recipient.document),
      addr_to_phone: cleanDigits(recipient.phone),
      addr_to_name: String(recipient.name).trim(),
      addr_to_cep: cleanDigits(recipient.cep),
      addr_to_number: String(recipient.number).trim(),
      addr_to_address: String(recipient.address).trim(),
      addr_to_neighborhood: String(recipient.neighborhood).trim(),
      addr_to_complement: String(recipient.complement || "").trim(),

      postal_service_name: selection.service,
      postal_company_id: Number(selection.postalCompanyId),
      declaration
    };

    if (invoiceNumber) packageItem.receipt = invoiceNumber;

    const result = await providerFetch("/cart", {
      method: "POST",
      body: JSON.stringify({ package: [packageItem] }),
      timeout: 45000
    });

    const providerPayload = result.data || {};
    if (providerPayload.error === true) {
      console.error("ConectEnvios create shipment provider error:", providerPayload);
      return res.status(422).json({ error: "A ConectEnvios recusou os dados da postagem. Revise os campos informados." });
    }

    const cart = providerPayload.data || providerPayload;
    const pkg = Array.isArray(cart.packages) ? cart.packages[0] : null;
    if (!pkg) {
      return res.status(502).json({ error: "A postagem foi processada, mas a API não retornou os dados do pacote." });
    }

    const postedAt = pkg.created_at || cart.created_at || new Date().toISOString();
    res.json({
      ok: true,
      cartId: cart.id || pkg.cart_id || null,
      packageId: pkg.id || null,
      trackingCode: pkg.postal_service_track || "",
      carrier: String(body.carrier || ""),
      service: pkg.postal_service_name || selection.service,
      deadline: Number(pkg.postal_service_deadline || selection.deadline || 0),
      salePrice: Number(selection.salePrice || 0),
      partnerCommission: Number(selection.partnerCommission || 0),
      paymentMethod: String(body.paymentMethod || ""),
      labelA4Url: pkg.api_print_url || cart.public_print_url || "",
      labelA6Url: pkg.api_print_url_a6 || "",
      labelUrl: pkg.api_print_url || "",
      labelUrlA6: pkg.api_print_url_a6 || "",
      publicPrintUrl: cart.public_print_url || "",
      declarationUrl: pkg.api_declaration_url || "",
      publicTrackingUrl: pkg.public_tracking_url || "",
      plpId: pkg.plp_id || "",
      cities: {
        from: pkg.addr_from_city_name || "",
        to: pkg.addr_to_city_name || ""
      },
      createdAt: postedAt,
      postedAt
    });
  } catch (error) {
    console.error("create shipment error:", error.status, error.providerData || error.message);
    const providerMessage = error.providerData?.message;
    res.status(error.status || 502).json({
      error: typeof providerMessage === "string" ? providerMessage : "Falha ao criar envio na ConectEnvios."
    });
  }
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Postal Balcao V1.1 disponivel na porta ${PORT}`);
  console.log(`ConectEnvios: ${TOKEN ? "configurada" : "modo demonstracao"}`);
});

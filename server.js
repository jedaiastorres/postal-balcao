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

const POSTAL_MARKUP = Math.max(0, Number(process.env.POSTAL_MARKUP_PERCENT || 8)) / 100;
const PARTNER_COMMISSION = Math.min(0.20, Math.max(0, Number(process.env.PARTNER_COMMISSION_PERCENT || 10) / 100));

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
  const subtotal = cost * (1 + POSTAL_MARKUP);
  const finalPrice = PARTNER_COMMISSION >= 0.999 ? subtotal : subtotal / (1 - PARTNER_COMMISSION);
  const partnerCommission = finalPrice * PARTNER_COMMISSION;
  return {
    salePrice: round2(finalPrice),
    partnerCommission: round2(partnerCommission)
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
    const cost = parseMoney(item.price ?? item.postal_service_price ?? item.value);
    if (!Number.isFinite(cost) || cost <= 0) return null;

    const pricing = sellPriceFromCost(cost);
    return {
      postalCompanyId: Number(item.postal_company_id ?? item.company_id ?? item.id ?? 0),
      transportadora: item.company_name ?? item.postal_company_name ?? item.company ?? "Transportadora",
      produto: item.service_name ?? item.postal_service_name ?? item.service ?? "Serviço",
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
  res.setHeader("SetCookie", "postal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
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
          cep_to: cepTo
        }),
        timeout: 25000
      });
      providerData = result.data;

      if (providerData && providerData.error === true) {
        console.error("ConectEnvios quote error:", providerData);
        return res.status(422).json({ error: "A unidade de frete retornou erro ao calcular." });
      }
    }

    const options = normalizeQuote(providerData);
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
    const result = await providerFetch(`/cep?cep=${encodeURIComponent(cep)}`, { method: "GET" });
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
      error: "Criacao de envios reais esta bloqueada nesta V1. Ative enable_shipment_creation=true apos homologacao."
    });
  }
  if (!TOKEN) return res.status(503).json({ error: "CONECTENVIOS_TOKEN nao configurado." });

  try {
    const body = req.body || {};
    if (!Array.isArray(body.package) || !body.package.length) {
      return res.status(400).json({ error: "O envio deve conter ao menos um item no array package." });
    }

    const result = await providerFetch("/cart", {
      method: "POST",
      body: JSON.stringify(body),
      timeout: 45000
    });

    res.json(result.data);
  } catch (error) {
    console.error("create shipment error:", error.status, error.providerData || error.message);
    res.status(error.status || 502).json({ error: "Falha ao criar envio na ConectEnvios." });
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

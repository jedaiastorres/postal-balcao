require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const postalLabel = require("./postal_label");
const db = require("./db");
const clientDb = require("./client_db");
const bulkShipping = require("./bulk_shipping");
const asaas = require("./asaas");
const ecommerce = require("./ecommerce_connectors");
const fiscalLookup = require("./fiscal_lookup");
const pointRules = require("./public/point_rules");
const trackingPrivacy = require("./public_tracking_privacy");
const publicQuotes = require("./public_quotes");
const publicPoints = require("./public_points");
const publicQuote = require("./public_quote");
const custody = require("./custody");
const quotePricing = require("./quote_pricing");
const shipmentCorrections = require("./shipment_corrections");
const providerServiceMapping = require("./provider_service_mapping");
const whiteLabel = require("./white_label");
const whiteLabelTenantDb = require("./white_label_tenant_db");
const whiteLabelPortal = require("./white_label_portal");
const whiteLabelHybrid = require("./white_label_hybrid_quote");
const operationalMetrics = require("./operational_metrics");
const postalOperations = require("./postal_operations");
const postalRegional = require("./postal_regional");
const { resolveExtraCharges } = require("./extra_charges");

const app = express();
// Railway terminates the public connection at a reverse proxy.
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);

const API_URL = (process.env.CONECTENVIOS_API_URL || "https://app.conectenvios.com.br/api/v1").replace(/\/$/, "");
const TOKEN = (process.env.CONECTENVIOS_TOKEN || "").trim();
const CONECTENVIOS_PAYMENT_MODE = String(process.env.CONECTENVIOS_PAYMENT_MODE || "WALLET").trim().toUpperCase();
const ASAAS_SELF_TEST_ON_BOOT = String(process.env.ASAAS_SELF_TEST_ON_BOOT || "false").toLowerCase() === "true";
const CONECTENVIO_MULTI_QUOTE_PROBE = String(process.env.CONECTENVIO_MULTI_QUOTE_PROBE || "false").toLowerCase() === "true";
const CONECTENVIO_QUOTE_CACHE_TTL_MS = Math.max(5000, Math.min(120000, Number(process.env.CONECTENVIO_QUOTE_CACHE_TTL_MS || 45000)));
const CONECTENVIO_QUOTE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CONECTENVIO_QUOTE_CONCURRENCY || 4)));
const providerQuoteCache = new Map();
let wlIntegratedQuoteInFlight = 0;
const regionalCepCache = new Map();
const shipmentCreationLocks = new Map();

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
const NUVEMSHOP_APP_ID = String(process.env.NUVEMSHOP_APP_ID || "").trim();
const NUVEMSHOP_CLIENT_SECRET = String(process.env.NUVEMSHOP_CLIENT_SECRET || "").trim();
const SHOPIFY_CLIENT_ID = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
const SHOPIFY_CLIENT_SECRET = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const SHOPIFY_API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2026-10").trim();
const SHOPIFY_READY = Boolean(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET &&
  /^20\d{2}-(01|04|07|10)$/.test(SHOPIFY_API_VERSION) &&
  /^https:\/\/[^/]+/.test(String(process.env.APP_PUBLIC_URL || "")));
const PAYMENT_SIMULATOR_ENABLED = String(process.env.PAYMENT_SIMULATOR_ENABLED || "true").toLowerCase() === "true";
const ADMIN_PASSWORD_RESET_HASH = String(process.env.ADMIN_PASSWORD_RESET_HASH || "").trim();
const CLIENT_PICKUP_FEE_PER_PACKAGE = Math.max(0, Number(process.env.CLIENT_PICKUP_FEE_PER_PACKAGE || 5));
const POINT_PICKUP_EARNING_PER_PACKAGE = Math.max(0, Number(process.env.POINT_PICKUP_EARNING_PER_PACKAGE || 3));
const POINT_DROPOFF_EARNING_PER_PACKAGE = Math.max(0, Number(process.env.POINT_DROPOFF_EARNING_PER_PACKAGE || 2));
const REFERRAL_EARNING_PER_SHIPMENT = Math.max(0, Number(process.env.REFERRAL_EARNING_PER_SHIPMENT || 0.50));
const HUB_TRANSFER_FEE_PER_PACKAGE = Math.max(0, Number(process.env.HUB_TRANSFER_FEE_PER_PACKAGE || 5));
const FISCAL_LOOKUP_URL = String(process.env.FISCAL_LOOKUP_URL || "").trim();
const FISCAL_LOOKUP_TOKEN = String(process.env.FISCAL_LOOKUP_TOKEN || "").trim();
const FISCAL_LOOKUP_PROVIDER = String(process.env.FISCAL_LOOKUP_PROVIDER || "AUTHORIZED").toUpperCase();
const FISCAL_LOOKUP_ENABLED = String(process.env.FISCAL_LOOKUP_ENABLED || "false").toLowerCase() === "true";
const PUBLIC_QUOTE_ENABLED = String(process.env.PUBLIC_QUOTE_ENABLED || "true").toLowerCase() === "true";
const visitorQuoteLimiter = publicQuote.makeVisitorLimiter();
let publicQuotesInFlight = 0;
function fiscalLookupConfigured() {
  if (!FISCAL_LOOKUP_ENABLED) return false;
  if (FISCAL_LOOKUP_PROVIDER === "CONSULTADANFE") return true;
  if (!FISCAL_LOOKUP_URL || !FISCAL_LOOKUP_TOKEN) return false;
  try {
    const url = new URL(FISCAL_LOOKUP_URL);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}
function normalizeFiscalReference(body = {}) {
  const type = String(body.fiscalDocumentType || "").toUpperCase();
  const key = String(body.fiscalDocumentKey || "").replace(/\D/g,"");
  if (!type && !key) return null;
  if (!["NFE","DCE"].includes(type)) throw Object.assign(new Error("Tipo de documento fiscal inválido."),{status:400});
  if (type === "DCE" && key.length !== 44) throw Object.assign(new Error("Informe uma chave de DC-e com 44 dígitos."),{status:400});
  if (key && key.length !== 44) throw Object.assign(new Error("A chave fiscal deve ter 44 dígitos."),{status:400});
  if (key && key.slice(20,22)!==(type==="NFE"?"55":"99")) throw Object.assign(new Error("A chave fiscal não corresponde ao tipo de documento."),{status:400});
  return { type, key: key || null, source:"USER_SUPPLIED" };
}


const paymentRuntime = {
  operational: false,
  pixReady: false,
  webhookReady: false,
  environment: asaas.environmentInfo(),
  lastError: "",
  checkedAt: null
};

function paymentOperational() {
  return Boolean(paymentRuntime.operational);
}


app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use((req,res,next)=>{
  if (req.method === "GET" && (req.path === "/" || req.path === "/cliente" || req.path.endsWith(".js") || req.path.endsWith(".css") || req.path.endsWith(".html"))) {
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

app.get("/rastreio", (_req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.sendFile(path.join(__dirname,"public","rastreio.html"));
});

app.get("/cotacao-compartilhada", (_req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.sendFile(path.join(__dirname,"public","cotacao-compartilhada.html"));
});

app.get("/pontos", (_req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.sendFile(path.join(__dirname,"public","pontos.html"));
});

app.get("/cotacao", (_req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.sendFile(path.join(__dirname,"public","cotacao.html"));
});

app.get("/scanner", (_req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.sendFile(path.join(__dirname,"public","scanner.html"));
});
app.get("/operacao",requireAuth,requireRole("ADMIN","SUPERVISOR","STORE_OWNER","OPS"),(_req,res)=>{
  res.setHeader("Cache-Control","private,no-store");
  res.sendFile(path.join(__dirname,"public","operacao.html"));
});


function parseCookies(req) {
  const cookies = Object.create(null);
  for (const part of String(req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    try {
      cookies[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch { /* Ignore invalid percent encoding from untrusted clients. */ }
  }
  return cookies;
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


function signEcommerceState(connectionId) {
  const id=String(connectionId||"");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update("ecommerce."+id).digest("base64url");
  return id+"."+sig;
}

function verifyEcommerceState(value) {
  const raw=String(value||"");
  const pos=raw.lastIndexOf(".");
  if(pos<1) return null;
  const id=raw.slice(0,pos), sig=raw.slice(pos+1);
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update("ecommerce."+id).digest("base64url");
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  return id;
}

function safeConnectionConfig(config={}) {
  const src=config&&typeof config==="object"?config:{};
  const out={...src};
  delete out.credentialBlob;
  delete out.consumerKey;
  delete out.consumerSecret;
  delete out.accessToken;
  delete out.personalToken;
  delete out.apiKey;
  delete out.oauthStateHash;
  return out;
}

function createShopifyState(connectionId) {
  const state=signEcommerceState(connectionId)+"."+crypto.randomBytes(24).toString("base64url");
  return {state,hash:crypto.createHash("sha256").update(state).digest("hex")};
}

function verifyShopifyState(state,config={}) {
  const value=String(state||"");
  const parts=value.split(".");
  if(parts.length!==3 || !parts[2] || !config.oauthStateHash) return null;
  const id=verifyEcommerceState(parts.slice(0,2).join("."));
  const expected=Buffer.from(String(config.oauthStateHash),"hex");
  const actual=crypto.createHash("sha256").update(value).digest();
  if(!id || expected.length!==actual.length || !crypto.timingSafeEqual(expected,actual)) return null;
  if(!Number.isFinite(Date.parse(config.oauthExpiresAt)) || Date.now()>Date.parse(config.oauthExpiresAt)) return null;
  return id;
}

async function syncWooCommerceConnection(connection) {
  const config=connection?.config||{};
  if(!config.credentialBlob) throw new Error("Autorização WooCommerce ainda não concluída.");
  const credentials=ecommerce.decryptCredentials(config.credentialBlob,SESSION_SECRET);
  const account=await clientDb.getCustomerAccount(connection.user_id);
  const sender=account?.default_sender||{};
  const orders=await ecommerce.fetchWooOrders({
    storeUrl:config.storeUrl,
    consumerKey:credentials.consumerKey,
    consumerSecret:credentials.consumerSecret,
    perPage:100,
    status:"processing"
  });

  let imported=0;
  for(const order of orders){
    const payload=ecommerce.normalizeWooOrder(order,sender);
    await clientDb.importEcommerceOrder({
      connectionId:connection.id,
      externalOrderId:String(order.id),
      customerName:payload.recipient?.name||"",
      externalStatus:String(order.status||""),
      payload
    });
    imported++;
  }

  await clientDb.updateConnection(connection.id,connection.user_id,{
    status:"CONNECTED",
    config:{...config,lastError:"",lastImportedCount:imported},
    markSynced:true
  });
  return {imported};
}



async function syncNuvemshopConnection(connection) {
  const config=connection?.config||{};
  if(!config.credentialBlob) throw new Error("Autorização Nuvemshop ainda não concluída.");
  const credentials=ecommerce.decryptCredentials(config.credentialBlob,SESSION_SECRET);
  const account=await clientDb.getCustomerAccount(connection.user_id);
  const sender=account?.default_sender||{};
  const orders=await ecommerce.fetchNuvemshopOrders({
    storeId:credentials.storeId,
    accessToken:credentials.accessToken,
    appId:NUVEMSHOP_APP_ID,
    perPage:100
  });

  let imported=0;
  for(const order of orders){
    const payload=ecommerce.normalizeNuvemshopOrder(order,sender);
    const externalId=String(payload.source?.orderId||order.id||"");
    if(!externalId) continue;
    await clientDb.importEcommerceOrder({
      connectionId:connection.id,
      externalOrderId:externalId,
      customerName:payload.recipient?.name||"",
      externalStatus:payload.source?.status||"",
      payload
    });
    imported++;
  }
  await clientDb.updateConnection(connection.id,connection.user_id,{
    status:"CONNECTED",
    externalStoreId:String(credentials.storeId||connection.external_store_id||""),
    config:{...config,lastError:"",lastImportedCount:imported},
    markSynced:true
  });
  return {imported};
}

async function syncLojaIntegradaConnection(connection) {
  const config=connection?.config||{};
  if(!config.credentialBlob) throw new Error("Personal token da Loja Integrada ainda não configurado.");
  const credentials=ecommerce.decryptCredentials(config.credentialBlob,SESSION_SECRET);
  const account=await clientDb.getCustomerAccount(connection.user_id);
  const sender=account?.default_sender||{};
  const orders=await ecommerce.fetchLojaIntegradaOrders({
    personalToken:credentials.personalToken,
    limit:100
  });

  let imported=0;
  for(const order of orders){
    const payload=ecommerce.normalizeLojaIntegradaOrder(order,sender);
    if(payload.source?.canceled) continue;
    if(payload.source?.approved===false) continue;
    const externalId=String(payload.source?.orderId||order.id||order.numero||"");
    if(!externalId) continue;
    await clientDb.importEcommerceOrder({
      connectionId:connection.id,
      externalOrderId:externalId,
      customerName:payload.recipient?.name||"",
      externalStatus:payload.source?.status||"",
      payload
    });
    imported++;
  }

  await clientDb.updateConnection(connection.id,connection.user_id,{
    status:"CONNECTED",
    config:{...config,lastError:"",lastImportedCount:imported,lastValidatedAt:new Date().toISOString()},
    markSynced:true
  });
  return {imported};
}

const shopifySyncLocks=new Map();
async function syncShopifyConnection(connection) {
  if(!SHOPIFY_READY) throw new Error("Configure o aplicativo Shopify na Postal para sincronizar.");
  const id=String(connection.id);
  if(shopifySyncLocks.has(id)) return shopifySyncLocks.get(id);
  const task=(async()=>{
    let config=connection?.config||{};
    if(!config.credentialBlob) throw new Error("Autorização Shopify ainda não concluída.");
    const shop=ecommerce.normalizeShopifyShop(config.shop);
    let credentials=ecommerce.decryptCredentials(config.credentialBlob,SESSION_SECRET);
    if(!credentials.accessToken) throw new Error("Credencial Shopify inválida. Reconecte a loja.");
    if(!credentials.expiresAt || Date.parse(credentials.expiresAt)<Date.now()+180000){
      if(!credentials.refreshToken || (credentials.refreshExpiresAt && Date.parse(credentials.refreshExpiresAt)<Date.now())){
        throw new Error("Autorização Shopify expirada. Desconecte e autorize a loja novamente.");
      }
      credentials=await ecommerce.refreshShopifyToken({shop,clientId:SHOPIFY_CLIENT_ID,
        clientSecret:SHOPIFY_CLIENT_SECRET,refreshToken:credentials.refreshToken});
      config={...config,credentialBlob:ecommerce.encryptCredentials(credentials,SESSION_SECRET),
        tokenRefreshedAt:new Date().toISOString()};
      // Salvar a rotação antes de qualquer outra chamada evita perder o novo refresh token.
      await clientDb.updateConnection(connection.id,connection.user_id,{config});
    }
    const account=await clientDb.getCustomerAccount(connection.user_id);
    const sender=account?.default_sender||{};
    const orders=await ecommerce.fetchShopifyOrders({shop,accessToken:credentials.accessToken,
      apiVersion:SHOPIFY_API_VERSION,maxPages:4});
    let imported=0;
    for(const order of orders){
      const payload=ecommerce.normalizeShopifyOrder(order,sender);
      if(!payload.source.orderId) continue;
      await clientDb.importEcommerceOrder({connectionId:connection.id,
        externalOrderId:payload.source.orderId,customerName:payload.recipient.name,
        externalStatus:payload.source.status,payload});
      imported++;
    }
    await clientDb.updateConnection(connection.id,connection.user_id,{
      status:"CONNECTED",config:{...config,lastError:"",lastImportedCount:imported},markSynced:true
    });
    return {imported};
  })();
  shopifySyncLocks.set(id,task);
  try {return await task;} finally {shopifySyncLocks.delete(id);}
}

async function syncEcommerceConnection(connection) {
  if(!connection) throw new Error("Conexão não encontrada.");
  const platform=String(connection.platform).toUpperCase();
  if(platform==="WOOCOMMERCE") return syncWooCommerceConnection(connection);
  if(platform==="LOJA_INTEGRADA") return syncLojaIntegradaConnection(connection);
  if(platform==="NUVEMSHOP") return syncNuvemshopConnection(connection);
  if(platform==="SHOPIFY") return syncShopifyConnection(connection);
  throw new Error("Sincronização nativa desta plataforma ainda não está disponível.");
}

async function processEcommerceSyncQueue() {
  try{
    const connections=await clientDb.listBridgeConnections(null,250);
    for(const connection of connections){
      const platform=String(connection.platform).toUpperCase();
      if(!["WOOCOMMERCE","LOJA_INTEGRADA","NUVEMSHOP","SHOPIFY"].includes(platform)) continue;
      if(!["CONNECTED","SYNC_REQUESTED"].includes(String(connection.status||""))) continue;
      try{
        if(connection.status==="SYNC_REQUESTED"){
          await clientDb.updateConnection(connection.id,connection.user_id,{
            status:"SYNCING",
            config:{...(connection.config||{}),lastError:""}
          });
        }
        await syncEcommerceConnection(connection);
      }catch(error){
        // Usar a versão atual evita desfazer uma eventual rotação de token Shopify
        // já gravada antes de uma falha na consulta de pedidos.
        const fresh=await clientDb.getConnectionById(connection.id).catch(()=>null);
        const current=fresh?.config||connection.config||{};
        await clientDb.updateConnection(connection.id,connection.user_id,{
          status:"ERROR",
          config:{...current,lastError:String(error.message||"Falha de sincronização").slice(0,500)}
        });
        console.error("ecommerce sync error:",connection.id,connection.platform,error.message);
      }
    }
  }catch(error){
    console.error("ecommerce worker error:",error.message);
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
  // Nunca consultar dados de toda a rede por falta de vinculação a um ponto.
  return { storeId: "00000000-0000-0000-0000-000000000000" };
}

function reportStoreForUser(user, requestedStoreId) {
  if (user?.role === "ADMIN") {
    const chosen = String(requestedStoreId || "").trim();
    if (chosen && !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(chosen)) {
      throw Object.assign(new Error("Ponto inválido."), { status: 400 });
    }
    return chosen;
  }
  if (!user?.storeId) throw Object.assign(new Error("Usuário sem unidade vinculada."), { status: 403 });
  const chosen = String(requestedStoreId || "").trim();
  if (chosen && chosen !== String(user.storeId)) {
    throw Object.assign(new Error("Acesso a outra unidade não permitido."), { status: 403 });
  }
  return String(user.storeId);
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
  return requireCurrentUser(req, res, next);
}

async function requireCurrentUser(req,res,next){
  try {
    if(req.currentUserValidated)return next();
    const user=await db.getUserById(req.user.userId);
    if(!user?.active||user.role!==req.user.role||user.email!==req.user.email||(user.store_id||null)!==(req.user.storeId||null)){
      return res.status(403).json({error:"Seu acesso foi alterado. Entre novamente."});
    }
    // Somente o usuário master possui acesso transversal. Supervisores e
    // demais perfis operacionais precisam pertencer a uma unidade ativa.
    if(!["ADMIN","CLIENT"].includes(user.role)&&!user.store_id){
      return res.status(403).json({error:"Usuário sem unidade vinculada. Solicite o vínculo ao master."});
    }
    if(req.user.storeId){
      const store=await db.getStore(req.user.storeId);
      if(!store?.active)return res.status(403).json({error:"Ponto inativo."});
    }
    req.currentUserValidated=true;
    next();
  }catch(error){return res.status(503).json({error:"Não foi possível validar o acesso. Tente novamente."});}
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
  if (!TOKEN) throw new Error("Integração logística indisponível.");
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
    const err = new Error("A integração logística não conseguiu concluir a solicitação.");
    err.status = response.status;
    err.providerData = data;
    throw err;
  }

  return { response, data, contentType: type };
}

function providerFailureText(error) {
  const data = error?.providerData;
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const candidates = [
      data.message, data.error, data.description, data.detail,
      data.data?.message, data.data?.error, data.data?.description
    ].filter(Boolean);
    if (Array.isArray(data.errors)) {
      for (const item of data.errors) candidates.push(item?.message || item?.description || item?.error || item?.code);
    }
    const text = candidates.filter(Boolean).map(item => {
      if (typeof item === "string") return item;
      try { return JSON.stringify(item); } catch { return String(item); }
    }).join(" | ");
    if (text && !/^\[object Object\](\s*\|\s*(true|false))?$/i.test(text)) return text;
    try {
      const serialized = JSON.stringify(data);
      if (serialized && serialized !== "{}") return serialized;
    } catch {}
  }
  return String(error?.message || "");
}

function providerPaymentFailureStatus(error) {
  const text = providerFailureText(error).toLowerCase();
  if (/saldo|balance|insuficient|insufficient|pagamento|payment|carteira|wallet|cr[eé]dito/.test(text)) {
    return "AWAITING_FUNDS";
  }
  return "ERROR";
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
  return quotePricing.sellPriceFromCost(cost, partnerCommissionRate, POSTAL_MARGIN);
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
      providerServiceName: providerServiceMapping.canonicalServiceName(item),
      prazoEntrega: Number(item.deadline ?? item.postal_service_deadline ?? 0),
      precoVenda: pricing.salePrice,
      comissaoParceiro: pricing.partnerCommission,
      providerCost: round2(cost),
      postalMargin: pricing.postalMargin
    };
  }).filter(Boolean).sort((a, b) => a.precoVenda - b.precoVenda);
}

async function resolveOperationalQuoteOrigin(user, actualCepFrom) {
  let store = null;
  if (user?.storeId) {
    store = await db.getStore(user.storeId);
  } else if (user?.role === "PUBLIC" || (user?.role === "CLIENT" && user?.userId)) {
    // O CEP real define o hub. Não usar automaticamente um ponto indicador
    // de outra cidade como origem do pacote.
    try { store = await db.findStoreForQuoteOrigin(actualCepFrom); } catch {}
    if (!store) {
      try {
        const account = await clientDb.getCustomerAccount(user.userId);
        if (account?.referral_store_id) {
          const linked = await db.getStore(account.referral_store_id);
          const pointCep = cleanDigits(linked?.address?.cep);
          if (linked?.active && pointCep.length===8 && pointCep.slice(0,5)===actualCepFrom.slice(0,5)) store=linked;
        }
      } catch {}
    }
  }
  const configured = cleanDigits(store?.quote_origin_cep || "");
  const operationalHub = store?.operational_hub && typeof store.operational_hub==="object"
    ? store.operational_hub
    : {};
  return {
    actualCepFrom,
    providerCepFrom: configured.length === 8 ? configured : actualCepFrom,
    storeId: store?.id || null,
    store,
    operationalHub,
    overridden: configured.length === 8 && configured !== actualCepFrom
  };
}

function toPositiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} deve ser maior que zero.`);
  return Math.max(1, Math.round(n));
}


function providerQuoteCacheKey(providerCepFrom, cepTo, volume) {
  return [
    providerCepFrom,
    cepTo,
    Number(volume.weightGrams || 0),
    Number(volume.width || 0),
    Number(volume.height || 0),
    Number(volume.length || 0)
  ].join("|");
}

function pruneProviderQuoteCache(now = Date.now()) {
  if (providerQuoteCache.size < 250) return;
  for (const [key, item] of providerQuoteCache.entries()) {
    if (!item || item.expiresAt <= now) providerQuoteCache.delete(key);
  }
  while (providerQuoteCache.size > 500) {
    providerQuoteCache.delete(providerQuoteCache.keys().next().value);
  }
}

async function fetchProviderQuoteCached(providerCepFrom, cepTo, volume) {
  const key = providerQuoteCacheKey(providerCepFrom, cepTo, volume);
  const now = Date.now();
  const cached = providerQuoteCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { data: cached.data, cached: true };
  }
  if (cached) providerQuoteCache.delete(key);

  const result = await providerFetch("/package/shipping", {
    method:"POST",
    body:JSON.stringify({
      type:"box",
      weight:volume.weightGrams,
      width:volume.width,
      height:volume.height,
      length:volume.length,
      cep_from:providerCepFrom,
      cep_to:cepTo,
      addr_from_cep:providerCepFrom,
      addr_to_cep:cepTo
    }),
    timeout:25000
  });

  providerQuoteCache.set(key, {
    data: result.data,
    expiresAt: now + CONECTENVIO_QUOTE_CACHE_TTL_MS
  });
  pruneProviderQuoteCache(now);
  return { data: result.data, cached: false };
}

async function resolveRegionalCityByCep(cep) {
  const now = Date.now();
  const cached = regionalCepCache.get(cep);
  if (cached && cached.expiresAt > now) return cached.location;
  let location=null;
  try {
    const result = await providerFetch(`/cep/address/?cep=${encodeURIComponent(cep)}`, {method:"GET",timeout:9000});
    location = postalRegional.parseLocation(result.data);
  } catch (error) {
    console.warn("Postal Regional: cidade do CEP não confirmada",error.status||"",error.message);
  }
  if(!location){
    // Serviço público de CEP como alternativa quando o agregador não devolve cidade/UF.
    try{
      const response=await fetch(`https://viacep.com.br/ws/${cep}/json/`,{
        headers:{Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(4500)
      });
      if(response.ok){
        const payload=await response.json();
        if(!payload.erro)location=postalRegional.parseLocation(payload);
      }
    }catch(error){console.warn("Postal Regional: consulta alternativa de CEP indisponível",error.name||"");}
  }
  regionalCepCache.set(cep,{location,expiresAt:now+(location?60*60*1000:60*1000)});
  if(regionalCepCache.size>3000)regionalCepCache.delete(regionalCepCache.keys().next().value);
  return location; // Nunca inferir município apenas pelo prefixo do CEP.
}

async function offerPostalRegional(partnerOptions, cepFrom, cepTo, hubTransferTotal,volumes,commissionRate=PARTNER_COMMISSION) {
  if (!postalRegional.eligibleVolumes(volumes)) return null;
  const [origin,destination] = await Promise.all([
    resolveRegionalCityByCep(cepFrom),resolveRegionalCityByCep(cepTo)
  ]);
  const route=postalRegional.coveredRoute(origin,destination);
  if(!route)return null;
  if(partnerOptions.length)return postalRegional.regionalOption(partnerOptions,route,{hubTransferTotal});
  const tariff=await db.getPostalTariff(route.originCity,route.destinationCity);
  return postalRegional.tariffOption(route,tariff,{volumeCount:volumes.length,commissionRate});
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, () => run()));
  return output;
}

function parseQuoteVolumes(body = {}) {
  const incoming = Array.isArray(body.volumes) && body.volumes.length
    ? body.volumes
    : [{
        peso: body.peso,
        comprimento: body.comprimento,
        largura: body.largura,
        altura: body.altura,
        vlDeclarado: body.vlDeclarado
      }];

  if (!incoming.length) throw new Error("Informe ao menos um volume.");
  if (incoming.length > 50) throw new Error("Este envio aceita no máximo 50 volumes por cotação.");

  return incoming.map((volume, index) => {
    const weightKg = Number(volume.peso ?? volume.weightKg ?? volume.weight ?? 0);
    const weightGrams = toPositiveInteger(weightKg * 1000, `Peso do volume ${index + 1}`);
    const width = toPositiveInteger(volume.largura ?? volume.width, `Largura do volume ${index + 1}`);
    const height = toPositiveInteger(volume.altura ?? volume.height, `Altura do volume ${index + 1}`);
    const length = toPositiveInteger(volume.comprimento ?? volume.length, `Comprimento do volume ${index + 1}`);
    const declaredValue = round2(Math.max(0, Number(volume.vlDeclarado ?? volume.declaredValue ?? 0) || 0));
    return { index:index + 1, weightGrams, width, height, length, declaredValue };
  });
}

function aggregateVolumeQuoteSets(sets) {
  if (!Array.isArray(sets) || !sets.length) return [];
  const keyOf = option => [
    Number(option.postalCompanyId || 0),
    String(option.codigoServico || "").trim().toLowerCase(),
    String(option.produto || "").trim().toLowerCase()
  ].join("|");

  const map = new Map();
  for (const option of sets[0]) {
    map.set(keyOf(option), { ...option, volumeCosts:[Number(option.providerCost || 0)] });
  }

  for (let i = 1; i < sets.length; i++) {
    const current = new Map(sets[i].map(option => [keyOf(option), option]));
    for (const [key, aggregate] of [...map.entries()]) {
      const option = current.get(key);
      if (!option) {
        map.delete(key);
        continue;
      }
      aggregate.providerCost = round2(Number(aggregate.providerCost || 0) + Number(option.providerCost || 0));
      aggregate.precoVenda = round2(Number(aggregate.precoVenda || 0) + Number(option.precoVenda || 0));
      aggregate.comissaoParceiro = round2(Number(aggregate.comissaoParceiro || 0) + Number(option.comissaoParceiro || 0));
      aggregate.postalMargin = round2(Number(aggregate.postalMargin || 0) + Number(option.postalMargin || 0));
      aggregate.prazoEntrega = Math.max(Number(aggregate.prazoEntrega || 0), Number(option.prazoEntrega || 0));
      aggregate.volumeCosts.push(Number(option.providerCost || 0));
    }
  }
  return [...map.values()].sort((a,b)=>a.precoVenda-b.precoVenda);
}

function shipmentFromProviderCart(cart, expectedVolumeCount = 1) {
  const packages = Array.isArray(cart?.packages)
    ? cart.packages
    : (Array.isArray(cart?.package) ? cart.package : []);

  const volumes = packages.map((pkg,index)=>({
    index:index + 1,
    packageId:pkg.id || pkg.package_id || null,
    trackingCode:
      pkg.postal_service_track ||
      pkg.tracking_code ||
      pkg.trackingCode ||
      pkg.tracking ||
      pkg.track ||
      "",
    labelA4Url:pkg.api_print_url || pkg.label_url || "",
    labelA6Url:pkg.api_print_url_a6 || pkg.label_a6_url || "",
    declarationUrl:pkg.api_declaration_url || pkg.declaration_url || "",
    publicTrackingUrl:pkg.public_tracking_url || pkg.tracking_url || ""
  }));

  const first = volumes[0] || {};
  const firstRaw = packages[0] || {};
  const cartTracking = cart?.tracking_code || cart?.trackingCode || "";
  const rawPaid = firstRaw?.paid ?? cart?.paid ?? firstRaw?.is_paid ?? cart?.is_paid ?? null;
  const providerPaid = rawPaid === null || rawPaid === undefined
    ? null
    : (rawPaid === true || rawPaid === 1 || String(rawPaid).toLowerCase() === "true" || String(rawPaid).toLowerCase() === "paid");
  const providerStatus = String(firstRaw?.status || cart?.status || firstRaw?.status_label || cart?.status_label || "");
  const shipment = {
    cartId:cart?.id || cart?.cart_id || packages[0]?.cart_id || null,
    packageId:first.packageId || null,
    trackingCode:first.trackingCode || cartTracking || "",
    labelA4Url:first.labelA4Url || cart?.public_print_url || cart?.label_url || "",
    labelA6Url:first.labelA6Url || cart?.public_print_url_a6 || "",
    declarationUrl:first.declarationUrl || cart?.declaration_url || "",
    publicTrackingUrl:first.publicTrackingUrl || cart?.public_tracking_url || "",
    providerPaid,
    providerStatus,
    volumes
  };

  const expected = Math.max(1, Number(expectedVolumeCount || 1));
  const enoughVolumes = expected === 1 ? volumes.length >= 1 : volumes.length >= expected;
  const readyVolumes = expected === 1
    ? Boolean(shipment.trackingCode && (shipment.labelA6Url || shipment.labelA4Url))
    : enoughVolumes && volumes.slice(0,expected).every(v => v.trackingCode && (v.labelA6Url || v.labelA4Url));

  shipment.ready = readyVolumes;
  shipment.expectedVolumeCount = expected;
  return shipment;
}

async function refreshShipmentFromProvider(order) {
  if (!order?.conect_cart_id) return null;
  const result = await providerFetch("/cart/" + encodeURIComponent(order.conect_cart_id), {
    method:"GET",
    timeout:30000
  });
  const payload = result.data || {};
  let cart = payload.data || payload;
  const expected = Number(order.package_count || order.package_data?.volumes?.length || 1);
  let shipment = shipmentFromProviderCart(cart, expected);

  // A ConectEnvios libera uma URL assinada de impressão antes de preencher o rastreio.
  // Ao abrir essa URL para um envio já pago, a plataforma materializa a etiqueta e
  // grava o código de rastreio. Se ainda não estiver pago, a chamada não retorna PDF
  // e o pedido permanece pendente, sem criar outro carrinho.
  if (!shipment.ready) {
    const printUrls = [...new Set(
      (shipment.volumes || [])
        .map(volume => String(volume.labelA4Url || ""))
        .filter(Boolean)
    )];

    if (printUrls.length) {
      let materialized = 0;
      for (const printUrl of printUrls) {
        try {
          const printResponse = await fetch(printUrl, {
            method:"GET",
            headers:providerHeaders(),
            redirect:"follow",
            signal:AbortSignal.timeout(30000)
          });
          const printType = String(printResponse.headers.get("content-type") || "").toLowerCase();
          if (printResponse.ok && printType.includes("application/pdf")) {
            materialized++;
          }
          try { await printResponse.arrayBuffer(); } catch {}
        } catch (error) {
          console.warn("CONECTENVIOS_LABEL_MATERIALIZE_VOLUME_PENDING", order.id, String(error?.message || error));
        }
      }

      if (materialized > 0) {
        try {
          const refreshed = await providerFetch("/cart/" + encodeURIComponent(order.conect_cart_id), {
            method:"GET",
            timeout:30000
          });
          const refreshedPayload = refreshed.data || {};
          cart = refreshedPayload.data || refreshedPayload;
          shipment = shipmentFromProviderCart(cart, expected);
          console.log(
            "CONECTENVIOS_LABELS_MATERIALIZED",
            order.id,
            "pdfs="+materialized,
            "volumes="+(shipment.volumes || []).length,
            "ready="+shipment.ready
          );
        } catch (error) {
          console.warn("CONECTENVIOS_LABEL_REFRESH_PENDING", order.id, String(error?.message || error));
        }
      }
    }
  }

  const awaitingFunds =
    String(order.provider_payment_status || "").toUpperCase() === "AWAITING_FUNDS" ||
    shipment.providerPaid === false ||
    /aguardando pagamento|awaiting payment|unpaid/i.test(shipment.providerStatus || "");
  console.log("CONECTENVIOS_CART_STATE", order.id, JSON.stringify({
    cartId: shipment.cartId || order.conect_cart_id || null,
    providerPaymentStatus: order.provider_payment_status || null,
    providerPaid: shipment.providerPaid,
    providerStatus: shipment.providerStatus || null,
    ready: shipment.ready,
    attempts: Number(order.provider_payment_attempts || 0)
  }));

  // Carrinhos sem etiqueta permanecem pendentes até a ConectEnvios confirmar a emissão.
  // Não recriamos automaticamente o envio: POST /cart apenas cria outro rascunho e pode duplicar o pedido.
  if (shipment.ready) {
    await db.saveShipment(order.id, shipment);
    await db.addOrderEvent(order.id, "LABEL_AVAILABLE", "Etiquetas liberadas",
      expected > 1 ? `${expected} volumes liberados pela ConectEnvios.` : "Etiqueta liberada pela transportadora.");
  } else {
    await db.saveProviderPendingShipment(order.id, shipment);
    await db.updateProviderPayment(order.id,{
      status:awaitingFunds ? "AWAITING_FUNDS" : "AWAITING_PROVIDER_CONFIRMATION",
      ref:shipment.cartId || shipment.packageId || null,
      error:awaitingFunds
        ? "Envio criado na transportadora e aguardando liberação financeira."
        : `Aguardando etiquetas/rastreios dos volumes (${shipment.volumes.length}/${expected}).`
    });
    if (awaitingFunds) {
      await db.addOrderEvent(order.id, "PROVIDER_AWAITING_FUNDS", "Aguardando liberação financeira",
        "O pagamento do cliente está confirmado; a etiqueta aguarda liberação da transportadora.");
    }
  }
  return shipment;
}


async function probeConectEnviosMultiVolumeQuote() {
  if (!TOKEN) return;
  const common = {
    cep_from: "68515000",
    cep_to: "01310100",
    addr_from_cep: "68515000",
    addr_to_cep: "01310100"
  };
  const volumes = [
    { index:1, weightGrams:1000, width:20, height:10, length:25, declaredValue:50 },
    { index:2, weightGrams:1500, width:25, height:15, length:30, declaredValue:50 }
  ];

  const sets=[];
  for(const volume of volumes){
    try{
      const result=await providerFetch("/package/shipping",{
        method:"POST",
        body:JSON.stringify({
          type:"box",weight:volume.weightGrams,width:volume.width,height:volume.height,length:volume.length,
          ...common
        }),
        timeout:25000
      });
      const normalized=normalizeQuote(result.data,0);
      sets.push(normalized);
      console.log("CONECTENVIO_MULTI_QUOTE_PROBE","volume_"+volume.index,"HTTP_OK","services="+normalized.length);
    }catch(error){
      console.log("CONECTENVIO_MULTI_QUOTE_PROBE","volume_"+volume.index,"FAILED","status="+(error.status||""),providerFailureText(error).slice(0,180));
      return;
    }
  }
  const commonOptions=aggregateVolumeQuoteSets(sets);
  console.log("CONECTENVIO_MULTI_QUOTE_PROBE","aggregate","OK","commonServices="+commonOptions.length);
}

async function resolveCartServiceCode(order, packageData, storedVolumes) {
  // Nome canônico da cotação: código técnico (ex.: FREIGHT_TYPE_ECONOMIC)
  // não é aceito em postal_service_name na criação do carrinho.
  const storedName = String(packageData?.postalServiceName || "").trim();
  if (storedName) return storedName;

  const first = storedVolumes?.[0];
  if (!first) return String(order?.service_name || "").trim();

  try {
    const providerCepFrom = cleanDigits(packageData?.providerCepFrom || order?.sender?.cep);
    const cepTo = cleanDigits(order?.recipient?.cep);
    if (providerCepFrom.length !== 8 || cepTo.length !== 8) {
      return String(order?.service_name || "").trim();
    }
    const result = await providerFetch("/package/shipping", {
      method:"POST",
      body:JSON.stringify({
        type:"box",
        weight:Number(first.weightGrams || 0),
        width:Number(first.width || 0),
        height:Number(first.height || 0),
        length:Number(first.length || 0),
        cep_from:providerCepFrom,
        cep_to:cepTo,
        addr_from_cep:providerCepFrom,
        addr_to_cep:cepTo
      }),
      timeout:25000
    });

    const rawOptions = extractShippingItems(result.data);
    const serviceName = providerServiceMapping.resolveServiceNameFromQuote(rawOptions,{
      postalCompanyId:order?.postal_company_id,
      carrierName:order?.carrier,
      serviceName:order?.service_name,
      serviceCode:packageData?.serviceCode
    });
    if (serviceName) {
      console.log("CONECTENVIOS_SERVICE_RESOLVED", order.id, serviceName);
      return serviceName;
    }
    console.warn("CONECTENVIOS_SERVICE_NO_MATCH", order?.id || "", "No matching service name from quote");
  } catch (error) {
    console.warn("CONECTENVIOS_SERVICE_RESOLVE_FAIL", order?.id || "", error.status || "network");
  }
  // Último recurso: o nome comercial legível do pedido, nunca o código técnico.
  return String(order?.service_name || "").trim();
}

async function createShipmentFromOrder(order) {
  if (!order?.id) throw new Error("Pedido não encontrado.");
  const running = shipmentCreationLocks.get(order.id);
  if (running) return running;

  const task = createShipmentFromOrderUnlocked(order)
    .finally(() => shipmentCreationLocks.delete(order.id));
  shipmentCreationLocks.set(order.id, task);
  return task;
}

async function createShipmentFromOrderUnlocked(order) {
  if (!order) throw new Error("Pedido não encontrado.");

  const expectedVolumeCount = Math.max(1, Number(order.package_count || order.package_data?.volumes?.length || 1));

  if (order.tracking_code && (order.label_a6_url || order.label_a4_url) &&
      (expectedVolumeCount === 1 || (Array.isArray(order.shipment_volumes) && order.shipment_volumes.length >= expectedVolumeCount))) {
    return {
      cartId: order.conect_cart_id || null,
      packageId: order.conect_package_id || null,
      trackingCode: order.tracking_code || "",
      labelA4Url: order.label_a4_url || "",
      labelA6Url: order.label_a6_url || "",
      declarationUrl: order.declaration_url || "",
      publicTrackingUrl: postalTrackingUrl(order.tracking_code || ""),
      volumes: Array.isArray(order.shipment_volumes) ? order.shipment_volumes : [],
      ready:true
    };
  }

  if (order.package_data?.carrierMode === "POSTAL_OWN") {
    if (String(order.payment_status) !== "PAID") {
      throw new Error("A Postal só emite a etiqueta própria após o pagamento confirmado.");
    }
    if (!order.package_data?.ownRoute?.originCity || !order.package_data?.ownRoute?.destinationCity) {
      throw new Error("A rota Postal Regional não foi validada na cotação.");
    }
    const prefix="PS"+String(order.id).replace(/-/g,"").slice(0,20).toUpperCase();
    const volumes=Array.from({length:expectedVolumeCount},(_,index)=>{
      const trackingCode=prefix+String(index+1).padStart(2,"0");
      return {
        index:index+1, packageId:null,trackingCode,
        labelA4Url:`/api/orders/${order.id}/labels`,
        labelA6Url:`/api/orders/${order.id}/labels`,
        publicTrackingUrl:postalTrackingUrl(trackingCode)
      };
    });
    const shipment={
      cartId:null,packageId:null,trackingCode:volumes[0].trackingCode,
      labelA4Url:`/api/orders/${order.id}/labels`,
      labelA6Url:`/api/orders/${order.id}/labels`,
      declarationUrl:"",publicTrackingUrl:postalTrackingUrl(volumes[0].trackingCode),
      volumes,ready:true
    };
    await db.saveShipment(order.id,shipment);
    await db.addOrderEvent(order.id,"POSTAL_OWN_CREATED","Etiqueta Postal Regional emitida",
      "Envio registrado na rede própria. As movimentações serão atualizadas pela leitura nos pontos e hubs.");
    return shipment;
  }

  if (!ENABLE_SHIPMENT_CREATION) {
    await db.updateStatus(order.id, "PAID_WAITING_SHIPMENT", "PAID");
    return null;
  }
  if (!TOKEN) throw new Error("Integração logística indisponível.");

  // Carrinho já criado: consulta o mesmo carrinho em vez de gerar cobrança/postagem duplicada.
  if (order.conect_cart_id) {
    return refreshShipmentFromProvider(order);
  }
  if (order.conect_package_id) {
    await db.updateProviderPayment(order.id,{
      status: order.provider_payment_status || "AWAITING_PROVIDER_CONFIRMATION",
      ref: order.conect_package_id,
      error: "Postagem já criada no provedor e aguardando retorno completo."
    });
    await db.updateStatus(order.id,"PROVIDER_PAYMENT_PENDING","PAID");
    throw new Error("A postagem já foi criada na transportadora e aguarda liberação. Não será gerada em duplicidade.");
  }

  const packageData = order.package_data || {};
  const sender = order.sender || {};
  const recipient = order.recipient || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const declaredFallback = items.reduce((sum, item) => sum + Number(item.value || 0) * Number(item.quantity || 1), 0);

  const storedVolumes = Array.isArray(packageData.volumes) && packageData.volumes.length
    ? packageData.volumes
    : [{
        weightGrams:Number(packageData.weightGrams || 0),
        width:Number(packageData.width || 0),
        height:Number(packageData.height || 0),
        length:Number(packageData.length || 0),
        declaredValue:Number(packageData.declaredValue || declaredFallback)
      }];

  const declaredSum = storedVolumes.reduce((sum,v)=>sum + Math.max(0,Number(v.declaredValue || 0)),0);
  const providerServiceCode = await resolveCartServiceCode(order, packageData, storedVolumes);
  const providerCepFrom=cleanDigits(packageData.providerCepFrom||sender.cep);
  const senderCep=cleanDigits(sender.cep);
  const usesOperationalHub=providerCepFrom.length===8 && senderCep.length===8 && providerCepFrom!==senderCep;
  const operationalHub=packageData.operationalHub&&typeof packageData.operationalHub==="object"?packageData.operationalHub:{};
  if(usesOperationalHub){
    if(cleanDigits(operationalHub.cep||"")!==providerCepFrom ||
       !String(operationalHub.address||"").trim() ||
       !String(operationalHub.number||"").trim()){
      throw new Error("O Hub / Origem Operacional deste ponto está incompleto. O MASTER deve corrigir o cadastro antes de emitir a postagem.");
    }
  }
  const providerSender=usesOperationalHub?{
    cep:providerCepFrom,
    address:String(operationalHub.address||"").trim(),
    number:String(operationalHub.number||"").trim(),
    neighborhood:String(operationalHub.neighborhood||"").trim(),
    complement:String(operationalHub.complement||"").trim()
  }:{
    cep:senderCep,
    address:String(sender.address||"").trim(),
    number:String(sender.number||"").trim(),
    neighborhood:String(sender.neighborhood||"").trim(),
    complement:String(sender.complement||"").trim()
  };
  const packageItems = storedVolumes.map((volume,index)=>{
    const fallbackDeclared = declaredSum > 0
      ? 0
      : round2(Number(declaredFallback || 0) / Math.max(1, storedVolumes.length));
    const packageItem = {
      name: String("Envio Postal V" + (index + 1) + "/" + storedVolumes.length + " - " + (sender.name || "") + " para " + (recipient.name || "")).slice(0, 120),
      type: "box",
      weight: Number(volume.weightGrams || 0),
      width: Number(volume.width || 0),
      height: Number(volume.height || 0),
      length: Number(volume.length || 0),
      extra_notify: true,
      extra_in_hand: false,
      addr_from_document: cleanDigits(sender.document),
      addr_from_phone: cleanDigits(sender.phone),
      addr_from_name: String(sender.name || "").trim(),
      addr_from_cep: providerSender.cep,
      addr_from_number: providerSender.number,
      addr_from_address: providerSender.address,
      addr_from_neighborhood: providerSender.neighborhood,
      addr_from_complement: providerSender.complement,
      addr_to_document: cleanDigits(recipient.document),
      addr_to_phone: cleanDigits(recipient.phone),
      addr_to_name: String(recipient.name || "").trim(),
      addr_to_cep: cleanDigits(recipient.cep),
      addr_to_number: String(recipient.number || "").trim(),
      addr_to_address: String(recipient.address || "").trim(),
      addr_to_neighborhood: String(recipient.neighborhood || "").trim(),
      addr_to_complement: String(recipient.complement || "").trim(),
      postal_service_name: String(providerServiceCode || order.service_name || ""),
      postal_company_id: Number(order.postal_company_id || 0)
    };

    if (order.invoice_number) {
      packageItem.receipt = String(order.invoice_number);
    } else {
      // A ConectEnvios exige a documentação do pacote. Mantemos a mesma declaração
      // vinculada ao conjunto de volumes; o valor declarado de cada volume é individual.
      packageItem.declaration = items.map(item => ({
        description: String(item.description || "").trim(),
        quantity: Math.max(1, Math.round(Number(item.quantity || 1))),
        value: round2(Number(item.value || 0))
      }));
    }
    return packageItem;
  });

  await db.updateProviderPayment(order.id,{
    status:"PROCESSING",
    error:null,
    incrementAttempt:true
  });

  let result;
  try {
    result = await providerFetch("/cart", {
      method: "POST",
      body: JSON.stringify({ package: packageItems }),
      timeout: 45000
    });
  } catch (error) {
    const failureStatus=providerPaymentFailureStatus(error)==="AWAITING_FUNDS"?"AWAITING_FUNDS":([400,422].includes(Number(error.status))?"REJECTED_INPUT":"ERROR");
    const detail=(shipmentCorrections.providerErrorSummary(providerFailureText(error))+(error.status?" (HTTP "+Number(error.status)+")":"")).slice(0,1000);
    // Apenas nomes de campos de validação: não registrar CPF, endereços ou payload.
    const validationErrors = error?.providerData?.errors;
    const validationFields = validationErrors && typeof validationErrors === "object"
      ? Object.keys(validationErrors).filter(field => /^[a-zA-Z0-9_.-]{1,100}$/.test(field)).slice(0,12)
      : [];
    console.error("provider cart failure:",{orderId:order.id,httpStatus:Number(error.status)||null,validationFields,reason:detail});
    await db.updateProviderPayment(order.id,{status:failureStatus,error:detail});
    await db.updateStatus(order.id,"PROVIDER_PAYMENT_PENDING","PAID");
    await db.addOrderEvent(
      order.id,
      "PROVIDER_PAYMENT_PENDING",
      failureStatus==="AWAITING_FUNDS" ? "Saldo do provedor precisa de reposição" : "A transportadora não liberou a postagem",
      detail || "Falha ao gerar as etiquetas no provedor."
    );
    throw error;
  }

  const providerPayload = result.data || {};
  if (providerPayload.error === true) {
    const err = new Error(providerFailureText({providerData:providerPayload}) || "A transportadora recusou a postagem.");
    err.providerData = providerPayload;
    const failureStatus=providerPaymentFailureStatus(err);
    await db.updateProviderPayment(order.id,{status:failureStatus,error:shipmentCorrections.providerErrorSummary(providerFailureText(err)).slice(0,1000)});
    await db.updateStatus(order.id,"PROVIDER_PAYMENT_PENDING","PAID");
    throw err;
  }

  const cart = providerPayload.data || providerPayload;
  const shipment = shipmentFromProviderCart(cart, storedVolumes.length);
  if (!shipment.cartId && !shipment.packageId) {
    const err=new Error("A transportadora não retornou os dados da postagem.");
    await db.updateProviderPayment(order.id,{status:"ERROR",error:err.message});
    await db.updateStatus(order.id,"PROVIDER_PAYMENT_PENDING","PAID");
    throw err;
  }

  if (!shipment.ready) {
    await db.saveProviderPendingShipment(order.id,shipment);
    const awaitingFunds = shipment.providerPaid === false || /aguardando pagamento|awaiting payment|unpaid/i.test(shipment.providerStatus || "");
    await db.updateProviderPayment(order.id,{
      status:awaitingFunds ? "AWAITING_FUNDS" : "AWAITING_PROVIDER_CONFIRMATION",
      ref:shipment.cartId || shipment.packageId || null,
      error:awaitingFunds
        ? "Envio criado na transportadora e aguardando liberação financeira."
        : `Postagem criada na transportadora; aguardando etiquetas/rastreios dos volumes (${shipment.volumes.length}/${storedVolumes.length}).`
    });
    await db.addOrderEvent(
      order.id,
      awaitingFunds ? "PROVIDER_AWAITING_FUNDS" : "PROVIDER_PAYMENT_PENDING",
      awaitingFunds ? "Aguardando liberação financeira" : "Aguardando liberação da transportadora",
      awaitingFunds
        ? "O pagamento do cliente está confirmado; a etiqueta aguarda liberação da transportadora."
        : (storedVolumes.length > 1
            ? `Envio com ${storedVolumes.length} volumes criado no provedor e aguardando todas as etiquetas.`
            : "O pedido foi criado no provedor, mas a etiqueta/rastreio ainda não foram liberados.")
    );
    return shipment;
  }

  await db.saveShipment(order.id, shipment);
  await db.updateProviderPayment(order.id,{
    status:"PAID",
    ref:shipment.cartId || shipment.packageId || null,
    error:null
  });
  await db.addOrderEvent(order.id, "LABEL_AVAILABLE", storedVolumes.length > 1 ? "Etiquetas dos volumes liberadas" : "Etiqueta liberada",
    storedVolumes.length > 1
      ? `${storedVolumes.length} volumes prontos para impressão e postagem.`
      : "Postagem registrada na transportadora e etiqueta disponível.");
  return shipment;
}

function postalTrackingUrl(trackingCode) {
  const code=String(trackingCode||"").trim();
  if(!code) return "";
  const base=String(process.env.APP_PUBLIC_URL||"").replace(/\/$/,"");
  const path="/rastreio?codigo="+encodeURIComponent(code);
  return base ? base+path : path;
}

function publicOrder(order) {
  if (!order) return null;
  const rawPackageData = order.package_data && typeof order.package_data === "object" ? order.package_data : {};
  const { providerCepFrom: _internalProviderCep, ...safePackageData } = rawPackageData;
  return {
    id: order.id,
    storeId: order.store_id || null,
    storeName: order.store_name || "",
    storeCode: order.store_code || "",
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
    hubTransferTotal: Number(order.hub_transfer_total || 0),
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
      isManualExtra: addon.metadata?.source === "POINT_MANUAL_EXTRA",
      pointRevenue: Number(addon.point_revenue || 0)
    })) : [],
    carrier: order.carrier || "",
    serviceName: order.service_name || "",
    deadline: Number(order.deadline || 0),
    sender: order.sender || {},
    recipient: order.recipient || {},
    items: order.items || [],
    invoiceNumber: order.invoice_number || "",
    packageData: safePackageData,
    trackingCode: order.tracking_code || "",
    labelA4Url: order.label_a4_url || "",
    labelA6Url: order.label_a6_url || "",
    declarationUrl: order.declaration_url || "",
    // Nunca expor URL de rastreamento do prestador, inclusive em pedidos antigos.
    publicTrackingUrl: order.tracking_code ? "/rastreio?codigo="+encodeURIComponent(String(order.tracking_code).trim()) : "",
    shipmentVolumes: Array.isArray(order.shipment_volumes) ? order.shipment_volumes.map(v => ({
      index:Number(v.index || 0),
      packageId:v.packageId || null,
      trackingCode:v.trackingCode || "",
      labelA4Url:v.labelA4Url || "",
      labelA6Url:v.labelA6Url || "",
      declarationUrl:v.declarationUrl || "",
      publicTrackingUrl:(v.trackingCode || v.tracking_code) ? "/rastreio?codigo="+encodeURIComponent(String(v.trackingCode || v.tracking_code).trim()) : ""
    })) : [],
    providerPaymentStatus: order.provider_payment_status || "PENDING",
    providerPaymentRef: order.provider_payment_ref || "",
    providerPaymentAttempts: Number(order.provider_payment_attempts || 0),
    providerPaymentLastError: shipmentCorrections.providerErrorSummary(order.provider_payment_last_error),
    canEditShippingDetails: shipmentCorrections.canEditOrder(order),
    canReprocessShipment: shipmentCorrections.canRetryShipment(order),
    clientUserId: order.client_user_id || null,
    firstMileType: order.first_mile_type || "",
    firstMileFee: Number(order.first_mile_fee || 0),
    packageCount: Number(order.package_count || rawPackageData.volumes?.length || 1),
    referralCommission: Number(order.referral_commission || 0),
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

function publicOrderForUser(order,user) {
  const dto=publicOrder(order);
  if(!dto) return dto;
  if(user?.role==="STORE_CLERK"){
    delete dto.pointRevenueTotal;
    delete dto.partnerCommission;
    delete dto.cashRemittanceAmount;
    delete dto.cashRemittanceTotal;
    dto.addons=(dto.addons||[]).map(addon=>{
      const safe={...addon};
      delete safe.pointRevenue;
      return safe;
    });
  }
  return dto;
}

function validateFreightParties(sender, recipient, items) {
  const required = ["name", "document", "phone", "cep", "address", "number", "neighborhood", "city"];
  for (const pair of [["remetente", sender], ["destinatário", recipient]]) {
    const label = pair[0];
    const party = pair[1] || {};
    const missing = required.filter(key => !String(party[key] || "").trim());
    if (missing.length) throw Object.assign(new Error("Preencha os dados obrigatórios do " + label + "."),{status:400});
    if (!shipmentCorrections.validDocument(party.document)) {
      throw Object.assign(new Error("CPF/CNPJ do " + label + " inválido. Corrija os dígitos verificadores."),{status:400});
    }
  }
  if (!Array.isArray(items) || !items.length) throw new Error("Informe ao menos um item da encomenda.");
  if (items.some(item => !String(item.description || "").trim() || Number(item.quantity) <= 0 || Number(item.value) < 0)) {
    throw Object.assign(new Error("Revise os itens da encomenda."),{status:400});
  }
}

function normalizeClientAddress(raw,required=false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if(!required)return {};
    throw Object.assign(new Error("Informe os dados do endereço."),{status:400});
  }
  const result={};
  for(const field of ["name","document","phone","email","cep","address","number","neighborhood","complement","city"]){
    result[field]=String(raw[field]||"").trim().slice(0,field==="address"?200:120);
  }
  result.cep=cleanDigits(result.cep);
  result.document=cleanDigits(result.document);
  const addressFields=["cep","address","number","neighborhood","city"];
  const hasAddress=addressFields.some(field=>Boolean(result[field]));
  if(required||hasAddress){
    if(addressFields.some(field=>!result[field])||result.cep.length!==8){
      throw Object.assign(new Error("Informe CEP, logradouro, número, bairro e cidade/UF completos."),{status:400});
    }
  }
  if(required&&["name","document","phone"].some(field=>!result[field])){
    throw Object.assign(new Error("Informe nome, documento e telefone do contato."),{status:400});
  }
  if(result.document&&![11,14].includes(result.document.length)){
    throw Object.assign(new Error("CPF/CNPJ precisa ter 11 ou 14 dígitos."),{status:400});
  }
  if(result.email&&!/^\S+@\S+\.\S+$/.test(result.email)){
    throw Object.assign(new Error("E-mail do contato inválido."),{status:400});
  }
  return result;
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

function clientOpsStatus(order) {
  const collectionStatus=String(order?.collection_status||"").toUpperCase();
  if(["COLLECTED","RECEIVED_AT_POINT","COMPLETED"].includes(collectionStatus)) return "SENT";
  if(String(order?.payment_status||"").toUpperCase()!=="PAID") return "AWAITING_PAYMENT";
  if(String(order?.status||"").toUpperCase()==="PROVIDER_PAYMENT_PENDING") return "PROVIDER_PENDING";
  return "READY_TO_SHIP";
}

async function simulatedLabelPdf(order) {
  const pdf=await PDFDocument.create();
  const page=pdf.addPage([283.46,425.2]); // A6 em pontos
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const draw=(text,x,y,size=10,isBold=false)=>{
    page.drawText(String(text||""),{x,y,size,font:isBold?bold:font,color:rgb(0,0,0)});
  };
  draw("POSTAL SERVIÇOS",20,392,15,true);
  draw("ETIQUETA DE HOMOLOGAÇÃO — SEM VALIDADE LOGÍSTICA",20,370,8,true);
  draw("Rastreio:",20,340,9,true); draw(order.tracking_code||"—",80,340,11,true);
  draw("Transportadora:",20,315,8,true); draw(order.carrier||"Postal",100,315,9);
  draw("Serviço:",20,298,8,true); draw(order.service_name||"",62,298,9);
  const sender=order.sender||{},recipient=order.recipient||{};
  draw("REMETENTE",20,265,9,true);
  draw((sender.name||"").slice(0,40),20,248,9);
  draw(((sender.address||"")+" "+(sender.number||"")).slice(0,48),20,232,8);
  draw(((sender.city||"")+" "+(sender.cep||"")).slice(0,48),20,216,8);
  draw("DESTINATÁRIO",20,185,9,true);
  draw((recipient.name||"").slice(0,40),20,168,9);
  draw(((recipient.address||"")+" "+(recipient.number||"")).slice(0,48),20,152,8);
  draw(((recipient.city||"")+" "+(recipient.cep||"")).slice(0,48),20,136,8);
  draw("Pedido Postal: "+String(order.id||"").slice(0,12).toUpperCase(),20,92,8);
  draw("Documento gerado somente para testes do fluxo de impressão.",20,56,7);
  return Buffer.from(await pdf.save());
}

async function mergedLabelPdf(orders) {
  const target=await PDFDocument.create();
  for(const order of orders){
    if(order.package_data?.carrierMode==="POSTAL_OWN") {
      const volumes=Array.isArray(order.shipment_volumes)&&order.shipment_volumes.length
        ? order.shipment_volumes : [{index:1,trackingCode:order.tracking_code}];
      for(const volume of volumes){
        const own=await PDFDocument.load(await postalLabel.generate(order,volume));
        for(const page of await target.copyPages(own,own.getPageIndices()))target.addPage(page);
      }
      continue;
    }
    if(order.is_simulation){
      const simBytes=await simulatedLabelPdf(order);
      const simDoc=await PDFDocument.load(simBytes);
      const pages=await target.copyPages(simDoc,simDoc.getPageIndices());
      pages.forEach(page=>target.addPage(page));
      continue;
    }

    const shipmentVolumes=Array.isArray(order.shipment_volumes)?order.shipment_volumes:[];
    const urls=shipmentVolumes.length
      ? shipmentVolumes.map(v=>v.labelA6Url||v.labelA4Url).filter(Boolean)
      : [order.label_a6_url||order.label_a4_url].filter(Boolean);

    if(!urls.length) throw new Error("Etiqueta indisponível para o pedido "+order.id);

    for(const raw of urls){
      const rawUrl=String(raw||"");
      const allowedPrefix=`${API_URL}/package/`;
      if(!rawUrl.startsWith(allowedPrefix)) throw new Error("Etiqueta inválida para o pedido "+order.id);
      const response=await fetch(rawUrl,{
        method:"GET",
        headers:providerHeaders(),
        signal:AbortSignal.timeout(30000)
      });
      if(!response.ok) throw new Error("Não foi possível carregar uma das etiquetas.");
      const bytes=Buffer.from(await response.arrayBuffer());
      const source=await PDFDocument.load(bytes);
      const pages=await target.copyPages(source,source.getPageIndices());
      pages.forEach(page=>target.addPage(page));
    }
  }
  return Buffer.from(await target.save());
}

async function processAsaasWebhookEvent(eventRow) {
  const payload = eventRow.payload || {};
  const eventType = String(eventRow.event_type || payload.event || "");
  const checkoutId = String(eventRow.checkout_id || payload.checkout?.id || "");
  const order = checkoutId ? await db.getOrderByCheckoutId(checkoutId) : null;
  const topup = !order && checkoutId ? await clientDb.getTopupByCheckoutId(checkoutId) : null;

  if (!order && !topup) {
    await db.markWebhookProcessed(eventRow.id, "Pedido ou recarga não encontrados para o checkout.");
    return;
  }

  try {
    if (topup) {
      if (eventType === "CHECKOUT_PAID") {
        await clientDb.markTopupPaid(topup.id);
      } else if (eventType === "CHECKOUT_CANCELED") {
        await clientDb.updateTopupStatus(topup.id, "CANCELED");
      } else if (eventType === "CHECKOUT_EXPIRED") {
        await clientDb.updateTopupStatus(topup.id, "EXPIRED");
      }
      await db.markWebhookProcessed(eventRow.id, null);
      return;
    }

    if (eventType === "CHECKOUT_PAID") {
      const ownRegional=order.package_data?.carrierMode==="POSTAL_OWN";
      const paidOrder = await db.markPaid(order.id, (ENABLE_SHIPMENT_CREATION||ownRegional) ? "PAYMENT_CONFIRMED" : "PAID_WAITING_SHIPMENT");
      if (order.payment_method !== "DINHEIRO") {
        await db.consumeOrderInventory(order.id, inventoryOwnerFromOrder(order));
      }
      await db.addOrderEvent(order.id, "PAYMENT_CONFIRMED", "Pagamento confirmado", "Confirmação recebida pelo gateway de pagamento.");
      if (ENABLE_SHIPMENT_CREATION||ownRegional) {
        try {
          await createShipmentFromOrder(paidOrder);
        } catch (shipmentError) {
          console.error("shipment after payment error:",{orderId:order.id,httpStatus:Number(shipmentError.status)||null,reason:shipmentCorrections.providerErrorSummary(providerFailureText(shipmentError))});
          await db.updateStatus(order.id, "SHIPMENT_ERROR", "PAID");
        }
      }
    } else if (eventType === "CHECKOUT_CANCELED") {
      if (order.payment_method !== "DINHEIRO") await db.releaseOrderInventory(order.id, inventoryOwnerFromOrder(order));
      await db.updateStatus(order.id, "PAYMENT_CANCELED", "CANCELED");
      await db.addOrderEvent(order.id, "PAYMENT_CANCELED", "Pagamento cancelado", "O checkout foi cancelado.");
    } else if (eventType === "CHECKOUT_EXPIRED") {
      if (order.payment_method !== "DINHEIRO") await db.releaseOrderInventory(order.id, inventoryOwnerFromOrder(order));
      await db.updateStatus(order.id, "PAYMENT_EXPIRED", "EXPIRED");
      await db.addOrderEvent(order.id, "PAYMENT_EXPIRED", "Pagamento expirado", "O checkout expirou sem confirmação.");
    }

    await db.markWebhookProcessed(eventRow.id, null);
  } catch (error) {
    await db.markWebhookProcessed(eventRow.id, String(error.message || error));
    throw error;
  }
}

async function processPendingProviderPayments() {
  if (!process.env.DATABASE_URL || !ENABLE_SHIPMENT_CREATION || !TOKEN) return;
  try {
    const candidates = await db.listProviderPaymentRetryCandidates(20);
    for (const order of candidates) {
      try {
        console.log("CONECTENVIOS_RETRY", order.id, "attempt", Number(order.provider_payment_attempts || 0) + 1);
        await createShipmentFromOrder(order);
      } catch (error) {
        const status = providerPaymentFailureStatus(error);
        if (status !== "AWAITING_FUNDS") {
          console.error("ConectEnvios retry stopped:",{
            orderId:order.id,
            httpStatus:Number(error.status)||null,
            reason:shipmentCorrections.providerErrorSummary(providerFailureText(error))
          });
        }
      }
    }

    const confirmations = await db.listProviderConfirmationCandidates(20);
    for (const order of confirmations) {
      try {
        console.log("CONECTENVIOS_CONFIRMATION_POLL", order.id, order.conect_cart_id);
        await refreshShipmentFromProvider(order);
      } catch (error) {
        await db.updateProviderPayment(order.id,{
          status:"AWAITING_PROVIDER_CONFIRMATION",
          ref:order.conect_cart_id || null,
          error:providerFailureText(error).slice(0,1000)
        });
      }
    }
  } catch (error) {
    console.error("provider payment worker error:", error.message);
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
    provider: "Postal Shipping Gateway",
    providerConfigured: Boolean(TOKEN)
  });
});

app.get("/api/public-config", (_req, res) => {
  res.json({
    provider: "Postal Serviços",
    providerConfigured: Boolean(TOKEN),
    demoAuth: DEMO_AUTH,
    commissionPercent: round2(PARTNER_COMMISSION * 100),
    receiptWidthMm: RECEIPT_WIDTH_MM,
    shipmentCreationEnabled: ENABLE_SHIPMENT_CREATION,
    paymentsProvider: "ASAAS",
    paymentsConfigured: asaas.configured(),
    paymentsOperational: paymentOperational(),
    paymentsEnvironment: paymentRuntime.environment?.keyEnvironment || "unknown",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    fiscalLookupConfigured: fiscalLookupConfigured(),
    fiscalLookupProvider: FISCAL_LOOKUP_PROVIDER,
    publicQuoteEnabled: PUBLIC_QUOTE_ENABLED && Boolean(TOKEN),
    version: "1.10.0",
    dataResetVersion: String(process.env.POSTAL_DATA_RESET_VERSION||""),
    paymentSimulatorEnabled: PAYMENT_SIMULATOR_ENABLED && !asaas.configured(),
    clientPickupFeePerPackage: CLIENT_PICKUP_FEE_PER_PACKAGE,
    pointPickupEarningPerPackage: POINT_PICKUP_EARNING_PER_PACKAGE,
    pointDropoffEarningPerPackage: POINT_DROPOFF_EARNING_PER_PACKAGE,
    referralEarningPerShipment: REFERRAL_EARNING_PER_SHIPMENT
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
        storeName: user.store_name || null,
        storeCommissionPercent: user.store_commission_percent == null ? null : Number(user.store_commission_percent)
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
      storeCode: req.user.storeCode || null,
      storeCommissionPercent: req.user.storeCommissionPercent == null ? null : Number(req.user.storeCommissionPercent)
    }
  });
});

app.post("/api/client/register", async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const document = cleanDigits(body.document || "");
    const phone = String(body.phone || "").trim();
    const companyName = String(body.companyName || "").trim();
    const referralCode = String(body.referralCode || "").trim();

    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !name || password.length < 6) {
      return res.status(400).json({ error: "Informe nome, e-mail válido e senha com pelo menos 6 caracteres." });
    }

    const existing = await db.findUserByEmail(email);
    if (existing) return res.status(409).json({ error: "Já existe uma conta com este e-mail." });

    let referralStore = null;
    if (referralCode) {
      referralStore = await clientDb.findStoreByReferralCode(referralCode);
      if (!referralStore) return res.status(400).json({ error: "Link de indicação inválido ou ponto inativo." });
    }

    const user = await db.createUser({
      storeId: null,
      email,
      name,
      passwordHash: hashPassword(password),
      role: "CLIENT",
      active: true
    });

    await clientDb.createCustomerAccount({
      userId: user.id,
      document,
      phone,
      companyName,
      referralStoreId: referralStore?.id || null,
      defaultSender: body.defaultSender || {}
    });

    await db.insertAudit({
      userId: user.id,
      storeId: referralStore?.id || null,
      userEmail: email,
      action: "CLIENT_REGISTER",
      entityType: "CLIENT",
      entityId: user.id,
      metadata: { referred: Boolean(referralStore), referralStoreCode: referralStore?.code || null }
    });

    res.status(201).json({
      ok: true,
      message: referralStore
        ? "Conta criada e vinculada ao ponto indicador."
        : "Conta cliente criada com sucesso."
    });
  } catch (error) {
    console.error("client register error:", error.message);
    res.status(500).json({ error: "Não foi possível criar a conta cliente." });
  }
});

// Public quotations do not grant a purchase token and are rate-limited.
// This route is intentionally before the session/CSRF middleware.
app.post("/api/public/cotacao", async (req,res)=>{
  if (!PUBLIC_QUOTE_ENABLED) return res.status(503).json({error:"Cotação pública temporariamente indisponível."});
  if (!TOKEN) return res.status(503).json({error:"Cotação em tempo real indisponível. Tente novamente mais tarde."});
  let input;
  try { input = publicQuote.validatePublicQuote(req.body,parseQuoteVolumes); }
  catch (error) { return res.status(400).json({error:error.message}); }
  const limit = visitorQuoteLimiter(String(req.ip || req.socket?.remoteAddress || "unknown"));
  if (!limit.ok) {
    res.setHeader("Retry-After",String(limit.retryAfter));
    return res.status(429).json({error:"Muitas cotações realizadas. Aguarde alguns minutos para consultar novamente."});
  }
  if (publicQuotesInFlight >= 4) {
    res.setHeader("Retry-After","15");
    return res.status(503).json({error:"Estamos consultando muitos fretes. Tente novamente em alguns segundos."});
  }
  publicQuotesInFlight++;
  try {
    const {cepFrom,cepTo,volumes}=input;
    const origin=await resolveOperationalQuoteOrigin({role:"PUBLIC"},cepFrom);
    // A vitrine gratuita usa a mesma comissão do ponto que atenderá esta origem.
    const partnerCommissionRate=quotePricing.pointCommissionRate(origin.store,PARTNER_COMMISSION);
    const hubTransferTotal=origin.overridden?round2(HUB_TRANSFER_FEE_PER_PACKAGE*volumes.length):0;
    const quoteSets=await mapWithConcurrency(volumes,Math.min(3,CONECTENVIO_QUOTE_CONCURRENCY),async volume=>{
      let quoted;
      try{quoted=await fetchProviderQuoteCached(origin.providerCepFrom,cepTo,volume);}
      catch(error){if(error.status===422)return [];throw error;}
      if(quoted.data?.error===true)return [];
      return normalizeQuote(quoted.data,partnerCommissionRate);
    });
    const options=aggregateVolumeQuoteSets(quoteSets);
    const own=await offerPostalRegional(options,cepFrom,cepTo,hubTransferTotal,volumes,partnerCommissionRate);
    if(own)options.unshift(own);
    if(!options.length)return res.status(422).json({error:"Nenhuma tarifa de transportadora ou da Postal está disponível para esta rota."});
    res.setHeader("Cache-Control","no-store");
    res.json(publicQuote.publicQuoteResponse(options,{volumes,cepFrom,cepTo,hubTransferTotal,demo:false}));
  }catch(error){
    console.error("public quote error:",error.status,error.message);
    res.status(error.status===422?422:502).json({error:error.status===422?error.message:"Não foi possível consultar as transportadoras agora. Tente novamente."});
  }finally{publicQuotesInFlight--;}
});

// CSRF para mutações autenticadas do painel. Webhooks e API externa usam autenticação própria.
app.use("/api", (req, res, next) => {
  if (!["POST","PUT","PATCH","DELETE"].includes(req.method)) return next();
  if (req.path.startsWith("/webhooks/") || req.path.startsWith("/integrations/") || req.path.startsWith("/wl/")) return next();

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

app.post("/api/account/password", requireAuth, async (req,res)=>{
  try{
    const currentPassword=String(req.body.currentPassword||"");
    const newPassword=String(req.body.newPassword||"");
    if(newPassword.length<10){
      return res.status(400).json({error:"A nova senha precisa ter pelo menos 10 caracteres."});
    }
    if(currentPassword===newPassword){
      return res.status(400).json({error:"A nova senha precisa ser diferente da senha atual."});
    }
    const user=await db.findUserByEmail(req.user.email);
    if(!user || !user.active || !verifyPassword(currentPassword,user.password_hash)){
      return res.status(401).json({error:"Senha atual incorreta."});
    }
    await db.updateUser(user.id,{passwordHash:hashPassword(newPassword)});
    await audit(req,"CHANGE_OWN_PASSWORD","USER",user.id,{});
    res.setHeader("Set-Cookie","postal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ok:true,reloginRequired:true,message:"Senha alterada. Entre novamente com a nova senha."});
  }catch(error){
    console.error("change own password error:",error.message);
    res.status(500).json({error:"Não foi possível alterar a senha."});
  }
});

app.get("/api/client/profile",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try{
    const account=await clientDb.getCustomerAccount(req.user.userId);
    if(!account)return res.status(404).json({error:"Conta cliente não encontrada."});
    res.json({profile:{
      name:account.name,email:account.email,document:account.document||"",
      phone:account.phone||"",companyName:account.company_name||"",
      defaultSender:account.default_sender||{},
      referralStoreName:account.referral_store_name||""
    }});
  }catch(error){console.error("client profile read:",error.message);res.status(500).json({error:"Não foi possível carregar o perfil."});}
});

app.patch("/api/client/profile",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try{
    const account=await clientDb.getCustomerAccount(req.user.userId);
    if(!account)return res.status(404).json({error:"Conta cliente não encontrada."});
    const phone=cleanDigits(req.body?.phone||"").slice(0,15);
    const companyName=String(req.body?.companyName||"").trim().slice(0,180);
    if(phone && phone.length<10)return res.status(400).json({error:"Informe um telefone com DDD válido."});
    const raw={...(req.body?.defaultSender||{}),name:account.name,document:account.document,phone:phone||account.phone,email:account.email};
    const defaultSender=normalizeClientAddress(raw);
    await clientDb.updateCustomerProfile(req.user.userId,{phone,companyName,defaultSender});
    await audit(req,"CLIENT_PROFILE_UPDATE","CLIENT",req.user.userId,{defaultSender:!!defaultSender.cep});
    res.json({ok:true,message:"Perfil atualizado."});
  }catch(error){console.error("client profile update:",error.message);res.status(error.status||500).json({error:error.status?error.message:"Não foi possível atualizar o perfil."});}
});

app.get("/api/client/addresses",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try{
    const addresses=await clientDb.listCustomerAddresses(req.user.userId);
    res.json({addresses:addresses.map(a=>({
      id:a.id,kind:a.kind,label:a.label,address:a.address_data,createdAt:a.created_at
    }))});
  }catch(error){res.status(500).json({error:"Não foi possível carregar os endereços."});}
});

app.post("/api/client/addresses",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try{
    const kind=String(req.body?.kind||"").toUpperCase();
    const label=String(req.body?.label||"").trim().slice(0,80);
    if(!["SENDER","RECIPIENT"].includes(kind)||!label)return res.status(400).json({error:"Informe o tipo e um apelido para o endereço."});
    const address=normalizeClientAddress(req.body?.address,true);
    const saved=await clientDb.createCustomerAddress(req.user.userId,{kind,label,address});
    res.status(201).json({ok:true,address:{id:saved.id,kind:saved.kind,label:saved.label,address:saved.address_data}});
  }catch(error){console.error("client address create:",error.message);res.status(error.status||500).json({error:error.status?error.message:"Não foi possível salvar o endereço."});}
});

app.delete("/api/client/addresses/:id",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try{
    if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:"Identificador inválido."});
    const removed=await clientDb.deleteCustomerAddress(req.user.userId,req.params.id);
    if(!removed)return res.status(404).json({error:"Endereço não encontrado."});
    res.json({ok:true});
  }catch(error){res.status(500).json({error:"Não foi possível excluir o endereço."});}
});

app.post("/api/quotes/share",requireAuth,requireRole("ADMIN","STORE_OWNER","STORE_CLERK","CLIENT"),async(req,res)=>{
  try{
    const tokens=req.body?.selectionTokens;
    if(!Array.isArray(tokens)||!tokens.length||tokens.length>12){
      return res.status(400).json({error:"Compartilhe de 1 a 12 opções de uma mesma cotação."});
    }
    const selections=tokens.map(token=>typeof token==="string"&&token.length<50000?verifySelectionToken(token):null);
    if(selections.some(p=>!p))return res.status(400).json({error:"Cotação vencida ou inválida. Calcule os fretes novamente."});
    const quoteData=publicQuotes.buildPublicQuote(selections);
    const token=await clientDb.createQuoteShare(req.user.userId,quoteData);
    await audit(req,"SHARE_QUOTE","QUOTE_SHARE",null,{options:quoteData.options.length});
    const base=String(process.env.APP_PUBLIC_URL||"").replace(/\/$/,"");
    const url=(base||"")+"/cotacao-compartilhada?c="+encodeURIComponent(token);
    res.status(201).json({url,expiresAt:quoteData.expiresAt});
  }catch(error){
    console.error("share quote error:",error.message);
    res.status(error.status||500).json({error:error.status?error.message:"Não foi possível compartilhar a cotação."});
  }
});

app.get("/api/public/quotes/:token",async(req,res)=>{
  try{
    const snapshot=await clientDb.getQuoteShare(String(req.params.token||""));
    if(!snapshot)return res.status(404).json({error:"Cotação não encontrada ou expirada. Solicite uma nova cotação."});
    res.setHeader("Cache-Control","private,no-store");
    res.json({quote:snapshot.quote_data});
  }catch(error){
    res.status(503).json({error:"Não foi possível consultar esta cotação agora."});
  }
});

app.get("/api/public/points",async(_req,res)=>{
  try{
    const stores=await clientDb.listPublicStores();
    res.setHeader("Cache-Control","public,max-age=120");
    res.json({points:stores.map(publicPoints.sanitizePoint).filter(publicPoints.isPublishablePoint)});
  }catch(error){
    console.error("public points error:",error.message);
    res.status(503).json({error:"Os pontos estão temporariamente indisponíveis."});
  }
});

app.get("/api/client/dashboard", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const [wallet,operations,collections,connections]=await Promise.all([
      clientDb.getWallet(req.user.userId),
      clientDb.listClientOperations(req.user.userId,250),
      clientDb.listCollections({clientUserId:req.user.userId},250),
      clientDb.listConnections(req.user.userId)
    ]);
    const shipmentStatuses=operations.shipments.map(clientOpsStatus);
    res.json({
      balance:Number(wallet?.balance||0),
      referralStore:wallet?.account?.referral_store_name||"",
      totalShipments:operations.shipments.length,
      importedOrders:operations.imports.length,
      readyToShip:shipmentStatuses.filter(x=>x==="READY_TO_SHIP").length,
      sentOrders:shipmentStatuses.filter(x=>x==="SENT").length,
      pendingCollections:collections.filter(x=>!["COLLECTED","RECEIVED_AT_POINT","COMPLETED","CANCELED"].includes(x.status)).length,
      connections:connections.length
    });
  }catch(error){
    console.error("client dashboard error:",error.message);
    res.status(500).json({error:"Não foi possível carregar sua conta."});
  }
});

app.get("/api/client/wallet", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const wallet=await clientDb.getWallet(req.user.userId);
    const transactions=await clientDb.listWalletTransactions(req.user.userId,100);
    const topups=await clientDb.listTopups(req.user.userId,50);
    res.json({
      balance:Number(wallet?.balance||0),
      transactions:transactions.map(t=>({
        id:t.id,type:t.transaction_type,amount:Number(t.amount||0),status:t.status,
        description:t.description||"",createdAt:t.created_at
      })),
      topups:topups.map(t=>({
        id:t.id,amount:Number(t.amount||0),fee:Number(t.fee||0),totalAmount:Number(t.total_amount||0),
        paymentMethod:t.payment_method,status:t.status,checkoutUrl:t.checkout_url||"",
        isSimulation:Boolean(t.is_simulation),createdAt:t.created_at,paidAt:t.paid_at
      }))
    });
  }catch(error){res.status(500).json({error:"Não foi possível carregar o saldo."});}
});

app.post("/api/client/wallet/topup-preview", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const amount=round2(Number(req.body.amount||0));
    const paymentMethod=String(req.body.paymentMethod||"PIX").toUpperCase();
    if(!Number.isFinite(amount)||amount<10) return res.status(400).json({error:"Informe ao menos R$ 10,00."});
    if(!["PIX","CARTAO"].includes(paymentMethod)) return res.status(400).json({error:"Forma de pagamento inválida."});
    const p=asaas.grossUp(amount,paymentMethod);
    res.json({credit:amount,fee:Number(p.surcharge||0),total:Number(p.grossAmount||amount)});
  }catch(error){res.status(400).json({error:error.message||"Não foi possível calcular a recarga."});}
});

app.post("/api/client/wallet/topups", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  let topup=null;
  try{
    const amount=round2(Number(req.body.amount||0));
    const paymentMethod=String(req.body.paymentMethod||"PIX").toUpperCase();
    if(!Number.isFinite(amount)||amount<10||amount>50000) return res.status(400).json({error:"A recarga deve ficar entre R$ 10 e R$ 50.000."});
    if(!["PIX","CARTAO"].includes(paymentMethod)) return res.status(400).json({error:"Escolha PIX ou cartão."});

    const preview=asaas.grossUp(amount,paymentMethod);
    const simulation=PAYMENT_SIMULATOR_ENABLED&&!asaas.configured();
    if(!simulation && !paymentOperational()){
      return res.status(503).json({error:"Pagamentos reais estão temporariamente bloqueados até a validação completa do Asaas produção."});
    }
    topup=await clientDb.createTopup({
      userId:req.user.userId,amount,fee:preview.surcharge,totalAmount:preview.grossAmount,
      paymentMethod,provider:simulation?"SIMULATOR":"ASAAS",isSimulation:simulation
    });

    if(simulation){
      const paid=await clientDb.markTopupPaid(topup.id);
      await audit(req,"SIMULATE_WALLET_TOPUP","WALLET_TOPUP",topup.id,{amount});
      return res.status(201).json({
        topup:{...topup,status:"PAID",isSimulation:true},
        balance:Number(paid.balance||0),
        message:"Saldo de homologação adicionado. Nenhum dinheiro real foi movimentado."
      });
    }

    if(!asaas.configured()){
      await clientDb.updateTopupStatus(topup.id,"FAILED");
      return res.status(503).json({error:"A recarga real será liberada assim que a conta Asaas estiver ativa."});
    }

    const account=await clientDb.getCustomerAccount(req.user.userId);
    const billingAddress=account?.default_sender||{};
    const checkout=await asaas.createCheckout({
      orderId:"TOPUP-"+topup.id,
      billingType:paymentMethod,
      amount,
      itemName:"Adicionar saldo Postal",
      itemDescription:"Crédito pré-pago para uso exclusivo em serviços Postal Serviços",
      partnerWalletId:null,reserveWalletId:null,partnerCommission:0,providerCost:0,
      customerData:account ? {
        name:account.name||req.user.name||"",
        cpfCnpj:account.document||"",
        email:account.email||req.user.email||"",
        phone:account.phone||"",
        address:billingAddress.address||"",
        addressNumber:billingAddress.number||"",
        complement:billingAddress.complement||"",
        postalCode:billingAddress.cep||"",
        province:billingAddress.neighborhood||""
      } : null
    });

    const updated=await clientDb.setTopupCheckout(topup.id,{
      checkoutId:checkout.id,checkoutUrl:checkout.url,fee:checkout.surcharge,totalAmount:checkout.grossAmount
    });
    await audit(req,"CREATE_WALLET_TOPUP","WALLET_TOPUP",topup.id,{amount,paymentMethod});
    res.status(201).json({topup:updated,checkoutUrl:checkout.url});
  }catch(error){
    if(topup?.id){
      try{await clientDb.updateTopupStatus(topup.id,"FAILED");}catch{}
    }
    const providerDetail=asaas.providerErrorMessage?.(error.providerData,error.message) || error.message;
    console.error("wallet topup error:",error.status||"",providerDetail);
    res.status(error.status && error.status<500 ? error.status : 502).json({
      error:providerDetail||"Não foi possível gerar a recarga."
    });
  }
});

app.get("/api/client/points", requireAuth, requireRole("CLIENT"), async (_req,res)=>{
  try{
    const stores=await clientDb.listPublicStores();
    res.json({points:stores.map(s=>({
      id:s.id,code:s.code,name:s.name,address:s.address||{},
      pickupEnabled:Boolean(s.pickup_enabled),referralCode:s.referral_code||""
    }))});
  }catch(error){res.status(500).json({error:"Não foi possível carregar os pontos Postal."});}
});

app.get("/api/client/orders", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const orders=await clientDb.listClientOrders(req.user.userId,Number(req.query.limit||100));
    res.json({orders:orders.map(publicOrder)});
  }catch(error){res.status(500).json({error:"Não foi possível carregar seus envios."});}
});

app.get("/api/client/bulk/template",requireAuth,requireRole("CLIENT"),async(_req,res)=>{
  try {
    const output=await bulkShipping.template();
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",'attachment; filename="postal-modelo-postagens-em-massa.xlsx"');
    res.setHeader("Cache-Control","private,no-store");
    res.send(Buffer.from(output));
  } catch(error) {
    console.error("bulk template error",error.message);
    res.status(500).json({error:"Não foi possível gerar o modelo da planilha."});
  }
});

app.post("/api/client/bulk/parse",requireAuth,requireRole("CLIENT"),async(req,res)=>{
  try {
    const parsed=await bulkShipping.parseUpload(req.body||{});
    const rows=parsed.rows.map(row=>({
      ...row,
      bulkRowKey:"bulk:"+crypto.createHash("sha256")
        .update("postal-bulk-order-v1|"+row.ref).digest("hex")
    }));
    await audit(req,"PREVIEW_CLIENT_BULK_FILE","BULK_IMPORT",null,{rows:rows.length,valid:parsed.valid,invalid:parsed.invalid});
    res.json({rows,valid:parsed.valid,invalid:parsed.invalid});
  }catch(error){
    res.status(400).json({error:error.message||"Arquivo de postagens inválido."});
  }
});

app.post("/api/client/orders", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  let createdOrderId=null;
  let createdCollectionId=null;
  try{
    const body=req.body||{};
    const bulkRowKey=String(body.bulkRowKey||"").trim();
    if(bulkRowKey&&!/^bulk:[a-f0-9]{64}$/.test(bulkRowKey)){
      return res.status(400).json({error:"Identificador do lote inválido."});
    }
    if(bulkRowKey){
      const previous=await clientDb.getClientOrderByBulkKey(req.user.userId,bulkRowKey);
      if(previous){
        const wallet=await clientDb.getWallet(req.user.userId);
        return res.json({ok:true,alreadyCreated:true,order:publicOrderForUser(previous,req.user),balance:Number(wallet?.balance||0)});
      }
    }
    const selection=verifySelectionToken(body.selectionToken);
    if(!selection||!Number.isFinite(Number(selection.providerCost))){
      return res.status(400).json({error:"A cotação expirou. Calcule novamente."});
    }
    if(Number(selection.partnerCommission||0)!==0){
      return res.status(400).json({error:"Esta cotação não pertence ao portal cliente. Calcule novamente."});
    }
    const ownRegional=postalRegional.isOwnSelection(selection);
    const safeSandbox=asaas.isSandbox();
    if (asaas.configured() && !ENABLE_SHIPMENT_CREATION && !ownRegional && !safeSandbox) {
      return res.status(503).json({error:"A emissão real ainda está em homologação. Seu saldo não será debitado até a geração real de etiquetas ser liberada."});
    }

    const sender=body.sender||{},recipient=body.recipient||{};
    const items=Array.isArray(body.items)?body.items:[];
    validateFreightParties(sender,recipient,items);
    if(ownRegional && (!postalRegional.matchesCity(sender.city,selection.package?.ownRoute?.originCity) ||
      !postalRegional.matchesCity(recipient.city,selection.package?.ownRoute?.destinationCity))){
      return res.status(400).json({error:"A cidade informada não corresponde à rota Postal Regional cotada. Corrija o endereço ou faça outra cotação."});
    }
    if(cleanDigits(sender.cep)!==selection.package.cepFrom||cleanDigits(recipient.cep)!==selection.package.cepTo){
      return res.status(400).json({error:"Os CEPs mudaram após a cotação."});
    }

    const firstMileType=String(body.firstMileType||"LATER").toUpperCase();
    if(!["PICKUP","DROPOFF","LATER"].includes(firstMileType)){
      return res.status(400).json({error:"Escolha coleta, postagem em um ponto ou solicitar depois."});
    }

    const packageCount=Math.max(1,Number(selection.package?.volumes?.length || selection.package?.volumeCount || 1));
    const firstMileFee=firstMileType==="LATER"?0:round2(CLIENT_PICKUP_FEE_PER_PACKAGE*packageCount);
    const account=await clientDb.getCustomerAccount(req.user.userId);
    if(!account) return res.status(400).json({error:"Conta cliente não encontrada."});

    let assignedStore=null;
    let pointRate=0;
    if(firstMileType==="PICKUP"){
      const address={
        ...sender,
        state:sender.state||String(sender.city||"").split("/")[1]||"",
        city:String(sender.city||"").split("/")[0]||sender.city||""
      };
      const choice=await clientDb.choosePickupStore({address,latitude:body.latitude,longitude:body.longitude});
      assignedStore=choice?.store||null;
      pointRate=assignedStore?POINT_PICKUP_EARNING_PER_PACKAGE:0;
    }else if(firstMileType==="DROPOFF"){
      const stores=await clientDb.listPublicStores();
      assignedStore=stores.find(s=>s.id===String(body.dropoffStoreId||""))||null;
      if(!assignedStore) return res.status(400).json({error:"Selecione o ponto Postal onde os pacotes serão deixados."});
      pointRate=POINT_DROPOFF_EARNING_PER_PACKAGE;
    }

    const pointCompensation=round2(pointRate*packageCount);
    const postalFirstMile=round2(firstMileFee-pointCompensation);
    const freightPrice=round2(Number(selection.salePrice));
    const providerCost=round2(Number(selection.providerCost));
    const postalMargin=round2(Number(selection.postalMargin||Math.max(0,freightPrice-providerCost)));
    const referralCommission=account.referral_store_id?round2(REFERRAL_EARNING_PER_SHIPMENT):0;
    const totalAmount=round2(freightPrice+firstMileFee);
    const postalRevenueTotal=round2(postalMargin+postalFirstMile-referralCommission);
    const orderId=crypto.randomUUID();
    createdOrderId=orderId;

    const created=await clientDb.createClientOrderAndDebit({
      id:orderId,clientUserId:req.user.userId,referralStoreId:account.referral_store_id||null,
      referralCommission,partnerEmail:req.user.email,status:"PAYMENT_CONFIRMED",
      totalAmount,freightPrice,customerSubtotal:totalAmount,postalRevenueTotal,providerCost,postalMargin,
      firstMileType:firstMileType==="LATER"?null:firstMileType,firstMileFee,packageCount,
      postalCompanyId:selection.postalCompanyId,
      carrier:ownRegional?"Postal Serviços":String(selection.carrierName||body.carrier||""),serviceName:String(selection.service||""),deadline:Number(selection.deadline||0),
      quoteToken:body.selectionToken,sender,recipient,items,invoiceNumber:String(body.invoiceNumber||"").trim(),
      bulkRowKey,
      hubTransferFeePerPackage:Number(selection.hubTransferFeePerPackage||0),
      hubTransferTotal:Number(selection.hubTransferTotal||0),
      packageData:{...selection.package, fiscalDocument:normalizeFiscalReference(body)}
    });

    if(created.alreadyCreated){
      const existing=await clientDb.getClientOrder(created.order.id,req.user.userId);
      return res.json({ok:true,alreadyCreated:true,order:publicOrderForUser(existing,req.user),balance:created.balance});
    }

    let collection=null;
    if(firstMileType!=="LATER"){
      collection=await clientDb.createCollectionRequest({
        clientUserId:req.user.userId,freightOrderId:orderId,serviceType:firstMileType,
        status:firstMileType==="DROPOFF"?"WAITING_DROPOFF":(assignedStore?"ASSIGNED":"REQUESTED"),
        packageCount,feePerPackage:CLIENT_PICKUP_FEE_PER_PACKAGE,totalFee:firstMileFee,
        assignedStoreId:assignedStore?.id||null,pointRate,pointCompensation,
        postalCompensation:postalFirstMile,address:sender,latitude:body.latitude||null,longitude:body.longitude||null,
        scheduledFor:body.scheduledFor||null,notes:String(body.collectionNotes||"")
      });
      createdCollectionId=collection?.id||null;
    }

    await db.addOrderEvent(orderId,"WALLET_PAYMENT","Pagamento com saldo Postal","Valor debitado da carteira pré-paga.");
    if(firstMileType==="LATER"){
      await db.addOrderEvent(orderId,"FIRST_MILE_PENDING","Coleta ainda não solicitada","O cliente poderá selecionar vários envios e solicitar a coleta em lote.");
    }else{
      await db.addOrderEvent(orderId,"FIRST_MILE_REQUESTED",
        firstMileType==="PICKUP"?"Coleta solicitada":"Postagem no ponto selecionada",
        assignedStore?("Ponto: "+assignedStore.name):"Aguardando direcionamento pela Postal.");
    }

    const simulation=!ENABLE_SHIPMENT_CREATION && !ownRegional && (safeSandbox || (PAYMENT_SIMULATOR_ENABLED&&!asaas.configured()));
    let shipmentIssued=false;

    if(ENABLE_SHIPMENT_CREATION||ownRegional){
      const orderForProvider=await db.getOrder(orderId);
      await createShipmentFromOrder(orderForProvider);
      await db.addOrderEvent(orderId,"SHIPMENT_CREATED","Etiqueta gerada","Postagem criada na malha logística.");
      shipmentIssued=true;
    }else if(simulation){
      const tracking="CLI"+orderId.replace(/-/g,"").slice(0,10).toUpperCase();
      await db.saveSimulatedShipment(orderId,tracking);
      await db.addOrderEvent(orderId,"LABEL_AVAILABLE_SIMULATED","Etiqueta de homologação liberada","Documento sem validade logística.");
      shipmentIssued=true;
    }else{
      await db.updateStatus(orderId,"PAID_WAITING_SHIPMENT","PAID");
    }

    if(body.sourceEcommerceOrderId){
      await clientDb.linkImportedOrder(String(body.sourceEcommerceOrderId),req.user.userId,orderId);
    }

    if(shipmentIssued&&account.referral_store_id){
      await clientDb.createPointEarning({
        storeId:account.referral_store_id,clientUserId:req.user.userId,earningType:"REFERRAL",
        amount:referralCommission,referenceType:"FREIGHT_ORDER",referenceId:orderId,
        status:simulation?"SIMULATED":"EARNED",metadata:{source:"client_portal"}
      });
    }

    await audit(req,"CREATE_CLIENT_SHIPMENT","FREIGHT_ORDER",orderId,{
      firstMileType,packageCount,collectionId:collection?.id||null,
      referral:Boolean(account.referral_store_id),sourceEcommerceOrderId:body.sourceEcommerceOrderId||null
    });
    const complete=await clientDb.getClientOrder(orderId,req.user.userId);
    res.status(201).json({order:publicOrderForUser(complete,req.user),collection,balance:created.balance});
  }catch(error){
    console.error("client shipment error:",error.message);
    if(error.code==="23505" && req.body?.bulkRowKey){
      const existing=await clientDb.getClientOrderByBulkKey(req.user.userId,req.body.bulkRowKey).catch(()=>null);
      if(existing){
        const wallet=await clientDb.getWallet(req.user.userId);
        return res.json({ok:true,alreadyCreated:true,order:publicOrderForUser(existing,req.user),balance:Number(wallet?.balance||0)});
      }
    }
    if(createdOrderId){
      try{
        const existing=await clientDb.getClientOrder(createdOrderId,req.user.userId);
        const permanentProviderFailure=String(existing?.provider_payment_status||"").toUpperCase()==="ERROR";
        const preProviderFailure=["PAYMENT_CONFIRMED","PAID_WAITING_SHIPMENT"].includes(String(existing?.status||""));
        if(existing&&(preProviderFailure||permanentProviderFailure)){
          await clientDb.creditWallet(req.user.userId,Number(existing.payment_amount||0),{
            type:"REFUND",description:"Estorno automático por falha definitiva na criação do envio",
            orderId:createdOrderId,idempotencyKey:"client-order-refund:"+createdOrderId
          });
          await db.updateStatus(createdOrderId,"CLIENT_ORDER_ERROR","REFUNDED");
          await db.addOrderEvent(
            createdOrderId,
            "CLIENT_ORDER_REFUNDED",
            "Saldo devolvido automaticamente",
            "A postagem não pôde ser criada. O valor foi devolvido ao Saldo Postal."
          );
          if(createdCollectionId){
            try{
              await clientDb.updateCollection(createdCollectionId,{
                status:"CANCELED",
                notes:"Cancelada automaticamente porque a postagem não foi criada."
              });
            }catch(collectionError){
              console.error("client collection cancel error:",collectionError.message);
            }
          }
        }
      }catch(refundError){console.error("client shipment refund error:",refundError.message);}
    }
    res.status(error.message==="Saldo insuficiente."?402:500).json({error:error.message||"Não foi possível criar o envio."});
  }
});

app.get("/api/client/operations", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const [wallet,data]=await Promise.all([
      clientDb.getWallet(req.user.userId),
      clientDb.listClientOperations(req.user.userId,Number(req.query.limit||250))
    ]);

    const imported=(data.imports||[]).map(row=>({
      kind:"IMPORTED",
      id:row.id,
      externalOrderId:row.external_order_id,
      sourcePlatform:row.platform,
      sourceConnection:row.connection_name||"",
      customerName:row.customer_name||"",
      sourceStatus:row.external_status||row.import_status||"IMPORTED",
      status:"IMPORTED",
      payload:row.payload||{},
      createdAt:row.created_at
    }));

    const shipments=(data.shipments||[]).map(row=>({
      kind:"SHIPMENT",
      id:row.id,
      sourceOrderId:row.source_order_id||"",
      sourcePlatform:row.source_platform||"POSTAL",
      sourceConnection:row.source_connection_name||"",
      customerName:row.recipient?.name||"",
      destination:row.recipient?.city||row.recipient?.cep||"",
      status:clientOpsStatus(row),
      internalStatus:row.status,
      paymentStatus:row.payment_status,
      carrier:row.carrier||"",
      serviceName:row.service_name||"",
      total:Number(row.payment_amount||row.customer_subtotal||row.sale_price||0),
      trackingCode:row.tracking_code||"",
      labelReady:Boolean(row.tracking_code)&&["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(row.status),
      isSimulation:Boolean(row.is_simulation),
      collectionId:row.collection_id||null,
      collectionStatus:row.collection_status||"",
      collectionServiceType:row.collection_service_type||"",
      collectionStoreName:row.collection_store_name||"",
      sender:row.sender||{},
      recipient:row.recipient||{},
      createdAt:row.created_at
    }));

    const all=[...imported,...shipments].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const counts={
      imported:all.filter(x=>x.status==="IMPORTED").length,
      awaitingPayment:all.filter(x=>x.status==="AWAITING_PAYMENT").length,
      readyToShip:all.filter(x=>x.status==="READY_TO_SHIP").length,
      sent:all.filter(x=>x.status==="SENT").length
    };

    res.json({balance:Number(wallet?.balance||0),counts,items:all});
  }catch(error){
    console.error("client operations error:",error.message);
    res.status(500).json({error:"Não foi possível carregar o painel de pedidos."});
  }
});

app.get("/api/client/imported-orders/:id", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const order=await clientDb.getImportedOrder(req.params.id,req.user.userId);
    if(!order) return res.status(404).json({error:"Pedido importado não encontrado."});
    res.json({order:{
      id:order.id,externalOrderId:order.external_order_id,platform:order.platform,
      connectionName:order.connection_name||"",customerName:order.customer_name||"",
      status:order.external_status||order.import_status,payload:order.payload||{}
    }});
  }catch(error){res.status(500).json({error:"Não foi possível carregar o pedido importado."});}
});

app.post("/api/client/orders/bulk-issue", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const ids=[...new Set((req.body.orderIds||[]).map(String).filter(Boolean))].slice(0,100);
    if(!ids.length) return res.status(400).json({error:"Selecione ao menos um envio."});
    const results=[];
    for(const orderId of ids){
      const order=await clientDb.getClientOrder(orderId,req.user.userId);
      if(!order){results.push({id:orderId,ok:false,error:"Envio não encontrado."});continue;}
      if(String(order.payment_status)!=="PAID"){results.push({id:orderId,ok:false,error:"Pagamento pendente."});continue;}
      if(["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(order.status)){
        results.push({id:orderId,ok:true,alreadyReady:true});continue;
      }
      try{
        if(ENABLE_SHIPMENT_CREATION||order.package_data?.carrierMode==="POSTAL_OWN"){
          await createShipmentFromOrder(order);
          await db.addOrderEvent(order.id,"SHIPMENT_CREATED","Etiqueta gerada em lote","Postagem criada pela emissão em massa.");
        }else if(asaas.isSandbox()){
          const tracking="CLI"+order.id.replace(/-/g,"").slice(0,10).toUpperCase();
          await db.saveSimulatedShipment(order.id,tracking);
          await db.addOrderEvent(order.id,"LABEL_AVAILABLE_SIMULATED","Etiqueta de homologação em lote","Documento sem validade logística.");
        }else{
          results.push({id:orderId,ok:false,error:"Emissão real ainda não liberada."});continue;
        }
        results.push({id:orderId,ok:true});
      }catch(error){
        results.push({id:orderId,ok:false,error:error.message||"Falha na emissão."});
      }
    }
    await audit(req,"BULK_ISSUE_LABELS","FREIGHT_ORDER","batch",{count:ids.length});
    res.json({results,issued:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length});
  }catch(error){res.status(500).json({error:error.message||"Não foi possível emitir as etiquetas."});}
});

app.post("/api/client/orders/bulk-labels", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const ids=[...new Set((req.body.orderIds||[]).map(String).filter(Boolean))].slice(0,100);
    if(!ids.length) return res.status(400).json({error:"Selecione etiquetas para imprimir."});
    const orders=[];
    for(const orderId of ids){
      const order=await clientDb.getClientOrder(orderId,req.user.userId);
      if(!order) continue;
      if(!["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(order.status)) continue;
      orders.push(order);
    }
    if(!orders.length) return res.status(400).json({error:"Nenhuma etiqueta disponível entre os pedidos selecionados."});
    const pdf=await mergedLabelPdf(orders);
    await audit(req,"BULK_PRINT_LABELS","FREIGHT_ORDER","batch",{count:orders.length});
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",'inline; filename="etiquetas-postal.pdf"');
    res.send(pdf);
  }catch(error){
    console.error("bulk labels error:",error.message);
    res.status(500).json({error:"Não foi possível montar o arquivo de etiquetas."});
  }
});

app.post("/api/client/collections/bulk", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const ids=[...new Set((req.body.orderIds||[]).map(String).filter(Boolean))].slice(0,100);
    if(!ids.length) return res.status(400).json({error:"Selecione ao menos um envio pronto."});

    const first=await clientDb.getClientOrder(ids[0],req.user.userId);
    if(!first) return res.status(404).json({error:"Envio não encontrado."});
    const address=req.body.address&&Object.keys(req.body.address).length?req.body.address:(first.sender||{});
    const latitude=req.body.latitude==null?null:Number(req.body.latitude);
    const longitude=req.body.longitude==null?null:Number(req.body.longitude);
    const choice=await clientDb.choosePickupStore({address,latitude,longitude});
    const assignedStore=choice?.store||null;

    const result=await clientDb.createBulkCollectionsAndDebit({
      userId:req.user.userId,orderIds:ids,address,latitude,longitude,
      scheduledFor:req.body.scheduledFor||null,notes:String(req.body.notes||""),
      feePerPackage:CLIENT_PICKUP_FEE_PER_PACKAGE,
      pointRate:POINT_PICKUP_EARNING_PER_PACKAGE,
      assignedStoreId:assignedStore?.id||null
    });

    for(const collection of result.collections){
      if(collection.freight_order_id){
        await db.addOrderEvent(
          collection.freight_order_id,
          "FIRST_MILE_REQUESTED",
          "Coleta solicitada em lote",
          assignedStore?("Direcionada para "+assignedStore.name):"Aguardando direcionamento pela Postal."
        );
      }
    }
    await audit(req,"BULK_REQUEST_COLLECTION","COLLECTION","batch",{
      orders:ids.length,packages:result.totalPackages,totalFee:result.totalFee,assignedStoreId:assignedStore?.id||null
    });
    res.status(201).json({
      collections:result.collections,balance:result.balance,
      totalPackages:result.totalPackages,totalFee:result.totalFee,
      assignedStore:assignedStore?{id:assignedStore.id,name:assignedStore.name}:null
    });
  }catch(error){
    const status=error.message?.includes("Saldo insuficiente")?402:400;
    res.status(status).json({error:error.message||"Não foi possível solicitar as coletas."});
  }
});

app.get("/api/client/collections", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const rows=await clientDb.listCollections({clientUserId:req.user.userId},100);
    res.json({collections:rows});
  }catch(error){res.status(500).json({error:"Não foi possível carregar as coletas."});}
});

app.get("/api/client/connections", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const connections=await clientDb.listConnections(req.user.userId);
    const orders=await clientDb.listEcommerceOrders(req.user.userId,100);
    res.json({
      supported:[
        {code:"NUVEMSHOP",name:"Nuvemshop",mode:"OAUTH",ready:Boolean(NUVEMSHOP_APP_ID&&NUVEMSHOP_CLIENT_SECRET)},
        {code:"WOOCOMMERCE",name:"WooCommerce",mode:"STORE_AUTH",ready:true},
        {code:"LOJA_INTEGRADA",name:"Loja Integrada",mode:"PERSONAL_TOKEN",ready:true},
        {code:"SHOPIFY",name:"Shopify",mode:"OAUTH",ready:SHOPIFY_READY},
        {code:"TRAY",name:"Tray",mode:"OAUTH",ready:false}
      ],
      connections:connections.map(x=>({
        id:x.id,platform:x.platform,displayName:x.display_name||"",status:x.status,
        importedOrders:Number(x.imported_orders||0),lastSyncAt:x.last_sync_at,
        authorizationUrl:x.authorization_url||"",
        externalStoreId:x.external_store_id||"",
        storeUrl:x.config?.storeUrl||"",
        lastError:x.config?.lastError||""
      })),
      orders
    });
  }catch(error){res.status(500).json({error:"Não foi possível carregar as integrações."});}
});

app.post("/api/client/connections", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const platform=String(req.body.platform||"").toUpperCase();
    const allowed=new Set(["NUVEMSHOP","WOOCOMMERCE","LOJA_INTEGRADA","SHOPIFY","TRAY"]);
    if(!allowed.has(platform)) return res.status(400).json({error:"Plataforma ainda não suportada."});
    const displayName=String(req.body.displayName||"").trim();
    const storeUrl=String(req.body.storeUrl||"").trim();

    if(platform==="NUVEMSHOP"){
      if(!NUVEMSHOP_APP_ID || !NUVEMSHOP_CLIENT_SECRET){
        return res.status(503).json({error:"O aplicativo Postal na Nuvemshop ainda precisa do App ID e Client Secret do Portal de Parceiros."});
      }
      const connection=await clientDb.createConnection({userId:req.user.userId,platform,displayName});
      const state=signEcommerceState(connection.id);
      const authorizationUrl=ecommerce.buildNuvemshopAuthorizationUrl({appId:NUVEMSHOP_APP_ID,state});
      const updated=await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"AWAITING_PROVIDER_AUTH",
        authorizationUrl,
        config:{whiteLabel:"POSTAL_SERVICOS",bridge:"DIRECT_NUVEMSHOP",authRequestedAt:new Date().toISOString(),lastError:""}
      });
      await audit(req,"CREATE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform});
      return res.status(201).json({
        connection:{id:updated.id,platform:updated.platform,status:updated.status,displayName:updated.display_name||"",authorizationUrl},
        authorizationUrl,
        message:"Nuvemshop preparada. Autorize o aplicativo Postal na sua loja."
      });
    }

    if(platform==="WOOCOMMERCE"){
      const normalizedStoreUrl=await ecommerce.assertPublicHttpsUrl(storeUrl);
      const connection=await clientDb.createConnection({userId:req.user.userId,platform,displayName});
      const state=signEcommerceState(connection.id);
      const authorizationUrl=ecommerce.buildWooAuthorizationUrl({
        storeUrl:normalizedStoreUrl,
        connectionState:state,
        appPublicUrl:process.env.APP_PUBLIC_URL
      });
      const updated=await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"AWAITING_PROVIDER_AUTH",
        authorizationUrl,
        config:{
          whiteLabel:"POSTAL_SERVICOS",
          bridge:"DIRECT_WOOCOMMERCE",
          storeUrl:normalizedStoreUrl,
          authRequestedAt:new Date().toISOString(),
          lastError:""
        }
      });
      await audit(req,"CREATE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform});
      return res.status(201).json({
        connection:{
          id:updated.id,platform:updated.platform,status:updated.status,
          displayName:updated.display_name||"",authorizationUrl
        },
        authorizationUrl,
        message:"WooCommerce preparado. Autorize o acesso na sua loja."
      });
    }

    if(platform==="SHOPIFY"){
      if(!SHOPIFY_READY){
        return res.status(503).json({error:"A integração Shopify precisa do Client ID, Client Secret e APP_PUBLIC_URL HTTPS do aplicativo Postal."});
      }
      const shop=ecommerce.normalizeShopifyShop(storeUrl);
      const connection=await clientDb.createConnection({userId:req.user.userId,platform,displayName});
      const oauth=createShopifyState(connection.id);
      const authorizationUrl=ecommerce.buildShopifyAuthorizationUrl({
        shop,clientId:SHOPIFY_CLIENT_ID,state:oauth.state,
        redirectUri:String(process.env.APP_PUBLIC_URL||"").replace(/\/$/,"")+"/api/integrations/shopify/callback"
      });
      const updated=await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"AWAITING_PROVIDER_AUTH",authorizationUrl,
        config:{whiteLabel:"POSTAL_SERVICOS",bridge:"DIRECT_SHOPIFY",shop,
          storeUrl:"https://"+shop,oauthStateHash:oauth.hash,
          oauthExpiresAt:new Date(Date.now()+30*60*1000).toISOString(),
          authRequestedAt:new Date().toISOString(),lastError:""}
      });
      await audit(req,"CREATE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform,shop});
      return res.status(201).json({
        connection:{id:updated.id,platform,status:updated.status,displayName:updated.display_name||"",authorizationUrl},
        authorizationUrl,message:"Shopify preparada. Autorize o acesso aos pedidos na sua loja."
      });
    }

    const connection=await clientDb.createConnection({userId:req.user.userId,platform,displayName});
    if(platform==="LOJA_INTEGRADA"){
      const updated=await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"AWAITING_PROVIDER_AUTH",
        config:{whiteLabel:"POSTAL_SERVICOS",bridge:"DIRECT_LOJA_INTEGRADA",lastError:""}
      });
      await audit(req,"CREATE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform});
      return res.status(201).json({
        connection:{id:updated.id,platform:updated.platform,status:updated.status,displayName:updated.display_name||""},
        requiresCredential:"PERSONAL_TOKEN",
        message:"Loja Integrada preparada. Informe o personal token gerado pelo proprietário da loja."
      });
    }
    if(storeUrl){
      await clientDb.updateConnection(connection.id,req.user.userId,{
        config:{whiteLabel:"POSTAL_SERVICOS",bridge:"CONECTENVIOS",storeUrl}
      });
    }
    await audit(req,"CREATE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform});
    res.status(201).json({
      connection:{
        id:connection.id,platform:connection.platform,status:connection.status,
        displayName:connection.display_name||""
      },
      message:"Integração criada. A autorização desta plataforma será habilitada quando as credenciais do aplicativo estiverem configuradas."
    });
  }catch(error){
    console.error("create ecommerce connection error:",error.message);
    res.status(400).json({error:error.message||"Não foi possível preparar a integração."});
  }
});

app.post("/api/client/connections/:id/credentials", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const connection=await clientDb.getConnectionById(req.params.id);
    if(!connection || String(connection.user_id)!==String(req.user.userId)){
      return res.status(404).json({error:"Integração não encontrada."});
    }
    const platform=String(connection.platform||"").toUpperCase();
    if(platform!=="LOJA_INTEGRADA"){
      return res.status(400).json({error:"Esta conexão não usa credencial manual."});
    }
    const personalToken=String(req.body.personalToken||"").trim();
    if(personalToken.length<12){
      return res.status(400).json({error:"Personal token inválido."});
    }
    const config=connection.config||{};
    const credentialBlob=ecommerce.encryptCredentials({personalToken},SESSION_SECRET);
    const validating={...connection,config:{...config,credentialBlob}};
    // A primeira sincronização também funciona como validação real da credencial.
    await clientDb.updateConnection(connection.id,req.user.userId,{
      status:"SYNCING",
      config:{...config,credentialBlob,lastError:""}
    });
    try{
      const result=await syncLojaIntegradaConnection(validating);
      await audit(req,"CONNECT_ECOMMERCE_CREDENTIAL","ECOMMERCE_CONNECTION",connection.id,{platform,imported:result.imported});
      return res.json({ok:true,connected:true,imported:result.imported,message:"Loja Integrada conectada com sucesso."});
    }catch(error){
      await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"ERROR",
        config:{...config,lastError:String(error.message||"Credencial recusada").slice(0,500)}
      });
      throw error;
    }
  }catch(error){
    console.error("ecommerce credential setup error:",error.message);
    res.status(error.status&&error.status<500?error.status:502).json({error:error.message||"Não foi possível validar a credencial."});
  }
});

app.post("/api/client/connections/:id/sync", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const connection=await clientDb.getConnectionById(req.params.id);
    if(!connection || String(connection.user_id)!==String(req.user.userId)) {
      return res.status(404).json({error:"Integração não encontrada."});
    }
    if(connection.status!=="CONNECTED" && connection.status!=="ERROR"){
      return res.status(409).json({error:"Conclua a autorização da loja antes de sincronizar."});
    }

    if(["WOOCOMMERCE","LOJA_INTEGRADA","NUVEMSHOP","SHOPIFY"].includes(String(connection.platform).toUpperCase())){
      await clientDb.updateConnection(connection.id,req.user.userId,{
        status:"SYNCING",
        config:{...(connection.config||{}),lastError:""}
      });
      const fresh=await clientDb.getConnectionById(connection.id);
      const result=await syncEcommerceConnection(fresh);
      await audit(req,"SYNC_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform:connection.platform,imported:result.imported});
      return res.json({ok:true,imported:result.imported,message:result.imported+" pedido(s) aprovado(s) sincronizado(s)."});
    }

    const currentConfig=connection.config||{};
    const updated=await clientDb.updateConnection(connection.id,req.user.userId,{
      status:"SYNC_REQUESTED",
      config:{...currentConfig,syncRequestedAt:new Date().toISOString(),lastError:""}
    });
    await audit(req,"REQUEST_ECOMMERCE_SYNC","ECOMMERCE_CONNECTION",connection.id,{platform:connection.platform});
    res.json({ok:true,connection:{id:updated.id,status:updated.status},message:"Sincronização solicitada."});
  }catch(error){
    const connection=await clientDb.getConnectionById(req.params.id).catch(()=>null);
    if(connection){
      await clientDb.updateConnection(connection.id,connection.user_id,{
        status:"ERROR",
        config:{...(connection.config||{}),lastError:String(error.message||"Falha na sincronização").slice(0,500)}
      }).catch(()=>{});
    }
    console.error("manual ecommerce sync error:",error.message);
    res.status(502).json({error:error.message||"Não foi possível sincronizar a loja."});
  }
});

app.delete("/api/client/connections/:id", requireAuth, requireRole("CLIENT"), async (req,res)=>{
  try{
    const connection=await clientDb.getConnectionById(req.params.id);
    if(!connection || String(connection.user_id)!==String(req.user.userId)) {
      return res.status(404).json({error:"Integração não encontrada."});
    }
    const removed=await clientDb.deleteConnection(connection.id,req.user.userId);
    if(!removed) return res.status(404).json({error:"Integração não encontrada."});
    await audit(req,"DELETE_ECOMMERCE_CONNECTION","ECOMMERCE_CONNECTION",connection.id,{platform:connection.platform});
    res.json({ok:true});
  }catch(error){res.status(500).json({error:"Não foi possível desconectar a loja."});}
});

app.get("/api/store/pickup-settings", requireAuth, requireRole("STORE_OWNER","OPS"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const store=await db.getStore(req.user.storeId);
    res.json({
      enabled:Boolean(store?.pickup_enabled),radiusKm:Number(store?.pickup_radius_km||10),
      latitude:store?.latitude==null?null:Number(store.latitude),
      longitude:store?.longitude==null?null:Number(store.longitude),
      pickupRate:POINT_PICKUP_EARNING_PER_PACKAGE,dropoffRate:POINT_DROPOFF_EARNING_PER_PACKAGE,
      referralCode:store?.referral_code||store?.code||""
    });
  }catch(error){res.status(500).json({error:"Não foi possível carregar a configuração de coletas."});}
});

app.patch("/api/store/pickup-settings", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const store=await clientDb.updateStorePickupSettings(req.user.storeId,{
      enabled:req.body.enabled,radiusKm:req.body.radiusKm,latitude:req.body.latitude,longitude:req.body.longitude
    });
    await audit(req,"UPDATE_PICKUP_SETTINGS","STORE",req.user.storeId,{enabled:Boolean(req.body.enabled)});
    res.json({ok:true,settings:{
      enabled:Boolean(store.pickup_enabled),radiusKm:Number(store.pickup_radius_km||10),
      latitude:store.latitude==null?null:Number(store.latitude),longitude:store.longitude==null?null:Number(store.longitude)
    }});
  }catch(error){res.status(500).json({error:"Não foi possível atualizar a opção de coletas."});}
});


function analyticsDateRange(query={}) {
  const now=new Date();
  const end=new Date(now);
  let start=new Date(now);
  const period=String(query.period||"30d").toLowerCase();
  if(period==="today"){
    start=new Date(now); start.setHours(0,0,0,0);
  }else if(period==="7d"){
    start=new Date(now.getTime()-6*86400000); start.setHours(0,0,0,0);
  }else if(period==="90d"){
    start=new Date(now.getTime()-89*86400000); start.setHours(0,0,0,0);
  }else if(period==="month"){
    start=new Date(now.getFullYear(),now.getMonth(),1);
  }else if(period==="year"){
    start=new Date(now.getFullYear(),0,1);
  }else if(period==="custom" && /^\d{4}-\d{2}-\d{2}$/.test(String(query.from||""))){
    start=new Date(String(query.from)+"T00:00:00");
    if(/^\d{4}-\d{2}-\d{2}$/.test(String(query.to||""))){
      end.setTime(new Date(String(query.to)+"T23:59:59.999").getTime());
    }
  }else{
    start=new Date(now.getTime()-29*86400000); start.setHours(0,0,0,0);
  }
  if(start>end){ const tmp=start; start=end; end=tmp; }
  return {start,end,period};
}

// Relatório da cadeia de custódia Postal: mede somente leituras internas.
// Não confunde ausência de leitura com atraso contratual da transportadora.
async function readOperationalReport(req) {
  const range=analyticsDateRange(req.query||{});
  const params=[range.start.toISOString(),range.end.toISOString()];
  const where=["f.created_at >= $1::timestamptz","f.created_at <= $2::timestamptz","f.is_simulation=FALSE","f.payment_status='PAID'"];
  const storeId=reportStoreForUser(req.user,req.query.storeId);
  if(storeId){
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(storeId))throw Object.assign(new Error("Ponto inválido."),{status:400});
    params.push(storeId);where.push("f.store_id=$"+params.length);
  }
  for(const [column,value] of [["carrier",req.query.carrier],["service_name",req.query.service]]){
    const filter=String(value||"").trim().slice(0,120);
    if(filter){params.push(filter);where.push("LOWER(f."+column+")=LOWER($"+params.length+")");}
  }
  const paymentMethod=String(req.query.paymentMethod||"").trim().toUpperCase();
  if(paymentMethod){
    if(!["PIX","CARTAO","DINHEIRO"].includes(paymentMethod))throw Object.assign(new Error("Pagamento inválido."),{status:400});
    params.push(paymentMethod);where.push("UPPER(f.payment_method)=$"+params.length);
  }
  const {rows}=await db.pool.query(operationalMetrics.custodyReportSql(where.join(" AND ")),params);
  const truncated=rows.length>operationalMetrics.MAX_ROWS;
  const data=operationalMetrics.summarizeCustody(rows.slice(0,operationalMetrics.MAX_ROWS),{inactivityHours:24});
  return {range:{from:range.start.toISOString(),to:range.end.toISOString()},scope:{storeId:storeId||null},truncated,...data};
}

app.get("/api/analytics/custody",requireAuth,requireRole("ADMIN","SUPERVISOR","STORE_OWNER"),async(req,res)=>{
  try{
    const {items,...report}=await readOperationalReport(req);
    res.setHeader("Cache-Control","no-store");
    res.json(report);
  }catch(error){
    console.error("custody analytics error",error.message);
    res.status(error.status||503).json({error:error.status?error.message:"Não foi possível carregar o painel de movimentação."});
  }
});

app.get("/api/analytics/custody.csv",requireAuth,requireRole("ADMIN","SUPERVISOR","STORE_OWNER"),async(req,res)=>{
  try{
    const report=await readOperationalReport(req);
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",'attachment; filename="postal-movimentacao-'+new Date().toISOString().slice(0,10)+'.csv"');
    res.send(operationalMetrics.custodyCsv(report.items));
  }catch(error){
    console.error("custody CSV error",error.message);
    res.status(error.status||503).json({error:error.status?error.message:"Não foi possível exportar as movimentações."});
  }
});

app.get("/api/postal/tariffs",requireAuth,requireRole("ADMIN"),async(_req,res)=>{
  try{
    res.setHeader("Cache-Control","no-store");
    res.json({cities:postalRegional.cities,tariffs:await db.listPostalTariffs(false)});
  }catch(error){console.error("regional tariffs list",error.message);res.status(503).json({error:"Não foi possível consultar a tabela regional."});}
});

app.put("/api/postal/tariffs",requireAuth,requireRole("ADMIN"),requireCurrentUser,async(req,res)=>{
  try{
    const body=req.body||{};
    const canonicalCity=value=>postalRegional.cities.find(city=>postalRegional.canonical(city)===postalRegional.canonical(value));
    const originCity=canonicalCity(body.originCity),destinationCity=canonicalCity(body.destinationCity);
    const price=Number(body.price),deadlineDays=Number(body.deadlineDays);
    const estimatedOperatingCost=Number(body.estimatedOperatingCost??0);
    if(!originCity||!destinationCity||!Number.isFinite(price)||price<=0||price>10000||
      !Number.isInteger(deadlineDays)||deadlineDays<1||deadlineDays>30||
      !Number.isFinite(estimatedOperatingCost)||estimatedOperatingCost<0||estimatedOperatingCost>10000||
      typeof body.active!=="boolean"){
      return res.status(400).json({error:"Informe cidades atendidas, preço por volume, prazo, custo estimado e situação válida."});
    }
    const tariff=await db.savePostalTariff({originCity,destinationCity,price:round2(price),deadlineDays,
      estimatedOperatingCost:round2(estimatedOperatingCost),active:body.active,userId:req.user.userId});
    await audit(req,"SAVE_POSTAL_ROUTE_TARIFF","POSTAL_TARIFF",tariff.id,{originCity,destinationCity,active:body.active,price:round2(price),deadlineDays});
    res.json({ok:true,tariff});
  }catch(error){console.error("regional tariffs save",error.message);res.status(503).json({error:"Não foi possível salvar a tabela regional."});}
});

async function readPostalDispatch(req){
  const scoped=req.user.role!=="ADMIN";
  if(scoped&&!req.user.storeId)throw Object.assign(new Error("Conta sem ponto vinculado."),{status:403});
  const {rows}=await db.pool.query(postalOperations.dispatchSql(scoped),scoped?[req.user.storeId]:[]);
  return postalOperations.summarizeDispatch(rows);
}

app.get("/api/postal/dispatch",requireAuth,requireRole("ADMIN","SUPERVISOR","STORE_OWNER","OPS"),requireCurrentUser,async(req,res)=>{
  try{
    res.setHeader("Cache-Control","no-store");res.json(await readPostalDispatch(req));
  }catch(error){console.error("postal dispatch",error.message);res.status(error.status||503).json({error:error.status?error.message:"Não foi possível consultar a expedição."});}
});
app.get("/api/postal/dispatch.csv",requireAuth,requireRole("ADMIN","SUPERVISOR","STORE_OWNER","OPS"),requireCurrentUser,async(req,res)=>{
  try{
    const report=await readPostalDispatch(req);
    res.setHeader("Cache-Control","private,no-store");res.type("text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",'attachment; filename="postal-expedicao.csv"');
    res.send(postalOperations.dispatchCsv(report.shipments));
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:"Não foi possível exportar a expedição."});}
});

app.post("/api/postal/orders/:id/operating-costs",requireAuth,requireRole("ADMIN"),requireCurrentUser,async(req,res)=>{
  try{
    if(!/^[\da-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:"Pedido inválido."});
    const order=await db.getOrder(req.params.id);
    if(!order||order.package_data?.carrierMode!=="POSTAL_OWN"||order.payment_status!=="PAID"||order.is_simulation)
      return res.status(409).json({error:"Registre custo somente em frete Postal próprio, real e pago."});
    const description=String(req.body?.description||"").trim().replace(/\s+/g," ");
    const amount=Number(req.body?.amount);
    const idempotencyKey=String(req.body?.idempotencyKey||"");
    if(description.length<3||description.length>120||!Number.isFinite(amount)||amount<=0||amount>100000||
      Math.abs(amount*100-Math.round(amount*100))>0.000001||!/^[\da-f-]{36}$/i.test(idempotencyKey))
      return res.status(400).json({error:"Informe descrição, custo em reais (duas casas) e identificador de lançamento."});
    const cost=await db.addPostalOperatingCost({orderId:order.id,description,amount:round2(amount),actorUserId:req.user.userId,idempotencyKey});
    if(cost.order_id!==order.id||cost.description!==description||Number(cost.amount)!==round2(amount))
      return res.status(409).json({error:"Identificador de lançamento já utilizado em outro custo."});
    await audit(req,"REGISTER_POSTAL_OPERATING_COST","FREIGHT_ORDER",order.id,{costId:cost.id,amount:round2(amount)});
    res.status(201).json({ok:true,cost:{id:cost.id,amount:Number(cost.amount),createdAt:cost.created_at}});
  }catch(error){console.error("postal operating cost",error.message);res.status(503).json({error:"Não foi possível registrar o custo operacional."});}
});

app.get("/api/analytics/overview", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER"), async (req,res)=>{
  try{
    const range=analyticsDateRange(req.query||{});
    const params=[range.start.toISOString(),range.end.toISOString()];
    const where=["f.created_at >= $1::timestamptz","f.created_at <= $2::timestamptz","f.is_simulation=FALSE"];
    const globalRole=req.user.role==="ADMIN";
    const storeId=reportStoreForUser(req.user,req.query.storeId);
    if(storeId){
      params.push(storeId); where.push("f.store_id=$"+params.length);
    }
    const carrier=String(req.query.carrier||"").trim();
    if(carrier){
      params.push(carrier); where.push("LOWER(f.carrier)=LOWER($"+params.length+")");
    }
    const service=String(req.query.service||"").trim();
    if(service){
      params.push(service); where.push("LOWER(f.service_name)=LOWER($"+params.length+")");
    }
    const paymentMethod=String(req.query.paymentMethod||"").trim().toUpperCase();
    if(paymentMethod){
      params.push(paymentMethod); where.push("UPPER(f.payment_method)=$"+params.length);
    }
    const paidWhere=where.concat(["f.payment_status='PAID'"]);
    const whereSql=where.join(" AND ");
    const paidWhereSql=paidWhere.join(" AND ");
    const rangeDays=Math.max(1,Math.ceil((range.end-range.start)/86400000)+1);
    const bucket=rangeDays<=45?"day":(rangeDays<=210?"week":"month");
    const bucketFormat=bucket==="day"?"DD/MM":(bucket==="week"?"DD/MM":"MM/YYYY");

    const [
      summaryResult,timelineResult,carrierResult,serviceResult,paymentResult,
      clientsResult,destinationsResult,statusResult,storesResult,filterCarrierResult,filterServiceResult
    ]=await Promise.all([
      db.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE f.payment_status='PAID')::int AS paid_orders,
           COALESCE(SUM(f.package_count) FILTER (WHERE f.payment_status='PAID'),0)::int AS packages,
           COALESCE(SUM(f.customer_subtotal+f.payment_surcharge) FILTER (WHERE f.payment_status='PAID'),0) AS gross_sales,
           COALESCE(SUM(f.point_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS point_revenue,
           COALESCE(SUM(f.postal_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS postal_revenue,
           COALESCE(SUM(f.hub_transfer_total) FILTER (WHERE f.payment_status='PAID'),0) AS hub_transfer_revenue,
           COALESCE(SUM(f.provider_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS provider_cost,
           COALESCE(AVG(f.customer_subtotal+f.payment_surcharge) FILTER (WHERE f.payment_status='PAID'),0) AS avg_ticket,
           COUNT(DISTINCT COALESCE(NULLIF(f.sender->>'document',''),NULLIF(LOWER(f.sender->>'name'),''))) FILTER (WHERE f.payment_status='PAID')::int AS unique_customers
         FROM freight_orders f
         WHERE ${whereSql}`,
        params
      ),
      db.pool.query(
        `SELECT date_trunc('${bucket}',f.created_at) AS bucket,
                to_char(date_trunc('${bucket}',f.created_at),'${bucketFormat}') AS label,
                COUNT(*)::int AS orders,
                COALESCE(SUM(f.package_count),0)::int AS packages,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales,
                COALESCE(SUM(f.point_revenue_total),0) AS point_revenue,
                COALESCE(SUM(f.postal_revenue_total),0) AS postal_revenue,
                COALESCE(SUM(f.hub_transfer_total),0) AS hub_transfer_revenue
           FROM freight_orders f
          WHERE ${paidWhereSql}
          GROUP BY 1,2 ORDER BY 1`,
        params
      ),
      db.pool.query(
        `SELECT COALESCE(NULLIF(f.carrier,''),'Não informado') AS label,
                COUNT(*)::int AS orders,
                COALESCE(SUM(f.package_count),0)::int AS packages,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales
           FROM freight_orders f WHERE ${paidWhereSql}
          GROUP BY 1 ORDER BY gross_sales DESC LIMIT 12`,
        params
      ),
      db.pool.query(
        `SELECT COALESCE(NULLIF(f.service_name,''),'Não informado') AS label,
                COUNT(*)::int AS orders,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales
           FROM freight_orders f WHERE ${paidWhereSql}
          GROUP BY 1 ORDER BY gross_sales DESC LIMIT 12`,
        params
      ),
      db.pool.query(
        `SELECT COALESCE(NULLIF(f.payment_method,''),'Não informado') AS label,
                COUNT(*)::int AS orders,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales
           FROM freight_orders f WHERE ${paidWhereSql}
          GROUP BY 1 ORDER BY gross_sales DESC`,
        params
      ),
      db.pool.query(
        `SELECT
           COALESCE(NULLIF(MAX(f.sender->>'name'),''),'Cliente não identificado') AS name,
           COALESCE(NULLIF(MAX(f.sender->>'document'),''),'') AS document,
           COUNT(*)::int AS shipments,
           COALESCE(SUM(f.package_count),0)::int AS packages,
           COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales,
           MAX(f.created_at) AS last_shipment
         FROM freight_orders f
         WHERE ${paidWhereSql}
           AND COALESCE(NULLIF(f.sender->>'document',''),NULLIF(LOWER(f.sender->>'name'),'')) IS NOT NULL
         GROUP BY COALESCE(NULLIF(f.sender->>'document',''),NULLIF(LOWER(f.sender->>'name'),''))
         ORDER BY shipments DESC,gross_sales DESC LIMIT 15`,
        params
      ),
      db.pool.query(
        `SELECT COALESCE(NULLIF(f.recipient->>'city',''),'Não informado') AS city,
                COUNT(*)::int AS shipments,
                COALESCE(SUM(f.package_count),0)::int AS packages,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge),0) AS gross_sales
           FROM freight_orders f WHERE ${paidWhereSql}
          GROUP BY 1 ORDER BY shipments DESC,gross_sales DESC LIMIT 12`,
        params
      ),
      db.pool.query(
        `SELECT COALESCE(NULLIF(f.status,''),'Não informado') AS label,COUNT(*)::int AS orders
           FROM freight_orders f WHERE ${whereSql}
          GROUP BY 1 ORDER BY orders DESC LIMIT 15`,
        params
      ),
      globalRole ? db.pool.query(
        `SELECT COALESCE(s.name,'Sem ponto') AS name,s.id,
                COUNT(f.id) FILTER (WHERE f.payment_status='PAID')::int AS orders,
                COALESCE(SUM(f.package_count) FILTER (WHERE f.payment_status='PAID'),0)::int AS packages,
                COALESCE(SUM(f.customer_subtotal+f.payment_surcharge) FILTER (WHERE f.payment_status='PAID'),0) AS gross_sales,
                COALESCE(SUM(f.point_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS point_revenue,
                COALESCE(SUM(f.hub_transfer_total) FILTER (WHERE f.payment_status='PAID'),0) AS hub_transfer_revenue
           FROM freight_orders f LEFT JOIN stores s ON s.id=f.store_id
          WHERE ${whereSql}
          GROUP BY s.id,s.name ORDER BY gross_sales DESC LIMIT 30`,
        params
      ) : Promise.resolve({rows:[]}),
      db.pool.query(
        `SELECT DISTINCT f.carrier AS value FROM freight_orders f
          WHERE ${whereSql} AND NULLIF(f.carrier,'') IS NOT NULL ORDER BY 1`,
        params
      ),
      db.pool.query(
        `SELECT DISTINCT f.service_name AS value FROM freight_orders f
          WHERE ${whereSql} AND NULLIF(f.service_name,'') IS NOT NULL ORDER BY 1`,
        params
      )
    ]);

    const s=summaryResult.rows[0]||{};
    res.json({
      range:{from:range.start.toISOString(),to:range.end.toISOString(),period:range.period,bucket},
      scope:{global:globalRole,storeId:storeId||null},
      summary:{
        paidOrders:Number(s.paid_orders||0),
        packages:Number(s.packages||0),
        grossSales:Number(s.gross_sales||0),
        pointRevenue:Number(s.point_revenue||0),
        postalRevenue:Number(s.postal_revenue||0),
        hubTransferRevenue:Number(s.hub_transfer_revenue||0),
        providerCost:Number(s.provider_cost||0),
        avgTicket:Number(s.avg_ticket||0),
        uniqueCustomers:Number(s.unique_customers||0)
      },
      timeline:timelineResult.rows.map(r=>({
        label:r.label,orders:Number(r.orders||0),packages:Number(r.packages||0),
        grossSales:Number(r.gross_sales||0),pointRevenue:Number(r.point_revenue||0),postalRevenue:Number(r.postal_revenue||0),hubTransferRevenue:Number(r.hub_transfer_revenue||0)
      })),
      carriers:carrierResult.rows.map(r=>({label:r.label,orders:Number(r.orders||0),packages:Number(r.packages||0),grossSales:Number(r.gross_sales||0)})),
      services:serviceResult.rows.map(r=>({label:r.label,orders:Number(r.orders||0),grossSales:Number(r.gross_sales||0)})),
      paymentMethods:paymentResult.rows.map(r=>({label:r.label,orders:Number(r.orders||0),grossSales:Number(r.gross_sales||0)})),
      topCustomers:clientsResult.rows.map(r=>({name:r.name,document:r.document,shipments:Number(r.shipments||0),packages:Number(r.packages||0),grossSales:Number(r.gross_sales||0),lastShipment:r.last_shipment})),
      topDestinations:destinationsResult.rows.map(r=>({city:r.city,shipments:Number(r.shipments||0),packages:Number(r.packages||0),grossSales:Number(r.gross_sales||0)})),
      statuses:statusResult.rows.map(r=>({label:r.label,orders:Number(r.orders||0)})),
      stores:storesResult.rows.map(r=>({id:r.id,name:r.name,orders:Number(r.orders||0),packages:Number(r.packages||0),grossSales:Number(r.gross_sales||0),pointRevenue:Number(r.point_revenue||0),hubTransferRevenue:Number(r.hub_transfer_revenue||0)})),
      filters:{
        carriers:filterCarrierResult.rows.map(r=>r.value),
        services:filterServiceResult.rows.map(r=>r.value),
        paymentMethods:["PIX","CARTAO","DINHEIRO"]
      }
    });
  }catch(error){
    console.error("analytics overview error:",error.message);
    res.status(error.status||500).json({error:error.status?error.message:"Não foi possível carregar os indicadores gerenciais."});
  }
});

app.get("/api/store/cash", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER"), async (req,res)=>{
  try{
    const range=analyticsDateRange(req.query||{});
    const storeId=reportStoreForUser(req.user,req.query.storeId);

    const orderParams=[range.start.toISOString(),range.end.toISOString()];
    const orderWhere=["f.created_at >= $1::timestamptz","f.created_at <= $2::timestamptz","f.is_simulation=FALSE"];
    if(storeId){ orderParams.push(storeId); orderWhere.push("f.store_id=$"+orderParams.length); }
    const carrier=String(req.query.carrier||"").trim();
    if(carrier){ orderParams.push(carrier); orderWhere.push("LOWER(f.carrier)=LOWER($"+orderParams.length+")"); }
    const paymentMethod=String(req.query.paymentMethod||"").trim().toUpperCase();
    if(paymentMethod){ orderParams.push(paymentMethod); orderWhere.push("UPPER(f.payment_method)=$"+orderParams.length); }

    const earningParams=[range.start.toISOString(),range.end.toISOString()];
    const earningWhere=["pe.created_at >= $1::timestamptz","pe.created_at <= $2::timestamptz","pe.status IN ('EARNED','PAID')"];
    if(storeId){ earningParams.push(storeId); earningWhere.push("pe.store_id=$"+earningParams.length); }

    const [ordersResult,earningsResult,salesMovementsResult,earningMovementsResult]=await Promise.all([
      db.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE f.payment_status='PAID')::int AS paid_orders,
           COALESCE(SUM(f.payment_amount) FILTER (WHERE f.payment_status='PAID'),0) AS customer_received,
           COALESCE(SUM(f.point_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS sales_earnings,
           COALESCE(SUM(f.postal_revenue_total) FILTER (WHERE f.payment_status='PAID'),0) AS postal_earnings,
           COALESCE(SUM(f.cash_remittance_amount) FILTER (
             WHERE f.status IN ('CASH_REMITTANCE_PENDING','CASH_REMITTANCE_PAYMENT_PENDING')
           ),0) AS pending_remittance
         FROM freight_orders f
         WHERE ${orderWhere.join(" AND ")}`,
        orderParams
      ),
      db.pool.query(
        `SELECT
           COALESCE(SUM(pe.amount),0) AS extra_earnings,
           COALESCE(SUM(pe.amount) FILTER (WHERE pe.earning_type='PICKUP'),0) AS pickup_earnings,
           COALESCE(SUM(pe.amount) FILTER (WHERE pe.earning_type='DROPOFF'),0) AS dropoff_earnings,
           COALESCE(SUM(pe.amount) FILTER (WHERE pe.earning_type='DELIVERY'),0) AS delivery_earnings,
           COALESCE(SUM(pe.amount) FILTER (WHERE pe.earning_type='REFERRAL'),0) AS referral_earnings,
           COALESCE(SUM(pe.amount) FILTER (WHERE pe.paid_at IS NULL),0) AS unpaid_extra_earnings
         FROM point_earnings pe
         WHERE ${earningWhere.join(" AND ")}`,
        earningParams
      ),
      db.pool.query(
        `SELECT f.id::text AS id,f.created_at,'SALE'::text AS type,
                COALESCE(s.name,'Postal Serviços') AS store_name,
                ('Frete '||COALESCE(f.tracking_code,LEFT(f.id::text,8))) AS description,
                CASE WHEN f.payment_status='PAID' THEN f.point_revenue_total ELSE 0 END AS amount,
                f.payment_status AS status
           FROM freight_orders f
           LEFT JOIN stores s ON s.id=f.store_id
          WHERE ${orderWhere.join(" AND ")}
          ORDER BY f.created_at DESC LIMIT 100`,
        orderParams
      ),
      db.pool.query(
        `SELECT pe.id::text AS id,pe.created_at,'EARNING'::text AS type,
                COALESCE(s.name,'Postal Serviços') AS store_name,
                CASE pe.earning_type
                  WHEN 'PICKUP' THEN 'Remuneração de coleta'
                  WHEN 'DROPOFF' THEN 'Remuneração de postagem/recebimento'
                  WHEN 'DELIVERY' THEN 'Entrega final Postal Regional'
                  WHEN 'REFERRAL' THEN 'Comissão por cliente indicado'
                  ELSE 'Ganho do ponto'
                END AS description,
                pe.amount,pe.status
           FROM point_earnings pe
           LEFT JOIN stores s ON s.id=pe.store_id
          WHERE ${earningWhere.join(" AND ")}
          ORDER BY pe.created_at DESC LIMIT 100`,
        earningParams
      )
    ]);

    const sales=ordersResult.rows[0]||{};
    const extras=earningsResult.rows[0]||{};
    const storeSalesEarnings=Number(sales.sales_earnings||0);
    const postalEarnings=Number(sales.postal_earnings||0);
    const extraEarnings=Number(extras.extra_earnings||0);
    const primarySalesEarnings=storeSalesEarnings;
    const movements=[...salesMovementsResult.rows,...earningMovementsResult.rows]
      .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,100);

    res.json({
      range:{from:range.start.toISOString(),to:range.end.toISOString(),period:range.period},
      scope:storeId?"STORE":"NETWORK",
      storeId:storeId||null,
      summary:{
        paidOrders:Number(sales.paid_orders||0),
        customerReceived:Number(sales.customer_received||0),
        salesEarnings:primarySalesEarnings,
        storeSalesEarnings,
        postalEarnings,
        extraEarnings,
        totalEarnings:round2(primarySalesEarnings+extraEarnings),
        pickupEarnings:Number(extras.pickup_earnings||0),
        dropoffEarnings:Number(extras.dropoff_earnings||0),
        deliveryEarnings:Number(extras.delivery_earnings||0),
        referralEarnings:Number(extras.referral_earnings||0),
        unpaidExtraEarnings:Number(extras.unpaid_extra_earnings||0),
        pendingRemittance:Number(sales.pending_remittance||0)
      },
      movements:movements.map(row=>({
        id:row.id,type:row.type,storeName:row.store_name,
        description:row.description,amount:Number(row.amount||0),
        status:row.status,createdAt:row.created_at
      }))
    });
  }catch(error){
    console.error("store cash error:",error.message);
    res.status(error.status||500).json({error:error.status?error.message:"Não foi possível carregar o Meu Caixa."});
  }
});

app.get("/api/store/financial-settings", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const store=await db.getStore(req.user.storeId);
    if(!store) return res.status(404).json({error:"Ponto não encontrado."});
    res.json({
      store:{
        id:store.id,
        name:store.name||"",
        legalName:store.legal_name||"",
        cnpj:store.cnpj||"",
        email:store.email||"",
        phone:store.phone||""
      },
      asaas:{
        walletId:store.asaas_wallet_id||"",
        configured:Boolean(String(store.asaas_wallet_id||"").trim())
      }
    });
  }catch(error){
    console.error("store financial settings error:",error.message);
    res.status(500).json({error:"Não foi possível carregar os dados financeiros do ponto."});
  }
});

app.patch("/api/store/financial-settings", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const walletId=String(req.body.asaasWalletId||"").trim();
    if(walletId && !/^[A-Za-z0-9_-]{8,120}$/.test(walletId)){
      return res.status(400).json({error:"Wallet ID do Asaas inválido. Copie o identificador exatamente como aparece na sua conta Asaas."});
    }
    const store=await db.updateStore(req.user.storeId,{asaasWalletId:walletId||null});
    if(!store) return res.status(404).json({error:"Ponto não encontrado."});
    await audit(req,"UPDATE_STORE_ASAAS_WALLET","STORE",req.user.storeId,{
      configured:Boolean(walletId),
      walletSuffix:walletId ? walletId.slice(-6) : ""
    });
    res.json({
      ok:true,
      configured:Boolean(walletId),
      walletId:store.asaas_wallet_id||"",
      message:walletId
        ?"Carteira Asaas vinculada. Os próximos pagamentos elegíveis poderão usar o split automático do ponto."
        :"Carteira Asaas removida. Pagamentos com comissão ficarão bloqueados até nova vinculação."
    });
  }catch(error){
    console.error("store financial settings update error:",error.message);
    res.status(500).json({error:"Não foi possível salvar a carteira Asaas do ponto."});
  }
});

app.get("/api/store/users", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const users=await db.listStoreUsers(req.user.storeId);
    res.json({users:users.map(user=>({
      id:user.id,
      email:user.email,
      name:user.name,
      role:user.role,
      active:Boolean(user.active),
      lastLoginAt:user.last_login_at,
      createdAt:user.created_at
    }))});
  }catch(error){
    console.error("store users list error:",error.message);
    res.status(500).json({error:"Não foi possível carregar os usuários do ponto."});
  }
});

app.post("/api/store/users", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const email=String(req.body.email||"").trim().toLowerCase();
    const name=String(req.body.name||"").trim();
    const password=String(req.body.password||"");
    if(!email||!name||password.length<10){
      return res.status(400).json({error:"Nome, e-mail e senha com ao menos 10 caracteres são obrigatórios."});
    }
    if(await db.findUserByEmail(email)){
      return res.status(409).json({error:"Já existe uma conta com este e-mail."});
    }
    const user=await db.createUser({
      storeId:req.user.storeId,
      email,
      name,
      passwordHash:hashPassword(password),
      role:"STORE_CLERK",
      active:true
    });
    await audit(req,"CREATE_STORE_CLERK","USER",user.id,{email,storeId:req.user.storeId});
    res.status(201).json({
      user:{id:user.id,email:user.email,name:user.name,role:user.role,active:Boolean(user.active)}
    });
  }catch(error){
    console.error("store user create error:",error.message);
    if(String(error.message).includes("duplicate key")){
      return res.status(409).json({error:"Já existe uma conta com este e-mail."});
    }
    res.status(500).json({error:"Não foi possível criar o usuário do ponto."});
  }
});

app.patch("/api/store/users/:id", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const current=await db.getUserById(req.params.id);
    if(!current || String(current.store_id)!==String(req.user.storeId) || current.role!=="STORE_CLERK"){
      return res.status(404).json({error:"Usuário do ponto não encontrado."});
    }
    const password=req.body.password?String(req.body.password):"";
    if(password && password.length<10){
      return res.status(400).json({error:"A nova senha precisa ter ao menos 10 caracteres."});
    }
    const user=await db.updateUser(current.id,{
      storeId:req.user.storeId,
      name:req.body.name===undefined?undefined:String(req.body.name||"").trim(),
      passwordHash:password?hashPassword(password):undefined,
      role:"STORE_CLERK",
      active:req.body.active===undefined?undefined:Boolean(req.body.active)
    });
    await audit(req,"UPDATE_STORE_CLERK","USER",user.id,{
      active:Boolean(user.active),
      storeId:req.user.storeId
    });
    res.json({user:{
      id:user.id,email:user.email,name:user.name,role:user.role,active:Boolean(user.active)
    }});
  }catch(error){
    console.error("store user update error:",error.message);
    res.status(500).json({error:"Não foi possível atualizar o usuário do ponto."});
  }
});

app.get("/api/store/referral", requireAuth, requireRole("STORE_OWNER"), async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const store=await db.getStore(req.user.storeId);
    const stats=await clientDb.referralStats(req.user.storeId);
    const clients=await clientDb.listClientsByStore(req.user.storeId,100);
    const base=String(process.env.APP_PUBLIC_URL||"").replace(/\/$/,"");
    res.json({
      code:store.referral_code||store.code,
      link:base+"/cliente?ref="+encodeURIComponent(store.referral_code||store.code),
      earningPerShipment:REFERRAL_EARNING_PER_SHIPMENT,
      stats:{
        referredClients:Number(stats.referred_clients||0),referredShipments:Number(stats.referred_shipments||0),
        referralEarnings:Number(stats.referral_earnings||0),pickupEarnings:Number(stats.pickup_earnings||0),
        dropoffEarnings:Number(stats.dropoff_earnings||0),deliveryEarnings:Number(stats.delivery_earnings||0)
      },
      clients
    });
  }catch(error){res.status(500).json({error:"Não foi possível carregar suas indicações."});}
});

app.get("/api/store/clients", requireAuth, requireRole("STORE_OWNER","STORE_CLERK"), requireCurrentUser, async(req,res)=>{
  if(!req.user.storeId)return res.status(400).json({error:"Usuário sem ponto vinculado."});
  try {res.json({clients:await clientDb.listClientsByStore(req.user.storeId,250)});}
  catch(error){res.status(500).json({error:"Não foi possível carregar os clientes do ponto."});}
});

app.post("/api/store/clients", requireAuth, requireRole("STORE_OWNER","STORE_CLERK"), requireCurrentUser, async (req,res)=>{
  try{
    pointRules.assert(req.user.storeId,"Usuário sem ponto vinculado.");
    const email=String(req.body.email||"").trim().toLowerCase();
    const name=String(req.body.name||"").trim();
    const document=cleanDigits(req.body.document||"");
    const phone=cleanDigits(req.body.phone||"");
    pointRules.assert(name.length>=2&&name.length<=160&&email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),"Informe nome e e-mail válidos.");
    pointRules.assert(!document||[11,14].includes(document.length),"CPF/CNPJ deve conter 11 ou 14 dígitos.");
    pointRules.assert(!phone||[10,11].includes(phone.length),"Informe telefone com DDD.");
    const generated=!req.body.password;
    const password=generated?crypto.randomBytes(12).toString("base64url"):String(req.body.password);
    pointRules.assert(password.length>=8&&password.length<=128,"A senha deve ter de 8 a 128 caracteres.");
    const raw=req.body.defaultSender||{};
    const defaultSender={name,document,phone,email};
    for(const field of ["address","number","complement","neighborhood","cep","city"]){
      defaultSender[field]=String(raw[field]||"").trim().slice(0,200);
    }
    defaultSender.cep=cleanDigits(defaultSender.cep);
    pointRules.assert(!defaultSender.cep||defaultSender.cep.length===8,"CEP inválido.");
    const user=await clientDb.registerPointClient({storeId:req.user.storeId,email,name,passwordHash:hashPassword(password),document,phone,defaultSender});
    await audit(req,"REGISTER_REFERRED_CLIENT","CLIENT",user.id,{email});
    res.status(201).json({ok:true,client:user,temporaryPassword:generated?password:undefined,
      message:"Cliente cadastrado e vinculado ao ponto. O cadastro não movimenta saldo nem gera comissão; a indicação segue as regras dos envios emitidos."});
  }catch(error){
    if(error.code==="23505")return res.status(409).json({error:"Já existe uma conta com este e-mail. O vínculo existente foi preservado."});
    res.status(error.status||500).json({error:error.status?error.message:"Não foi possível cadastrar o cliente."});
  }
});

function collectionForRole(collection,role){
  if(!["STORE_CLERK","OPS"].includes(role))return collection;
  const safe={...collection};
  for(const key of ["point_rate","point_compensation","postal_compensation"])delete safe[key];
  return safe;
}

app.post("/api/store/collections", requireAuth, requireRole("STORE_OWNER","STORE_CLERK"), requireCurrentUser, async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const body=req.body||{};
    const requesterName=String(body.requesterName||"").trim();
    const requesterPhone=cleanDigits(body.requesterPhone||"");
    const requesterDocument=cleanDigits(body.requesterDocument||"");
    pointRules.assert(requesterName.length>=2&&requesterName.length<=160,"Informe nome de 2 a 160 caracteres.");
    pointRules.assert(!requesterDocument||[11,14].includes(requesterDocument.length),"CPF/CNPJ deve conter 11 ou 14 dígitos.");
    if(body.clientUserId)pointRules.assert(/^[0-9a-f-]{36}$/i.test(String(body.clientUserId)),"Cliente inválido.");
    const packageCount=Number(body.packageCount??1);
    const pricing=pointRules.collectionPricing(packageCount,CLIENT_PICKUP_FEE_PER_PACKAGE,POINT_PICKUP_EARNING_PER_PACKAGE);
    pointRules.assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.requestKey||"")),"Identificador da solicitação inválido. Atualize a página.");
    const store=await db.getStore(req.user.storeId);
    pointRules.assert(store?.active,"Ponto inativo ou inexistente.",403);
    if(body.scheduledFor)pointRules.assert(Number.isFinite(Date.parse(body.scheduledFor))&&Date.parse(body.scheduledFor)>Date.now(),"Escolha uma data futura para a coleta.");
    const address=body.address&&typeof body.address==="object"?body.address:{};
    const cep=cleanDigits(address.cep||"");
    const street=String(address.address||"").trim();
    const number=String(address.number||"").trim();
    const city=String(address.city||"").trim();

    if(!requesterName) return res.status(400).json({error:"Informe o nome do cliente."});
    if(![10,11].includes(requesterPhone.length)) return res.status(400).json({error:"Informe telefone com DDD."});
    if(!street||!number||cep.length!==8||!city){
      return res.status(400).json({error:"Informe endereço, número, CEP e cidade para a coleta."});
    }

    const feePerPackage=CLIENT_PICKUP_FEE_PER_PACKAGE;
    const pointRate=POINT_PICKUP_EARNING_PER_PACKAGE;
    const {totalFee,pointCompensation,postalCompensation}=pricing;

    if(body.clientUserId){
      const account=await clientDb.getCustomerAccount(body.clientUserId);
      pointRules.assert(account?.referral_store_id===req.user.storeId,"Cliente não pertence a este ponto.",403);
    }
    const collection=await clientDb.createCollectionRequest({
      clientUserId:body.clientUserId||null,
      freightOrderId:null,
      serviceType:"PICKUP",
      status:"ASSIGNED",
      packageCount,
      feePerPackage,
      totalFee,
      assignedStoreId:req.user.storeId,
      pointRate,
      pointCompensation,
      postalCompensation,
      address:{
        address:street,
        number,
        complement:String(address.complement||"").trim(),
        neighborhood:String(address.neighborhood||"").trim(),
        cep,
        city,
        uf:String(address.uf||"").trim().toUpperCase()
      },
      scheduledFor:body.scheduledFor||null,
      notes:String(body.notes||"").trim().slice(0,1000),
      requesterName,
      requesterPhone,
      requesterDocument,
      createdByUserId:req.user.userId,
      requestKey:body.requestKey
    });

    pointRules.assert(collection.assigned_store_id===req.user.storeId,"Esta solicitação já foi direcionada a outro ponto.",409);
    await audit(req,"CREATE_STORE_COLLECTION","COLLECTION",collection.id,{
      storeId:req.user.storeId,
      requesterName,
      packageCount,
      totalFee
    });

    res.status(201).json({
      collection:collectionForRole(collection,req.user.role),
      pricing:{packageCount:collection.package_count,feePerPackage:Number(collection.fee_per_package),totalFee:Number(collection.total_fee)},
      message:"Coleta registrada. Valor previsto, sem débito ou remuneração automática; pagamento ainda não vinculado."
    });
  }catch(error){
    console.error("store collection create error:",error.message);
    res.status(error.status||500).json({error:error.status?error.message:"Não foi possível criar a ordem de coleta."});
  }
});

app.get("/api/store/collections", requireAuth, requireRole("STORE_OWNER","STORE_CLERK","OPS"), requireCurrentUser, async (req,res)=>{
  try{
    if(!req.user.storeId) return res.status(400).json({error:"Usuário sem ponto vinculado."});
    const collections=await clientDb.listCollections({storeId:req.user.storeId},100);
    const earnings=["STORE_CLERK","OPS"].includes(req.user.role)?[]:await clientDb.listPointEarnings(req.user.storeId,100);
    res.json({
      collections:collections.map(item=>collectionForRole(item,req.user.role)),
      earnings
    });
  }catch(error){res.status(500).json({error:"Não foi possível carregar as coletas."});}
});

app.patch("/api/collections/:id", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), requireCurrentUser, async(req,res)=>{
  try {
    if(req.body.scheduledFor)pointRules.assert(Number.isFinite(Date.parse(req.body.scheduledFor))&&Date.parse(req.body.scheduledFor)>Date.now(),"Escolha uma data futura para a coleta.");
    const updated=await clientDb.transitionCollection({collectionId:req.params.id,user:req.user,status:req.body.status,
      assignedStoreId:req.body.assignedStoreId,scheduledFor:req.body.scheduledFor,notes:req.body.notes===undefined?undefined:String(req.body.notes).slice(0,1000),
      pickupRate:POINT_PICKUP_EARNING_PER_PACKAGE,dropoffRate:POINT_DROPOFF_EARNING_PER_PACKAGE});
    await audit(req,"UPDATE_COLLECTION","COLLECTION",updated.id,{status:updated.status,assignedStoreId:updated.assigned_store_id});
    res.json({collection:collectionForRole(updated,req.user.role)});
  }catch(error){res.status(error.status||500).json({error:error.status?error.message:"Não foi possível atualizar a coleta."});}
});

app.get("/api/admin/collections", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  try{res.json({collections:await clientDb.listCollections({all:true},250)});}
  catch(error){res.status(500).json({error:"Não foi possível carregar o painel de coletas."});}
});

app.get("/api/integrations/nuvemshop/callback", async (req,res)=>{
  try{
    const connectionId=verifyEcommerceState(req.query.state);
    const code=String(req.query.code||"").trim();
    if(!connectionId||!code) return res.status(400).send("Autorização Nuvemshop inválida ou expirada.");
    if(!NUVEMSHOP_APP_ID||!NUVEMSHOP_CLIENT_SECRET) return res.status(503).send("Aplicativo Nuvemshop não configurado.");
    const connection=await clientDb.getConnectionById(connectionId);
    if(!connection||String(connection.platform).toUpperCase()!=="NUVEMSHOP"){
      return res.status(404).send("Conexão Nuvemshop não encontrada.");
    }
    const token=await ecommerce.exchangeNuvemshopCode({
      appId:NUVEMSHOP_APP_ID,clientSecret:NUVEMSHOP_CLIENT_SECRET,code
    });
    const config=connection.config||{};
    const credentialBlob=ecommerce.encryptCredentials({accessToken:token.accessToken,storeId:token.storeId},SESSION_SECRET);
    const updated=await clientDb.updateConnection(connection.id,connection.user_id,{
      externalStoreId:token.storeId,status:"CONNECTED",authorizationUrl:"",
      config:{...config,credentialBlob,scope:token.scope,connectedAt:new Date().toISOString(),lastError:""}
    });
    setImmediate(()=>syncNuvemshopConnection(updated).catch(async error=>{
      await clientDb.updateConnection(updated.id,updated.user_id,{
        status:"ERROR",config:{...(updated.config||{}),lastError:String(error.message||"Falha inicial de sincronização").slice(0,500)}
      }).catch(()=>{});
    }));
    res.redirect("/cliente?integration=nuvemshop");
  }catch(error){
    console.error("nuvemshop oauth callback error:",error.message);
    res.status(502).send("Não foi possível concluir a autorização da Nuvemshop.");
  }
});

app.get("/api/integrations/shopify/callback", async (req,res)=>{
  let claimed=null;
  try{
    if(!SHOPIFY_READY) return res.status(503).send("Aplicativo Shopify não configurado.");
    if(!ecommerce.verifyShopifyCallbackHmac(req.query,SHOPIFY_CLIENT_SECRET)){
      return res.status(401).send("Assinatura de autorização Shopify inválida.");
    }
    const state=String(req.query.state||"");
    const code=String(req.query.code||"");
    const shop=ecommerce.normalizeShopifyShop(req.query.shop);
    const parts=state.split(".");
    const id=parts.length===3?verifyEcommerceState(parts.slice(0,2).join(".")):null;
    if(!id||!code) return res.status(400).send("Autorização Shopify inválida.");
    const connection=await clientDb.getConnectionById(id);
    if(!connection||String(connection.platform).toUpperCase()!=="SHOPIFY"){
      return res.status(404).send("Conexão Shopify não encontrada.");
    }
    const config=connection.config||{};
    if(config.shop!==shop || verifyShopifyState(state,config)!==id ||
        connection.status!=="AWAITING_PROVIDER_AUTH"){
      return res.status(400).send("Autorização Shopify expirada, já utilizada ou de outra loja.");
    }
    // Consome o nonce com alteração atômica para impedir reuso simultâneo do callback.
    claimed=await clientDb.claimConnectionAuthorization(connection.id,connection.user_id);
    if(!claimed) return res.status(409).send("Esta autorização Shopify já está sendo processada.");
    const credentials=await ecommerce.exchangeShopifyCode({shop,clientId:SHOPIFY_CLIENT_ID,
      clientSecret:SHOPIFY_CLIENT_SECRET,code});
    if(!credentials.scope.split(",").map(s=>s.trim()).includes("read_orders")){
      throw new Error("O lojista não concedeu acesso de leitura aos pedidos.");
    }
    const {oauthStateHash,oauthExpiresAt,...publicConfig}=config;
    const updated=await clientDb.updateConnection(connection.id,connection.user_id,{
      status:"CONNECTED",authorizationUrl:"",externalStoreId:shop,
      config:{...publicConfig,credentialBlob:ecommerce.encryptCredentials(credentials,SESSION_SECRET),
        scope:credentials.scope,connectedAt:new Date().toISOString(),lastError:""}
    });
    res.redirect("/cliente?integration=shopify");
    setImmediate(()=>syncShopifyConnection(updated).catch(async error=>{
      const fresh=await clientDb.getConnectionById(updated.id).catch(()=>null);
      if(fresh) await clientDb.updateConnection(fresh.id,fresh.user_id,{
        status:"ERROR",config:{...(fresh.config||{}),lastError:String(error.message||"Falha inicial na Shopify").slice(0,500)}
      }).catch(()=>{});
    }));
  }catch(error){
    console.error("shopify oauth callback error:",error.message);
    if(claimed) await clientDb.updateConnection(claimed.id,claimed.user_id,{
      status:"ERROR",authorizationUrl:"",
      config:{...(claimed.config||{}),oauthStateHash:null,lastError:String(error.message).slice(0,500)}
    }).catch(()=>{});
    if(!res.headersSent) res.status(502).send("Não foi possível concluir a autorização Shopify. Desconecte e conecte a loja novamente.");
  }
});

app.post("/api/integrations/woocommerce/callback", async (req,res)=>{
  try{
    const body=req.body||{};
    const connectionId=verifyEcommerceState(body.user_id);
    if(!connectionId) return res.status(401).json({error:"Estado de autorização inválido."});
    const connection=await clientDb.getConnectionById(connectionId);
    if(!connection || String(connection.platform).toUpperCase()!=="WOOCOMMERCE"){
      return res.status(404).json({error:"Conexão WooCommerce não encontrada."});
    }
    const consumerKey=String(body.consumer_key||"").trim();
    const consumerSecret=String(body.consumer_secret||"").trim();
    if(!/^ck_/i.test(consumerKey) || !/^cs_/i.test(consumerSecret)){
      return res.status(400).json({error:"Credenciais WooCommerce inválidas."});
    }
    const config=connection.config||{};
    const credentialBlob=ecommerce.encryptCredentials({consumerKey,consumerSecret},SESSION_SECRET);
    const updated=await clientDb.updateConnection(connection.id,connection.user_id,{
      status:"CONNECTED",
      externalStoreId:String(body.key_id||"")||connection.external_store_id,
      authorizationUrl:"",
      config:{...config,credentialBlob,keyPermissions:String(body.key_permissions||"read"),connectedAt:new Date().toISOString(),lastError:""}
    });
    res.status(200).json({ok:true});
    setImmediate(()=>syncWooCommerceConnection(updated).catch(async error=>{
      await clientDb.updateConnection(updated.id,updated.user_id,{
        status:"ERROR",
        config:{...(updated.config||{}),lastError:String(error.message||"Falha inicial de sincronização").slice(0,500)}
      }).catch(()=>{});
    }));
  }catch(error){
    console.error("woocommerce auth callback error:",error.message);
    res.status(500).json({error:"Não foi possível concluir a autorização WooCommerce."});
  }
});

app.get("/api/integrations/v1/ecommerce/connections", requireIntegrationAuth, async (req,res)=>{
  try{
    const status=String(req.query.status||"").trim();
    const rows=await clientDb.listBridgeConnections(status||null,Math.min(250,Number(req.query.limit||100)));
    res.json({ok:true,version:"v1",connections:rows.map(row=>({...row,config:safeConnectionConfig(row.config)}))});
  }catch(error){res.status(500).json({error:"Falha ao listar conexões de e-commerce."});}
});

app.patch("/api/integrations/v1/ecommerce/connections/:id", requireIntegrationAuth, async (req,res)=>{
  try{
    const connection=await clientDb.getConnectionById(req.params.id);
    if(!connection) return res.status(404).json({error:"Conexão não encontrada."});
    const updated=await clientDb.updateConnection(connection.id,connection.user_id,{
      externalStoreId:req.body.externalStoreId,status:req.body.status||"CONNECTED",
      authorizationUrl:req.body.authorizationUrl,config:req.body.config||undefined,markSynced:Boolean(req.body.markSynced)
    });
    res.json({ok:true,version:"v1",connection:updated});
  }catch(error){res.status(500).json({error:"Falha ao atualizar a conexão de e-commerce."});}
});

app.post("/api/integrations/v1/ecommerce/connections/:id/orders", requireIntegrationAuth, async (req,res)=>{
  try{
    const connection=await clientDb.getConnectionById(req.params.id);
    if(!connection) return res.status(404).json({error:"Conexão não encontrada."});
    const body=req.body||{};
    if(!body.externalOrderId) return res.status(400).json({error:"externalOrderId é obrigatório."});
    const imported=await clientDb.importEcommerceOrder({
      connectionId:connection.id,externalOrderId:body.externalOrderId,
      customerName:body.customerName||"",externalStatus:body.status||"",payload:body.payload||body
    });
    await clientDb.updateConnection(connection.id,connection.user_id,{status:"CONNECTED",markSynced:true});
    res.status(201).json({ok:true,version:"v1",order:imported});
  }catch(error){res.status(500).json({error:"Falha ao importar pedido da plataforma."});}
});

app.get("/api/admin/system-health", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  const health={
    database:{ok:false},
    conectenvios:{ok:false,configured:Boolean(TOKEN),mode:CONECTENVIOS_PAYMENT_MODE},
    asaas:{ok:false,...asaas.environmentInfo(),runtimeOperational:paymentOperational(),webhookReady:Boolean(paymentRuntime.webhookReady)},
    providerPayments:{awaitingFunds:0,awaitingProvider:0,errors:0,paid:0},
    shipmentCreationEnabled:ENABLE_SHIPMENT_CREATION,
    checkedAt:new Date().toISOString()
  };
  try{
    await db.pool.query("SELECT 1");
    health.database.ok=true;
  }catch(error){health.database.error=String(error.message||error);}
  try{
    if(TOKEN){
      const ce=await providerFetch("/postal_company",{method:"GET",timeout:15000});
      health.conectenvios.ok=Boolean(ce && ce.data);
    }
  }catch(error){
    health.conectenvios.error=providerFailureText(error);
    health.conectenvios.status=error.status||null;
  }
  try{
    if(asaas.configured()){
      await asaas.asaasFetch("/checkouts?limit=1",{method:"GET"});
      const pix=await asaas.ensurePixKey({waitForActiveMs:0});
      health.asaas.pixReady=Boolean(pix.ok && String(pix.status||"").toUpperCase()==="ACTIVE");
      health.asaas.preferredPixKeyMatched=Boolean(pix.preferredMatched);
      health.asaas.ok=Boolean(health.asaas.pixReady && paymentRuntime.webhookReady && asaas.environmentInfo().keyEnvironment==="production");
      health.asaas.runtimeOperational=paymentOperational();
    }
  }catch(error){
    health.asaas.error=asaas.providerErrorMessage(error.providerData,error.message);
    health.asaas.status=error.status||null;
  }
  try{
    const summary=await db.providerPaymentSummary();
    health.providerPayments={
      awaitingFunds:Number(summary.awaiting_funds||0),
      awaitingProvider:Number(summary.awaiting_provider||0),
      errors:Number(summary.provider_errors||0),
      paid:Number(summary.provider_paid||0)
    };
  }catch(error){
    health.providerPayments.error=String(error.message||error);
  }
  res.json(health);
});

app.get("/api/admin/go-live-readiness", requireAuth, requireRole("ADMIN"), async (_req,res)=>{
  const checks=[];
  const add=(key,label,ok,detail,blocking=true)=>checks.push({key,label,ok:Boolean(ok),detail:String(detail||""),blocking:Boolean(blocking)});
  try{
    await db.pool.query("SELECT 1");
    add("database","Banco PostgreSQL",true,"Conexão ativa.");
  }catch(error){
    add("database","Banco PostgreSQL",false,error.message);
  }

  try{
    const ce=TOKEN?await providerFetch("/postal_company",{method:"GET",timeout:15000}):null;
    add("conectenvios","Integração logística",Boolean(ce?.data),"API logística autenticada.");
  }catch(error){
    add("conectenvios","Integração logística",false,providerFailureText(error)||error.message);
  }

  const env=asaas.environmentInfo();
  add(
    "asaas",
    "Asaas produção",
    paymentOperational(),
    paymentOperational()
      ?"API, webhook e PIX validados em produção."
      : (paymentRuntime.lastError || ("Ambiente "+env.keyEnvironment+"; webhook="+paymentRuntime.webhookReady+"; pix="+paymentRuntime.pixReady))
  );
  add("shipment_creation","Emissão real",ENABLE_SHIPMENT_CREATION,ENABLE_SHIPMENT_CREATION?"Criação de postagem está habilitada.":"ENABLE_SHIPMENT_CREATION está desabilitado.");
  add("payment_simulator","Simulador desligado",!PAYMENT_SIMULATOR_ENABLED,PAYMENT_SIMULATOR_ENABLED?"Simulador ainda está ligado.":"Somente fluxos reais permitidos.");

  try{
    const wallets=await db.pool.query(
      `SELECT COUNT(*) FILTER (WHERE active=TRUE)::int AS active,
              COUNT(*) FILTER (WHERE active=TRUE AND COALESCE(asaas_wallet_id,'')='')::int AS missing
         FROM stores`
    );
    const row=wallets.rows[0]||{};
    add("store_wallets","Carteiras dos pontos",Number(row.missing||0)===0,
      Number(row.active||0)+" ponto(s) ativo(s); "+Number(row.missing||0)+" sem wallet Asaas.");
  }catch(error){
    add("store_wallets","Carteiras dos pontos",false,error.message);
  }

  add("admin_reset","Reset automático da senha MASTER",!ADMIN_PASSWORD_RESET_HASH,
    ADMIN_PASSWORD_RESET_HASH?"Variável de reset ainda está ativa.":"Reset automático desativado.");

  try{
    const payments=await db.providerPaymentSummary();
    const bad=Number(payments.awaiting_funds||0)+Number(payments.awaiting_provider||0)+Number(payments.provider_errors||0);
    add("provider_queue","Fila de postagens",bad===0,
      "aguardando saldo="+Number(payments.awaiting_funds||0)+", aguardando provedor="+Number(payments.awaiting_provider||0)+", erros="+Number(payments.provider_errors||0),
      false);
  }catch(error){
    add("provider_queue","Fila de postagens",false,error.message,false);
  }

  try{
    const eq=await db.pool.query(
      `SELECT platform,status,COUNT(*)::int AS total
         FROM ecommerce_connections
        GROUP BY platform,status
        ORDER BY platform,status`
    );
    const connected=eq.rows.reduce((s,x)=>s+(x.status==="CONNECTED"?Number(x.total||0):0),0);
    add("ecommerce","Integrações de e-commerce",connected>0,
      eq.rows.length?eq.rows.map(x=>x.platform+":"+x.status+"="+x.total).join(", "):"Nenhuma conexão cadastrada.",
      false);
    add("nuvemshop_app","Aplicativo Nuvemshop",Boolean(NUVEMSHOP_APP_ID&&NUVEMSHOP_CLIENT_SECRET),
      NUVEMSHOP_APP_ID&&NUVEMSHOP_CLIENT_SECRET?"App ID e Client Secret configurados.":"Credenciais do aplicativo ainda não configuradas no Railway.",
      false);
    add("shopify_app","Aplicativo Shopify",SHOPIFY_READY,
      SHOPIFY_READY?"Aplicativo configurado para autorizar lojas via OAuth seguro.":"Aguardando Shopify Client ID, Client Secret e APP_PUBLIC_URL HTTPS.",
      false);
  }catch(error){
    add("ecommerce","Integrações de e-commerce",false,error.message,false);
  }

  const blockingFailures=checks.filter(x=>x.blocking&&!x.ok);
  res.json({
    ready:blockingFailures.length===0,
    version:"1.9.0",
    blockingFailures:blockingFailures.map(x=>x.key),
    checks,
    checkedAt:new Date().toISOString()
  });
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

// White Label: exclusivamente cadastro comercial MASTER. Nenhuma rota operacional é
// liberada nesta fase; empresas não recebem login, frete, cotação ou split ativo.
app.get("/api/admin/white-label-carriers",requireAuth,requireRole("ADMIN"),async(req,res)=>{
  try{
    res.setHeader("Cache-Control","private,no-store");
    const rows=await db.listWhiteLabelCarriers();
    res.json({carriers:rows.map(whiteLabel.whiteLabelCarrierDTO),operationalEnabled:false});
  }catch(error){
    console.error("white label list error:",error.code||error.name);
    res.status(503).json({error:"Não foi possível carregar as transportadoras White Label."});
  }
});
app.post("/api/admin/white-label-carriers",requireAuth,requireRole("ADMIN"),async(req,res)=>{
  try{
    const carrier=whiteLabel.normalizeWhiteLabelCarrier(req.body);
    const saved=await db.createWhiteLabelCarrier(carrier,req.user.userId);
    await audit(req,"CREATE_WHITE_LABEL_CARRIER","WHITE_LABEL_CARRIER",saved.id,{code:saved.code});
    res.status(201).json({ok:true,carrier:whiteLabel.whiteLabelCarrierDTO(saved),
      message:"Transportadora cadastrada para homologação. Operação e pagamentos não estão habilitados."});
  }catch(error){
    if(error.code==="23505")return res.status(409).json({error:"Já existe uma transportadora com esse CNPJ ou código."});
    if(error.status===400)return res.status(400).json({error:error.message});
    console.error("white label create error:",error.code||error.name);
    res.status(503).json({error:"Não foi possível cadastrar a transportadora."});
  }
});
app.patch("/api/admin/white-label-carriers/:id",requireAuth,requireRole("ADMIN"),async(req,res)=>{
  try{
    if(!/^[\da-f]{8}-[\da-f-]{27,36}$/i.test(String(req.params.id||"")))return res.status(400).json({error:"Identificador inválido."});
    const existing=await db.getWhiteLabelCarrier(req.params.id);
    if(!existing)return res.status(404).json({error:"Transportadora não encontrada."});
    if(existing.status!=="DRAFT")return res.status(409).json({error:"Cadastro fora da fase de edição."});
    const patch=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};
    const carrier=whiteLabel.normalizeWhiteLabelCarrier({...whiteLabel.whiteLabelCarrierDTO(existing),...patch});
    const updated=await db.updateWhiteLabelCarrier(req.params.id,carrier);
    if(!updated)return res.status(409).json({error:"O cadastro mudou de situação. Atualize a página."});
    await audit(req,"UPDATE_WHITE_LABEL_CARRIER","WHITE_LABEL_CARRIER",updated.id,{code:updated.code});
    res.json({ok:true,carrier:whiteLabel.whiteLabelCarrierDTO(updated),
      message:"Cadastro White Label atualizado. A operação permanece em homologação."});
  }catch(error){
    if(error.code==="23505")return res.status(409).json({error:"CNPJ ou código já cadastrado."});
    if(error.status===400)return res.status(400).json({error:error.message});
    console.error("white label update error:",error.code||error.name);
    res.status(503).json({error:"Não foi possível atualizar o cadastro White Label."});
  }
});

// Portal independente com cookies, contas e isolamento próprios de White Label.
whiteLabelPortal.register({
  app,db,requireAuth,requireRole,signSession,verifySession,parseCookies,
  hashPassword,verifyPassword,checkLoginRate,recordLoginFailure,clearLoginFailures,audit,
  quoteIntegrated:async (args,carrier)=>{
    // Reutiliza a mesma conta de integração e cache do Balcão, mas recalcula
    // a venda pela política comercial específica deste parceiro (não em cache).
    if(!TOKEN || wlIntegratedQuoteInFlight>=10){
      return {status:"UNAVAILABLE",options:[]};
    }
    wlIntegratedQuoteInFlight++;
    try{
      const quoted=await fetchProviderQuoteCached(args.origin,args.destination,{
        weightGrams:args.weight,length:args.length,width:args.width,height:args.height
      });
      if(quoted.data?.error===true)return {status:"NONE",options:[]};
      const partnerCommissionRate=quotePricing.pointCommissionRate(
        {commission_percent:Number(carrier.integrated_commission_percent||0)},0);
      const priced=normalizeQuote(quoted.data,partnerCommissionRate);
      const options=whiteLabelHybrid.sanitizeIntegratedOptions(priced);
      return {status:options.length?"AVAILABLE":"NONE",options};
    }catch(error){
      if(error.status===422)return {status:"NONE",options:[]};
      console.warn("WL_PROVIDER_QUOTE_FAIL",error.status||error.name||"network");
      return {status:"UNAVAILABLE",options:[]};
    }finally{
      wlIntegratedQuoteInFlight--;
    }
  }
});

app.get("/api/admin/stores", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    const stores = await db.listStores();
    res.json({ stores: stores.map(store => ({
      id: store.id, code: store.code, name: store.name, legalName: store.legal_name || "",
      cnpj: store.cnpj || "", phone: store.phone || "", email: store.email || "",
      asaasWalletId: store.asaas_wallet_id || "",
      quoteOriginCep: store.quote_origin_cep || "",
      operationalHub: store.operational_hub || {},unitType:store.unit_type||'POINT',
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
    const unitType=String(body.unitType||'POINT').toUpperCase();
    if(!['POINT','HUB','MIXED'].includes(unitType))return res.status(400).json({error:'Tipo de unidade inválido.'});
    const commissionPercent = Number(body.commissionPercent ?? 20);
    const quoteOriginCep = cleanDigits(body.quoteOriginCep || "");
    const operationalHub = body.operationalHub && typeof body.operationalHub==="object" ? {...body.operationalHub} : {};
    operationalHub.cep = cleanDigits(operationalHub.cep || quoteOriginCep || "");
    if (!code || !name) return res.status(400).json({ error: "Código e nome do ponto são obrigatórios." });
    if (quoteOriginCep && quoteOriginCep.length !== 8) return res.status(400).json({ error: "O CEP operacional deve ter 8 dígitos." });
    if(quoteOriginCep){
      if(operationalHub.cep!==quoteOriginCep) return res.status(400).json({error:"O CEP do hub deve ser igual ao CEP máscara."});
      if(!String(operationalHub.address||"").trim()||!String(operationalHub.number||"").trim()||!String(operationalHub.city||"").trim()||!String(operationalHub.state||"").trim()){
        return res.status(400).json({error:"Preencha endereço, número, cidade e UF do Hub / Origem Operacional."});
      }
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50) {
      return res.status(400).json({ error: "A comissão do ponto deve estar entre 0% e 50%." });
    }
    const store = await db.createStore({
      code,name,legalName:body.legalName,cnpj:cleanDigits(body.cnpj),phone:body.phone,email:body.email,
      asaasWalletId:body.asaasWalletId||null,quoteOriginCep:quoteOriginCep||null,operationalHub:quoteOriginCep?operationalHub:{},address:body.address||{},commissionPercent,active:body.active!==false,unitType
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
    const unitType=req.body.unitType===undefined?undefined:String(req.body.unitType).toUpperCase();
    if(unitType!==undefined&&!['POINT','HUB','MIXED'].includes(unitType))return res.status(400).json({error:'Tipo de unidade inválido.'});
    const currentStore=await db.getStore(req.params.id);
    if(!currentStore) return res.status(404).json({error:"Ponto não encontrado."});
    const quoteOriginCep = req.body.quoteOriginCep === undefined ? undefined : cleanDigits(req.body.quoteOriginCep || "");
    const effectiveQuoteCep = quoteOriginCep===undefined ? cleanDigits(currentStore.quote_origin_cep||"") : quoteOriginCep;
    const operationalHub = req.body.operationalHub===undefined
      ? (currentStore.operational_hub||{})
      : (req.body.operationalHub&&typeof req.body.operationalHub==="object"?{...req.body.operationalHub}:{});
    if(effectiveQuoteCep) operationalHub.cep=cleanDigits(operationalHub.cep||effectiveQuoteCep);
    if (quoteOriginCep !== undefined && quoteOriginCep && quoteOriginCep.length !== 8) {
      return res.status(400).json({ error: "O CEP operacional deve ter 8 dígitos." });
    }
    if(effectiveQuoteCep){
      if(cleanDigits(operationalHub.cep||"")!==effectiveQuoteCep) return res.status(400).json({error:"O CEP do hub deve ser igual ao CEP máscara."});
      if(!String(operationalHub.address||"").trim()||!String(operationalHub.number||"").trim()||!String(operationalHub.city||"").trim()||!String(operationalHub.state||"").trim()){
        return res.status(400).json({error:"Preencha endereço, número, cidade e UF do Hub / Origem Operacional."});
      }
    }
    if (commissionPercent != null && (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50)) {
      return res.status(400).json({ error: "Comissão inválida." });
    }
    const store = await db.updateStore(req.params.id,{...req.body,unitType,commissionPercent,quoteOriginCep,operationalHub:effectiveQuoteCep?operationalHub:{}});
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
    if(!["ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"].includes(role)) return res.status(400).json({error:"Perfil inválido."});
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

app.patch("/api/admin/users/:id", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const body=req.body||{};
    const role=body.role?String(body.role).toUpperCase():undefined;
    if(role && !["ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"].includes(role)) return res.status(400).json({error:"Perfil inválido."});
    const password=body.password?String(body.password):"";
    if(password && password.length<6) return res.status(400).json({error:"A nova senha precisa ter ao menos 6 caracteres."});
    const currentUser=await db.getUserById(req.params.id);
    if(!currentUser)return res.status(404).json({error:"Usuário não encontrado."});
    if((role||currentUser.role)!=="ADMIN" && !(body.storeId??currentUser.store_id))return res.status(400).json({error:"Selecione a unidade deste usuário."});
    const user=await db.updateUser(req.params.id,{
      storeId:role==="ADMIN"?null:body.storeId,
      name:body.name,
      passwordHash:password?hashPassword(password):undefined,
      role,
      active:body.active
    });
    if(!user) return res.status(404).json({error:"Usuário não encontrado."});
    await audit(req,"UPDATE_USER","USER",user.id,{role:user.role,active:user.active,storeId:user.store_id});
    res.json({user});
  } catch(error){ res.status(500).json({error:"Não foi possível atualizar o usuário."}); }
});

app.post("/api/admin/users/:id/reset-password", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try{
    if(String(req.params.id)===String(req.user.userId)){
      return res.status(400).json({error:"Use 'Alterar minha senha' para trocar a senha do próprio MASTER."});
    }
    const current=await db.getUserById(req.params.id);
    if(!current) return res.status(404).json({error:"Usuário não encontrado."});
    const supplied=String(req.body.password||"").trim();
    const temporaryPassword=supplied || ("Postal@"+crypto.randomBytes(5).toString("base64url"));
    if(temporaryPassword.length<10) return res.status(400).json({error:"A senha precisa ter ao menos 10 caracteres."});
    await db.updateUser(current.id,{passwordHash:hashPassword(temporaryPassword)});
    await audit(req,"RESET_USER_PASSWORD","USER",current.id,{email:current.email,role:current.role});
    res.json({ok:true,temporaryPassword,message:"Senha redefinida com sucesso."});
  }catch(error){
    console.error("admin reset user password error:",error.message);
    res.status(500).json({error:"Não foi possível redefinir a senha."});
  }
});

app.delete("/api/admin/users/:id", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try{
    if(String(req.params.id)===String(req.user.userId)){
      return res.status(400).json({error:"O MASTER não pode excluir o próprio acesso enquanto estiver conectado."});
    }
    const current=await db.getUserById(req.params.id);
    if(!current) return res.status(404).json({error:"Usuário não encontrado."});
    const deleted=await db.deleteUser(current.id);
    await audit(req,"DELETE_USER","USER",current.id,{email:current.email,role:current.role,storeId:current.store_id});
    res.json({ok:true,user:{id:deleted.id,email:deleted.email,name:deleted.name,role:deleted.role}});
  }catch(error){
    console.error("admin delete user error:",error.message);
    res.status(500).json({error:"Não foi possível excluir o usuário."});
  }
});

app.get("/api/admin/export", requireAuth, requireRole("ADMIN"), async (req,res)=>{
  try {
    const snapshot=await db.exportOperationalSnapshot();
    await audit(req,"EXPORT_OPERATIONAL_SNAPSHOT","SYSTEM","database",{generatedAt:snapshot.generatedAt});
    res.setHeader("Content-Disposition", `attachment; filename="postal-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(snapshot);
  } catch(error){ res.status(500).json({error:"Não foi possível gerar a exportação operacional."}); }
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
    const unitPrice=Number(body.unitPrice);
    const costPrice=Number(body.costPrice ?? 0);
    if(!Number.isFinite(unitPrice)||unitPrice<0||!Number.isFinite(costPrice)||costPrice<0) return res.status(400).json({error:"Custos e preços devem ser valores não negativos."});
    const shares=[Number(body.pointSharePercent||0),Number(body.postalSharePercent||0),Number(body.providerSharePercent||0)];
    if(shares.some(v=>!Number.isFinite(v)||v<0)||shares.reduce((a,b)=>a+b,0)>100.0001) return res.status(400).json({error:"Divisão financeira inválida."});
    const item=await db.upsertCatalogItem({
      code,itemType,category:String(body.category||"OUTROS").toUpperCase(),name,description:body.description||"",
      unitPrice,costPrice,trackStock:itemType==="PRODUCT"&&Boolean(body.trackStock),
      pointSharePercent:shares[0],postalSharePercent:shares[1],providerSharePercent:shares[2],
      externalProvider:body.externalProvider||null,externalRef:body.externalRef||null,active:body.active!==false,metadata:body.metadata||{}
    });
    await audit(req,"UPSERT_CATALOG_ITEM","CATALOG_ITEM",item.id,{code:item.code,itemType:item.item_type});
    res.json({item});
  } catch(error){ res.status(500).json({error:"Não foi possível salvar o item."}); }
});

// Crédito no Balcão descontinuado no produto.
app.use("/api/credit",(_req,res)=>res.status(410).json({error:"Módulo de crédito descontinuado."}));
app.use("/api/admin/credit",(_req,res)=>res.status(410).json({error:"Módulo de crédito descontinuado."}));
app.use("/api/integrations/v1/credit",(_req,res)=>res.status(410).json({error:"Módulo de crédito descontinuado."}));

app.post("/api/cotacao", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK","CLIENT"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = req.body || {};
    const cepFrom = String(body.cepOrigem || "").replace(/\D/g, "");
    const cepTo = String(body.cepDestino || "").replace(/\D/g, "");
    if (cepFrom.length !== 8 || cepTo.length !== 8) {
      return res.status(400).json({ error: "CEP de origem e destino devem ter 8 dígitos." });
    }

    const volumes = parseQuoteVolumes(body);
    const quoteOrigin = await resolveOperationalQuoteOrigin(req.user, cepFrom);
    const providerCepFrom = quoteOrigin.providerCepFrom;

    // A mesma tabela é usada no balcão, no portal cliente e na cotação gratuita.
    // No portal cliente a parcela do ponto integra a margem da Postal, pois o
    // cliente paga com saldo e não existe repasse automático ao balcão.
    let partnerCommissionRate = (req.user.role === "ADMIN" && !req.user.storeId)
      ? 0 : quotePricing.pointCommissionRate(quoteOrigin.store,PARTNER_COMMISSION);
    if (req.user.role !== "CLIENT" && req.user.storeId) {
      const store = quoteOrigin.store || await db.getStore(req.user.storeId);
      partnerCommissionRate = quotePricing.pointCommissionRate(store,PARTNER_COMMISSION);
    }
    const hubTransferFeePerPackage = quoteOrigin.overridden ? HUB_TRANSFER_FEE_PER_PACKAGE : 0;
    const hubTransferTotal = round2(hubTransferFeePerPackage * volumes.length);

    let demo = false;
    let cacheHits = 0;

    const quoteSets = await mapWithConcurrency(
      volumes,
      TOKEN ? CONECTENVIO_QUOTE_CONCURRENCY : 1,
      async volume => {
        let providerData;
        if (!TOKEN) {
          providerData = { error:false, data:demoQuote(body) };
          demo = true;
        } else {
          let providerQuote;
          try {
            providerQuote = await fetchProviderQuoteCached(providerCepFrom, cepTo, volume);
          } catch (error) {
            if(error.status===422)return [];
            error.message = `Volume ${volume.index}: ${error.message || "falha na cotação"}`;
            throw error;
          }
          providerData = providerQuote.data;
          if (providerQuote.cached) cacheHits++;

          if (providerData && providerData.error === true) {
            return [];
          }
        }
        return normalizeQuote(providerData, partnerCommissionRate);
      }
    );

    const aggregated = aggregateVolumeQuoteSets(quoteSets);
    const ownOption=await offerPostalRegional(aggregated,cepFrom,cepTo,hubTransferTotal,volumes,partnerCommissionRate);
    if(ownOption)aggregated.unshift(ownOption);
    const totalWeightGrams = volumes.reduce((sum,v)=>sum + Number(v.weightGrams || 0),0);
    const totalDeclaredValue = round2(volumes.reduce((sum,v)=>sum + Number(v.declaredValue || 0),0));

    const options = aggregated.map(option => {
      const first = volumes[0];
      const own=option.carrierMode==="POSTAL_OWN";
      const salePriceWithHub = round2(Number(option.precoVenda||0) + (own?0:hubTransferTotal));
      const postalMarginWithHub = round2(Number(option.postalMargin||0) + (own?0:hubTransferTotal));
      const clientDirect=req.user.role==="CLIENT";
      const selectionToken = signSelectionToken({
        exp: Date.now() + 2 * 60 * 60 * 1000,
        carrierMode:own?"POSTAL_OWN":"PARTNER",
        postalCompanyId: option.postalCompanyId,
        carrierName:option.transportadora,
        demo:Boolean(demo),
        service: option.produto,
        deadline: option.prazoEntrega,
        salePrice: salePriceWithHub,
        partnerCommission:clientDirect?0:option.comissaoParceiro,
        providerCost: option.providerCost,
        postalMargin:clientDirect?round2(salePriceWithHub-Number(option.providerCost||0)):postalMarginWithHub,
        hubTransferFeePerPackage:own?0:hubTransferFeePerPackage,
        hubTransferTotal:own?0:hubTransferTotal,
        package: {
          weightGrams: totalWeightGrams,
          width:first.width,
          height:first.height,
          length:first.length,
          cepFrom,
          cepTo,
          providerCepFrom,
          operationalHub: quoteOrigin.overridden ? quoteOrigin.operationalHub : null,
          hubTransferFeePerPackage:own?0:hubTransferFeePerPackage,
          hubTransferTotal:own?0:hubTransferTotal,
          ownRoute:own?option.route:null,
          carrierMode:own?"POSTAL_OWN":null,
          declaredValue:totalDeclaredValue,
          serviceCode: String(option.codigoServico || ""),
          postalServiceName: String(option.providerServiceName || option.produto || ""),
          volumeCount:volumes.length,
          volumes
        }
      });

      return {
        postalCompanyId: option.postalCompanyId,
        carrierMode:option.carrierMode||"PARTNER",
        recommended:Boolean(option.recommended),
        prazoEstimado:Boolean(option.prazoEstimado),
        prazoReferencia:option.prazoReferencia||"",
        transportadora: option.transportadora,
        produto: option.produto,
        codigoServico: option.codigoServico,
        prazoEntrega: option.prazoEntrega,
        precoVenda: salePriceWithHub,
        comissaoParceiro: req.user.role === "STORE_CLERK" ? undefined : option.comissaoParceiro,
        hubTransferApplied: quoteOrigin.overridden && !own,
        hubTransferFeePerPackage:own?0:hubTransferFeePerPackage,
        hubTransferTotal:own?0:hubTransferTotal,
        volumeCount:volumes.length,
        selectionToken
      };
    });

    if (!options.length) {
      return res.status(422).json({
        error: volumes.length > 1
          ? "Nenhum serviço atende todos os volumes informados. Revise peso/dimensões ou tente outra composição."
          : "Nenhuma opção de envio disponível para os dados informados."
      });
    }

    res.json({
      demo,
      provider: req.user.role === "CLIENT" ? "Postal Serviços" : "Integração logística",
      commissionPercent: round2(partnerCommissionRate * 100),
      volumeCount:volumes.length,
      totalWeightKg:round2(totalWeightGrams / 1000),
      hubTransfer:{
        applied:quoteOrigin.overridden,
        feePerPackage:hubTransferFeePerPackage,
        total:hubTransferTotal
      },
      quoteElapsedMs:Date.now() - startedAt,
      cacheHits,
      options
    });
  } catch (error) {
    console.error("quote error:", error.status, error.message);
    res.status(error.status === 401 ? 502 : (error.status && error.status < 500 ? error.status : 502)).json({
      error: error.status === 401
        ? "Consulta não autorizada pela integração logística."
        : (error.message || "Falha ao consultar os servicos de frete.")
    });
  }
});

// Consulta endereco por CEP.
app.get("/api/cep/:cep", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    const cep = String(req.params.cep || "").replace(/\D/g, "");
    const result = await providerFetch(`/cep/address/?cep=${encodeURIComponent(cep)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("cep error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar CEP." });
  }
});

// Lista transportadoras habilitadas para a conta.
app.get("/api/transportadoras", requireAuth, async (_req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    const result = await providerFetch("/postal_company", { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("postal company error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao listar transportadoras." });
  }
});

// Simulacao isolada de prazo.
app.post("/api/prazo", requireAuth, async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    const cepFrom = String(req.body.cepOrigem || "").replace(/\D/g, "");
    const cepTo = String(req.body.cepDestino || "").replace(/\D/g, "");
    const result = await providerFetch("/package/deadline", {
      method: "POST",
      body: JSON.stringify({ cep_from: cepFrom, cep_to: cepTo })
    });
    res.json(result.data);
  } catch (error) {
    console.error("deadline error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar prazo." });
  }
});

app.get("/api/catalog", requireAuth, async (req, res) => {
  try {
    const items = await db.getPartnerCatalog(inventoryOwner(req.user));
    const salesOnly = req.user.role !== "ADMIN";
    res.json({
      items: items.map(item => {
        const saleItem = {
          code: item.code,
          itemType: item.item_type,
          category: item.category,
          name: item.name,
          description: item.description || "",
          unitPrice: Number(item.effective_unit_price ?? item.unit_price ?? 0),
          trackStock: Boolean(item.track_stock),
          availableQuantity: Number(item.available_quantity || 0)
        };
        if (salesOnly) return saleItem;
        return {
          ...saleItem,
          stockQuantity: Number(item.stock_quantity || 0),
          reservedQuantity: Number(item.reserved_quantity || 0),
          minQuantity: Number(item.min_quantity || 0),
          averageCost: Number(item.average_cost || 0),
          externalProvider: item.external_provider || "",
          metadata: item.metadata || {}
        };
      })
    });
  } catch (error) {
    console.error("catalog error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar produtos e serviços." });
  }
});

app.post("/api/payment-preview", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req, res) => {
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

    if(Array.isArray(body.extraCharges)&&body.extraCharges.length&&!req.user.storeId)
      return res.status(400).json({error:"Custos extras diversos exigem um ponto Postal vinculado ao pedido."});
    const addons = [
      ...await resolveRequestedAddons(inventoryOwner(req.user), body.addons),
      ...resolveExtraCharges(body.extraCharges)
    ];
    const financials = summarizeFinancials(selection, addons, paymentMethod);

    res.json({
      freightPrice: financials.freightPrice,
      addonsTotal: financials.addonsTotal,
      extraChargesTotal: round2(addons.filter(a=>a.metadata?.source==="POINT_MANUAL_EXTRA").reduce((s,a)=>s+a.totalPrice,0)),
      subtotal: financials.customerSubtotal,
      paymentFee: financials.paymentSurcharge,
      total: financials.totalToCustomer,
      hubTransferFeePerPackage:Number(selection.hubTransferFeePerPackage||0),
      hubTransferTotal:Number(selection.hubTransferTotal||0),
      pointRevenue: req.user.role==="STORE_CLERK" ? undefined : financials.pointRevenueTotal,
      cashRemittance: req.user.role==="STORE_CLERK"
        ? undefined
        : (paymentMethod === "DINHEIRO"
          ? round2(financials.cashRemittanceBase + financials.paymentSurcharge)
          : 0)
    });
  } catch (error) {
    console.error("payment preview error:", error.message);
    res.status(400).json({ error: error.message || "Não foi possível calcular o pagamento." });
  }
});

app.get("/api/inventory", requireAuth, requireRole("ADMIN","STORE_OWNER","OPS"), async (req, res) => {
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
        minQuantity: Number(item.min_quantity || 0),
        ...(req.user.role === "ADMIN" ? { averageCost: Number(item.cost_price || 0) } : {})
      }))
    });
  } catch (error) {
    console.error("inventory error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar o estoque." });
  }
});

app.post("/api/inventory/receive", requireAuth, requireRole("ADMIN","STORE_OWNER","OPS"), async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const quantity = Number(req.body.quantity || 0);
    if (Object.hasOwn(req.body || {}, "salePrice") || Object.hasOwn(req.body || {}, "unitCost")) {
      return res.status(403).json({ error: "Custos e preços são configurados exclusivamente no catálogo MASTER." });
    }
    const lotCode = String(req.body.lotCode || "").trim();
    if (!code || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Informe produto e quantidade válida." });
    }
    const item = await db.getCatalogItemByCode(code);
    if (!item || !item.active) return res.status(404).json({ error: "Produto não encontrado." });
    if (!item.track_stock) return res.status(400).json({ error: "Este item não controla estoque físico." });

    const inventory = await db.receiveInventory(
      inventoryOwner(req.user),
      item.id,
      quantity,
      String(req.body.note || "Recebimento pelo ponto"),
      null,
      Number(item.cost_price || 0),
      lotCode || null
    );
    await audit(req,"INVENTORY_RECEIVE","CATALOG_ITEM",item.id,{code:item.code,quantity,lotCode:lotCode||null});
    res.json({ ok: true, inventory });
  } catch (error) {
    console.error("receive inventory error:", error.message);
    res.status(500).json({ error: "Não foi possível receber o estoque." });
  }
});

app.post("/api/inventory/adjust", requireAuth, requireRole("ADMIN","STORE_OWNER","OPS"), async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const quantity = Number(req.body.quantity || 0);
    const minQuantity = Math.max(0, Number(req.body.minQuantity || 0));
    if (Object.hasOwn(req.body || {}, "salePrice") || Object.hasOwn(req.body || {}, "unitCost")) {
      return res.status(403).json({ error: "Custos e preços são configurados exclusivamente no catálogo MASTER." });
    }
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
      null
    );
    await audit(req,"INVENTORY_ADJUST","CATALOG_ITEM",item.id,{code:item.code,quantity,minQuantity});
    res.json({ ok: true, inventory });
  } catch (error) {
    console.error("adjust inventory error:", error.message);
    res.status(500).json({ error: "Não foi possível ajustar o estoque." });
  }
});

app.get("/api/inventory/movements", requireAuth, requireRole("ADMIN","STORE_OWNER","OPS"), async (req,res)=>{
  try {
    const movements=await db.listInventoryMovements(inventoryOwner(req.user),Number(req.query.limit||100));
    res.json({movements:movements.map(m=>({
      id:m.id,code:m.code,name:m.name,movementType:m.movement_type,
      quantity:Number(m.quantity||0),lotCode:m.lot_code||"",...(req.user.role==="ADMIN" ? { unitCost:Number(m.unit_cost||0) } : {}),
      note:m.note||"",referenceType:m.reference_type||"",referenceId:m.reference_id||"",
      createdAt:m.created_at
    }))});
  } catch(error){ res.status(500).json({error:"Não foi possível carregar o histórico de estoque."}); }
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
    if (Object.hasOwn(req.body||{}, "salePrice") || Object.hasOwn(req.body||{}, "unitCost")) {
      return res.status(403).json({error:"Custos e preços são definidos no catálogo MASTER."});
    }
    const item = await db.getCatalogItemByCode(code);
    if (!item || !item.track_stock) return res.status(404).json({ error: "Produto de estoque não encontrado." });
    const inventory = await db.receiveInventory(
      partnerEmail,
      item.id,
      quantity,
      String(req.body.note || "Recebimento via integração"),
      null,
      Number(item.cost_price || 0)
    );
    res.json({ ok: true, version: "v1", inventory });
  } catch (error) {
    console.error("integration inventory receive error:", error.message);
    res.status(500).json({ error: "Falha ao registrar estoque." });
  }
});

// A busca de conteúdo fiscal por chave requer um provedor autorizado. Sem credenciais,
// não tenta consultar portais públicos protegidos por CAPTCHA nem inventa dados fiscais.
// Contrato do adaptador seguro: POST JSON {type,key,purpose}, resposta JSON {document:{...}}.
app.post("/api/fiscal-documents/lookup", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","CLIENT"), async (req,res)=>{
  const type=String(req.body?.type||"").toUpperCase();
  const key=cleanDigits(req.body?.key);
  if(!["NFE","DCE"].includes(type) || key.length!==44 || key.slice(20,22)!==(type==="NFE"?"55":"99")){
    return res.status(400).json({error:"Informe uma chave válida de 44 dígitos para o documento selecionado."});
  }
  if(req.body?.consent!==true) return res.status(403).json({error:"É necessário declarar autorização para consultar o documento."});
  if(!fiscalLookupConfigured()) return res.status(503).json({error:"Consulta fiscal autorizada ainda não configurada. Use a importação de XML ou o preenchimento manual."});
  try {
    let doc;
    if (FISCAL_LOOKUP_PROVIDER === "CONSULTADANFE") {
      if (type !== "NFE") return res.status(400).json({error:"Consulta DANFE consulta somente NF-e modelo 55 por chave. Para DC-e, importe o XML."});
      doc = await fiscalLookup.consultDanfe(key);
    } else {
      const response=await fetch(FISCAL_LOOKUP_URL,{
        method:"POST",
        headers:{"Content-Type":"application/json","Accept":"application/json","Authorization":"Bearer "+FISCAL_LOOKUP_TOKEN},
        body:JSON.stringify({type,key,purpose:"POSTAL_SHIPPING_QUOTE"}),
        redirect:"error",
        signal:AbortSignal.timeout(20000)
      });
      if([401,403].includes(response.status))return res.status(403).json({error:"O provedor fiscal não autorizou o acesso a este documento."});
      if(response.status===404)return res.status(404).json({error:"Documento não encontrado pelo provedor fiscal autorizado."});
      if(!response.ok)return res.status(502).json({error:"O serviço fiscal está indisponível. Você pode importar o XML ou preencher manualmente."});
      if(!String(response.headers.get("content-type")||"").toLowerCase().includes("application/json")){
        return res.status(502).json({error:"O provedor fiscal não retornou dados estruturados válidos."});
      }
      const raw=await response.text();
      if(raw.length>3000000)return res.status(502).json({error:"Documento muito grande para consulta."});
      const payload=JSON.parse(raw);
      if(payload.authorized !== true){
        return res.status(403).json({error:"O provedor não confirmou autorização de acesso ao XML."});
      }
      doc=payload.document || payload.data || payload;
    }
    if(String(doc?.type||"").toUpperCase()!==type || cleanDigits(doc?.key)!==key ||
       cleanDigits(doc?.sender?.cep).length!==8 || cleanDigits(doc?.recipient?.cep).length!==8 ||
       !Array.isArray(doc?.items)){
      return res.status(502).json({error:"Os dados recebidos não correspondem à chave solicitada."});
    }
    // Clientes não podem consultar documentos de terceiros sem vínculo fiscal próprio.
    if(req.user?.role==="CLIENT"){
      const account=await clientDb.getCustomerAccount(req.user.userId);
      const personalDocument=cleanDigits(account?.document);
      const permitted=[cleanDigits(doc.sender?.document),cleanDigits(doc.recipient?.document)];
      if(!personalDocument || !permitted.includes(personalDocument)){
        return res.status(403).json({error:"A consulta da chave requer documento fiscal vinculado à conta. Importe seu XML ou preencha manualmente."});
      }
    }
    const safeText=(value,max=160)=>String(value??"").slice(0,max);
    const safeParty=(party)=>Object.fromEntries([
      "name","document","phone","email","cep","address","number","neighborhood","complement","city"
    ].map(field=>[field,safeText(party?.[field],field==="address"?200:160)]));
    const safeItems=doc.items.slice(0,200).filter(x=>x&&typeof x==="object").map(x=>({
      description:safeText(x.description,200),
      quantity:Number(x.quantity||1),
      value:Number(x.value||0)
    })).filter(x=>x.description&&Number.isFinite(x.quantity)&&x.quantity>0&&Number.isFinite(x.value)&&x.value>=0);
    await audit(req,"FISCAL_DOCUMENT_LOOKUP","FISCAL_DOCUMENT",type,{type,keySuffix:key.slice(-4),source:FISCAL_LOOKUP_PROVIDER});
    return res.json({
      document:{
        type,key,sender:safeParty(doc.sender),recipient:safeParty(doc.recipient),items:safeItems,
        declaredValue:Number.isFinite(Number(doc.declaredValue))?Number(doc.declaredValue):0,
        volumeCount:Math.max(0,Math.min(50,Number(doc.volumeCount)||0))||null,
        grossWeightKg:Number(doc.grossWeightKg)>0?Number(doc.grossWeightKg):null,
        source:FISCAL_LOOKUP_PROVIDER === "CONSULTADANFE" ? "CONSULTADANFE_LOOKUP" : "AUTHORIZED_LOOKUP"
      }
    });
  } catch(error){
    if ([400,404,422,429].includes(error.status)) return res.status(error.status).json({error:error.message});
    console.warn("fiscal lookup failed",String(error?.name||"UnknownError"));
    return res.status(502).json({error:"Não foi possível concluir a consulta autorizada. Importe o XML ou preencha manualmente."});
  }
});

app.get("/api/orders", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  try {
    const orders = await db.listOrdersScoped(scopeForUser(req.user), Number(req.query.limit || 100));
    res.json({ orders: orders.map(order=>publicOrderForUser(order,req.user)) });
  } catch (error) {
    console.error("list orders error:", error.message);
    res.status(503).json({ error: "Não foi possível carregar Meus Fretes." });
  }
});

app.get("/api/orders/:id", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id, scopeForUser(req.user));
    if (!order) return res.status(404).json({ error: "Frete não encontrado." });
    res.json({ order: publicOrderForUser(order,req.user) });
  } catch (error) {
    console.error("get order error:", error.message);
    res.status(503).json({ error: "Não foi possível consultar o frete." });
  }
});

// Operational proof of internal hand-offs; it never changes the carrier's POD
// or triggers payment, shipment creation or external tracking mutations.
const scannerRoles=["ADMIN","SUPERVISOR","OPS","STORE_OWNER","STORE_CLERK"];
app.get("/api/ops/scanner-session",requireAuth,requireRole(...scannerRoles),requireCurrentUser,async(req,res)=>{
  try {
    const stores=await db.listStores();
    res.setHeader("Cache-Control","no-store");
    res.json({csrfToken:String(req.user.csrf||""),role:req.user.role,storeId:req.user.storeId||null,stages:custody.stages,
      destinations:stores.filter(s=>s.active).map(s=>({id:s.id,name:s.name,code:s.code,unitType:s.unit_type||'POINT'}))});
  }catch(error){res.status(503).json({error:"Não foi possível carregar os destinos de transferência."});}
});

async function scopedScanOrder(req,trackingCode){
  const order=await db.findOrderByTrackingCode(trackingCode);
  if(!order)return null;
  if(req.user.role==='ADMIN')return db.getOrder(order.id);
  if(!req.user.storeId)return null;
  const scans=await db.listCustodyScans(order.id,trackingCode);
  const last=scans.at(-1);
  const responsible=last
    ? (last.stage==='TRANSFERRED'?last.proof?.destinationStoreId:last.actor_store_id)
    : order.store_id;
  if(String(responsible||'')!==String(req.user.storeId))return null;
  return db.getOrder(order.id);
}

app.get("/api/ops/scans/:code",requireAuth,requireRole(...scannerRoles),requireCurrentUser,async(req,res)=>{
  try{
    const code=String(req.params.code||"").trim();
    if(!/^[A-Za-z0-9]{6,40}$/.test(code))return res.status(400).json({error:"Código inválido."});
    const order=await scopedScanOrder(req,code);
    if(!order)return res.status(404).json({error:"Envio não encontrado ou sem permissão para consulta."});
    const scans=await db.listCustodyScans(order.id,code);
    res.setHeader("Cache-Control","no-store");
    res.json({trackingCode:code,carrier:order.carrier||"Postal Serviços",paymentConfirmed:order.payment_status==="PAID"&&!order.is_simulation,
      scans:scans.map(scan=>({id:scan.id,stage:scan.stage,label:custody.stages[scan.stage]?.label||scan.stage,createdAt:scan.created_at,
        proof:scan.stage==="DELIVERY_RECORDED"?{
          recipientName:scan.proof?.recipientName||"",latitude:scan.proof?.latitude??null,longitude:scan.proof?.longitude??null,
          hasPhoto:Boolean(scan.proof?.photo)
        }:null,
        destination:scan.stage==='TRANSFERRED'?{id:scan.proof?.destinationStoreId||null,name:scan.proof?.destinationName||''}:null}))});
  }catch(error){console.error("scan history error",error.message);res.status(503).json({error:"Não foi possível consultar a movimentação."});}
});

app.post("/api/ops/scans",requireAuth,requireRole(...scannerRoles),requireCurrentUser,async(req,res)=>{
  try{
    const body=req.body||{};
    // Check the physical scan against a real order within this user's scope.
    const code=String(body.trackingCode||"").trim();
    if(!/^[A-Za-z0-9]{6,40}$/.test(code))return res.status(400).json({error:"Código inválido."});
    const order=await scopedScanOrder(req,code);
    if(!order)return res.status(404).json({error:"Envio não encontrado ou sem permissão para leitura."});
    const result=await db.recordCustodyScan({orderId:order.id,trackingCode:code,stage:String(body.stage||""),
      actorUserId:req.user.userId,actorStoreId:req.user.storeId,idempotencyKey:String(body.idempotencyKey||""),
      proofName:String(body.recipientName||""),latitude:body.latitude??null,longitude:body.longitude??null,photo:body.photo||null,
      destinationStoreId:body.destinationStoreId||null,isManager:req.user.role==="ADMIN",
      deliveryEarning:POINT_PICKUP_EARNING_PER_PACKAGE});
    if(!result.replayed)await audit(req,"CUSTODY_SCAN","FREIGHT_ORDER",order.id,{trackingCode:code,stage:body.stage,destinationStoreId:body.destinationStoreId||null});
    res.status(result.replayed?200:201).json({ok:true,replayed:result.replayed,
      stage:result.scan.stage,label:custody.stages[result.scan.stage]?.label,createdAt:result.scan.created_at});
  }catch(error){
    if(error.status)return res.status(error.status).json({error:error.message});
    console.error("scan record error",error.message);
    res.status(503).json({error:"Não foi possível registrar a leitura. Tente novamente sem duplicar o evento."});
  }
});

app.get("/api/ops/scans/:code/photo/:scanId",requireAuth,requireRole(...scannerRoles),requireCurrentUser,async(req,res)=>{
  try{
    const code=String(req.params.code||"");
    if(!/^[A-Za-z0-9]{6,40}$/.test(code)||!/^[\da-f-]{36}$/i.test(req.params.scanId))return res.sendStatus(400);
    const order=await scopedScanOrder(req,code);
    if(!order)return res.sendStatus(404);
    const scan=(await db.listCustodyScans(order.id,code)).find(s=>s.id===req.params.scanId);
    const picture=scan?.proof?.photo||"";
    if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(picture))return res.sendStatus(404);
    res.setHeader("Cache-Control","private,no-store");res.type("jpeg");res.send(Buffer.from(picture.split(",")[1],"base64"));
  }catch(error){console.error("delivery photo error",error.message);res.sendStatus(503);}
});

// Edição restrita da postagem existente: não recria cobrança nem toca no valor pago.
app.patch("/api/orders/:id/shipping-details",requireAuth,requireRole("ADMIN","STORE_OWNER","STORE_CLERK"),async(req,res)=>{
  try{
    const order=await db.getOrder(req.params.id,scopeForUser(req.user));
    if(!order)return res.status(404).json({error:"Pedido não encontrado nesta unidade."});
    if(!shipmentCorrections.canEditOrder(order)){
      return res.status(409).json({error:"Este frete não pode mais ser editado: já há emissão em andamento ou postagem vinculada à transportadora."});
    }
    const sender=shipmentCorrections.correctedParty(order.sender,req.body?.sender,"remetente");
    const recipient=shipmentCorrections.correctedParty(order.recipient,req.body?.recipient,"destinatário");
    validateFreightParties(sender,recipient,order.items||[]);
    if(order.package_data?.carrierMode==="POSTAL_OWN" &&
       (!postalRegional.matchesCity(sender.city,order.package_data?.ownRoute?.originCity) ||
        !postalRegional.matchesCity(recipient.city,order.package_data?.ownRoute?.destinationCity))) {
      return res.status(400).json({error:"A cidade deve corresponder à rota já contratada. Para mudar o trajeto, solicite revisão da cotação."});
    }
    const changed=await db.updateOrderShippingParties(order.id,scopeForUser(req.user),sender,recipient);
    if(!changed)return res.status(409).json({error:"O pedido mudou de situação durante a edição; atualize antes de tentar novamente."});
    await db.addOrderEvent(order.id,"SHIPPING_DETAILS_CORRECTED","Dados cadastrais corrigidos",
      "Remetente e destinatário revisados. Cotação, pagamento, valores, CEP e volumes preservados.");
    await audit(req,"EDIT_ORDER_SHIPPING_DETAILS","FREIGHT_ORDER",order.id,{status:order.status});
    const updated=await db.getOrder(order.id,scopeForUser(req.user));
    res.json({ok:true,order:publicOrderForUser(updated,req.user),
      message:shipmentCorrections.canRetryShipment(updated)
        ?"Dados corrigidos. Você pode solicitar nova emissão sem pagar outra vez."
        :"Dados corrigidos no pedido original. Emissão anterior exige conferência com a transportadora antes de reprocessar, para evitar duplicidade."});
  }catch(error){
    res.status(error.status>=400&&error.status<500?error.status:500)
      .json({error:error.status?error.message:"Não foi possível salvar as correções. Tente novamente."});
  }
});

// Reprocessamento manual: conserva o pedido pago e nunca cria um novo checkout.
app.post("/api/orders/:id/reprocess-shipment", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req,res)=>{
  try {
    if ((!ENABLE_SHIPMENT_CREATION || !TOKEN) && !(await db.getOrder(req.params.id,scopeForUser(req.user)))?.package_data?.carrierMode?.includes("POSTAL_OWN")) return res.status(503).json({error:"Emissão não habilitada no momento."});
    const order=await db.getOrder(req.params.id,scopeForUser(req.user));
    if (!order) return res.status(404).json({error:"Frete não encontrado."});
    if (String(order.payment_status).toUpperCase()!=="PAID" || order.is_simulation) {
      return res.status(409).json({error:"Somente pedidos reais com pagamento confirmado podem ser reprocessados."});
    }
    if (!["SHIPMENT_ERROR","PROVIDER_PAYMENT_PENDING","PAID_WAITING_SHIPMENT","PAYMENT_CONFIRMED","LABEL_AVAILABLE"].includes(order.status)) {
      return res.status(409).json({error:"Este pedido não está aguardando emissão."});
    }
    // O mesmo pedido pago é reutilizado. Só tentamos novamente um POST /cart
    // quando a rejeição HTTP 400/422 é explícita (REJECTED_INPUT), falta saldo
    // ou nunca houve tentativa; resultado incerto permanece bloqueado.
    // Se há carrinho remoto, createShipmentFromOrder faz GET no mesmo carrinho.
    const hasProviderRef=Boolean(order.conect_cart_id || order.conect_package_id);
    if (!shipmentCorrections.canRetryShipment(order)) {
      return res.status(409).json({error:"A transportadora não confirmou se a tentativa anterior criou o envio. Confira a postagem antes de repetir, para evitar duplicidade."});
    }
    const retryStatus=String(order.provider_payment_status||"").toUpperCase();
    if (retryStatus==="REJECTED_INPUT" && !hasProviderRef) {
      const lastAttempt=Date.parse(order.provider_payment_updated_at||"");
      if (Number.isFinite(lastAttempt) && Date.now()-lastAttempt<20000) {
        return res.status(429).json({error:"Aguarde 20 segundos entre tentativas de emissão do mesmo frete."});
      }
    }
    const shipment=await createShipmentFromOrder(order);
    const updated=await db.getOrder(order.id,scopeForUser(req.user));
    await audit(req,"REPROCESS_SHIPMENT","FREIGHT_ORDER",order.id,{ready:Boolean(shipment?.ready),hadProviderRef:hasProviderRef});
    return res.json({
      ok:true,
      ready:Boolean(shipment?.ready || updated?.status==="LABEL_AVAILABLE"),
      message:shipment?.ready || updated?.status==="LABEL_AVAILABLE"
        ?"Etiqueta liberada. Você já pode imprimir."
        :"Postagem reconsultada. Aguardando liberação da etiqueta pela transportadora; não é necessário pagar novamente.",
      order:publicOrderForUser(updated,req.user)
    });
  } catch(error) {
    const errorSummary=shipmentCorrections.providerErrorSummary(providerFailureText(error));
    console.error("manual reprocess shipment error:",{orderId:req.params.id,httpStatus:Number(error.status)||null,reason:errorSummary});
    const updated=await db.getOrder(req.params.id,scopeForUser(req.user)).catch(()=>null);
    return res.status(error.status && error.status>=400 && error.status<500 ? error.status : 502).json({
      error:providerPaymentFailureStatus(error)==="AWAITING_FUNDS"
        ?"Liberação financeira da transportadora pendente. O pedido já pago foi preservado."
        :errorSummary
          ?errorSummary+" O pedido pago foi preservado; não efetue outro pagamento."
          :"Não foi possível liberar a etiqueta. O pedido pago foi preservado; consulte os detalhes antes de tentar novamente.",
      order:updated?publicOrderForUser(updated,req.user):undefined
    });
  }
});

app.post("/api/orders", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req, res) => {
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
    if(!paymentOperational()){
      return res.status(503).json({
        error:"Pagamentos e repasses estão bloqueados até o Asaas produção ficar 100% validado. Nenhum valor foi recebido."
      });
    }

    const sender = body.sender || {};
    const recipient = body.recipient || {};
    const items = Array.isArray(body.items) ? body.items : [];
    validateFreightParties(sender, recipient, items);
    if (postalRegional.isOwnSelection(selection) &&
        (!postalRegional.matchesCity(sender.city,selection.package?.ownRoute?.originCity) ||
         !postalRegional.matchesCity(recipient.city,selection.package?.ownRoute?.destinationCity))) {
      return res.status(400).json({error:"A cidade não corresponde ao CEP da rota Postal Regional cotada."});
    }

    if (cleanDigits(sender.cep) !== selection.package.cepFrom || cleanDigits(recipient.cep) !== selection.package.cepTo) {
      return res.status(400).json({ error: "Os CEPs mudaram após a cotação. Calcule novamente." });
    }

    if(Array.isArray(body.extraCharges)&&body.extraCharges.length&&!req.user.storeId)
      return res.status(400).json({error:"Custos extras diversos exigem um ponto Postal vinculado ao pedido."});
    const addons = [
      ...await resolveRequestedAddons(inventoryOwner(req.user), body.addons),
      ...resolveExtraCharges(body.extraCharges)
    ];
    const financials = summarizeFinancials(selection, addons, paymentMethod);

    const salePrice = round2(Number(selection.salePrice));
    const partnerCommission = round2(Number(selection.partnerCommission));
    const providerCost = round2(Number(selection.providerCost));
    const postalMargin = round2(Math.max(0, salePrice - partnerCommission - providerCost));
    const orderId = crypto.randomUUID();
    const invoiceNumber = String(body.invoiceNumber || "").trim();
    let partnerWalletId = ASAAS_DEFAULT_PARTNER_WALLET_ID;
    if (req.user.storeId) {
      const financialStore = await db.getStore(req.user.storeId);
      partnerWalletId = String(financialStore?.asaas_wallet_id || ASAAS_DEFAULT_PARTNER_WALLET_ID || "").trim();
    } else {
      const partner = await db.ensurePartner(req.user.email);
      partnerWalletId = String(partner?.asaas_wallet_id || ASAAS_DEFAULT_PARTNER_WALLET_ID || "").trim();
    }

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
      hubTransferFeePerPackage: Number(selection.hubTransferFeePerPackage||0),
      hubTransferTotal: Number(selection.hubTransferTotal||0),
      partnerCommission,
      postalMargin,
      providerCost,
      postalCompanyId: selection.postalCompanyId,
      carrier: postalRegional.isOwnSelection(selection)?"Postal Serviços":String(selection.carrierName || body.carrier || ""),
      serviceName: String(selection.service || ""),
      deadline: Number(selection.deadline || 0),
      quoteToken: body.selectionToken,
      sender,
      recipient,
      items,
      invoiceNumber,
      packageData: {...selection.package, fiscalDocument:normalizeFiscalReference(body)},
      packageCount: Math.max(1, Number(selection.package?.volumes?.length || selection.package?.volumeCount || 1))
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
      await audit(req,"CREATE_FREIGHT_ORDER","FREIGHT_ORDER",order.id,{paymentMethod,addonsCount:addons.length});

      const complete = await db.getOrder(order.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrderForUser(complete,req.user),
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
    await audit(req,"CREATE_FREIGHT_ORDER","FREIGHT_ORDER",order.id,{paymentMethod,addonsCount:addons.length});

    if (!paymentOperational()) {
      if (PAYMENT_SIMULATOR_ENABLED && !asaas.configured()) {
        await db.updateStatus(order.id, "SIMULATED_PAYMENT_PENDING", "PENDING");
        await db.addOrderEvent(order.id, "PAYMENT_SIMULATOR", "Pagamento de homologação pendente", "Use o simulador para confirmar o pagamento sem movimentar dinheiro.");
        const complete = await db.getOrder(order.id, scopeForUser(req.user));
        return res.status(201).json({
          order: publicOrderForUser(complete,req.user),
          nextAction: "SIMULATE_PAYMENT",
          message: "Pagamento salvo em modo homologação."
        });
      }
      const complete = await db.getOrder(order.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrderForUser(complete,req.user),
        paymentSetupRequired: true,
        message: "Asaas ainda precisa da chave de API para liberar cobranças."
      });
    }

    if (!partnerWalletId && Number(financials.pointRevenueTotal || 0) > 0) {
      const pending = await db.updateStatus(order.id, "PARTNER_FINANCIAL_SETUP_REQUIRED", "PENDING");
      const complete = await db.getOrder(pending.id, scopeForUser(req.user));
      return res.status(201).json({
        order: publicOrderForUser(complete,req.user),
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
        phone: sender.phone,
        address: sender.address,
        addressNumber: sender.number,
        complement: sender.complement || undefined,
        postalCode: cleanDigits(sender.cep),
        province: sender.neighborhood
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

    const complete = await db.getOrder(updated.id, scopeForUser(req.user));
    res.status(201).json({
      order: publicOrderForUser(complete,req.user),
      checkoutUrl: checkout.url,
      nextAction: "OPEN_CHECKOUT"
    });
  } catch (error) {
    console.error("create order error:", error.status, error.message);
    res.status(error.status && error.status < 500 ? error.status : 500).json({
      error: error.message || "Não foi possível iniciar o pagamento do frete."
    });
  }
});

app.post("/api/orders/:id/remittance", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id, scopeForUser(req.user));
    if (!order) return res.status(404).json({ error: "Frete não encontrado." });
    if (order.payment_method !== "DINHEIRO") return res.status(400).json({ error: "Este frete não é de pagamento em dinheiro." });
    if (order.status === "LABEL_AVAILABLE") return res.json({ order: publicOrderForUser(order,req.user), alreadyPaid: true });
    if (order.payment_checkout_url && order.payment_status === "PENDING") {
      return res.json({ order: publicOrderForUser(order,req.user), checkoutUrl: order.payment_checkout_url });
    }
    if (!asaas.configured()) {
      if (PAYMENT_SIMULATOR_ENABLED) {
        const updated = await db.updateStatus(order.id, "SIMULATED_REMITTANCE_PENDING", "PENDING");
        await db.addOrderEvent(order.id, "REMITTANCE_SIMULATOR", "Repasse de homologação pendente", "Use o simulador para confirmar o repasse sem movimentar dinheiro.");
        const complete = await db.getOrder(updated.id, scopeForUser(req.user));
        return res.json({ order: publicOrderForUser(complete,req.user), simulator: true });
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

    res.json({ order: publicOrderForUser(updated,req.user), checkoutUrl: checkout.url });
  } catch (error) {
    console.error("cash remittance error:", error.status, error.message);
    res.status(500).json({ error: error.message || "Não foi possível gerar o repasse." });
  }
});

app.post("/api/orders/:id/simulate-payment", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req, res) => {
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
    res.json({ ok:true, order: publicOrderForUser(complete,req.user) });
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


app.get("/api/orders/:id/labels", requireAuth, requireRole("ADMIN","STORE_OWNER","STORE_CLERK"), async (req,res)=>{
  try{
    const order=await db.getOrder(req.params.id,scopeForUser(req.user));
    if(!order) return res.status(404).json({error:"Frete não encontrado."});
    if(!["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(order.status)){
      return res.status(409).json({error:"As etiquetas deste envio ainda não estão disponíveis."});
    }
    const pdf=await mergedLabelPdf([order]);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",'inline; filename="etiquetas-'+String(order.id).slice(0,8)+'.pdf"');
    res.send(pdf);
  }catch(error){
    console.error("order labels error:",error.message);
    res.status(500).json({error:"Não foi possível montar as etiquetas deste envio."});
  }
});

async function canReadProviderReference(req,kind,reference) {
  const scope=req.user.role==="ADMIN"?{global:true}:scopeForUser(req.user);
  return Boolean(await db.findOrderByProviderReference(kind,reference,scope));
}

// Consulta carrinho: o token do master só pode consultar um carrinho do próprio ponto.
app.get("/api/carrinhos/:id", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    if(!(await canReadProviderReference(req,"cart",req.params.id)))return res.status(404).json({error:"Carrinho não encontrado."});
    const result = await providerFetch(`/cart/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("cart detail error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar carrinho." });
  }
});

// Consulta pacote individual.
app.get("/api/envios/:id", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    if(!(await canReadProviderReference(req,"package",req.params.id)))return res.status(404).json({error:"Envio não encontrado."});
    const result = await providerFetch(`/package/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("package detail error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao consultar envio." });
  }
});

// Rastreamento público com marca Postal. A transportadora de pedidos próprios é
// identificada pelo nome comercial, sem expor conta, provedor ou tarifas internas.
function trackingEventsFromPayload(payload) {
  const candidates=[];
  const seen=new Set();
  const isEventLike=value=>{
    if(!value || typeof value!=="object" || Array.isArray(value)) return false;
    return Boolean(
      value.date || value.datetime || value.created_at || value.createdAt ||
      value.description || value.label || value.status_label || value.status ||
      value.city || value.uf || value.state || value.type
    );
  };
  const walk=(value,depth=0)=>{
    if(value==null || depth>7) return;
    if(typeof value==="object"){
      if(seen.has(value)) return;
      seen.add(value);
    }
    if(Array.isArray(value)){
      if(value.length && value.some(isEventLike)) candidates.push(value.filter(isEventLike));
      value.forEach(item=>walk(item,depth+1));
      return;
    }
    if(typeof value!=="object") return;
    for(const key of ["events","eventos","history","historico","tracking","trackings","occurrences","ocorrencias","movements","movimentacoes","checkpoints","statuses"]){
      if(Array.isArray(value[key]) && value[key].some(isEventLike)) candidates.push(value[key].filter(isEventLike));
    }
    Object.values(value).forEach(child=>walk(child,depth+1));
  };
  walk(payload);
  candidates.sort((a,b)=>b.length-a.length);
  return candidates[0]||[];
}

function trackingFieldFromPayload(payload,keys) {
  const seen=new Set();
  const walk=(value,depth=0)=>{
    if(value==null || depth>6 || typeof value!=="object") return null;
    if(seen.has(value)) return null;
    seen.add(value);
    for(const key of keys){
      const field=value[key];
      if(field!==undefined && field!==null && !Array.isArray(field) && typeof field!=="object" && String(field).trim()){
        return field;
      }
    }
    const preferred=["data","result","package","shipment","tracking","track"];
    for(const key of preferred){
      if(value[key] && typeof value[key]==="object"){
        const found=walk(value[key],depth+1);
        if(found!==null) return found;
      }
    }
    return null;
  };
  return walk(payload);
}

function postalServiceLabel(rawService) {
  const value=String(rawService||"").toUpperCase();
  if(value.includes("ECON")) return "Econômico";
  if(value.includes("EXPRESS") || value.includes("EXPRESSO")) return "Expresso";
  if(value.includes("SEDEX")) return "Expresso";
  if(value.includes("PAC")) return "Econômico";
  if(value.includes("STANDARD") || value.includes("PADR")) return "Padrão";
  return value ? "Entrega Postal" : "Entrega";
}

function postalizeTrackingText(value) {
  let text=String(value||"").trim();
  if(!text) return "";
  const brands=[
    /conect\s*envios/gi,
    /loggi/gi,
    /jadlog/gi,
    /correios/gi,
    /azul\s*cargo(?:\s*express)?/gi,
    /j\s*&\s*t(?:\s*express)?/gi,
    /latam\s*cargo/gi,
    /gol\s*log/gi
  ];
  for(const pattern of brands) text=text.replace(pattern,"Postal Serviços");
  return text;
}

function postalTrackingEventDescription(event) {
  const type=String(event?.correios_type||event?.type||event?.code||"").toLowerCase();
  const status=String(event?.correios_status||event?.status||"").trim();
  if(type==="1" || /adicionado no sistema/i.test(status)){
    return "A etiqueta de envio já foi criada e o pacote está pronto para a coleta.";
  }
  if(type==="stamped") return "Etiqueta requisitada";
  if(type==="created") return "Objeto criado";
  return postalizeTrackingText(
    event?.description||event?.correios_detail||event?.message||event?.label||
    event?.status_label||event?.statusLabel||status||event?.title||"Atualização do envio"
  );
}

function postalTrackingStatus(events,payload) {
  const first=Array.isArray(events)&&events.length?events[0]:null;
  const type=String(first?.type||"").toLowerCase();
  if(type==="1") return "Pronto para coleta";
  if(type==="stamped") return "Etiqueta requisitada";
  if(type==="created") return "Objeto criado";
  const raw=trackingFieldFromPayload(payload,["status_label","statusLabel","current_status_label","currentStatus","status"]);
  return postalizeTrackingText(raw||first?.description||"Em acompanhamento");
}

// Rastreios criados diretamente na ConectEnvios não possuem pedido local no Postal Balcão.
// Consulte somente a linha do tempo pública; não exponha dados pessoais de envios externos.
function normalizePostalTrackingEvents(rawEvents) {
  return rawEvents.slice(0,30).map(event=>({
    date:event.correios_date||event.date||event.datetime||event.created_at||event.createdAt||event.timestamp||null,
    description:postalTrackingEventDescription(event),
    city:event.city||event.location?.city||event.local?.city||null,
    uf:event.uf||event.state||event.location?.uf||event.location?.state||null,
    type:event.correios_type||event.type||event.code||event.status_code||null
  }));
}

async function externalPostalTracking(stamp) {
  let payload;
  try {
    const result=await providerFetch(`/package/track/stamp/${encodeURIComponent(stamp)}`,{method:"GET",timeout:15000});
    payload=result.data;
  }catch(error){
    // Um código desconhecido não deve virar erro do servidor.
    if([400,404,422].includes(Number(error.status))) return null;
    throw error;
  }
  if(!payload || typeof payload!=="object" || Array.isArray(payload)) return null;
  if(payload.success===false || payload.error) return null;
  const rawEvents=trackingEventsFromPayload(payload);
  const rawStatus=trackingFieldFromPayload(payload,["status_label","statusLabel","current_status_label","currentStatus","status"]);
  if(!rawEvents.length && (!rawStatus || /^(error|failed|404)$|not found|n[aã]o encontrado|inv[aá]lido/i.test(String(rawStatus)))) return null;
  const events=normalizePostalTrackingEvents(rawEvents);
  const status=postalTrackingStatus(events,payload);
  return {
    trackingCode:stamp,
    statusLabel:String(status),
    operator:"Postal Serviços",
    service:postalServiceLabel(trackingFieldFromPayload(payload,["service_name","serviceName","service"])),
    sender:{name:"",city:"",cep:""},
    recipient:{name:"",address:"",number:"",complement:"",neighborhood:"",city:"",cep:""},
    origin:{city:"",cep:""},
    destination:{city:"",cep:""},
    package:{volumeCount:1,weightKg:0,declaredValue:0,volumes:[]},
    events,
    updatedAt:trackingFieldFromPayload(payload,["updated_at","updatedAt","last_update","lastUpdate"])||events[0]?.date||null
  };
}

app.get("/api/public/rastreio/:stamp", async (req,res)=>{
  const stamp=String(req.params.stamp||"").trim();
  if(!/^[A-Za-z0-9]{6,40}$/.test(stamp)){
    return res.status(400).json({error:"Código de rastreio inválido."});
  }
  try{
    const order=await db.findOrderByTrackingCode(stamp);
    if(!order){
      if(!TOKEN)return res.status(404).json({error:"Código não encontrado na rede Postal."});
      const external=await externalPostalTracking(stamp);
      if(!external) return res.status(404).json({error:"Código não encontrado na rede Postal."});
      return res.json(external);
    }

    if(order.package_data?.carrierMode==="POSTAL_OWN"){
      const scans=await db.listCustodyScans(order.id,stamp);
      const last=scans.at(-1);
      const lastLabel=last?custody.stages[last.stage]?.label:"Etiqueta emitida";
      const packageData=order.package_data||{};
      const volumes=Array.isArray(packageData.volumes)?packageData.volumes:[];
      res.setHeader("Cache-Control","no-store");
      return res.json({
        trackingCode:stamp,statusLabel:lastLabel||"Em acompanhamento",
        operator:"Postal Serviços",carrier:"Postal Serviços",service:"Postal Regional",
        sender:trackingPrivacy.publicParty(order.sender||{}),
        recipient:trackingPrivacy.publicParty(order.recipient||{}),
        origin:trackingPrivacy.publicRoute(order.sender||{}),
        destination:trackingPrivacy.publicRoute(order.recipient||{}),
        package:trackingPrivacy.publicPackage({
          volumeCount:Number(order.package_count||volumes.length||1),
          weightKg:Number((volumes.reduce((sum,v)=>sum+Number(v.weightGrams||0),0)/1000).toFixed(3)),
          declaredValue:Number(packageData.declaredValue||0),
          volumes:volumes.map((v,index)=>({
            index:index+1,weightKg:Number((Number(v.weightGrams||0)/1000).toFixed(3)),
            dimensions:{length:Number(v.length||0),width:Number(v.width||0),height:Number(v.height||0)},
            declaredValue:Number(v.declaredValue||0)
          }))
        }),
        events:[...scans].reverse().map(scan=>({
          date:scan.created_at,
          description:custody.stages[scan.stage]?.label||"Atualização operacional",
          city:null,uf:null,type:scan.stage
        })).concat([{date:order.shipped_at||order.created_at,description:"Etiqueta Postal Regional emitida",type:"CREATED"}]),
        updatedAt:last?.created_at||order.shipped_at||order.created_at
      });
    }

    if(!TOKEN)return res.status(503).json({error:"Rastreamento do parceiro temporariamente indisponível."});

    const volumes=Array.isArray(order.shipment_volumes)?order.shipment_volumes:[];
    const matchingVolume=volumes.find(v=>String(v?.trackingCode||v?.tracking_code||"").trim()===stamp);
    const packageIds=[matchingVolume?.packageId,matchingVolume?.package_id,order.conect_package_id]
      .filter(Boolean)
      .map(String)
      .filter((value,index,array)=>array.indexOf(value)===index);

    const payloads=[];
    for(const packageId of packageIds){
      try{
        const byId=await providerFetch(`/package/track/${encodeURIComponent(packageId)}`,{method:"GET",timeout:30000});
        payloads.push(byId.data);
      }catch(error){
        console.warn("public tracking by id fallback",packageId,error.status||"",error.message);
      }
    }
    try{
      const byStamp=await providerFetch(`/package/track/stamp/${encodeURIComponent(stamp)}`,{method:"GET",timeout:30000});
      payloads.push(byStamp.data);
    }catch(error){
      console.warn("public tracking by stamp fallback",stamp,error.status||"",error.message);
    }

    let bestPayload={};
    let bestEvents=[];
    for(const payload of payloads){
      const events=trackingEventsFromPayload(payload);
      if(events.length>bestEvents.length){
        bestEvents=events;
        bestPayload=payload||{};
      }
    }
    if(!bestEvents.length && payloads.length) bestPayload=payloads[0]||{};

    const normalizedEvents=normalizePostalTrackingEvents(bestEvents);

    const rawPackage=order.package_data&&typeof order.package_data==="object"?order.package_data:{};
    const packageVolumes=Array.isArray(rawPackage.volumes)&&rawPackage.volumes.length
      ? rawPackage.volumes
      : [{
          weightGrams:Number(rawPackage.weightGrams||0),
          length:Number(rawPackage.length||0),
          width:Number(rawPackage.width||0),
          height:Number(rawPackage.height||0),
          declaredValue:Number(rawPackage.declaredValue||0)
        }];
    const totalWeightGrams=packageVolumes.reduce((sum,v)=>sum+Number(v.weightGrams||0),0);
    const totalDeclared=Number(rawPackage.declaredValue||packageVolumes.reduce((sum,v)=>sum+Number(v.declaredValue||0),0)||0);
    const sender=order.sender||{};
    const recipient=order.recipient||{};
    const status=postalTrackingStatus(normalizedEvents,bestPayload);
    const updatedAt=trackingFieldFromPayload(bestPayload,["updated_at","updatedAt","last_update","lastUpdate"])||
      normalizedEvents[0]?.date||null;

    res.json({
      trackingCode:stamp,
      statusLabel:String(status),
      operator:"Postal Serviços",
      carrier:String(order.carrier||"").slice(0,90),
      service:postalServiceLabel(order.service_name),
      sender:trackingPrivacy.publicParty(sender),
      recipient:trackingPrivacy.publicParty(recipient),
      origin:trackingPrivacy.publicRoute(sender),
      destination:trackingPrivacy.publicRoute(recipient),
      package:trackingPrivacy.publicPackage({
        volumeCount:Number(order.package_count||packageVolumes.length||1),
        weightKg:Number((totalWeightGrams/1000).toFixed(3)),
        declaredValue:Number(totalDeclared||0),
        volumes:packageVolumes.map((v,index)=>({
          index:index+1,
          weightKg:Number((Number(v.weightGrams||0)/1000).toFixed(3)),
          dimensions:{
            length:Number(v.length||0),
            width:Number(v.width||0),
            height:Number(v.height||0)
          },
          declaredValue:Number(v.declaredValue||0)
        }))
      }),
      events:normalizedEvents,
      updatedAt
    });
  }catch(error){
    console.error("public tracking error:",error.status,error.message);
    res.status(502).json({error:"Não foi possível atualizar o rastreio agora. Tente novamente em alguns instantes."});
  }
});

// Rastreamento pelo ID interno do pacote.
app.get("/api/rastreio/id/:id", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    if(!(await canReadProviderReference(req,"package",req.params.id)))return res.status(404).json({error:"Envio não encontrado."});
    const result = await providerFetch(`/package/track/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("track by id error:", error.status, error.message);
    res.status(error.status || 502).json({ error: "Falha ao rastrear envio." });
  }
});

// Rastreamento pelo codigo da etiqueta.
app.get("/api/rastreio/codigo/:stamp", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });
  try {
    if(!(await canReadProviderReference(req,"tracking",req.params.stamp)))return res.status(404).json({error:"Rastreio não encontrado."});
    const result = await providerFetch(`/package/track/stamp/${encodeURIComponent(req.params.stamp)}`, { method: "GET" });
    res.json(result.data);
  } catch (error) {
    console.error("track by stamp error:", error.status, error.message);
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
app.post("/api/documento-proxy", requireAuth, requireRole("ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS"), async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "Integração logística indisponível." });

  try {
    const rawUrl = String(req.body.url || "");
    const allowed = new URL(`${API_URL}/package/`);
    let documentUrl;
    try { documentUrl = new URL(rawUrl); } catch {
      return res.status(400).json({ error: "URL de documento invalida." });
    }
    if (documentUrl.origin !== allowed.origin || !documentUrl.pathname.startsWith(allowed.pathname) || documentUrl.username || documentUrl.password) {
      return res.status(400).json({ error: "URL de documento invalida." });
    }
    if(!(await canReadProviderReference(req,"document",documentUrl.href))){
      return res.status(404).json({error:"Documento não encontrado para esta unidade."});
    }

    const response = await fetch(documentUrl.href, {
      method: "GET",
      headers: providerHeaders(),
      redirect: "error",
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

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Endpoint da API não encontrado." });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function ensureBootstrapAdmin() {
  if (process.env.NODE_ENV === "production" && SESSION_SECRET === "postal-v1-dev-secret-change-me") {
    throw new Error("APP_SESSION_SECRET inseguro em produção.");
  }

  const existing = await db.findUserByEmail(APP_USER);
  if (!existing) {
    if (process.env.NODE_ENV === "production" && APP_PASSWORD === "postal123" && !ADMIN_PASSWORD_RESET_HASH.startsWith("pbkdf2$")) {
      throw new Error("Defina APP_PASSWORD com uma senha própria antes de criar o administrador em produção.");
    }
    const admin = await db.createUser({
      email: APP_USER,
      name: "Administrador Postal",
      passwordHash: ADMIN_PASSWORD_RESET_HASH.startsWith("pbkdf2$") ? ADMIN_PASSWORD_RESET_HASH : hashPassword(APP_PASSWORD),
      role: "ADMIN",
      active: true,
      storeId: null
    });
    console.log("Usuário administrador inicial criado:", admin.email);
    return;
  }

  if (ADMIN_PASSWORD_RESET_HASH.startsWith("pbkdf2$")) {
    await db.updateUser(existing.id, { passwordHash: ADMIN_PASSWORD_RESET_HASH, active: true, role: "ADMIN", storeId: null });
    console.log("Senha do administrador inicial sincronizada por migração segura.");
  }
}

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

async function ensureAsaasCheckoutWebhook() {
  if (!asaas.configured() || !asaas.webhookConfigured()) return { configured: false, reason: "missing_credentials" };

  const url = String(process.env.APP_PUBLIC_URL || "").replace(/\/$/, "") + "/api/webhooks/asaas";
  if (!url.startsWith("https://")) {
    console.warn("Asaas webhook não configurado: APP_PUBLIC_URL precisa usar HTTPS.");
    return { configured: false, reason: "invalid_public_url" };
  }

  const desired = {
    name: "Postal Balcao Checkout",
    url,
    email: APP_USER,
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken: String(process.env.ASAAS_WEBHOOK_TOKEN || ""),
    sendType: "SEQUENTIALLY",
    events: ["CHECKOUT_PAID","CHECKOUT_CANCELED","CHECKOUT_EXPIRED"]
  };

  try {
    const listed = await asaas.asaasFetch("/webhooks", { method: "GET" });
    const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.data) ? listed.data : []);
    const existing = rows.find(item => String(item.url || "") === url || String(item.name || "") === desired.name);

    if (existing?.id) {
      await asaas.asaasFetch("/webhooks/" + encodeURIComponent(existing.id), {
        method: "PUT",
        body: JSON.stringify(desired)
      });
      console.log("Asaas webhook de Checkout validado/atualizado.");
      return { configured: true, created: false, id: existing.id };
    }

    const created = await asaas.asaasFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify(desired)
    });
    console.log("Asaas webhook de Checkout criado.");
    return { configured: true, created: true, id: created?.id || null };
  } catch (error) {
    console.error("Falha ao configurar webhook Asaas:", error.status || "", error.message);
    return { configured: false, reason: "asaas_error", status: error.status || null };
  }
}

async function start() {
  await db.initDb();
  if(db.pool) await whiteLabelTenantDb.init(db.pool);
  await clientDb.initClientDb();
  await ensureBootstrapAdmin();
  await seedDefaultCatalog();
  const webhookState=await ensureAsaasCheckoutWebhook();
  paymentRuntime.webhookReady=Boolean(webhookState?.configured);
  paymentRuntime.environment=asaas.environmentInfo();
  paymentRuntime.lastError="";
  if (CONECTENVIO_MULTI_QUOTE_PROBE) {
    await probeConectEnviosMultiVolumeQuote();
  }

  if (asaas.configured()) {
    const envInfo = asaas.environmentInfo();
    console.log("ASAAS_ENVIRONMENT", envInfo.keyEnvironment, envInfo.urlEnvironment, envInfo.baseUrl);
  }

  let asaasPixReady=false;
  if (asaas.configured()) {
    try {
      const pixKey=await asaas.ensurePixKey({waitForActiveMs:60000});
      asaasPixReady=Boolean(pixKey.ok && String(pixKey.status||"").toUpperCase()==="ACTIVE");
      paymentRuntime.pixReady=asaasPixReady;
      console.log("ASAAS_PIX_KEY_READY", asaasPixReady ? "ACTIVE" : (pixKey.status || "PENDING"));
      console.log("ASAAS_PIX_KEY_SOURCE", pixKey.preferredMatched ? "PREFERRED_MATCHED" : "ACTIVE_ACCOUNT_KEY");
    } catch (error) {
      asaasPixReady=false;
      paymentRuntime.pixReady=false;
      paymentRuntime.lastError=asaas.providerErrorMessage(error.providerData,error.message);
      console.error("ASAAS_PIX_KEY_FAIL", error.status || "", paymentRuntime.lastError);
    }
  }
  const env=paymentRuntime.environment||{};
  paymentRuntime.operational=Boolean(
    asaas.configured() &&
    env.keyEnvironment==="production" &&
    env.urlEnvironment==="production" &&
    paymentRuntime.webhookReady &&
    paymentRuntime.pixReady
  );
  paymentRuntime.checkedAt=new Date().toISOString();
  console.log(
    "ASAAS_RUNTIME_READY",
    paymentRuntime.operational ? "YES" : "NO",
    "webhook="+paymentRuntime.webhookReady,
    "pix="+paymentRuntime.pixReady
  );

  try {
    const storeWallets=await db.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE active=TRUE)::int AS active_stores,
         COUNT(*) FILTER (WHERE active=TRUE AND COALESCE(asaas_wallet_id,'')='')::int AS active_stores_without_asaas_wallet
       FROM stores`
    );
    const ecommerce=await db.pool.query(
      `SELECT platform,status,COUNT(*)::int AS total
         FROM ecommerce_connections
        GROUP BY platform,status
        ORDER BY platform,status`
    );
    const sw=storeWallets.rows[0]||{};
    console.log("GO_LIVE_STORE_WALLETS","active="+Number(sw.active_stores||0),"missing="+Number(sw.active_stores_without_asaas_wallet||0));
    console.log("GO_LIVE_ECOMMERCE_CONNECTIONS",JSON.stringify(ecommerce.rows||[]));
  } catch (error) {
    console.error("GO_LIVE_DIAGNOSTICS_FAIL",error.message);
  }

  if (ASAAS_SELF_TEST_ON_BOOT && asaas.configured() && asaasPixReady) {
    try {
      const test=await asaas.selfTestCheckout();
      console.log("ASAAS_SELF_TEST_OK",test.status||"OK");
    } catch (error) {
      console.error("ASAAS_SELF_TEST_FAIL",error.status||"",asaas.providerErrorMessage(error.providerData,error.message));
    }
  } else if (ASAAS_SELF_TEST_ON_BOOT && asaas.configured() && !asaasPixReady) {
    console.warn("ASAAS_SELF_TEST_SKIPPED Pix key ainda não ativa.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Postal Balcao V1.9.0 disponivel na porta ${PORT}`);
    console.log(`ConectEnvios: ${TOKEN ? "configurada" : "modo demonstracao"}`);
    console.log(`Asaas: ${asaas.configured() ? "configurado" : "aguardando chave"}`);
    console.log(`Banco: ${process.env.DATABASE_URL ? "PostgreSQL configurado" : "nao configurado"}`);
  });

  setInterval(() => {
    processPendingAsaasEvents().catch(error => console.error("webhook worker error:", error.message));
  }, 10000).unref();

  setImmediate(() => {
    processPendingProviderPayments().catch(error => console.error("provider payment startup recovery error:", error.message));
  });

  setInterval(() => {
    processPendingProviderPayments().catch(error => console.error("provider payment worker error:", error.message));
  }, 5 * 60 * 1000).unref();

  setInterval(() => {
    processEcommerceSyncQueue().catch(error => console.error("ecommerce worker error:", error.message));
  }, 10 * 60 * 1000).unref();
}

start().catch(error => {
  console.error("Falha ao iniciar Postal Balcao:", error);
  process.exit(1);
});

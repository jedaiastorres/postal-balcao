"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

function keyFromSecret(secret) {
  if (!secret) throw new Error("Chave de criptografia não configurada.");
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptCredentials(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value || {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc","v1",iv.toString("base64url"),tag.toString("base64url"),encrypted.toString("base64url")].join(":");
}

function decryptCredentials(blob, secret) {
  const parts = String(blob || "").split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Credencial de integração inválida.");
  }
  const iv = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  const encrypted = Buffer.from(parts[4], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

function normalizeStoreUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("Informe o endereço da loja.");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("A loja precisa usar HTTPS para conexão segura.");
  if (url.username || url.password) throw new Error("Não informe usuário ou senha dentro da URL.");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function privateIpv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x))) return false;
  return p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] === 0;
}

function privateIpv6(ip) {
  const s = String(ip || "").toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80:");
}

async function assertPublicHttpsUrl(raw) {
  const normalized = normalizeStoreUrl(raw);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Endereço de loja não permitido.");
  }
  if (net.isIP(host)) {
    if ((net.isIP(host) === 4 && privateIpv4(host)) || (net.isIP(host) === 6 && privateIpv6(host))) {
      throw new Error("Endereço de loja privado não permitido.");
    }
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length) throw new Error("Não foi possível resolver o domínio da loja.");
    for (const item of addresses) {
      if ((item.family === 4 && privateIpv4(item.address)) || (item.family === 6 && privateIpv6(item.address))) {
        throw new Error("O domínio da loja aponta para uma rede privada e não pode ser conectado.");
      }
    }
  }
  return normalized;
}

async function safeFetch(rawUrl, options = {}) {
  let current = await assertPublicHttpsUrl(rawUrl);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(current, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeout || 30000)
    });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = await assertPublicHttpsUrl(new URL(location, current).toString());
  }
  throw new Error("A loja retornou redirecionamentos demais.");
}

function metaValue(order, keys) {
  const map = new Map((Array.isArray(order?.meta_data) ? order.meta_data : []).map(x => [String(x?.key || "").toLowerCase(), x?.value]));
  for (const key of keys) {
    const value = map.get(String(key).toLowerCase());
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function firstNonEmpty(...values) {
  return values.find(v => v != null && String(v).trim() !== "") ?? "";
}

function fullName(obj = {}) {
  return [obj.first_name, obj.last_name].filter(Boolean).join(" ").trim();
}

function normalizeWooOrder(order, sender = {}) {
  const shipping = order?.shipping && Object.values(order.shipping).some(Boolean) ? order.shipping : (order?.billing || {});
  const billing = order?.billing || {};
  const recipientDocument = firstNonEmpty(
    shipping.cpf, shipping.cnpj, billing.cpf, billing.cnpj,
    metaValue(order, ["_shipping_cpf","shipping_cpf","_billing_cpf","billing_cpf","cpf","_shipping_cnpj","shipping_cnpj","_billing_cnpj","billing_cnpj","cnpj"])
  );
  const recipientNumber = firstNonEmpty(
    shipping.number,
    metaValue(order, ["_shipping_number","shipping_number","_billing_number","billing_number","numero","number"])
  );
  const recipientNeighborhood = firstNonEmpty(
    shipping.neighborhood,
    metaValue(order, ["_shipping_neighborhood","shipping_neighborhood","_billing_neighborhood","billing_neighborhood","bairro","neighborhood"])
  );
  const items = (Array.isArray(order?.line_items) ? order.line_items : []).map(item => {
    const qty = Math.max(1, Number(item.quantity || 1));
    const subtotal = Number(item.subtotal ?? item.total ?? item.price ?? 0);
    const unitValue = Number(item.price ?? (Number.isFinite(subtotal) ? subtotal / qty : 0));
    return {
      description: String(item.name || item.sku || "Produto"),
      quantity: qty,
      value: Number.isFinite(unitValue) ? Math.max(0, unitValue) : 0,
      sku: String(item.sku || "")
    };
  });
  const declaredValue = items.reduce((sum, item) => sum + Number(item.value || 0) * Number(item.quantity || 1), 0);

  return {
    sender: sender || {},
    recipient: {
      name: fullName(shipping) || fullName(billing),
      document: recipientDocument,
      phone: firstNonEmpty(billing.phone, shipping.phone),
      email: firstNonEmpty(billing.email, shipping.email),
      cep: firstNonEmpty(shipping.postcode, billing.postcode),
      address: firstNonEmpty(shipping.address_1, billing.address_1),
      number: recipientNumber,
      neighborhood: recipientNeighborhood,
      complement: firstNonEmpty(shipping.address_2, billing.address_2),
      city: firstNonEmpty(shipping.city, billing.city),
      state: firstNonEmpty(shipping.state, billing.state)
    },
    package: {
      weightKg: 0,
      length: 0,
      width: 0,
      height: 0,
      declaredValue: Math.round((declaredValue + Number.EPSILON) * 100) / 100
    },
    items,
    invoiceNumber: firstNonEmpty(
      metaValue(order, ["nfe_chave","_nfe_chave","invoice_key","invoice_number","numero_nfe"]),
      ""
    ),
    source: {
      platform: "WOOCOMMERCE",
      orderId: String(order?.id || ""),
      orderNumber: String(order?.number || order?.id || ""),
      status: String(order?.status || ""),
      createdAt: order?.date_created_gmt || order?.date_created || null
    }
  };
}

async function fetchWooOrders({ storeUrl, consumerKey, consumerSecret, perPage = 100, status = "processing" }) {
  const base = await assertPublicHttpsUrl(storeUrl);
  const url = new URL(base + "/wp-json/wc/v3/orders");
  url.searchParams.set("status", status);
  url.searchParams.set("per_page", String(Math.max(1, Math.min(100, Number(perPage) || 100))));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  const auth = Buffer.from(String(consumerKey) + ":" + String(consumerSecret)).toString("base64");
  const response = await safeFetch(url.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json",
      "authorization": "Basic " + auth,
      "user-agent": "PostalBalcao/1.9 (WooCommerce connector)"
    },
    timeout: 30000
  });

  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const message = body?.message || body?.data?.message || ("WooCommerce respondeu HTTP " + response.status + ".");
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(body)) throw new Error("Resposta inesperada do WooCommerce.");
  return body;
}

function buildWooAuthorizationUrl({ storeUrl, connectionState, appPublicUrl }) {
  const base = normalizeStoreUrl(storeUrl);
  const publicUrl = String(appPublicUrl || "").replace(/\/$/, "");
  if (!publicUrl.startsWith("https://")) throw new Error("APP_PUBLIC_URL precisa usar HTTPS.");
  const url = new URL(base + "/wc-auth/v1/authorize");
  url.searchParams.set("app_name", "Postal Balcao");
  url.searchParams.set("scope", "read");
  url.searchParams.set("user_id", connectionState);
  url.searchParams.set("return_url", publicUrl + "/cliente?integration=woocommerce");
  url.searchParams.set("callback_url", publicUrl + "/api/integrations/woocommerce/callback");
  return url.toString();
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  normalizeStoreUrl,
  assertPublicHttpsUrl,
  normalizeWooOrder,
  fetchWooOrders,
  buildWooAuthorizationUrl
};

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


const NUVEMSHOP_API_BASE = "https://api.nuvemshop.com.br/v1";
const NUVEMSHOP_AUTH_BASE = "https://www.nuvemshop.com.br/apps";

function buildNuvemshopAuthorizationUrl({ appId, state }) {
  if(!String(appId||"").trim()) throw new Error("NUVEMSHOP_APP_ID não configurado.");
  const url=new URL(NUVEMSHOP_AUTH_BASE+"/"+encodeURIComponent(String(appId).trim())+"/authorize");
  url.searchParams.set("state",String(state||""));
  return url.toString();
}

async function exchangeNuvemshopCode({ appId, clientSecret, code }) {
  if(!appId||!clientSecret||!code) throw new Error("Credenciais OAuth Nuvemshop incompletas.");
  const response=await fetch("https://www.nuvemshop.com.br/apps/authorize/token",{
    method:"POST",
    headers:{"accept":"application/json","content-type":"application/json","user-agent":"PostalBalcao/1.9"},
    body:JSON.stringify({
      client_id:String(appId),
      client_secret:String(clientSecret),
      grant_type:"authorization_code",
      code:String(code)
    }),
    signal:AbortSignal.timeout(30000)
  });
  let body; try{body=await response.json();}catch{body=null;}
  if(!response.ok || !body?.access_token || !body?.user_id){
    const error=new Error(String(body?.message||body?.error_description||body?.error||"Nuvemshop recusou a autorização."));
    error.status=response.status; throw error;
  }
  return {
    accessToken:String(body.access_token),
    storeId:String(body.user_id),
    scope:String(body.scope||"")
  };
}

function normalizeNuvemshopOrder(order, sender = {}) {
  const shipping=firstObject(order?.shipping_address,order?.shipping);
  const customer=firstObject(order?.customer);
  const rawProducts=Array.isArray(order?.products)?order.products:[];
  const items=rawProducts.map(item=>{
    const qty=Math.max(1,Number(item.quantity||1));
    const unit=Number(item.price ?? item.price_customer ?? item.original_price ?? 0);
    return {
      description:String(item.name||item.variant_name||item.sku||"Produto"),
      quantity:qty,
      value:Number.isFinite(unit)?Math.max(0,unit):0,
      sku:String(item.sku||"")
    };
  });
  const declaredValue=items.reduce((sum,item)=>sum+Number(item.value||0)*Number(item.quantity||1),0);
  const phone=firstNonEmpty(shipping.phone,customer.phone,order.contact_phone,"");
  const email=firstNonEmpty(customer.email,order.contact_email,"");
  const name=firstNonEmpty(shipping.name,customer.name,[customer.first_name,customer.last_name].filter(Boolean).join(" "));
  const document=firstNonEmpty(shipping.identification,customer.identification,customer.document,order.customer_document,"");
  return {
    sender:sender||{},
    recipient:{
      name:String(name||""),
      document:String(document||""),
      phone:String(phone||""),
      email:String(email||""),
      cep:String(firstNonEmpty(shipping.zipcode,shipping.zip_code,shipping.postal_code,"")),
      address:String(firstNonEmpty(shipping.address,shipping.street,"")),
      number:String(firstNonEmpty(shipping.number,"")),
      neighborhood:String(firstNonEmpty(shipping.locality,shipping.neighborhood,"")),
      complement:String(firstNonEmpty(shipping.floor,shipping.complement,"")),
      city:String(firstNonEmpty(shipping.city,"")),
      state:String(firstNonEmpty(shipping.province,shipping.state,""))
    },
    package:{
      weightKg:Number(order.weight||0)||0,
      length:0,width:0,height:0,
      declaredValue:Math.round((declaredValue+Number.EPSILON)*100)/100
    },
    items,
    invoiceNumber:String(firstNonEmpty(order.invoice?.key,order.invoice_number,"")),
    source:{
      platform:"NUVEMSHOP",
      orderId:String(order.id||""),
      orderNumber:String(order.number||order.id||""),
      status:String(order.status||""),
      paymentStatus:String(order.payment_status||""),
      shippingStatus:String(order.shipping_status||""),
      createdAt:order.created_at||null
    }
  };
}

async function fetchNuvemshopOrders({ storeId, accessToken, appId, perPage=50 }) {
  if(!storeId||!accessToken) throw new Error("Conexão Nuvemshop incompleta.");
  const url=new URL(NUVEMSHOP_API_BASE+"/"+encodeURIComponent(String(storeId))+"/orders");
  url.searchParams.set("status","open");
  url.searchParams.set("per_page",String(Math.max(1,Math.min(100,Number(perPage)||50))));
  const response=await fetch(url.toString(),{
    method:"GET",
    headers:{
      "accept":"application/json",
      "content-type":"application/json",
      "authorization":"Bearer "+String(accessToken),
      "user-agent":"Postal Balcao ("+String(appId||"postal-balcao")+")"
    },
    signal:AbortSignal.timeout(30000)
  });
  let body; try{body=await response.json();}catch{body=null;}
  if(!response.ok){
    const error=new Error(String(body?.message||body?.description||body?.error||("Nuvemshop respondeu HTTP "+response.status+".")));
    error.status=response.status; throw error;
  }
  if(!Array.isArray(body)) throw new Error("Resposta inesperada da Nuvemshop.");
  return body.filter(order=>String(order?.payment_status||"").toLowerCase()==="paid" && String(order?.status||"").toLowerCase()!=="cancelled");
}

const LOJA_INTEGRADA_API_BASE = "https://api.awsli.com.br/v1";

function firstObject(...values) {
  return values.find(v => v && typeof v === "object" && !Array.isArray(v)) || {};
}

function normalizeLiMoney(value) {
  if (typeof value === "number") return value;
  const raw=String(value??"").trim().replace(/\s/g,"");
  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(raw)) return Number(raw.replace(/\./g,"").replace(",","."));
  if (/^\d+,\d+$/.test(raw)) return Number(raw.replace(",","."));
  const n=Number(raw.replace(/[^\d.-]/g,""));
  return Number.isFinite(n)?n:0;
}

function normalizeLojaIntegradaOrder(order, sender = {}) {
  const cliente=firstObject(order?.cliente, order?.customer);
  const endereco=firstObject(order?.endereco_entrega, order?.shipping_address, order?.endereco);
  const situacao=firstObject(order?.situacao);
  const rawItems=Array.isArray(order?.itens) ? order.itens : (Array.isArray(order?.items) ? order.items : []);
  const items=rawItems.map(item=>{
    const qty=Math.max(1,Number(item.quantidade ?? item.quantity ?? 1));
    const unit=normalizeLiMoney(item.preco_venda ?? item.preco ?? item.valor ?? item.price ?? 0);
    return {
      description:String(item.nome ?? item.name ?? item.sku ?? "Produto"),
      quantity:qty,
      value:Math.max(0,unit),
      sku:String(item.sku ?? item.codigo ?? "")
    };
  });

  const document=firstNonEmpty(
    cliente.cpf, cliente.cnpj, order.cliente_cpf, order.cliente_cnpj,
    endereco.cpf, endereco.cnpj
  );
  const recipientName=firstNonEmpty(
    endereco.nome, endereco.razao_social, order.endereco_entrega_razao_social,
    cliente.nome, cliente.razao_social,
    [cliente.nome,cliente.sobrenome].filter(Boolean).join(" ")
  );
  const approved=Boolean(situacao.aprovado ?? order.situacao_aprovado ?? order.aprovado);
  const canceled=Boolean(situacao.cancelado ?? order.situacao_cancelado ?? order.cancelado);
  const declaredValue=items.length
    ? items.reduce((sum,item)=>sum+Number(item.value||0)*Number(item.quantity||1),0)
    : normalizeLiMoney(order.valor_subtotal ?? order.subtotal ?? order.valor_total ?? 0);

  return {
    sender:sender||{},
    recipient:{
      name:String(recipientName||""),
      document:String(document||""),
      phone:String(firstNonEmpty(cliente.telefone_celular,cliente.telefone_principal,cliente.telefone,order.cliente_telefone,"")),
      email:String(firstNonEmpty(cliente.email,order.cliente_email,"")),
      cep:String(firstNonEmpty(endereco.cep,order.endereco_entrega_cep,"")),
      address:String(firstNonEmpty(endereco.endereco,endereco.logradouro,order.endereco_entrega_endereco,"")),
      number:String(firstNonEmpty(endereco.numero,order.endereco_entrega_numero,"")),
      neighborhood:String(firstNonEmpty(endereco.bairro,order.endereco_entrega_bairro,"")),
      complement:String(firstNonEmpty(endereco.complemento,order.endereco_entrega_complemento,"")),
      city:String(firstNonEmpty(endereco.cidade?.nome,endereco.cidade,order.endereco_entrega_cidade,"")),
      state:String(firstNonEmpty(endereco.estado?.sigla,endereco.estado,order.endereco_entrega_estado,""))
    },
    package:{
      weightKg:Number(order.peso_real ?? order.peso ?? 0)||0,
      length:0,width:0,height:0,
      declaredValue:Math.round((declaredValue+Number.EPSILON)*100)/100
    },
    items,
    invoiceNumber:String(firstNonEmpty(order.nota_fiscal?.chave,order.nfe_chave,order.chave_nfe,"")),
    source:{
      platform:"LOJA_INTEGRADA",
      orderId:String(order.id ?? order.numero ?? ""),
      orderNumber:String(order.numero ?? order.id ?? ""),
      status:String(situacao.nome ?? order.situacao_nome ?? order.status ?? ""),
      approved,canceled,
      createdAt:order.data_criacao ?? order.created_at ?? null
    }
  };
}

async function fetchLojaIntegradaOrders({ personalToken, limit = 50 }) {
  const url=new URL(LOJA_INTEGRADA_API_BASE+"/pedido");
  url.searchParams.set("limit",String(Math.max(1,Math.min(100,Number(limit)||50))));
  const response=await safeFetch(url.toString(),{
    method:"GET",
    headers:{
      "accept":"application/json",
      "authorization":"Basic "+String(personalToken||"").trim(),
      "user-agent":"PostalBalcao/1.9 (Loja Integrada connector)"
    },
    timeout:30000
  });
  let body;
  try{body=await response.json();}catch{body=null;}
  if(!response.ok){
    const msg=body?.message||body?.error||body?.detail||("Loja Integrada respondeu HTTP "+response.status+".");
    const error=new Error(String(msg)); error.status=response.status; throw error;
  }
  const rows=Array.isArray(body)?body:(Array.isArray(body?.objects)?body.objects:(Array.isArray(body?.data)?body.data:[]));
  if(!Array.isArray(rows)) throw new Error("Resposta inesperada da Loja Integrada.");
  return rows;
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
  buildWooAuthorizationUrl,
  normalizeLojaIntegradaOrder,
  fetchLojaIntegradaOrders,
  buildNuvemshopAuthorizationUrl,
  exchangeNuvemshopCode,
  normalizeNuvemshopOrder,
  fetchNuvemshopOrders
};

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const connector = require("../ecommerce_connectors");

test("Shopify exige domínio myshopify.com sem URL de terceiros",()=>{
  assert.equal(connector.normalizeShopifyShop("Minha-Loja.myshopify.com"),"minha-loja.myshopify.com");
  assert.equal(connector.normalizeShopifyShop("https://minha-loja.myshopify.com/"),"minha-loja.myshopify.com");
  for(const bad of ["http://minha-loja.myshopify.com","localhost","127.0.0.1","outra.com",
    "https://minha-loja.myshopify.com/admin", "https://minha-loja.myshopify.com@evil.com",
    "minha-loja.myshopify.com.evil.com","-errada.myshopify.com"]){
    assert.throws(()=>connector.normalizeShopifyShop(bad),/loja|Shopify|domínio/i,bad);
  }
});

test("URL de autorização Shopify solicita apenas leitura de pedidos com nonce",()=>{
  const url=new URL(connector.buildShopifyAuthorizationUrl({
    shop:"minha-loja.myshopify.com",clientId:"clientid",state:"nonce-aleatorio",
    redirectUri:"https://postal.example.com/api/integrations/shopify/callback"
  }));
  assert.equal(url.origin,"https://minha-loja.myshopify.com");
  assert.equal(url.pathname,"/admin/oauth/authorize");
  assert.equal(url.searchParams.get("scope"),"read_orders");
  assert.equal(url.searchParams.get("state"),"nonce-aleatorio");
  assert.throws(()=>connector.buildShopifyAuthorizationUrl({shop:"loja.myshopify.com",clientId:"abc",state:"foo",redirectUri:"http://localhost:3000/callback"}),/HTTPS/);
});

test("Shopify rejeita alteração de HMAC ou parâmetros de callback",()=>{
  const secret="um-segredo-do-aplicativo";
  const params={shop:"loja.myshopify.com",state:"nonce",code:"code1",timestamp:"150000"};
  const message=Object.keys(params).sort().map(key=>key+"="+params[key]).join("&");
  const hmac=crypto.createHmac("sha256",secret).update(message).digest("hex");
  assert.equal(connector.verifyShopifyCallbackHmac({...params,hmac},secret),true);
  assert.equal(connector.verifyShopifyCallbackHmac({...params,shop:"outra.myshopify.com",hmac},secret),false);
  assert.equal(connector.verifyShopifyCallbackHmac({...params,hmac:"badauth"},secret),false);
  assert.equal(connector.verifyShopifyCallbackHmac({...params,code:["a","b"],hmac},secret),false);
});

test("Shopify normaliza pedido pago para pré-postagem, sem inventar CPF, número ou medidas",()=>{
  const normalized=connector.normalizeShopifyOrder({
    id:"gid://shopify/Order/99",name:"#1099",createdAt:"2026-11-19T10:00:00Z",
    displayFinancialStatus:"PAID",displayFulfillmentStatus:"UNFULFILLED",email:"cliente@example.com",
    shippingAddress:{name:"Maria Oliveira",address1:"Rua A",address2:"Casa",zip:"68515000",
      city:"Parauapebas",provinceCode:"PA",phone:"94999990000"},
    subtotalPriceSet:{shopMoney:{amount:"89.90"}},
    lineItems:{edges:[{node:{name:"Brinde",sku:"S001",quantity:2,originalUnitPriceSet:{shopMoney:{amount:"45.00"}}}}]}
  },{name:"Loja Postal"});
  assert.equal(normalized.recipient.name,"Maria Oliveira");
  assert.equal(normalized.recipient.document,"");
  assert.equal(normalized.recipient.number,"");
  assert.equal(normalized.package.weightKg,0);
  assert.equal(normalized.package.declaredValue,89.90);
  assert.equal(normalized.source.orderId,"gid://shopify/Order/99");
  assert.equal(normalized.items[0].quantity,2);
});

test("Shopify troca código por token renovável e renova antes de expirar",async t=>{
  const originalFetch=global.fetch;
  const calls=[];
  global.fetch=async (url,options)=>{
    calls.push({url,options});
    return {ok:true,status:200,json:async()=>({
      access_token:"shpat_access",refresh_token:"shprt_refresh",expires_in:3600,
      refresh_token_expires_in:7776000,scope:"read_orders"
    })};
  };
  t.after(()=>{global.fetch=originalFetch;});
  const common={shop:"loja.myshopify.com",clientId:"client",clientSecret:"secret"};
  const authorized=await connector.exchangeShopifyCode({...common,code:"oauth_code"});
  assert.equal(authorized.accessToken,"shpat_access");
  assert.ok(new Date(authorized.expiresAt).getTime()>Date.now());
  assert.match(calls[0].options.body,/expiring=1/);
  assert.match(calls[0].options.body,/code=oauth_code/);
  await connector.refreshShopifyToken({...common,refreshToken:"rotating"});
  assert.match(calls[1].options.body,/grant_type=refresh_token/);
  assert.match(calls[1].options.body,/refresh_token=rotating/);
  assert.equal(calls[1].url,"https://loja.myshopify.com/admin/oauth/access_token");
});

test("Shopify busca páginas sem importar pedidos cancelados, não pagos ou já enviados",async t=>{
  const originalFetch=global.fetch;
  const cursors=[];
  global.fetch=async (url,options)=>{
    assert.equal(url,"https://loja.myshopify.com/admin/api/2026-10/graphql.json");
    assert.equal(options.headers["x-shopify-access-token"],"token");
    const body=JSON.parse(options.body);
    assert.match(body.query,/financial_status:paid fulfillment_status:unfulfilled/);
    cursors.push(body.variables.cursor);
    return {ok:true,status:200,json:async()=>({data:{orders:{
      edges:body.variables.cursor ? [
        {node:{id:"2",displayFinancialStatus:"PAID",displayFulfillmentStatus:"FULFILLED"}},
        {node:{id:"3",displayFinancialStatus:"PAID",displayFulfillmentStatus:"UNFULFILLED"}}
      ] : [
        {node:{id:"1",displayFinancialStatus:"PAID",displayFulfillmentStatus:"UNFULFILLED"}},
        {node:{id:"4",displayFinancialStatus:"PENDING",displayFulfillmentStatus:"UNFULFILLED"}}
      ],pageInfo:{hasNextPage:!body.variables.cursor,endCursor:"next"}}}})};
  };
  t.after(()=>{global.fetch=originalFetch;});
  const orders=await connector.fetchShopifyOrders({shop:"loja.myshopify.com",accessToken:"token"});
  assert.deepEqual(orders.map(x=>x.id),["1","3"]);
  assert.deepEqual(cursors,[null,"next"]);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const mapper = require("../provider_service_mapping");

const quotes = [
  { postal_company_id: 2, company_name:"Jadlog", code:"2", postal_service_name:"Jadlog Package", service_name:"Package" },
  { postal_company_id: 4, company_name:"Loggi", code:"FREIGHT_TYPE_ECONOMIC", postal_service_name:"LOGGI ECONÔMICO", service_name:"Econômico" },
  { postal_company_id: 4, company_name:"Loggi", code:"FREIGHT_TYPE_EXPRESS", postal_service_name:"LOGGI EXPRESSO", service_name:"Expresso" }
];

test("serviço do carrinho usa nome canônico retornado pela cotação, não código técnico",()=>{
  assert.equal(mapper.canonicalServiceName(quotes[1]), "LOGGI ECONÔMICO");
  assert.equal(mapper.resolveServiceNameFromQuote(quotes, {
    postalCompanyId:4,serviceName:"LOGGI ECONÔMICO",carrierName:"Loggi",serviceCode:"FREIGHT_TYPE_ECONOMIC"
  }),"LOGGI ECONÔMICO");
});
test("envio legado encontra serviço mesmo quando nome no pedido é parcial",()=>{
  assert.equal(mapper.resolveServiceNameFromQuote(quotes, {
    postalCompanyId:4,serviceName:"Loggi Econômico",carrierName:"Loggi",serviceCode:""
  }),"LOGGI ECONÔMICO");
  assert.equal(mapper.resolveServiceNameFromQuote(quotes, {
    postalCompanyId:4,serviceName:"Econômico",carrierName:"Loggi",serviceCode:"FREIGHT_TYPE_ECONOMIC"
  }),"LOGGI ECONÔMICO");
});
test("não cruza serviços de transportadoras distintas, nem retorna código isolado",()=>{
  assert.equal(mapper.resolveServiceNameFromQuote(quotes,{postalCompanyId:2,serviceName:"Econômico",carrierName:"Loggi"}),"");
  assert.equal(mapper.resolveServiceNameFromQuote([{postal_company_id:4,code:"FREIGHT_TYPE_ECONOMIC"}],{
    postalCompanyId:4,serviceName:"Loggi Econômico",serviceCode:"FREIGHT_TYPE_ECONOMIC"
  }),"");
});
test("mantém o valor real da declaração e o carrinho reutiliza pedido pago",()=>{
  const server=fs.readFileSync(require.resolve("../server"),"utf8");
  assert.match(server,/providerServiceMapping\.canonicalServiceName\(item\)/);
  assert.match(server,/postalServiceName: String\(option\.providerServiceName \|\| option\.produto \|\| ""\)/);
  assert.match(server,/providerServiceMapping\.resolveServiceNameFromQuote\(rawOptions/);
  assert.match(server,/value: round2\(Number\(item\.value \|\| 0\)\)/);
  assert.match(server,/if \(order\.conect_cart_id\)/);
  assert.match(server,/if \(order\.conect_package_id\)/);
  assert.doesNotMatch(server,/postal_service_name: String\(packageData\.serviceCode/);
});

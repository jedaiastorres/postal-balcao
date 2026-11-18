"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const postal = require("./postal_regional");
const {publicQuoteResponse}=require("./public_quote");

test("19 municípios regionais aceitam acentos e grafia sem acento",()=>{
  assert.equal(postal.cities.length,19);
  for(const name of postal.cities){
    assert.equal(postal.coveredRoute({city:"Parauapebas",uf:"PA"},{city:name,uf:"PA"})?.destinationCity,name);
  }
  assert.equal(postal.coveredRoute({city:"SAPUCIA",uf:"PA"},{city:"Redenção",uf:"PA"}),null);
  assert.equal(postal.coveredRoute({city:"AGUA AZUL DO NORTE",uf:"PA"},{city:"TUCUMA",uf:"PA"})?.destinationCity,"Tucumã");
});

test("não oferta para trecho de origem externa ou estado diferente",()=>{
  assert.equal(postal.coveredRoute({city:"São Paulo",uf:"SP"},{city:"Redenção",uf:"PA"}),null);
  assert.equal(postal.coveredRoute({city:"Redenção",uf:"PA"},{city:"Redenção",uf:"SC"}),null);
  assert.equal(postal.parseLocation({data:{city:"Pau D'Arco",state:"Pará"}})?.uf,"PA");
  assert.equal(postal.parseLocation({data:{localidade:"Xinguara",uf:"PA"}})?.city,"Xinguara");
  assert.deepEqual(postal.parseLocation({data:{city_title:"Canaã dos Carajás",state_abbreviation:"PA"}}),{city:"Canaã dos Carajás",uf:"PA"});
});

test("tarifa regional igual à menor cotação final e prazo igual ao mais rápido",()=>{
  const route={originCity:"Parauapebas",destinationCity:"Xinguara"};
  const source=[
    {precoVenda:28,prazoEntrega:5,comissaoParceiro:4},
    {precoVenda:36,prazoEntrega:2,comissaoParceiro:6}
  ];
  const option=postal.regionalOption(source,route,{hubTransferTotal:5});
  assert.equal(option.precoVenda,33);
  assert.equal(option.prazoEntrega,2);
  assert.equal(option.postalMargin,29);
  assert.equal(option.recommended,true);
  assert.equal(option.prazoEstimado,true);
  assert.equal(postal.regionalOption([{precoVenda:15,prazoEntrega:0}],route),null);
  assert.equal(postal.regionalOption(source,null),null);
});

test("pacotes operacionais e cidade do pedido são verificados antes da emissão",()=>{
  assert.equal(postal.matchesCity("São Félix do Xingu/PA","São Félix do Xingu"),true);
  assert.equal(postal.matchesCity("Rio Maria","São Félix do Xingu"),false);
  assert.equal(postal.eligibleVolumes([{weightGrams:1000,width:20,height:15,length:20}]),true);
  assert.equal(postal.eligibleVolumes([{weightGrams:31000,width:20,height:15,length:20}]),false);
  assert.equal(postal.eligibleVolumes([{weightGrams:1000,width:80,height:80,length:80}]),false);
});

test("vitrine pública não aplica transferência duas vezes ao preço já equiparado da Postal",()=>{
  const partners=[{transportadora:"Transportadora A",produto:"Expresso",precoVenda:24,prazoEntrega:4,comissaoParceiro:4}];
  const own=postal.regionalOption(partners,{originCity:"Xinguara",destinationCity:"Redenção"},{hubTransferTotal:5});
  const response=publicQuoteResponse([own,...partners],{
    volumes:[{weightGrams:1000}],cepFrom:"68555000",cepTo:"68552000",hubTransferTotal:5
  });
  assert.equal(response.options[0].price,29);
  assert.equal(response.options[1].price,29);
  assert.equal(response.options[0].recommended,true);
  assert.equal(response.options[0].estimatedDeadline,true);
});

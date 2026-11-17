const test=require('node:test');
const assert=require('node:assert/strict');
const fiscal=require('../fiscal_lookup');
let prefix='35'+'2611'+'12345678000195'+'55'+'001'+'000000001'+'1'+'00000000';
let sum=0,w=2;for(let i=42;i>=0;i--){sum+=Number(prefix[i])*w;w=w===9?2:w+1;}const rest=sum%11;
const key=prefix+(rest<2?0:11-rest);
const xml=`<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${key}"><ide><mod>55</mod></ide><emit><xNome>Empresa &amp; Teste</xNome><CNPJ>12345678000195</CNPJ><enderEmit><CEP>68515000</CEP><xMun>Parauapebas</xMun><UF>PA</UF></enderEmit></emit><dest><xNome>Cliente Teste</xNome><CPF>12345678909</CPF><enderDest><CEP>01001000</CEP><xMun>São Paulo</xMun><UF>SP</UF></enderDest></dest><det nItem="1"><prod><xProd>Produto</xProd><qCom>2</qCom><vUnCom>10.50</vUnCom></prod></det><total><ICMSTot><vNF>21.00</vNF></ICMSTot></total><transp><vol><qVol>2</qVol><pesoB>1.5</pesoB></vol><vol><qVol>1</qVol><pesoB>2</pesoB></vol></transp></infNFe></NFe></nfeProc>`;
const response=payload=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});
test('Consulta DANFE adapter validates key, fixed endpoint and XML content',async()=>{
 const doc=await fiscal.consultDanfe(key,{fetchImpl:async(url,options)=>{
  assert.equal(url,'https://consultadanfe.com/api/v1/consulta');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body),{chave:key});assert.equal(options.headers.Authorization,undefined);
  return response({status:'ok',chave:key,tipo:'nfe',xml_base64:Buffer.from(xml).toString('base64')});
 }});
 assert.equal(doc.sender.document,'12345678000195');assert.equal(doc.sender.name,'Empresa & Teste');assert.equal(doc.recipient.cep,'01001000');
 assert.equal(doc.volumeCount,3);assert.equal(doc.grossWeightKg,3.5);assert.equal(doc.items[0].value,10.5);assert.equal(doc.declaredValue,21);
});
test('rejects wrong check digit and DC-e before transmitting a key',async()=>{
 for(const value of [key.slice(0,-1)+((Number(key.at(-1))+1)%10),'1'.repeat(44),'']){
  await assert.rejects(fiscal.consultDanfe(value,{fetchImpl:()=>{throw Error('must not fetch');}}),error=>error.status===400);
 }
});
test('rejects unsafe XML, mismatched keys and unstructured provider responses',async()=>{
 assert.throws(()=>fiscal.parseNfe('<!DOCTYPE nfe [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+xml,key));
 assert.throws(()=>fiscal.parseNfe(xml.replace(key,'0'.repeat(44)),key));
 assert.throws(()=>fiscal.parseNfe(xml.slice(0,-15),key));
 await assert.rejects(fiscal.consultDanfe(key,{fetchImpl:async()=>response({status:'ok',chave:'other',tipo:'nfe'})}));
 await assert.rejects(fiscal.consultDanfe(key,{fetchImpl:async()=>new Response('<html/>',{headers:{'content-type':'text/html'}})}));
});
test('handles provider limits, missing documents and date restrictions without automatic retry',async()=>{
 for(const status of [429,404,422]){
  let requests=0;
  await assert.rejects(fiscal.consultDanfe(key,{fetchImpl:async()=>{requests++;return new Response('',{status});}}),err=>err.status===status);
  assert.equal(requests,1);
 }
});

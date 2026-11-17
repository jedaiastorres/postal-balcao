"use strict";
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const ENDPOINT = "https://consultadanfe.com/api/v1/consulta";
const fail = (message, status = 502) => Object.assign(new Error(message), {status});
function validateKey(key) {
  if (!/^\d{44}$/.test(key) || key.slice(20,22) !== '55') throw fail('Informe uma chave numérica de NF-e (modelo 55) com 44 dígitos.',400);
  let sum=0, weight=2;
  for(let i=42;i>=0;i--){sum+=Number(key[i])*weight;weight=weight===9?2:weight+1;}
  const rest=sum%11, dv=rest<2?0:11-rest;
  if(dv!==Number(key[43])) throw fail('Dígito verificador da chave de NF-e inválido.',400);
  return key;
}
function parseNfe(xml, key) {
  if(typeof xml !== 'string' || Buffer.byteLength(xml)>3000000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('XML fiscal inválido ou maior que 3 MB.');
  if(XMLValidator.validate(xml)!==true) throw fail('XML fiscal malformado.');
  const parsed=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,processEntities:true}).parse(xml);
  const info=(parsed.nfeProc?.NFe||parsed.NFe)?.infNFe;
  if(!info || info['@_Id']!=='NFe'+key || String(info.ide?.mod)!=='55') throw fail('O XML recebido não corresponde à NF-e solicitada.');
  const party=(node,address)=>{
    const p=node||{},a=p[address]||{};
    return {name:p.xNome||'',document:p.CNPJ||p.CPF||'',phone:a.fone||p.fone||'',email:p.email||'',cep:a.CEP||'',address:a.xLgr||'',number:a.nro||'',neighborhood:a.xBairro||'',complement:a.xCpl||'',city:[a.xMun,a.UF].filter(Boolean).join('/')};
  };
  const list=value=>value==null?[]:Array.isArray(value)?value:[value];
  const volumes=list(info.transp?.vol);
  return {type:'NFE',key,sender:party(info.emit,'enderEmit'),recipient:party(info.dest,'enderDest'),
    items:list(info.det).slice(0,200).map(item=>({description:item.prod?.xProd||'',quantity:Number(item.prod?.qCom||1),value:Number(item.prod?.vUnCom||0)})),
    declaredValue:Number(info.total?.ICMSTot?.vNF||0),volumeCount:volumes.reduce((n,v)=>n+Number(v.qVol||0),0)||null,
    grossWeightKg:volumes.reduce((n,v)=>n+Number(v.pesoB||0),0)||null};
}
async function limitedText(response,max=8500000) {
  if(Number(response.headers.get('content-length'))>max) throw fail('Resposta fiscal excedeu o tamanho permitido.');
  let size=0;const parts=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>max)throw fail('Resposta fiscal excedeu o tamanho permitido.');parts.push(Buffer.from(chunk));}
  return Buffer.concat(parts).toString('utf8');
}
const recentRequests=[];
async function consultDanfe(key,{fetchImpl=fetch}={}) {
  validateKey(key);
  const now=Date.now();
  while(recentRequests.length && recentRequests[0]<now-60000)recentRequests.shift();
  if(recentRequests.length>=30)throw fail('Limite local de consultas atingido. Aguarde um minuto ou importe o XML.',429);
  recentRequests.push(now);
  const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({chave:key}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(response.status===429) throw fail('Limite do Consulta DANFE atingido. Aguarde antes de tentar novamente ou importe o XML.',429);
  if(response.status===404) throw fail('NF-e não encontrada. Confira a chave ou importe o XML.',404);
  if([400,422].includes(response.status)) throw fail('Consulta DANFE não aceitou a chave ou a data da nota. A API gratuita tem janela de datas; importe o XML.',422);
  if(!response.ok) throw fail('Consulta DANFE indisponível. Importe o XML ou tente mais tarde.');
  if(!String(response.headers.get('content-type')).includes('application/json'))throw fail('Resposta fiscal não estruturada.');
  const payload=JSON.parse(await limitedText(response));
  if(payload.status!=='ok' || payload.chave!==key || payload.tipo!=='nfe' || typeof payload.xml_base64!=='string')throw fail('Consulta DANFE retornou dados incompatíveis.');
  const xml=Buffer.from(payload.xml_base64,'base64').toString('utf8');
  return parseNfe(xml,key);
}
module.exports={consultDanfe,parseNfe,validateKey};

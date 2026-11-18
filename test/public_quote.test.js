const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {validatePublicQuote,publicQuoteResponse,makeVisitorLimiter}=require("../public_quote");

const parseVolumes=body=>body.volumes.map((item,index)=>({
  index:index+1,
  weightGrams:Math.round(Number(item.peso)*1000),
  width:Number(item.largura),height:Number(item.altura),length:Number(item.comprimento),
  declaredValue:Number(item.vlDeclarado)
}));
const volume={peso:1,largura:15,altura:10,comprimento:20,vlDeclarado:100};
const request={cepOrigem:"68515-000",cepDestino:"01310-100",volumes:[volume]};

test("public quotation validates CEP, parcels and operational size limits",()=>{
  const input=validatePublicQuote(request,parseVolumes);
  assert.equal(input.cepFrom,"68515000");
  assert.equal(input.cepTo,"01310100");
  assert.equal(input.totalWeightGrams,1000);
  assert.throws(()=>validatePublicQuote({...request,cepDestino:"12"},parseVolumes),/CEPs/);
  assert.throws(()=>validatePublicQuote({...request,volumes:[volume,volume,volume,volume]},parseVolumes),/3 volumes/);
  assert.throws(()=>validatePublicQuote({...request,volumes:[{...volume,peso:31}]},parseVolumes),/30 kg/);
  assert.throws(()=>validatePublicQuote({...request,volumes:[{...volume,comprimento:190}]},parseVolumes),/medidas/);
  assert.throws(()=>validatePublicQuote({...request,volumes:[{...volume,vlDeclarado:60000}]},parseVolumes),/medidas/);
});

test("public quotation never reveals internal prices, commissions, token or partner account",()=>{
  const response=publicQuoteResponse([{transportadora:"Azul Cargo",produto:"E-commerce",prazoEntrega:3,
    precoVenda:36.85,providerCost:20,postalMargin:10,comissaoParceiro:6,selectionToken:"private-token"}],
    {...validatePublicQuote(request,parseVolumes),hubTransferTotal:5,demo:false});
  assert.equal(response.options[0].price,41.85);
  assert.equal(response.options[0].carrier,"Azul Cargo");
  for(const confidential of ["providerCost","postalMargin","comissaoParceiro","selectionToken","hubTransferTotal"]){
    assert.equal(JSON.stringify(response).includes(confidential),false,confidential);
  }
});

test("visitor limiter applies rolling window and daily quota independently",()=>{
  const check=makeVisitorLimiter({windowMs:1000,windowLimit:2,dayLimit:3});
  assert.deepEqual(check("a",1000),{ok:true});
  assert.deepEqual(check("a",1001),{ok:true});
  assert.deepEqual(check("a",1002),{ok:false,retryAfter:1});
  assert.deepEqual(check("b",1002),{ok:true});
  assert.deepEqual(check("a",2000),{ok:true});
  assert.equal(check("a",2001).ok,false);
  assert.deepEqual(check("a",86402000),{ok:true});
});

test("public quote page is reachable without login and does not expose purchase controls",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const page=fs.readFileSync(path.join(__dirname,"../public/cotacao.html"),"utf8");
  const login=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
  assert.ok(server.indexOf('app.post("/api/public/cotacao"')<server.indexOf('app.use("/api", (req, res, next)'));
  assert.match(login, /href="\/cotacao"[^>]*>Calcular frete sem cadastro/);
  assert.match(page, /\/cotacao\.js/);
  assert.match(page, /<script src="\/branding\.js" defer><\/script>/);
  assert.ok(page.indexOf('/branding.js')<page.indexOf('/cotacao.js'));
  assert.doesNotMatch(page, /<script(?![^>]*src=)/);
  const client=fs.readFileSync(path.join(__dirname,"../public/cotacao.js"),"utf8");
  assert.match(client,/key==="peso"\?"0\.01":"1"/);
  assert.match(client,/PostalBrand\?\.carrierLogo\(option\.carrier\)/);
  assert.match(client,/"Menor preço"/);
  assert.match(client,/"Mais rápido"/);
  assert.match(client,/logo\.addEventListener\("error"/);
});

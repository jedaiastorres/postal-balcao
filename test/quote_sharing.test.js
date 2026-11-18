const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const {createRequire}=require("node:module");
const {randomUUID}=require("node:crypto");
const {PGlite}=require("@electric-sql/pglite");
const {buildPublicQuote}=require("../public_quotes");
const {maskName,publicParty,publicRoute,publicPackage}=require("../public_tracking_privacy");
const {sanitizePoint,isPublishablePoint}=require("../public_points");

function load(file,overrides){
  const filename=path.resolve(__dirname,"..",file),module={exports:{}};
  const local=createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,"utf8"),{
    module,exports:module.exports,require:name=>overrides[name]||local(name),
    process:{env:{DATABASE_URL:"postgresql://test-only"}},console,Buffer
  },{filename});
  return module.exports;
}

function selection(price,carrier,service,overrides={}){
  return {
    postalCompanyId:1,carrierName:carrier,service,salePrice:price,providerCost:price/2,
    postalMargin:price/2,partnerCommission:0,deadline:4,demo:false,
    package:{
      cepFrom:"68515000",cepTo:"01310100",providerCepFrom:"68515000",
      volumeCount:1,weightGrams:1000,declaredValue:100,width:20,height:10,length:30,
      volumes:[{index:1,weightGrams:1000,width:20,height:10,length:30,declaredValue:100}],
      serviceCode:service
    },...overrides
  };
}

test("shared quotes only contain signed public offer fields and reject mixed shipments",()=>{
  const quote=buildPublicQuote([
    selection(69.9,"Azul Cargo","Standard"),
    {...selection(44.5,"Jadlog","Expresso"),postalCompanyId:2}
  ],Date.parse("2026-11-18T00:00:00Z"));
  assert.equal(quote.options[0].price,44.5);
  assert.equal(quote.options[0].carrier,"Jadlog");
  assert.equal(quote.expiresAt,"2026-11-19T00:00:00.000Z");
  const serialized=JSON.stringify(quote);
  assert.ok(!serialized.includes("providerCost"));
  assert.ok(!serialized.includes("postalMargin"));
  assert.ok(!serialized.includes("partnerCommission"));
  assert.ok(!serialized.includes("selectionToken"));
  assert.throws(()=>buildPublicQuote([selection(10,"A","1"),
    selection(20,"A","2",{package:{...selection(20,"A","2").package,cepTo:"22041001"}})]),/mesma cotação/);
  assert.throws(()=>buildPublicQuote([selection(-1,"A","1")]),/inválido/);
  assert.throws(()=>buildPublicQuote([selection(10,"A","1"),selection(10,"A","1")]),/repita/);
});

test("public tracking hides street, postal code and declared value",()=>{
  assert.equal(maskName("Rafael Fernandes"),"R*** F***");
  const p=publicParty({name:"Rafael Fernandes",address:"Rua Secreta",number:"123",cep:"68515000",city:"Parauapebas"});
  assert.equal(p.address,undefined);
  assert.equal(p.cep,"");
  assert.equal(p.city,"Parauapebas");
  assert.equal(publicRoute({city:"Parauapebas",cep:"68515000"}).cep,"");
  const packageData=publicPackage({volumeCount:1,declaredValue:1500,volumes:[{index:1,weightKg:1,declaredValue:1500}]});
  assert.equal(packageData.declaredValue,null);
  assert.equal(packageData.volumes[0].declaredValue,null);
});

test("public point locator omits internal financial and referral fields",()=>{
  const point=sanitizePoint({
    name:"Postal Centro",code:"P-1",
    asaas_wallet_id:"secret",commission_percent:20,referral_code:"private",pickup_enabled:true,
    address:{city:"Parauapebas",cep:"68515000",address:"Avenida Central",number:"123",privateNote:"não publicar"},
    latitude:-6.07,longitude:-49.9
  });
  assert.equal(point.address.city,"Parauapebas");
  assert.equal(point.pickupEnabled,true);
  assert.equal(point.latitude,-6.07);
  const serialized=JSON.stringify(point);
  for(const forbidden of ["secret","commission_percent","referral_code","privateNote"]){
    assert.ok(!serialized.includes(forbidden),forbidden);
  }
});

test("public point locator hides test records and incomplete addresses without deleting them",()=>{
  assert.equal(isPublishablePoint(sanitizePoint({name:"TESTE",address:{cep:"68515000"}})),false);
  assert.equal(isPublishablePoint(sanitizePoint({name:"Ponto Teste Centro",address:{address:"Rua A",city:"Parauapebas",uf:"PA"}})),false);
  assert.equal(isPublishablePoint(sanitizePoint({name:"Postal Centro",address:{city:"Parauapebas",uf:"PA",cep:"68515000"}})),false);
  assert.equal(isPublishablePoint(sanitizePoint({name:"Postal Centro",address:{address:"Rua A",city:"Parauapebas",uf:"PA"}})),true);
});

test("PostgreSQL shared links use hashed tokens, expire and do not touch the wallet",async()=>{
  const pg=new PGlite();await pg.waitReady;
  const pool={query:async(sql,params)=>{
    const r=params?.length?await pg.query(sql,params):(await pg.exec(sql)).at(-1);
    return {...r,rowCount:r.affectedRows??r.rows?.length??0};
  }};
  pool.connect=async()=>({...pool,release(){}});
  const core=load("db.js",{pg:{Pool:function(){return pool;}}});
  const client=load("client_db.js",{"./db":core});
  try{
    await core.initDb();await client.initClientDb();await client.initClientDb();
    const owner=randomUUID();
    await pool.query(
      "INSERT INTO app_users(id,email,name,password_hash,role,active) VALUES($1,'share@test.local','Cliente','hash','CLIENT',TRUE)",
      [owner]
    );
    await client.createCustomerAccount({userId:owner});
    const quote=buildPublicQuote([selection(69.9,"Azul Cargo","Standard")]);
    const token=await client.createQuoteShare(owner,quote);
    assert.match(token,/^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(JSON.parse(JSON.stringify((await client.getQuoteShare(token)).quote_data)),quote);
    assert.equal(await client.getQuoteShare("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),null);
    assert.equal((await pool.query("SELECT token_hash FROM quote_shares")).rows[0].token_hash.includes(token),false);
    assert.equal(Number((await client.getWallet(owner)).balance),0);
    await pool.query("UPDATE quote_shares SET expires_at=NOW()-INTERVAL '1 minute'");
    assert.equal(await client.getQuoteShare(token),null);
  }finally{await pg.close();}
});

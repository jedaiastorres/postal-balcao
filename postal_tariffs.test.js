const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const crypto=require("node:crypto");
const {createRequire}=require("node:module");
const {PGlite}=require("@electric-sql/pglite");
const regional=require("./postal_regional");
const ops=require("./postal_operations");

test("tarifa administrada pela Postal cobre falta de cotação; custos reais separados",async()=>{
 const pg=new PGlite();await pg.waitReady;
 const client={query:async(sql,args)=>args?.length?pg.query(sql,args):(await pg.exec(sql)).at(-1)};
 const filename=path.resolve(__dirname,"db.js"),local=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,"utf8"),{
   module,exports:module.exports,require:name=>name==="pg"?{Pool:function(){return client;}}:local(name),
   process:{env:{DATABASE_URL:"postgresql://test"}},console
 },{filename});
 const db=module.exports;
 try{
  await db.initDb();
  const clientFile=path.resolve(__dirname,"client_db.js"),clientModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(clientFile,"utf8"),{
    module:clientModule,exports:clientModule.exports,require:name=>name==="./db"?db:createRequire(clientFile)(name),
    process:{env:{DATABASE_URL:"postgresql://test"}},console,Buffer
  },{filename:clientFile});
  await clientModule.exports.initClientDb();
  const admin=crypto.randomUUID();
  await client.query("INSERT INTO app_users(id,email,name,password_hash,role) VALUES($1,'admin@postal.local','Admin','hash','ADMIN')",[admin]);
  const tariff=await db.savePostalTariff({originCity:"Parauapebas",destinationCity:"Canaã dos Carajás",price:18.5,
    deadlineDays:2,estimatedOperatingCost:7,active:true,userId:admin});
  assert.equal(Number(tariff.price),18.5);
  const fetched=await db.getPostalTariff("Parauapebas","Canaã dos Carajás");
  const offered=regional.tariffOption({originCity:"Parauapebas",destinationCity:"Canaã dos Carajás"},fetched,{volumeCount:2,commissionRate:0.2});
  assert.equal(offered.precoVenda,37);assert.equal(offered.comissaoParceiro,7.4);assert.equal(offered.prazoEntrega,2);

  const store=crypto.randomUUID(),order=crypto.randomUUID();
  await client.query("INSERT INTO stores(id,code,name) VALUES($1,'P01','Ponto')",[store]);
  await client.query(`INSERT INTO freight_orders(id,store_id,partner_email,status,payment_method,payment_status,
    sale_price,postal_revenue_total,point_revenue_total,partner_commission,postal_margin,provider_cost,sender,recipient,items,package_data,deadline,package_count)
    VALUES($1,$2,'admin@postal.local','LABEL_AVAILABLE','PIX','PAID',37,29.6,7.4,7.4,29.6,0,
    '{"city":"Parauapebas"}','{"city":"Canaã dos Carajás"}','[]',
    '{"carrierMode":"POSTAL_OWN","ownRoute":{"originCity":"Parauapebas","destinationCity":"Canaã dos Carajás"}}',2,2)`,[order,store]);
  const costs=await db.addPostalOperatingCost({orderId:order,description:"Combustível",amount:8.6,actorUserId:admin,idempotencyKey:crypto.randomUUID()});
  assert.equal(Number(costs.amount),8.6);
  const rows=(await client.query(ops.dispatchSql(false))).rows;
  const report=ops.summarizeDispatch(rows);
  assert.equal(report.shipments[0].costType,"REGISTRADO");assert.equal(report.shipments[0].contribution,21);
  await db.savePostalTariff({originCity:"Parauapebas",destinationCity:"Canaã dos Carajás",price:18.5,
    deadlineDays:2,estimatedOperatingCost:7,active:false,userId:admin});
  assert.equal(await db.getPostalTariff("Parauapebas","Canaã dos Carajás"),null);
 }finally{await pg.close();}
});

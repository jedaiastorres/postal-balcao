const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const {createRequire}=require("node:module");
const {randomUUID}=require("node:crypto");
const {PGlite}=require("@electric-sql/pglite");
const custody=require("../custody");

function loadDatabase(pool){
  const filename=path.resolve(__dirname,"../db.js"),module={exports:{}};
  const native=createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,"utf8"),{
    module,exports:module.exports,require:name=>name==="pg"?{Pool:function(){return pool;}}:native(name),
    process:{env:{DATABASE_URL:"postgresql://isolated-test"}},console,Buffer
  },{filename});
  return module.exports;
}
const key=()=>randomUUID();

test("custody stages refuse skipped movements, duplicate events and delivery without recipient",()=>{
  const received={code:"BR123456789",stage:"RECEIVED_POINT",idempotencyKey:key()};
  assert.equal(custody.validateScan(received).stage,"RECEIVED_POINT");
  assert.throws(()=>custody.validateScan({...received,stage:"OUT_FOR_DELIVERY"}),/primeiro/);
  assert.throws(()=>custody.validateScan({...received,stage:"RECEIVED_POINT"},"RECEIVED_POINT"),/sequência/);
  assert.throws(()=>custody.validateScan({...received,stage:"DELIVERY_RECORDED"},"OUT_FOR_DELIVERY"),/nome/);
  assert.equal(custody.validateScan({...received,stage:"DELIVERY_RECORDED",recipientName:"Kelly"},"OUT_FOR_DELIVERY").proofName,"Kelly");
  assert.throws(()=>custody.validateScan({...received,code:"not a code"}),/rastreio/);
});

test("PostgreSQL: transfer requires destination, only its unit can receive, and Postal delivery earns once",async()=>{
  const pg=new PGlite();await pg.waitReady;
  const pool={query:async(sql,params)=>{
    const result=params?.length?await pg.query(sql,params):(await pg.exec(sql)).at(-1);
    return {...result,rowCount:result.affectedRows??result.rows?.length??0};
  }};
  pool.connect=async()=>({...pool,release(){}});
  const db=loadDatabase(pool);
  const clientFilename=path.resolve(__dirname,"../client_db.js"),clientModule={exports:{}};
  const clientRequire=createRequire(clientFilename);
  vm.runInNewContext(fs.readFileSync(clientFilename,"utf8"),{
    module:clientModule,exports:clientModule.exports,
    require:name=>name==="./db"?db:clientRequire(name),
    process:{env:{DATABASE_URL:"postgresql://isolated-test"}},console,Buffer
  },{filename:clientFilename});
  try{
    await db.initDb();
    await clientModule.exports.initClientDb();
    const storeA=key(),storeB=key(),actorA=key(),actorB=key(),order=key(),other=key();
    await pool.query("INSERT INTO stores(id,code,name,unit_type) VALUES($1,'A','Ponto A','POINT'),($2,'B','Hub B','HUB')",[storeA,storeB]);
    await pool.query("INSERT INTO app_users(id,store_id,email,name,password_hash,role) VALUES($1,$2,'first@test.local','Origem','hash','OPS'),($3,$4,'last@test.local','Destino','hash','OPS')",[actorA,storeA,actorB,storeB]);
    for(const [id,payment,code] of [[order,"PAID","BR123456789"],[other,"PENDING","BR987654321"]]){
      await pool.query(`INSERT INTO freight_orders(id,store_id,partner_email,status,payment_method,payment_status,sale_price,partner_commission,postal_margin,provider_cost,sender,recipient,items,package_data,tracking_code,is_simulation)
         VALUES($1,$2,'scanner@test.local','LABEL_AVAILABLE','PIX',$3,50,0,10,40,'{}','{}','[]',$4,$5,FALSE)`,
        [id,storeA,payment,JSON.stringify({carrierMode:"POSTAL_OWN"}),code]);
    }
    const base={orderId:order,trackingCode:"BR123456789",actorUserId:actorA,actorStoreId:storeA,idempotencyKey:key(),proofName:""};
    await assert.rejects(db.recordCustodyScan({...base,stage:"TRANSFERRED",destinationStoreId:storeB}),e=>e.status===409);
    const first=await db.recordCustodyScan({...base,stage:"RECEIVED_POINT"});
    const retry=await db.recordCustodyScan({...base,stage:"RECEIVED_POINT"});
    assert.equal(first.replayed,false);
    assert.equal(retry.replayed,true);
    assert.equal(retry.scan.id,first.scan.id);
    await assert.rejects(db.recordCustodyScan({...base,stage:"TRANSFERRED",idempotencyKey:key()}),e=>e.status===400);
    await assert.rejects(db.recordCustodyScan({...base,stage:"TRANSFERRED",destinationStoreId:storeA,idempotencyKey:key()}),e=>e.status===400);
    await assert.rejects(db.recordCustodyScan({...base,orderId:other,trackingCode:"BR987654321",stage:"RECEIVED_POINT",idempotencyKey:key()}),e=>e.status===409);
    const transfer=await db.recordCustodyScan({...base,stage:"TRANSFERRED",destinationStoreId:storeB,idempotencyKey:key()});
    assert.equal(transfer.scan.proof.destinationStoreId,storeB);
    await assert.rejects(db.recordCustodyScan({...base,stage:"RECEIVED_HUB",idempotencyKey:key()}),e=>e.status===403);
    const next={...base,actorUserId:actorB,actorStoreId:storeB};
    await db.recordCustodyScan({...next,stage:"RECEIVED_HUB",idempotencyKey:key()});
    await db.recordCustodyScan({...next,stage:"OUT_FOR_DELIVERY",idempotencyKey:key()});
    const final=await db.recordCustodyScan({...next,stage:"DELIVERY_RECORDED",proofName:"Cliente Teste",idempotencyKey:key(),deliveryEarning:3});
    assert.equal(final.replayed,false);
    const repeat=await db.recordCustodyScan({...next,stage:"DELIVERY_RECORDED",proofName:"Cliente Teste",idempotencyKey:final.scan.idempotency_key,deliveryEarning:3});
    assert.equal(repeat.replayed,true);
    const rewards=(await pool.query("SELECT store_id,earning_type,amount,reference_id FROM point_earnings")).rows;
    assert.equal(rewards.length,1);
    assert.equal(rewards[0].store_id,storeB);
    assert.equal(rewards[0].earning_type,"DELIVERY");
    assert.equal(Number(rewards[0].amount),3);
    assert.equal(rewards[0].reference_id,"BR123456789");
    assert.equal((await db.listCustodyScans(order,"BR123456789")).length,5);
    assert.equal((await pool.query("SELECT payment_status FROM freight_orders WHERE id=$1",[order])).rows[0].payment_status,"PAID");
  }finally{await pg.close();}
});

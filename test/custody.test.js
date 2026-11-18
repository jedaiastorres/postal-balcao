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

test("PostgreSQL custody ledger is scoped to paid real orders and retries are idempotent",async()=>{
  const pg=new PGlite();await pg.waitReady;
  const pool={query:async(sql,params)=>{
    const result=params?.length?await pg.query(sql,params):(await pg.exec(sql)).at(-1);
    return {...result,rowCount:result.affectedRows??result.rows?.length??0};
  }};
  pool.connect=async()=>({...pool,release(){}});
  const db=loadDatabase(pool);
  try{
    await db.initDb();
    const actor=key(),order=key(),other=key();
    await pool.query("INSERT INTO app_users(id,email,name,password_hash,role) VALUES($1,'scanner@test.local','Operador','hash','OPS')",[actor]);
    for(const [id,paid,sim] of [[order,"PAID",false],[other,"PENDING",false]]){
      await pool.query(`INSERT INTO freight_orders(id,partner_email,status,payment_method,payment_status,sale_price,partner_commission,postal_margin,provider_cost,sender,recipient,items,package_data,tracking_code,is_simulation)
        VALUES($1,'scanner@test.local','LABEL_AVAILABLE','PIX',$2,50,0,10,40,'{}','{}','[]','{}',$3,$4)`,
        [id,paid,id===order?"BR123456789":"BR987654321",sim]);
    }
    const data={orderId:order,trackingCode:"BR123456789",stage:"RECEIVED_POINT",actorUserId:actor,actorStoreId:null,idempotencyKey:key(),proofName:""};
    await assert.rejects(db.recordCustodyScan({...data,stage:"TRANSFERRED"}),e=>e.status===409);
    const first=await db.recordCustodyScan(data);
    assert.equal(first.replayed,false);
    const retry=await db.recordCustodyScan(data);
    assert.equal(retry.replayed,true);
    assert.equal(retry.scan.id,first.scan.id);
    await assert.rejects(db.recordCustodyScan({...data,stage:"TRANSFERRED"}),e=>e.status===409);
    await assert.rejects(db.recordCustodyScan({...data,orderId:other,trackingCode:"BR987654321",idempotencyKey:key()}),e=>e.status===409);
    await db.recordCustodyScan({...data,stage:"TRANSFERRED",idempotencyKey:key()});
    const history=await db.listCustodyScans(order,"BR123456789");
    assert.equal(history.length,2);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS total FROM order_events WHERE order_id=$1",[order])).rows[0].total,2);
    assert.equal((await pool.query("SELECT sale_price,payment_status FROM freight_orders WHERE id=$1",[order])).rows[0].payment_status,"PAID");
  }finally{await pg.close();}
});

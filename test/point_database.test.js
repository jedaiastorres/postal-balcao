const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const{createRequire}=require('node:module');const{randomUUID}=require('node:crypto');const{PGlite}=require('@electric-sql/pglite');
function load(file,overrides){const filename=path.resolve(__dirname,'..',file),module={exports:{}};const local=createRequire(filename);const context={module,exports:module.exports,require:name=>overrides[name]||local(name),process:{env:{DATABASE_URL:'postgresql://test-only'}},console,Buffer};vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});return module.exports;}
test('PostgreSQL: customer isolation, atomic registration, collection idempotency and financial transitions',async t=>{
 const pg=new PGlite();await pg.waitReady;
 const pool={query:async(sql,params)=>{const r=params?.length?await pg.query(sql,params):(await pg.exec(sql)).at(-1);return {...r,rowCount:r.affectedRows??r.rows?.length??0};}};
 pool.connect=async()=>({...pool,release(){}});
 const core=load('db.js',{pg:{Pool:function(){return pool;}}});const client=load('client_db.js',{'./db':core});
 try{
  await core.initDb();await client.initClientDb();await client.initClientDb();
  const store=randomUUID(),otherStore=randomUUID(),owner=randomUUID();
  await pool.query("INSERT INTO stores(id,code,name,active,pickup_enabled) VALUES($1,'A','Ponto A',TRUE,TRUE),($2,'B','Ponto B',TRUE,TRUE)",[store,otherStore]);
  await t.test('public quote locates the same point by origin CEP even without a CEP mask',async()=>{
   await pool.query("UPDATE stores SET address=$1,commission_percent=17.5 WHERE id=$2",[JSON.stringify({cep:'68515-000'}),store]);
   await pool.query("UPDATE stores SET address=$1,commission_percent=20 WHERE id=$2",[JSON.stringify({cep:'68515-999'}),otherStore]);
   const matched=await core.findStoreForQuoteOrigin('68515-000');
   assert.equal(matched.id,store);
   assert.equal(Number(matched.commission_percent),17.5);
   assert.equal(matched.quote_origin_cep,null);
  });
  await pool.query("INSERT INTO app_users(id,email,name,password_hash,role,active,store_id) VALUES($1,'owner@test.local','Dono','hash','STORE_OWNER',TRUE,$2)",[owner,store]);
  let customer;
  await t.test('registration does not move funds and stays scoped to the referring store',async()=>{
   customer=await client.registerPointClient({storeId:store,email:'client@test.local',name:'Cliente',passwordHash:'original',document:'12345678909',phone:'11988887777'});
   const a=await client.getCustomerAccount(customer.id);assert.equal(Number(a.wallet_balance),0);assert.equal(a.referral_store_id,store);
   const foreign=await client.listClientsByStore(otherStore);assert.equal(foreign.length,0);
   const own=await client.listClientsByStore(store);assert.equal(own.length,1);assert.equal(own[0].wallet_balance,undefined);assert.equal(own[0].password_hash,undefined);
   assert.equal((await pool.query('SELECT * FROM point_earnings')).rows.length,0);
  });
  await t.test('duplicate email cannot replace password, role or referral',async()=>{
   await assert.rejects(client.registerPointClient({storeId:otherStore,email:'client@test.local',name:'Outro',passwordHash:'replaced',document:'',phone:''}),e=>e.code==='23505');
   const u=await pool.query('SELECT * FROM app_users WHERE id=$1',[customer.id]);assert.equal(u.rows[0].password_hash,'original');assert.equal(u.rows[0].role,'CLIENT');
   assert.equal((await client.getCustomerAccount(customer.id)).referral_store_id,store);
   await assert.rejects(client.registerPointClient({storeId:store,email:'rollback@test.local',name:'Rollback',passwordHash:'hash',defaultSender:{invalid:1n}}));
   assert.equal((await pool.query("SELECT * FROM app_users WHERE email='rollback@test.local'")).rows.length,0);
  });
  const request={clientUserId:customer.id,serviceType:'PICKUP',status:'ASSIGNED',packageCount:2,feePerPackage:5,totalFee:10,assignedStoreId:store,pointRate:3,pointCompensation:6,postalCompensation:4,createdByUserId:owner,requestKey:randomUUID()};
  let manual;
  await t.test('retrying manual creation does not duplicate the request',async()=>{
   manual=await client.createCollectionRequest(request);const repeated=await client.createCollectionRequest(request);assert.equal(manual.id,repeated.id);
   assert.equal((await pool.query('SELECT * FROM collection_requests')).rows.length,1);
  });
  const user={role:'STORE_CLERK',storeId:store};
  const transition=(id,status,actor=user,extra={})=>client.transitionCollection({collectionId:id,status,user:actor,pickupRate:3,dropoffRate:2,...extra});
  await t.test('cross-store updates and skipped stages are rejected',async()=>{
   await assert.rejects(transition(manual.id,'ACCEPTED',{role:'STORE_CLERK',storeId:otherStore}),e=>e.status===403);
   await assert.rejects(transition(manual.id,'COLLECTED'),e=>e.status===409);
   assert.equal((await client.getCollection(manual.id)).status,'ASSIGNED');
  });
  await t.test('completed manual pickup produces no unpaid earnings or wallet movements',async()=>{
   await transition(manual.id,'ACCEPTED');await transition(manual.id,'COLLECTED');await transition(manual.id,'COLLECTED');
   assert.equal((await pool.query('SELECT * FROM point_earnings')).rows.length,0);
   assert.equal((await pool.query('SELECT * FROM wallet_transactions')).rows.length,0);
   await assert.rejects(transition(manual.id,'COMPLETED',{role:'ADMIN'},{assignedStoreId:otherStore}),e=>e.status===409);
  });
  await t.test('confirmed collection earns once; simulation never generates real earnings',async()=>{
   for(const simulated of [false,true]){
    const order=randomUUID();
    await pool.query(`INSERT INTO freight_orders(id,partner_email,status,payment_status,sender,recipient,package_data,items,first_mile_type,first_mile_fee,is_simulation,payment_method,sale_price,partner_commission,postal_margin,provider_cost) VALUES($1,'client@test.local','SHIPMENT_CREATED','PAID','{}','{}','{}','[]','PICKUP',10,$2,'SALDO',20,0,0,20)`,[order,simulated]);
    const c=await client.createCollectionRequest({...request,freightOrderId:order,requestKey:randomUUID()});
    await assert.rejects(transition(c.id,'CANCELED'),e=>e.status===409);
    assert.equal((await client.getCollection(c.id)).status,'ASSIGNED');
    await transition(c.id,'ACCEPTED');await transition(c.id,'COLLECTED');await transition(c.id,'COLLECTED');await transition(c.id,'COMPLETED');
    const earnings=(await pool.query('SELECT * FROM point_earnings WHERE reference_id=$1',[c.id])).rows;
    assert.equal(earnings.length,1);assert.equal(earnings[0].status,simulated?'SIMULATED':'EARNED');assert.equal(Number(earnings[0].amount),6);
   }
  });
 }finally{await pg.close();}
});

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');const {PGlite}=require('@electric-sql/pglite');const {reset,clearTables}=require('../scripts/operational-reset');
function load(file,overrides){const filename=path.resolve(__dirname,'..',file),module={exports:{}};const local=createRequire(filename);vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:name=>overrides[name]||local(name),process:{env:{DATABASE_URL:'postgresql://test'}},console,Buffer},{filename});return module.exports;}
test('operational reset is scoped, encrypted, transactional and repeat-safe',async t=>{
 const pg=new PGlite();await pg.waitReady;
 const client={query:async(sql,args)=>args?.length?pg.query(sql,args):(await pg.exec(sql)).at(-1)};
 const core=load('db.js',{pg:{Pool:function(){return client;}}}),accounts=load('client_db.js',{'./db':core});
 try{
  await core.initDb();await accounts.initClientDb();
  const master=crypto.randomUUID(),other=crypto.randomUUID(),store=crypto.randomUUID(),order=crypto.randomUUID();
  await client.query("INSERT INTO stores(id,code,name) VALUES($1,'TEST','Teste')",[store]);
  await client.query("INSERT INTO app_users(id,email,name,password_hash,role,store_id) VALUES($1,'master@test.local','Master','preserved-hash','ADMIN',NULL),($2,'other@test.local','Other','other-hash','CLIENT',$3)",[master,other,store]);
  await client.query("INSERT INTO customer_accounts(user_id,wallet_balance,referral_store_id) VALUES($1,100,$2)",[other,store]);
  await client.query("INSERT INTO wallet_transactions(id,user_id,transaction_type,amount,status,description) VALUES($1,$2,'TOPUP',100,'POSTED','Teste')",[crypto.randomUUID(),other]);
  await client.query("INSERT INTO freight_orders(id,store_id,partner_email,status,payment_method,payment_status,payment_amount,sale_price,partner_commission,postal_margin,provider_cost,sender,recipient,items,package_data) VALUES($1,$2,'other@test.local','SHIPMENT_CREATED','PIX','PAID',40,40,2,3,35,'{}','{}','[]','{}')",[order,store]);
  const options={email:'master@test.local',runId:crypto.randomUUID(),backupKey:crypto.randomBytes(32).toString('hex')};
  await t.test('dry run counts real payment and balance without deleting records',async()=>{
   const data=await reset(client,options);assert.equal(data.counts.app_users,2);assert.equal(data.financial.real_paid_orders,1);assert.equal(Number(data.financial.wallets),100);assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM app_users')).rows[0].n,2);
  });
  await t.test('wrong master or missing archive key cannot authorize deletion',async()=>{
   await assert.rejects(reset(client,{...options,email:'other@test.local',apply:true}));await assert.rejects(reset(client,{...options,backupKey:'',apply:true}));
   assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM app_users')).rows[0].n,2);
  });
  await t.test('reset preserves master credentials and removes operational balances and history',async()=>{
   const result=await reset(client,{...options,apply:true});assert.equal(result.applied,true);assert.equal(result.after.app_users,1);for(const name of clearTables)assert.equal(result.after[name],0,name);
   const users=(await client.query('SELECT * FROM app_users')).rows;assert.equal(users[0].id,master);assert.equal(users[0].password_hash,'preserved-hash');assert.equal(users[0].role,'ADMIN');
   const snapshot=(await client.query('SELECT * FROM postal_reset_archive.snapshots')).rows[0];const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(options.backupKey,'hex'),Buffer.from(snapshot.iv));decipher.setAuthTag(Buffer.from(snapshot.tag));const backup=JSON.parse(Buffer.concat([decipher.update(Buffer.from(snapshot.ciphertext)),decipher.final()]));assert.equal(backup.tables.freight_orders.length,1);assert.equal(backup.tables.app_users.length,2);assert.equal(Number(backup.tables.customer_accounts[0].wallet_balance),100);
  });
  await t.test('repeating the same reset does not erase newly created data',async()=>{
   await client.query("INSERT INTO stores(id,code,name) VALUES($1,'NEW','Novo')",[crypto.randomUUID()]);const result=await reset(client,{...options,apply:true});assert.equal(result.alreadyApplied,true);assert.equal(result.counts.stores,1);
  });
  await t.test('unexpected public tables block a new reset',async()=>{
   await client.query('CREATE TABLE unrelated_data(id INT)');await assert.rejects(reset(client,{...options,runId:crypto.randomUUID(),apply:true}));assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM stores')).rows[0].n,1);
  });
 }finally{await pg.close();}
});

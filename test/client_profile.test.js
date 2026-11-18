const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const {createRequire}=require("node:module");
const {randomUUID}=require("node:crypto");
const {PGlite}=require("@electric-sql/pglite");

function load(file,overrides){
  const filename=path.resolve(__dirname,"..",file),module={exports:{}};
  const local=createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,"utf8"),{
    module,exports:module.exports,require:name=>overrides[name]||local(name),
    process:{env:{DATABASE_URL:"postgresql://test-only"}},console,Buffer
  },{filename});
  return module.exports;
}

test("customer profile and address book are tenant-isolated without wallet mutations",async()=>{
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
    const ids=[randomUUID(),randomUUID()];
    for(let index=0;index<ids.length;index++){
      const id=ids[index];
      await pool.query(
        "INSERT INTO app_users(id,email,name,password_hash,role,active) VALUES($1,$2,$3,'hash','CLIENT',TRUE)",
        [id,"client"+index+"@test.local","Cliente "+index]
      );
      await client.createCustomerAccount({userId:id,document:"12345678909",phone:"11988887777"});
    }
    const address={name:"Pessoa",document:"12345678909",phone:"11988887777",cep:"68515000",address:"Rua Principal",number:"10",neighborhood:"Centro",city:"Parauapebas/PA"};
    const saved=await client.createCustomerAddress(ids[0],{kind:"SENDER",label:"Matriz",address});
    assert.equal((await client.listCustomerAddresses(ids[0])).length,1);
    assert.equal((await client.listCustomerAddresses(ids[1])).length,0);
    assert.equal(await client.deleteCustomerAddress(ids[1],saved.id),false);
    assert.equal((await client.listCustomerAddresses(ids[0])).length,1);
    await client.updateCustomerProfile(ids[0],{phone:"11999998888",companyName:"Postal",defaultSender:address});
    const profile=await client.getCustomerAccount(ids[0]);
    assert.equal(profile.phone,"11999998888");
    assert.equal(profile.default_sender.city,"Parauapebas/PA");
    assert.equal(Number(profile.wallet_balance),0);
    assert.equal((await pool.query("SELECT * FROM wallet_transactions")).rows.length,0);
    assert.equal(await client.deleteCustomerAddress(ids[0],saved.id),true);
    assert.equal((await client.listCustomerAddresses(ids[0])).length,0);
  }finally{await pg.close();}
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const server=fs.readFileSync(require.resolve('../server'),'utf8');
const dbSource=fs.readFileSync(require.resolve('../db'),'utf8');
const clientDbSource=fs.readFileSync(require.resolve('../client_db'),'utf8');
const part=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
const normalize=value=>JSON.parse(JSON.stringify(value));

test('somente ADMIN tem escopo global; supervisor e cada ponto usam a unidade da sessão',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(part(server,'function scopeForUser','function inventoryOwner'),ctx);
  assert.deepEqual(normalize(ctx.scopeForUser({role:'ADMIN'})),{});
  assert.deepEqual(normalize(ctx.scopeForUser({role:'SUPERVISOR',storeId:'unidade-a'})),{storeId:'unidade-a'});
  assert.deepEqual(normalize(ctx.scopeForUser({role:'STORE_OWNER',storeId:'unidade-b'})),{storeId:'unidade-b'});
  assert.deepEqual(normalize(ctx.scopeForUser({role:'OPS'})),{storeId:'00000000-0000-0000-0000-000000000000'});
  assert.equal(ctx.reportStoreForUser({role:'ADMIN'},''),'');
  assert.equal(ctx.reportStoreForUser({role:'SUPERVISOR',storeId:'unidade-a'},''),'unidade-a');
  assert.equal(ctx.reportStoreForUser({role:'STORE_OWNER',storeId:'unidade-b'},'unidade-b'),'unidade-b');
  assert.throws(()=>ctx.reportStoreForUser({role:'SUPERVISOR',storeId:'unidade-a'},'unidade-b'),error=>error.status===403);
  assert.throws(()=>ctx.reportStoreForUser({role:'STORE_OWNER',storeId:'unidade-b'},''+'unidade-a'),error=>error.status===403);
  assert.throws(()=>ctx.reportStoreForUser({role:'SUPERVISOR'},''),error=>error.status===403);
});

test('contas sem unidade e sessões revogadas são impedidas antes das rotas',async()=>{
  const records=[
    {active:true,role:'SUPERVISOR',store_id:null,email:'sup@postal.test'},
    {active:true,role:'STORE_OWNER',store_id:null,email:'point@postal.test'},
    {active:true,role:'SUPERVISOR',store_id:'unidade-b',email:'sup@postal.test'},
    {active:true,role:'SUPERVISOR',store_id:'unidade-a',email:'old@postal.test'}
  ];
  for(const record of records){
    const req={user:{userId:'u',role:record.role,storeId:record.store_id==='unidade-b'?'unidade-a':record.store_id,email:record.role==='SUPERVISOR'?'sup@postal.test':'point@postal.test'}};
    let forwarded=false,status=0;
    const ctx=vm.createContext({db:{getUserById:async()=>record,getStore:async()=>({active:true})}});
    vm.runInContext(part(server,'async function requireCurrentUser','function requireIntegrationAuth'),ctx);
    await ctx.requireCurrentUser(req,{status(n){status=n;return this;},json(){return this;}},()=>{forwarded=true;});
    assert.equal(forwarded,false);
    assert.equal(status,403);
  }
});

test('identificadores do provedor são buscados com filtro da unidade, sem fallback global',async()=>{
  const captured=[];
  const ctx=vm.createContext({requireDb:()=>({query:async(sql,params)=>{
    captured.push({sql,params});
    return {rows:params.includes('unidade-a')?[{id:'pedido-a',store_id:'unidade-a'}]:[]};
  }})});
  vm.runInContext(part(dbSource,'async function findOrderByProviderReference','async function setCheckout'),ctx);
  const owned=await ctx.findOrderByProviderReference('package','package-001',{storeId:'unidade-a'});
  assert.equal(owned.id,'pedido-a');
  assert.match(captured.at(-1).sql,/f\.store_id=\$2/);
  assert.deepEqual(normalize(captured.at(-1).params),['package-001','unidade-a']);
  const foreign=await ctx.findOrderByProviderReference('package','package-001',{storeId:'unidade-b'});
  assert.equal(foreign,null);
  assert.equal(await ctx.findOrderByProviderReference('cart','cart-001',{}),null);
  assert.equal(await ctx.findOrderByProviderReference('document','https://a.tld/label',{storeId:'unidade-b'}),null);
  assert.match(captured.at(-1).sql,/label_a4_url/);
  assert.match(captured.at(-1).sql,/labelA6Url/);
  assert.equal(await ctx.findOrderByProviderReference('wrong','package-001',{global:true}),null);
});

test('supervisor de uma unidade não pode redirecionar coletas de outro ponto',async()=>{
  let updated=false,rolledBack=false;
  const conn={
    async query(sql){
      if(sql.startsWith('SELECT * FROM collection_requests'))return {rows:[{id:'coleta-b',assigned_store_id:'unidade-b',status:'ASSIGNED'}]};
      if(sql.startsWith('UPDATE'))updated=true;
      if(sql==='ROLLBACK')rolledBack=true;
      return {rows:[]};
    },release(){}
  };
  const ctx=vm.createContext({database:()=>({connect:async()=>conn}),pointRules:{assert(ok,msg,status){if(!ok)throw Object.assign(new Error(msg),{status});}}});
  vm.runInContext(part(clientDbSource,'async function transitionCollection','async function createCustomerAccount'),ctx);
  await assert.rejects(ctx.transitionCollection({collectionId:'coleta-b',user:{role:'SUPERVISOR',storeId:'unidade-a'},status:'ACCEPTED'}),error=>error.status===403);
  assert.equal(updated,false);
  assert.equal(rolledBack,true);
});

test('endpoints mestres e acesso aos documentos do provedor exigem autorização explícita',()=>{
  for(const path of ['/api/admin/overview','/api/admin/stores','/api/admin/users','/api/admin/collections']){
    assert.match(server,new RegExp(`app\\.get\\("${path}", requireAuth, requireRole\\("ADMIN"\\)`));
  }
  for(const path of ['/api/carrinhos/:id','/api/envios/:id','/api/rastreio/id/:id','/api/rastreio/codigo/:stamp']){
    const pos=server.indexOf(`app.get("${path}"`);
    assert.ok(pos>0,path);
    assert.match(server.slice(pos,pos+425),/canReadProviderReference\(req/);
  }
  assert.match(server,/app\.post\("\/api\/documento-proxy"[\s\S]*?canReadProviderReference\(req,"document",documentUrl\.href\)/);
  assert.match(server,/const scoped=req\.user\.role!=="ADMIN";/);
});

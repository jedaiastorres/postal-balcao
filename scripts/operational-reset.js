"use strict";
const crypto=require('node:crypto');
const expectedScope={project:'c81472ed-1eb0-4ef9-890d-291f3621d971',environment:'c275bd66-38a7-4b28-a6dd-c844b3170642',service:'ba5581ad-014e-42bb-b5a3-65082906aa49'};
// Reference product definitions stay available; only operational/customer data is cleared.
const referenceTables=['catalog_items','credit_partners','credit_products'];
const clearTables=['payment_webhook_events','order_events','order_addons','point_earnings','collection_requests','ecommerce_orders','ecommerce_connections','wallet_transactions','wallet_topups','customer_accounts','credit_proposals','inventory_movements','partner_inventory','freight_orders','partner_accounts','audit_logs','stores'];
const allTables=[...clearTables,...referenceTables,'app_users'];
function check(condition,message){if(!condition)throw Error(message);}
async function counts(client){
 const result={};for(const table of allTables){const r=await client.query(`SELECT COUNT(*)::int AS count FROM public.${table}`);result[table]=Number(r.rows[0].count);}return result;
}
async function getMaster(client,email){
 check(typeof email==='string'&&email.includes('@'),'APP_USER não identifica o master.');
 const r=await client.query("SELECT id,email,role,active FROM app_users WHERE LOWER(email)=LOWER($1)",[email]);
 check(r.rows.length===1&&r.rows[0].role==='ADMIN'&&r.rows[0].active,'Master não encontrado ou perfil inválido; nenhuma exclusão permitida.');
 return r.rows[0];
}
async function inspect(client,email){
 const master=await getMaster(client,email);
 const roles=await client.query('SELECT role,COUNT(*)::int AS count FROM app_users GROUP BY role ORDER BY role');
 const financial=await client.query(`SELECT
  (SELECT COALESCE(SUM(wallet_balance),0) FROM customer_accounts) AS wallets,
  (SELECT COUNT(*) FROM freight_orders WHERE payment_status='PAID' AND is_simulation=FALSE)::int AS real_paid_orders,
  (SELECT COALESCE(SUM(payment_amount),0) FROM freight_orders WHERE payment_status='PAID' AND is_simulation=FALSE) AS real_paid_amount,
  (SELECT COUNT(*) FROM payment_webhook_events WHERE processed_at IS NULL)::int AS pending_webhooks`);
 const tables=await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
 return {masterId:master.id,roles:roles.rows,counts:await counts(client),unknownTables:tables.rows.map(r=>r.table_name).filter(name=>!allTables.includes(name)),financial:financial.rows[0]};
}
async function reset(client,{email,apply=false,runId,backupKey}){
 if(!apply){await client.query('BEGIN READ ONLY');try{return await inspect(client,email);}finally{await client.query('ROLLBACK');}}
 check(/^[0-9a-f-]{36}$/i.test(String(runId||'')),'runId inválido.');
 check(/^[0-9a-f]{64}$/i.test(String(backupKey||'')),'Chave de backup AES-256 ausente ou inválida.');
 await client.query('BEGIN');
 try {
  await client.query("SET LOCAL lock_timeout='20s'");
  await client.query("SET LOCAL statement_timeout='90s'");
  await client.query("SELECT pg_advisory_xact_lock(1780017017)");
  const tables=await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  check(tables.rows.every(r=>allTables.includes(r.table_name)),'Tabela desconhecida no banco; revise o escopo antes de limpar.');
  await client.query(`LOCK TABLE ${allTables.map(t=>'public.'+t).join(',')} IN ACCESS EXCLUSIVE MODE`);
  const before=await inspect(client,email);
  await client.query('CREATE SCHEMA IF NOT EXISTS postal_reset_archive');
  await client.query('REVOKE ALL ON SCHEMA postal_reset_archive FROM PUBLIC');
  await client.query(`CREATE TABLE IF NOT EXISTS postal_reset_archive.snapshots(
    id UUID PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),master_id UUID NOT NULL,
    ciphertext BYTEA NOT NULL,iv BYTEA NOT NULL,tag BYTEA NOT NULL,summary JSONB NOT NULL)`);
  const previous=await client.query('SELECT id,summary FROM postal_reset_archive.snapshots WHERE id=$1',[runId]);
  if(previous.rows.length){await client.query('ROLLBACK');return {alreadyApplied:true,runId,counts:before.counts};}
  const snapshot={createdAt:new Date().toISOString(),runId,masterId:before.masterId,tables:{}};
  for(const table of allTables){
    check(before.counts[table]<=100000,'Tabela excede limite seguro do backup.');
    snapshot.tables[table]=(await client.query('SELECT * FROM public.'+table)).rows;
  }
  const plaintext=Buffer.from(JSON.stringify(snapshot));
  check(plaintext.length<=32*1024*1024,'Backup excede 32 MB. Faça snapshot completo antes da limpeza.');
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(backupKey,'hex'),iv);
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  await client.query('INSERT INTO postal_reset_archive.snapshots(id,master_id,ciphertext,iv,tag,summary) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[runId,before.masterId,encrypted,iv,cipher.getAuthTag(),JSON.stringify({before})]);
  for(const table of clearTables)await client.query('DELETE FROM public.'+table);
  await client.query('DELETE FROM app_users WHERE id<>$1',[before.masterId]);
  const after=await counts(client);
  check(clearTables.every(t=>after[t]===0)&&after.app_users===1,'Verificação da limpeza falhou; revertendo tudo.');
  const master=await getMaster(client,email);check(master.id===before.masterId,'A conta master foi alterada.');
  await client.query('COMMIT');
  return {applied:true,runId,masterId:before.masterId,before:before.counts,after,backup:'postal_reset_archive.snapshots (AES-256-GCM)',referenceTables};
 }catch(error){await client.query('ROLLBACK');throw error;}
}
async function main(){
 require('dotenv').config();
 const args=process.argv.slice(2),apply=args.includes('--apply');
 if(apply){
  check(args.includes('--confirm=postal-balcao-production-master-only'),'Confirmação de alvo ausente.');
  check(process.env.RAILWAY_PROJECT_ID===expectedScope.project&&process.env.RAILWAY_ENVIRONMENT_ID===expectedScope.environment&&process.env.RAILWAY_SERVICE_ID===expectedScope.service,'Projeto/ambiente/serviço incorreto para limpeza.');
 }
 const db=require('../db');check(db.pool,'DATABASE_URL não configurada.');
 const client=await db.pool.connect();
 try{const result=await reset(client,{email:process.env.APP_USER,apply,runId:args.find(a=>a.startsWith('--run-id='))?.slice(9),backupKey:process.env.POSTAL_RESET_BACKUP_KEY});console.log(apply?'POSTAL_RESET_RESULT':'POSTAL_RESET_INVENTORY',JSON.stringify(result));}
 finally{client.release();await db.pool.end();}
}
if(require.main===module)main().catch(error=>{console.error('POSTAL_RESET_ABORTED',error.message);process.exitCode=1;});
module.exports={reset,inspect,clearTables,referenceTables};

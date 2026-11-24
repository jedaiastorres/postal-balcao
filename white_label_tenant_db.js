"use strict";
const {randomUUID}=require("node:crypto");
const uuid = "00000000-0000-0000-0000-000000000000";

async function init(pool) {
  if(!pool)throw new Error("Banco White Label indisponível.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wl_accounts (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL REFERENCES white_label_carriers(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('WL_MASTER','WL_OPERATOR')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INTEGER NOT NULL DEFAULT 0,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wl_accounts_tenant_idx ON wl_accounts(carrier_id,active);
    CREATE TABLE IF NOT EXISTS wl_tariffs (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL REFERENCES white_label_carriers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      origin_start CHAR(8) NOT NULL,
      origin_end CHAR(8) NOT NULL,
      destination_start CHAR(8) NOT NULL,
      destination_end CHAR(8) NOT NULL,
      min_weight INTEGER NOT NULL CHECK(min_weight BETWEEN 1 AND 30000),
      max_weight INTEGER NOT NULL CHECK(max_weight BETWEEN 1 AND 30000),
      price NUMERIC(12,2) NOT NULL CHECK(price>0),
      per_kg NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(per_kg>=0),
      days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 90),
      active BOOLEAN NOT NULL DEFAULT FALSE,
      created_by UUID REFERENCES wl_accounts(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(origin_start<=origin_end AND destination_start<=destination_end),
      CHECK(min_weight<=max_weight)
    );
    CREATE INDEX IF NOT EXISTS wl_tariffs_tenant_idx ON wl_tariffs(carrier_id,active);
  `);
}
const carrierByCode=async(pool,code)=>{
  const {rows}=await pool.query("SELECT * FROM white_label_carriers WHERE code=$1 LIMIT 1",[code]);
  return rows[0]||null;
};
const carrierById=async(pool,id)=>{
  const {rows}=await pool.query("SELECT * FROM white_label_carriers WHERE id=$1 LIMIT 1",[id]);
  return rows[0]||null;
};
const accountByEmail=async(pool,email)=>{
  const {rows}=await pool.query(
    "SELECT a.*, c.code AS carrier_code, c.status AS carrier_status FROM wl_accounts a JOIN white_label_carriers c ON c.id=a.carrier_id WHERE a.email=$1 LIMIT 1",
    [String(email||"").toLowerCase()]);
  return rows[0]||null;
};
const accountById=async(pool,id)=>{
  const {rows}=await pool.query("SELECT * FROM wl_accounts WHERE id=$1 LIMIT 1",[id]);
  return rows[0]||null;
};
async function provisionMaster(pool,carrier,passwordHash){
  // Não assumir propriedade de e-mail usado por outra transportadora.
  const {rows}=await pool.query(
    `INSERT INTO wl_accounts(id,carrier_id,email,name,password_hash,role,active,must_change_password)
      VALUES($1,$2,$3,$4,$5,'WL_MASTER',TRUE,TRUE)
      ON CONFLICT(email) DO UPDATE
         SET password_hash=EXCLUDED.password_hash,
             name=EXCLUDED.name,active=TRUE,must_change_password=TRUE,
             session_version=wl_accounts.session_version+1,updated_at=NOW()
       WHERE wl_accounts.carrier_id=EXCLUDED.carrier_id AND wl_accounts.role='WL_MASTER'
      RETURNING id,carrier_id,email,name,role,active,must_change_password`,
    [randomUUID(),carrier.id,carrier.admin_email.toLowerCase(),carrier.admin_name,passwordHash]
  );
  if(!rows[0])throw Object.assign(new Error("Este e-mail já pertence a outro perfil White Label."),{status:409});
  return rows[0];
}
async function listAccounts(pool,carrierId) {
  const {rows}=await pool.query(
    "SELECT id,name,email,role,active,must_change_password,created_at FROM wl_accounts WHERE carrier_id=$1 ORDER BY created_at",
    [carrierId]);return rows;
}
async function createOperator(pool,carrierId,{name,email,passwordHash}) {
  const {rows}=await pool.query(
    `INSERT INTO wl_accounts(id,carrier_id,email,name,password_hash,role)
      VALUES($1,$2,$3,$4,$5,'WL_OPERATOR')
      RETURNING id,name,email,role,active,must_change_password`,
    [randomUUID(),carrierId,email,name,passwordHash]);
  return rows[0];
}
async function setOperatorStatus(pool,carrierId,userId,active) {
  const {rows}=await pool.query(
    "UPDATE wl_accounts SET active=$3,session_version=session_version+1,updated_at=NOW() WHERE id=$2 AND carrier_id=$1 AND role='WL_OPERATOR' RETURNING id,name,email,role,active",
    [carrierId,userId,Boolean(active)]);
  return rows[0]||null;
}
async function updatePassword(pool,carrierId,userId,passwordHash) {
  const {rows}=await pool.query(
    `UPDATE wl_accounts SET password_hash=$3,must_change_password=FALSE,
      session_version=session_version+1,updated_at=NOW() WHERE carrier_id=$1 AND id=$2
      RETURNING id,email,role`,[carrierId,userId,passwordHash]);
  return rows[0]||null;
}
async function listTariffs(pool,carrierId) {
  const {rows}=await pool.query(
    "SELECT id,name,origin_start,origin_end,destination_start,destination_end,min_weight,max_weight,price,per_kg,days,active,updated_at FROM wl_tariffs WHERE carrier_id=$1 ORDER BY created_at DESC",
    [carrierId]);return rows;
}
async function saveTariff(pool,carrierId,userId,rate,id=null) {
  if(id) {
    const {rows}=await pool.query(
      `UPDATE wl_tariffs SET name=$3,origin_start=$4,origin_end=$5,destination_start=$6,
        destination_end=$7,min_weight=$8,max_weight=$9,price=$10,per_kg=$11,days=$12,
        active=$13,updated_at=NOW()
        WHERE carrier_id=$1 AND id=$2 RETURNING *`,
      [carrierId,id,rate.name,rate.originStart,rate.originEnd,rate.destinationStart,
      rate.destinationEnd,rate.minWeight,rate.maxWeight,rate.price,rate.perKg,rate.days,rate.active]);
    return rows[0]||null;
  }
  const {rows}=await pool.query(
    `INSERT INTO wl_tariffs(id,carrier_id,name,origin_start,origin_end,destination_start,destination_end,
       min_weight,max_weight,price,per_kg,days,active,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(),carrierId,rate.name,rate.originStart,rate.originEnd,
     rate.destinationStart,rate.destinationEnd,rate.minWeight,rate.maxWeight,rate.price,
     rate.perKg,rate.days,rate.active,userId]);
  return rows[0];
}
async function quoteTariffs(pool,carrierId,{origin,destination,weight}) {
  const {rows}=await pool.query(
    `SELECT id,name,price,per_kg,days FROM wl_tariffs WHERE carrier_id=$1 AND active=TRUE
      AND $2::text BETWEEN origin_start AND origin_end
      AND $3::text BETWEEN destination_start AND destination_end
      AND $4::int BETWEEN min_weight AND max_weight
      ORDER BY price+per_kg*($4::numeric/1000) ASC LIMIT 30`,
    [carrierId,origin,destination,weight]);
  return rows;
}
module.exports={init,carrierByCode,carrierById,accountByEmail,accountById,
  provisionMaster,listAccounts,createOperator,setOperatorStatus,updatePassword,
  listTariffs,saveTariff,quoteTariffs};

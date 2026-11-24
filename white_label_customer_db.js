"use strict";
const crypto=require("node:crypto");
const id=()=>crypto.randomUUID();
async function init(pool){
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wl_clients_tenant_id_unique
      ON wl_clients(carrier_id,id);
    CREATE TABLE IF NOT EXISTS wl_customer_accounts (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL REFERENCES white_label_carriers(id) ON DELETE CASCADE,
      client_id UUID NOT NULL,
      email VARCHAR(160) NOT NULL,
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(carrier_id,client_id),
      UNIQUE(carrier_id,email),
      FOREIGN KEY(carrier_id,client_id) REFERENCES wl_clients(carrier_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS wl_customer_accounts_tenant_active
      ON wl_customer_accounts(carrier_id,active);
    CREATE TABLE IF NOT EXISTS wl_customer_addresses (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL,
      client_id UUID NOT NULL,
      label VARCHAR(100) NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('SENDER','RECIPIENT')),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(carrier_id,client_id) REFERENCES wl_clients(carrier_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS wl_customer_addresses_owner
      ON wl_customer_addresses(carrier_id,client_id,created_at DESC);
  `);
}
async function provision(pool,carrierId,clientId,email,passwordHash){
  const {rows}=await pool.query(`
    INSERT INTO wl_customer_accounts
      (id,carrier_id,client_id,email,password_hash,active,must_change_password)
    SELECT $1,c.carrier_id,c.id,LOWER(c.email),$4,TRUE,TRUE
    FROM wl_clients c
    LEFT JOIN wl_points p ON p.id=c.point_id AND p.carrier_id=c.carrier_id
    WHERE c.carrier_id=$2 AND c.id=$3 AND c.active=TRUE
      AND c.email<>'' AND LOWER(c.email)=LOWER($5)
      AND (c.point_id IS NULL OR p.active=TRUE)
    ON CONFLICT (carrier_id,client_id)
    DO UPDATE SET email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,
      active=TRUE,must_change_password=TRUE,
      session_version=wl_customer_accounts.session_version+1,updated_at=NOW()
    RETURNING id,carrier_id,client_id,email,active,must_change_password`,
    [id(),carrierId,clientId,passwordHash,email]);
  return rows[0]||null;
}
const detail=`SELECT a.*,c.name,c.document,c.phone,c.street,c.number,c.neighborhood,
  c.cep,c.city,c.state,c.point_id,c.active AS client_active,
  p.active AS point_active
  FROM wl_customer_accounts a
  JOIN wl_clients c ON c.carrier_id=a.carrier_id AND c.id=a.client_id
  LEFT JOIN wl_points p ON p.carrier_id=c.carrier_id AND p.id=c.point_id`;
async function byEmail(pool,carrierId,email){
 const {rows}=await pool.query(detail+
   " WHERE a.carrier_id=$1 AND a.email=$2 LIMIT 1",[carrierId,email]);
 return rows[0]||null;
}
async function byId(pool,carrierId,accountId){
 const {rows}=await pool.query(detail+
   " WHERE a.carrier_id=$1 AND a.id=$2 LIMIT 1",[carrierId,accountId]);
 return rows[0]||null;
}
async function updatePassword(pool,carrierId,id,passwordHash){
 const {rows}=await pool.query(`
   UPDATE wl_customer_accounts SET password_hash=$3,must_change_password=FALSE,
     session_version=session_version+1,updated_at=NOW()
   WHERE carrier_id=$1 AND id=$2 AND active=TRUE RETURNING id`,
   [carrierId,id,passwordHash]);
 return rows[0]||null;
}
async function listAddresses(pool,carrierId,clientId){
 const {rows}=await pool.query(`
   SELECT id,label,kind,data,created_at FROM wl_customer_addresses
   WHERE carrier_id=$1 AND client_id=$2
   ORDER BY created_at DESC LIMIT 30`,[carrierId,clientId]);
 return rows;
}
async function createAddress(pool,carrierId,clientId,record){
 const {rows}=await pool.query(`
   INSERT INTO wl_customer_addresses(id,carrier_id,client_id,label,kind,data)
   SELECT $1,$2,$3,$4,$5,$6::jsonb
   WHERE (SELECT COUNT(*) FROM wl_customer_addresses
     WHERE carrier_id=$2 AND client_id=$3)<30
     AND EXISTS(SELECT 1 FROM wl_clients
       WHERE carrier_id=$2 AND id=$3 AND active=TRUE)
   RETURNING id,label,kind,data,created_at`,
   [id(),carrierId,clientId,record.label,record.kind,JSON.stringify(record.data)]);
 return rows[0]||null;
}
async function deleteAddress(pool,carrierId,clientId,addressId){
 const {rowCount}=await pool.query(
   "DELETE FROM wl_customer_addresses WHERE carrier_id=$1 AND client_id=$2 AND id=$3",
   [carrierId,clientId,addressId]);
 return rowCount>0;
}
module.exports={init,provision,byEmail,byId,updatePassword,listAddresses,createAddress,deleteAddress};

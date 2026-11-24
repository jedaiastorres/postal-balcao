"use strict";
const {randomUUID}=require("node:crypto");
async function init(pool){
  await pool.query(`
    ALTER TABLE wl_points ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(6,2)
      NOT NULL DEFAULT 0 CHECK(commission_percent BETWEEN 0 AND 100);
    CREATE TABLE IF NOT EXISTS wl_clients (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL REFERENCES white_label_carriers(id) ON DELETE CASCADE,
      point_id UUID,
      created_by UUID NOT NULL REFERENCES wl_accounts(id),
      name VARCHAR(160) NOT NULL,
      document VARCHAR(14) NOT NULL DEFAULT '',
      phone VARCHAR(11) NOT NULL DEFAULT '',
      email VARCHAR(160) NOT NULL DEFAULT '',
      street VARCHAR(160) NOT NULL DEFAULT '',
      number VARCHAR(20) NOT NULL DEFAULT '',
      neighborhood VARCHAR(100) NOT NULL DEFAULT '',
      city VARCHAR(100) NOT NULL DEFAULT '',
      state VARCHAR(2) NOT NULL DEFAULT '',
      cep VARCHAR(8) NOT NULL DEFAULT '',
      notes VARCHAR(1000) NOT NULL DEFAULT '',
      point_commission_override NUMERIC(6,2) CHECK(point_commission_override BETWEEN 0 AND 100),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(carrier_id,point_id) REFERENCES wl_points(carrier_id,id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wl_clients_tenant_document
      ON wl_clients(carrier_id,document) WHERE document<>'';
    CREATE INDEX IF NOT EXISTS wl_clients_tenant_point
      ON wl_clients(carrier_id,point_id,active,name);
    CREATE INDEX IF NOT EXISTS wl_clients_tenant_name
      ON wl_clients(carrier_id,name);
  `);
}
const select=`SELECT c.*,p.name AS point_name,p.commission_percent AS point_commission_percent
  FROM wl_clients c LEFT JOIN wl_points p
    ON p.id=c.point_id AND p.carrier_id=c.carrier_id`;
async function listClients(pool,carrierId,pointScope=null){
  const {rows}=await pool.query(
    select+` WHERE c.carrier_id=$1 AND ($2::uuid IS NULL OR c.point_id=$2)
      ORDER BY c.active DESC,c.name ASC LIMIT 300`,[carrierId,pointScope]);
  return rows;
}
async function getClient(pool,carrierId,id,pointScope=null){
  const {rows}=await pool.query(
    select+` WHERE c.carrier_id=$1 AND c.id=$2
      AND ($3::uuid IS NULL OR c.point_id=$3) LIMIT 1`,[carrierId,id,pointScope]);
  return rows[0]||null;
}
async function createClient(pool,carrierId,actorId,client,pointId,master){
  const {rows}=await pool.query(
    `INSERT INTO wl_clients
     (id,carrier_id,point_id,created_by,name,document,phone,email,street,number,
       neighborhood,city,state,cep,notes,point_commission_override,active)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     WHERE ($3::uuid IS NULL OR EXISTS (
       SELECT 1 FROM wl_points p WHERE p.carrier_id=$2 AND p.id=$3 AND p.active=TRUE))
       RETURNING id`,
    [randomUUID(),carrierId,pointId,actorId,client.name,client.document,client.phone,
      client.email,client.street,client.number,client.neighborhood,client.city,
      client.state,client.cep,client.notes,master?client.pointCommissionOverride:null,client.active]);
  if(!rows[0])throw Object.assign(new Error("Selecione uma unidade ativa desta transportadora."),{status:400});
  return getClient(pool,carrierId,rows[0].id,master?null:pointId);
}
async function updateClient(pool,carrierId,id,pointScope,client,pointId,master){
  const {rows}=await pool.query(
    `UPDATE wl_clients c SET
      point_id=CASE WHEN $18::boolean THEN $4 ELSE c.point_id END,
      name=$5,document=$6,phone=$7,email=$8,street=$9,number=$10,
      neighborhood=$11,city=$12,state=$13,cep=$14,notes=$15,
      point_commission_override=CASE WHEN $18::boolean THEN $16 ELSE c.point_commission_override END,
      active=CASE WHEN $18::boolean THEN $17 ELSE c.active END,
      updated_at=NOW()
     WHERE c.carrier_id=$1 AND c.id=$2
       AND ($3::uuid IS NULL OR c.point_id=$3)
       AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM wl_points p WHERE p.carrier_id=$1 AND p.id=$4 AND p.active=TRUE))
     RETURNING c.id`,
    [carrierId,id,pointScope,pointId,client.name,client.document,client.phone,
      client.email,client.street,client.number,client.neighborhood,client.city,
      client.state,client.cep,client.notes,master?client.pointCommissionOverride:null,
      client.active,Boolean(master)]);
  if(!rows[0])return null;
  return getClient(pool,carrierId,rows[0].id,pointScope);
}
async function setClientActive(pool,carrierId,id,active){
  const {rows}=await pool.query(
    "UPDATE wl_clients SET active=$3,updated_at=NOW() WHERE carrier_id=$1 AND id=$2 RETURNING id",
    [carrierId,id,Boolean(active)]);
  return rows[0]||null;
}
async function getPoint(pool,carrierId,pointId){
  const {rows}=await pool.query(
    "SELECT id,name,commission_percent,active FROM wl_points WHERE carrier_id=$1 AND id=$2 LIMIT 1",
    [carrierId,pointId]);
  return rows[0]||null;
}
async function setPointCommission(pool,carrierId,id,pct){
  const {rows}=await pool.query(
    `UPDATE wl_points SET commission_percent=$3,updated_at=NOW()
      WHERE carrier_id=$1 AND id=$2 AND active=TRUE RETURNING id,commission_percent`,
    [carrierId,id,pct]);
  return rows[0]||null;
}
module.exports={init,listClients,getClient,createClient,updateClient,setClientActive,
  getPoint,setPointCommission};

"use strict";
const {randomUUID}=require("node:crypto");

async function init(pool){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wl_collections (
      id UUID PRIMARY KEY,
      carrier_id UUID NOT NULL REFERENCES white_label_carriers(id) ON DELETE CASCADE,
      point_id UUID,
      request_key UUID NOT NULL,
      created_by UUID NOT NULL REFERENCES wl_accounts(id),
      requester_name VARCHAR(160) NOT NULL,
      requester_phone VARCHAR(11) NOT NULL,
      requester_document VARCHAR(14) NOT NULL DEFAULT '',
      package_count INTEGER NOT NULL CHECK (package_count BETWEEN 1 AND 200),
      address JSONB NOT NULL,
      scheduled_for TIMESTAMPTZ,
      notes VARCHAR(1000) NOT NULL DEFAULT '',
      driver_name VARCHAR(100) NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'REQUESTED'
        CHECK(status IN ('REQUESTED','ASSIGNED','IN_ROUTE','COLLECTED','CANCELED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(carrier_id,request_key),
      FOREIGN KEY(carrier_id,point_id) REFERENCES wl_points(carrier_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS wl_collections_tenant_recent
      ON wl_collections(carrier_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS wl_collections_tenant_point
      ON wl_collections(carrier_id,point_id,created_at DESC);
  `);
}
async function listCollections(pool,carrierId,pointId=null,limit=150){
  const {rows}=await pool.query(
    `SELECT id,carrier_id,point_id,requester_name,requester_phone,requester_document,
      package_count,address,scheduled_for,notes,driver_name,status,created_at,updated_at
      FROM wl_collections WHERE carrier_id=$1
      AND ($2::uuid IS NULL OR point_id=$2)
      ORDER BY created_at DESC LIMIT $3`,
    [carrierId,pointId,limit]);
  return rows;
}
async function createCollection(pool,carrierId,actorId,data,pointId){
  // O servidor determina o carrier_id e o escopo do ponto. Uma ordem de
  // operador só pode nascer em seu ponto ativo, e o MASTER pode deixá-la sem unidade.
  const status=pointId?"ASSIGNED":"REQUESTED";
  const {rows}=await pool.query(
    `INSERT INTO wl_collections
      (id,carrier_id,point_id,request_key,created_by,requester_name,requester_phone,
       requester_document,package_count,address,scheduled_for,notes,status)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,$12,$13
      WHERE ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM wl_points p WHERE p.carrier_id=$2 AND p.id=$3 AND p.active=TRUE))
      ON CONFLICT (carrier_id,request_key) DO NOTHING RETURNING *`,
    [randomUUID(),carrierId,pointId,data.requestKey,actorId,
      data.requesterName,data.requesterPhone,data.requesterDocument,data.packageCount,
      JSON.stringify(data.address),data.scheduledFor,data.notes,status]);
  if(rows[0])return {row:rows[0],created:true};
  // Idempotência: uma resposta perdida não pode gerar outra coleta no segundo clique.
  const prior=await pool.query(
    "SELECT * FROM wl_collections WHERE carrier_id=$1 AND request_key=$2 AND created_by=$3 LIMIT 1",
    [carrierId,data.requestKey,actorId]);
  if(prior.rows[0])return {row:prior.rows[0],created:false};
  throw Object.assign(new Error("Unidade indisponível ou identificador de coleta já utilizado."),{status:409});
}
async function assignCollection(pool,carrierId,id,pointId,driverName){
  // Impede atribuição a unidade desativada ou pertencente a outra transportadora.
  const {rows}=await pool.query(
    `UPDATE wl_collections c SET point_id=$3,driver_name=$4,status='ASSIGNED',
       updated_at=NOW()
      FROM wl_points p
      WHERE c.carrier_id=$1 AND c.id=$2 AND c.status IN ('REQUESTED','ASSIGNED')
        AND p.carrier_id=$1 AND p.id=$3 AND p.active=TRUE
      RETURNING c.*`,
    [carrierId,id,pointId,driverName]);
  return rows[0]||null;
}
async function transitionCollection(pool,carrierId,id,pointScope,nextStatus,allowedPrevious){
  const {rows}=await pool.query(
    `UPDATE wl_collections SET status=$4,updated_at=NOW()
      WHERE carrier_id=$1 AND id=$2 AND ($3::uuid IS NULL OR point_id=$3)
        AND status=ANY($5::text[])
      RETURNING *`,
    [carrierId,id,pointScope,nextStatus,allowedPrevious]);
  return rows[0]||null;
}
module.exports={init,listCollections,createCollection,assignCollection,transitionCollection};

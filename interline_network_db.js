"use strict";
const {randomUUID}=require("node:crypto");
const rules=require("./interline_network");
const conflict=message=>Object.assign(new Error(message),{status:409});
const denied=message=>Object.assign(new Error(message),{status:403});
const orderSelect=[
 "SELECT o.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(",
 " 'id',l.id,'position',l.position,'stage',l.stage,'operatorKey',l.operator_key,",
 " 'operatorName',m.display_name,'status',l.status,'amountCents',l.amount_cents,",
 " 'laneName',l.lane_name,'proof',l.proof,'updatedAt',l.updated_at) ORDER BY l.position)",
 " FROM interline_order_legs l JOIN interline_members m ON m.operator_key=l.operator_key",
 " WHERE l.order_id=o.id),'[]'::jsonb) AS legs FROM interline_orders o"
].join("\n");
async function init(pool){
 await pool.query([
 "CREATE TABLE IF NOT EXISTS interline_members (",
 " operator_key TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('POSTAL','WHITE_LABEL')),",
 " carrier_id UUID UNIQUE REFERENCES white_label_carriers(id) ON DELETE CASCADE,",
 " display_name VARCHAR(100) NOT NULL,opted_in BOOLEAN NOT NULL DEFAULT FALSE,",
 " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " CHECK ((kind='POSTAL' AND carrier_id IS NULL AND operator_key='POSTAL') OR",
 " (kind='WHITE_LABEL' AND carrier_id IS NOT NULL)));",
 "CREATE TABLE IF NOT EXISTS interline_lanes (",
 " id UUID PRIMARY KEY,operator_key TEXT NOT NULL REFERENCES interline_members(operator_key),",
 " stage TEXT NOT NULL CHECK(stage IN ('COLLECTION','TRANSFER','DELIVERY')),",
 " name VARCHAR(100) NOT NULL,origin_start CHAR(8) NOT NULL,origin_end CHAR(8) NOT NULL,",
 " destination_start CHAR(8) NOT NULL,destination_end CHAR(8) NOT NULL,",
 " min_weight INTEGER NOT NULL CHECK(min_weight>=1),",
 " max_weight INTEGER NOT NULL CHECK(max_weight<=30000),",
 " price_cents BIGINT NOT NULL CHECK(price_cents>=100),",
 " lead_hours INTEGER NOT NULL CHECK(lead_hours BETWEEN 1 AND 2160),",
 " active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " CHECK(origin_start<=origin_end AND destination_start<=destination_end),",
 " CHECK(min_weight<=max_weight));",
 "CREATE INDEX IF NOT EXISTS interline_lanes_active ON interline_lanes(stage,active,operator_key);",
 "CREATE TABLE IF NOT EXISTS interline_orders (",
 " id UUID PRIMARY KEY,request_key UUID NOT NULL,",
 " seller_key TEXT NOT NULL REFERENCES interline_members(operator_key),created_by TEXT NOT NULL,",
 " customer_reference VARCHAR(100) NOT NULL DEFAULT '',",
 " sender_name VARCHAR(160) NOT NULL,recipient_name VARCHAR(160) NOT NULL,",
 " origin_cep CHAR(8) NOT NULL,destination_cep CHAR(8) NOT NULL,",
 " weight INTEGER NOT NULL,tracking_code VARCHAR(36) NOT NULL UNIQUE,",
 " gross_cents BIGINT NOT NULL CHECK(gross_cents>=100),",
 " postal_commission_cents BIGINT NOT NULL CHECK(postal_commission_cents>=0),",
 " seller_margin_cents BIGINT NOT NULL CHECK(seller_margin_cents>=0),",
 " stage_total_cents BIGINT NOT NULL CHECK(stage_total_cents>=0),",
 " financial_snapshot JSONB NOT NULL,",
 " status TEXT NOT NULL DEFAULT 'PENDING_ACCEPTANCE'",
 " CHECK(status IN ('PENDING_ACCEPTANCE','READY','IN_PROGRESS',",
 " 'COMPLETED','NEEDS_REPLAN','CANCELED')),",
 " payment_status TEXT NOT NULL DEFAULT 'NOT_CHARGED'",
 " CHECK(payment_status IN ('NOT_CHARGED','PENDING','RECEIVED','REFUNDED','DISPUTED')),",
 " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " UNIQUE(seller_key,request_key),",
 " CHECK(gross_cents=postal_commission_cents+seller_margin_cents+stage_total_cents));",
 "CREATE TABLE IF NOT EXISTS interline_order_legs (",
 " id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES interline_orders(id) ON DELETE CASCADE,",
 " lane_id UUID REFERENCES interline_lanes(id),",
 " position SMALLINT NOT NULL CHECK(position BETWEEN 1 AND 3),",
 " operator_key TEXT NOT NULL REFERENCES interline_members(operator_key),",
 " stage TEXT NOT NULL CHECK(stage IN ('COLLECTION','TRANSFER','DELIVERY')),",
 " lane_name VARCHAR(100) NOT NULL,amount_cents BIGINT NOT NULL CHECK(amount_cents>=100),",
 " status TEXT NOT NULL DEFAULT 'OFFERED'",
 " CHECK(status IN ('OFFERED','ACCEPTED','IN_PROGRESS','COMPLETED','REJECTED')),",
 " proof VARCHAR(200),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " UNIQUE(order_id,position));",
 "CREATE INDEX IF NOT EXISTS interline_order_legs_operator",
 " ON interline_order_legs(operator_key,status);",
 "CREATE TABLE IF NOT EXISTS interline_allocations (",
 " id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES interline_orders(id) ON DELETE CASCADE,",
 " operator_key TEXT NOT NULL REFERENCES interline_members(operator_key),",
 " purpose TEXT NOT NULL CHECK(purpose IN ('POSTAL_FEE','SELLER_MARGIN',",
 " 'COLLECTION','TRANSFER','DELIVERY')),",
 " amount_cents BIGINT NOT NULL CHECK(amount_cents>=0),",
 " settlement_state TEXT NOT NULL DEFAULT 'NOT_FUNDED'",
 " CHECK(settlement_state IN ('NOT_FUNDED','FUNDED','RELEASED','REVERSED','DISPUTED')),",
 " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
 " UNIQUE(order_id,operator_key,purpose));",
 "CREATE TABLE IF NOT EXISTS interline_audit (",
 " id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES interline_orders(id) ON DELETE CASCADE,",
 " leg_id UUID REFERENCES interline_order_legs(id),",
 " actor_key TEXT NOT NULL REFERENCES interline_members(operator_key),",
 " actor_user TEXT NOT NULL,action TEXT NOT NULL,proof VARCHAR(200),",
 " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
 "CREATE INDEX IF NOT EXISTS interline_audit_order ON interline_audit(order_id,created_at);",
 "INSERT INTO interline_members(operator_key,kind,display_name,opted_in)",
 " VALUES('POSTAL','POSTAL','Postal Serviços',FALSE)",
 " ON CONFLICT(operator_key) DO NOTHING;"
 ].join("\n"));
}
async function ensureMember(pool,key,name,carrierId=null){
 const {rows}=await pool.query(
  "INSERT INTO interline_members(operator_key,kind,carrier_id,display_name) "+
  "VALUES($1,$2,$3,$4) ON CONFLICT(operator_key) DO UPDATE SET "+
  "display_name=EXCLUDED.display_name,updated_at=NOW() "+
  "RETURNING operator_key,kind,display_name,opted_in",
  [key,key==="POSTAL"?"POSTAL":"WHITE_LABEL",carrierId,String(name||key).slice(0,100)]);
 return rows[0];
}
async function member(pool,key){
 const {rows}=await pool.query(
  "SELECT operator_key,kind,display_name,opted_in FROM interline_members WHERE operator_key=$1",[key]);
 return rows[0]||null;
}
async function setOptIn(pool,key,enabled){
 const {rows}=await pool.query(
  "UPDATE interline_members SET opted_in=$2,updated_at=NOW() WHERE operator_key=$1 "+
  "RETURNING operator_key,kind,display_name,opted_in",[key,Boolean(enabled)]);
 return rows[0]||null;
}
async function listLanes(pool,key=null,activeNetwork=false){
 const {rows}=await pool.query(
  "SELECT l.*,m.display_name AS operator_name FROM interline_lanes l "+
  "JOIN interline_members m ON m.operator_key=l.operator_key "+
  "WHERE ($1::text IS NULL OR l.operator_key=$1) "+
  "AND ($2::boolean=FALSE OR (m.opted_in=TRUE AND l.active=TRUE)) "+
  "ORDER BY l.updated_at DESC LIMIT 300",[key,Boolean(activeNetwork)]);
 return rows;
}
async function addLane(pool,key,lane){
 const {rows}=await pool.query(
  "INSERT INTO interline_lanes(id,operator_key,stage,name,origin_start,origin_end,"+
  "destination_start,destination_end,min_weight,max_weight,price_cents,lead_hours,active) "+
  "SELECT $1,m.operator_key,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 "+
  "FROM interline_members m WHERE m.operator_key=$2 AND m.opted_in=TRUE RETURNING *",
  [randomUUID(),key,lane.stage,lane.name,lane.originStart,lane.originEnd,
   lane.destinationStart,lane.destinationEnd,lane.minWeight,lane.maxWeight,
   lane.priceCents,lane.leadHours,lane.active]);
 if(!rows[0])throw conflict("Ative sua participação antes de publicar serviços.");
 return rows[0];
}
async function toggleLane(pool,key,id,active){
 const {rows}=await pool.query(
  "UPDATE interline_lanes SET active=$3,updated_at=NOW() "+
  "WHERE operator_key=$1 AND id=$2 RETURNING *",[key,id,Boolean(active)]);
 return rows[0]||null;
}
async function discover(pool,route){
 const {rows}=await pool.query([
  "SELECT l.*,m.display_name AS operator_name FROM interline_lanes l",
  "JOIN interline_members m ON m.operator_key=l.operator_key",
  "WHERE m.opted_in=TRUE AND l.active=TRUE",
  "AND l.min_weight<=$3 AND l.max_weight>=$3",
  "AND ((l.stage='COLLECTION' AND $1 BETWEEN l.origin_start AND l.origin_end)",
  "OR (l.stage='DELIVERY' AND $2 BETWEEN l.destination_start AND l.destination_end)",
  "OR (l.stage='TRANSFER' AND $1 BETWEEN l.origin_start AND l.origin_end",
  "AND $2 BETWEEN l.destination_start AND l.destination_end))",
  "ORDER BY l.stage,l.price_cents ASC LIMIT 100"
 ].join(" "),[route.origin,route.destination,route.weight]);
 return rows;
}
async function withTransaction(pool,run){
 const tx=await pool.connect();
 try{await tx.query("BEGIN");const out=await run(tx);await tx.query("COMMIT");return out;}
 catch(error){await tx.query("ROLLBACK");throw error;}
 finally{tx.release();}
}
async function requestService(pool,sellerKey,userId,request,postalTerms){
 return withTransaction(pool,async tx=>{
  const existing=await tx.query(
   "SELECT id FROM interline_orders WHERE seller_key=$1 AND request_key=$2",
   [sellerKey,request.requestKey]);
  if(existing.rows[0])return {id:existing.rows[0].id,created:false};
  const seller=await tx.query(
   "SELECT opted_in FROM interline_members WHERE operator_key=$1 FOR SHARE",[sellerKey]);
  if(!seller.rows[0]?.opted_in)throw denied("Ative a participação na rede antes de solicitar.");
  const {rows}=await tx.query(
   "SELECT l.*,m.opted_in FROM interline_lanes l "+
   "JOIN interline_members m ON m.operator_key=l.operator_key "+
   "WHERE l.id=ANY($1::uuid[]) FOR SHARE OF l,m",[request.laneIds]);
  if(rows.length!==request.laneIds.length)throw conflict("Etapa indisponível.");
  const selected=request.laneIds.map(id=>rows.find(row=>row.id===id));
  if(selected.some(row=>!row.active||!row.opted_in||
    !rules.offerMatches(row,{origin:request.origin,destination:request.destination,weight:request.weight})))
    throw conflict("A cobertura ou tarifa de uma etapa foi alterada. Faça nova consulta.");
  const plan=rules.snapshotSale({sellerKey,selectedLanes:selected,
   grossCents:request.priceCents,postalFeePercent:postalTerms.percent,
   postalFeeFixed:postalTerms.fixed});
  const orderId=randomUUID();
  const trackingCode="NET"+randomUUID().replaceAll("-","").slice(0,17).toUpperCase();
  const financial={...plan,allocations:plan.allocations.map(x=>({...x})),
   freezeVersion:1,paymentEnabled:false,processor:"MERCHANT_CONNECTION_PENDING",
   frozenAt:new Date().toISOString()};
  const state=selected.every(l=>l.operator_key===sellerKey)?"READY":"PENDING_ACCEPTANCE";
  await tx.query(
   "INSERT INTO interline_orders(id,request_key,seller_key,created_by,customer_reference,"+
   "sender_name,recipient_name,origin_cep,destination_cep,weight,tracking_code,gross_cents,"+
   "postal_commission_cents,seller_margin_cents,stage_total_cents,financial_snapshot,status) "+
   "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)",
   [orderId,request.requestKey,sellerKey,String(userId),request.customerReference,
    request.senderName,request.recipientName,request.origin,request.destination,
    request.weight,trackingCode,plan.grossCents,plan.postalFeeCents,
    plan.sellerMarginCents,plan.stageTotalCents,JSON.stringify(financial),state]);
  let position=0;
  for(const lane of selected){
   position++;
   await tx.query(
    "INSERT INTO interline_order_legs(id,order_id,lane_id,position,operator_key,stage,"+
    "lane_name,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(),orderId,lane.id,position,lane.operator_key,lane.stage,lane.name,
     Number(lane.price_cents),lane.operator_key===sellerKey?"ACCEPTED":"OFFERED"]);
   await tx.query(
    "INSERT INTO interline_allocations(id,order_id,operator_key,purpose,amount_cents) "+
    "VALUES($1,$2,$3,$4,$5)",
    [randomUUID(),orderId,lane.operator_key,lane.stage,Number(lane.price_cents)]);
  }
  for(const [operator,purpose,amount] of [
    ["POSTAL","POSTAL_FEE",plan.postalFeeCents],
    [sellerKey,"SELLER_MARGIN",plan.sellerMarginCents]]){
   await tx.query(
    "INSERT INTO interline_allocations(id,order_id,operator_key,purpose,amount_cents) "+
    "VALUES($1,$2,$3,$4,$5)",[randomUUID(),orderId,operator,purpose,amount]);
  }
  await tx.query(
   "INSERT INTO interline_audit(id,order_id,actor_key,actor_user,action) "+
   "VALUES($1,$2,$3,$4,'REQUESTED')",
   [randomUUID(),orderId,sellerKey,String(userId)]);
  return {id:orderId,trackingCode,created:true,
    quote:{grossCents:plan.grossCents,postalCommissionCents:plan.postalFeeCents,
      sellerMarginCents:plan.sellerMarginCents,stages:plan.allocations},
    paymentEnabled:false};
 });
}
async function listOrders(pool,key){
 const {rows}=await pool.query(orderSelect+
  " WHERE ($2::boolean=TRUE OR o.seller_key=$1 OR EXISTS(SELECT 1 FROM interline_order_legs x "+
  "WHERE x.order_id=o.id AND x.operator_key=$1)) ORDER BY o.created_at DESC LIMIT 150",[key,key==="POSTAL"]);
 return rows;
}
async function updateLeg(pool,key,userId,legId,nextStatus,proof){
 return withTransaction(pool,async tx=>{
  const r=await tx.query(
   "SELECT l.*,o.status AS order_status,o.payment_status,o.seller_key "+
   "FROM interline_order_legs l JOIN interline_orders o ON o.id=l.order_id "+
   "WHERE l.id=$1 FOR UPDATE OF l,o",[legId]);
  const leg=r.rows[0];
  if(!leg||leg.operator_key!==key)throw denied("Etapa não pertence à sua empresa.");
  if(["CANCELED","NEEDS_REPLAN"].includes(leg.order_status))
    throw conflict("Operação suspensa ou cancelada.");
  rules.completeAllowed(leg.status,nextStatus);
  if(["IN_PROGRESS","COMPLETED"].includes(nextStatus)&&leg.payment_status!=="RECEIVED")
    throw conflict("A execução física só pode começar após a cobrança e conciliação financeira.");
  const evidence=String(proof||"").trim();
  if(nextStatus==="COMPLETED"&&(evidence.length<6||evidence.length>200))
    throw conflict("Informe protocolo ou comprovante de execução (6 a 200 caracteres).");
  const result=await tx.query(
   "SELECT id,position,status FROM interline_order_legs "+
   "WHERE order_id=$1 ORDER BY position FOR UPDATE",[leg.order_id]);
  if(nextStatus==="IN_PROGRESS"&&
    result.rows.some(x=>x.position<leg.position&&x.status!=="COMPLETED"))
    throw conflict("A etapa anterior ainda não foi concluída.");
  await tx.query(
   "UPDATE interline_order_legs SET status=$3,proof=$4,updated_at=NOW() "+
   "WHERE id=$1 AND operator_key=$2",
   [legId,key,nextStatus,evidence||leg.proof||null]);
  const statuses=result.rows.map(x=>x.id===legId?nextStatus:x.status);
  const state=statuses.includes("REJECTED")?"NEEDS_REPLAN":
   statuses.every(x=>x==="COMPLETED")?"COMPLETED":
   statuses.some(x=>["IN_PROGRESS","COMPLETED"].includes(x))?"IN_PROGRESS":
   statuses.every(x=>x==="ACCEPTED")?"READY":"PENDING_ACCEPTANCE";
  await tx.query(
   "UPDATE interline_orders SET status=$2,updated_at=NOW() WHERE id=$1",
   [leg.order_id,state]);
  await tx.query(
   "INSERT INTO interline_audit(id,order_id,leg_id,actor_key,actor_user,action,proof) "+
   "VALUES($1,$2,$3,$4,$5,$6,$7)",
   [randomUUID(),leg.order_id,legId,key,String(userId),nextStatus,evidence||null]);
  return {orderId:leg.order_id,orderStatus:state,legStatus:nextStatus,
    paymentStatus:leg.payment_status};
 });
}
async function cancelOrder(pool,key,actor,id){
 return withTransaction(pool,async tx=>{
  const r=await tx.query(
   "SELECT id,status,payment_status FROM interline_orders "+
   "WHERE id=$1 AND seller_key=$2 FOR UPDATE",[id,key]);
  if(!r.rows[0])throw denied("Pedido não pertence à sua empresa.");
  if(r.rows[0].payment_status!=="NOT_CHARGED")
    throw conflict("Pagamento recebido exige estorno e conciliação.");
  if(["COMPLETED","IN_PROGRESS","CANCELED"].includes(r.rows[0].status))
    throw conflict("Não é permitido cancelar pedido em execução ou concluído.");
  const legs=await tx.query(
   "SELECT status FROM interline_order_legs WHERE order_id=$1 FOR UPDATE",[id]);
  if(legs.rows.some(x=>["IN_PROGRESS","COMPLETED"].includes(x.status)))
    throw conflict("Uma etapa foi executada; precisa abrir ocorrência.");
  await tx.query(
   "UPDATE interline_orders SET status='CANCELED',updated_at=NOW() WHERE id=$1",[id]);
  await tx.query(
   "INSERT INTO interline_audit(id,order_id,actor_key,actor_user,action) "+
   "VALUES($1,$2,$3,$4,'CANCELED')",
   [randomUUID(),id,key,String(actor)]);
  return {id,status:"CANCELED"};
 });
}
function publicOrder(row,key){
 const seller=row.seller_key===key,postal=key==="POSTAL";
 const legs=(Array.isArray(row.legs)?row.legs:[])
  .filter(l=>seller||postal||l.operatorKey===key)
  .map(l=>({...l,amountCents:Number(l.amountCents)}));
 const result={id:row.id,trackingCode:row.tracking_code,
  origin:row.origin_cep,destination:row.destination_cep,weight:Number(row.weight),
  status:row.status,paymentStatus:row.payment_status,
  createdAt:row.created_at,customerReference:row.customer_reference,
  senderName:row.sender_name,recipientName:row.recipient_name,legs,
  sellerOperatorKey:row.seller_key};
 if(seller||postal){
  result.grossCents=Number(row.gross_cents);
  result.postalCommissionCents=Number(row.postal_commission_cents);
  result.sellerMarginCents=Number(row.seller_margin_cents);
  result.stageTotalCents=Number(row.stage_total_cents);
  result.payoutsEnabled=false;
 }
 return result;
}
async function publicTracking(pool,trackingCode){
 const code=String(trackingCode||"").toUpperCase();
 if(!/^NET[A-F0-9]{17}$/.test(code))return null;
 const {rows}=await pool.query(
  "SELECT o.tracking_code,o.origin_cep,o.destination_cep,o.weight,o.created_at,"+
  "o.updated_at,o.status,m.display_name AS seller_brand "+
  "FROM interline_orders o JOIN interline_members m ON m.operator_key=o.seller_key "+
  "WHERE o.tracking_code=$1 LIMIT 1",[code]);
 const o=rows[0];
 if(!o)return null;
 const legs=await pool.query(
  "SELECT stage,status,updated_at FROM interline_order_legs "+
  "WHERE order_id=(SELECT id FROM interline_orders WHERE tracking_code=$1) "+
  "ORDER BY position ASC",[code]);
 const label={PENDING_ACCEPTANCE:"Aguardando confirmação das transportadoras",
   READY:"Etapas confirmadas — aguardando pagamento",
   IN_PROGRESS:"Envio em movimentação",COMPLETED:"Entrega concluída",
   NEEDS_REPLAN:"Rota em reprogramação",CANCELED:"Solicitação cancelada"};
 const stages={COLLECTION:"Coleta",TRANSFER:"Transferência",DELIVERY:"Entrega"};
 const status={OFFERED:"solicitada",ACCEPTED:"aceita",
   IN_PROGRESS:"em andamento",COMPLETED:"concluída",REJECTED:"recusada"};
 return {
   trackingCode:o.tracking_code,carrier:o.seller_brand,
   service:"Rede logística compartilhada",statusLabel:label[o.status]||"Em acompanhamento",
   origin:{cep:o.origin_cep},destination:{cep:o.destination_cep},
   package:{volumeCount:1,weightKg:Number(o.weight)/1000},
   updatedAt:o.updated_at,
   events:[
     {description:"Solicitação registrada na rede",date:o.created_at},
     ...legs.rows.filter(x=>x.status!=="OFFERED").map(x=>({
       description:(stages[x.stage]||"Etapa")+" "+(status[x.status]||"atualizada"),
       date:x.updated_at
     }))
   ].sort((a,b)=>new Date(b.date)-new Date(a.date))
 };
}
module.exports={init,ensureMember,member,setOptIn,listLanes,addLane,toggleLane,discover,
 requestService,listOrders,updateLeg,cancelOrder,publicOrder,publicTracking};

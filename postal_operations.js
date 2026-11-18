"use strict";

function dispatchSql(scoped) {
  return `WITH selected AS (
    SELECT f.* FROM freight_orders f
     WHERE f.package_data->>'carrierMode'='POSTAL_OWN'
       AND f.payment_status='PAID' AND f.is_simulation=FALSE
       ${scoped ? "AND f.store_id=$1" : ""}
     ORDER BY f.created_at DESC LIMIT 500
  )
  SELECT f.id,f.tracking_code,f.sender,f.recipient,f.package_data,f.package_count,
         f.deadline,f.status,f.created_at,f.paid_at,f.shipped_at,f.sale_price,
         f.postal_revenue_total,f.point_revenue_total,f.provider_cost,
         s.name AS store_name,
         COALESCE(scan.read_codes,0) AS read_codes,COALESCE(scan.delivered_codes,0) AS delivered_codes,
         COALESCE(scan.off_point_scans,0) AS off_point_scans,
         scan.latest_at,scan.last_stage,
         COALESCE(costs.actual,0) AS actual_cost,COALESCE(costs.entries,0) AS cost_entries,
         COALESCE(t.estimated_operating_cost,0)*GREATEST(f.package_count,1) AS estimated_cost
    FROM selected f
    LEFT JOIN stores s ON s.id=f.store_id
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT tracking_code)::int AS read_codes,
             COUNT(DISTINCT tracking_code) FILTER (WHERE stage='DELIVERY_RECORDED')::int AS delivered_codes,
             COUNT(*) FILTER (WHERE actor_store_id IS NOT NULL AND actor_store_id IS DISTINCT FROM f.store_id)::int AS off_point_scans,
             MAX(created_at) AS latest_at,
             (SELECT stage FROM custody_scans WHERE order_id=f.id ORDER BY created_at DESC,id DESC LIMIT 1) AS last_stage
        FROM custody_scans WHERE order_id=f.id
    ) scan ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS actual, COUNT(*) AS entries FROM postal_operating_costs WHERE order_id=f.id
    ) costs ON TRUE
    LEFT JOIN postal_route_tariffs t ON t.origin_city=f.package_data->'ownRoute'->>'originCity'
         AND t.destination_city=f.package_data->'ownRoute'->>'destinationCity' AND t.active=TRUE
   ORDER BY f.created_at DESC`;
}

const round2=x=>Math.round((Number(x)||0)*100)/100;
function summarizeDispatch(rows,{now=Date.now()}={}) {
  const shipments=(rows||[]).map(row=>{
    const packages=Math.max(1,Number(row.package_count)||1);
    const read=Math.min(packages,Number(row.read_codes)||0);
    const delivered=Math.min(packages,Number(row.delivered_codes)||0);
    const closed=delivered>=packages;
    const d=Number(row.deadline)||0;
    const start=new Date(row.paid_at||row.created_at).getTime();
    const target=d>0&&Number.isFinite(start)?new Date(start+d*86400000).toISOString():null;
    const remaining=target?new Date(target).getTime()-now:null;
    const sla=closed?"ENTREGA_INTERNA":remaining===null?"SEM_PRAZO":remaining<0?"REFERENCIA_VENCIDA":remaining<=86400000?"ALERTA_24H":"DENTRO_DA_REFERENCIA";
    const actual=round2(row.actual_cost),estimated=round2(row.estimated_cost);
    const revenue=round2(row.postal_revenue_total);
    const costEntries=Number(row.cost_entries)||0;
    const costBasis=costEntries?actual:estimated;
    const origin=row.package_data?.ownRoute?.originCity||row.sender?.city||"Não informada";
    const destination=row.package_data?.ownRoute?.destinationCity||row.recipient?.city||"Não informada";
    return {id:row.id,trackingCode:row.tracking_code,origin,destination,storeName:row.store_name||"Sem ponto",
      createdAt:row.created_at,deadlineDays:d,target,packages,read,delivered,stage:row.last_stage||"SEM_LEITURA",
      lastScanAt:row.latest_at,sla,referenceOnly:true,offPointScans:Number(row.off_point_scans)||0,
      sale:round2(row.sale_price),pointRevenue:round2(row.point_revenue_total),postalRevenue:revenue,
      actualCost:actual,estimatedCost:estimated,costBasis,costType:costEntries?"REGISTRADO":estimated>0?"ESTIMADO":"SEM_CUSTO",
      contribution:round2(revenue-costBasis),costEntries};
  });
  const totals=shipments.reduce((a,x)=>{a.packages+=x.packages;a.revenue+=x.postalRevenue;a.cost+=x.costBasis;a.contribution+=x.contribution;
    if(x.sla==="REFERENCIA_VENCIDA")a.overdue++;
    if(x.sla==="ALERTA_24H")a.atRisk++;
    if(x.read<x.packages)a.pendingChecks++;
    if(x.stage==="TRANSFERRED")a.pendingTransfers++;
    if(x.offPointScans>0)a.offPointScans+=x.offPointScans;
    if(x.delivered===x.packages)a.delivered++;
    return a;},{shipments:shipments.length,packages:0,revenue:0,cost:0,contribution:0,overdue:0,atRisk:0,pendingChecks:0,pendingTransfers:0,offPointScans:0,delivered:0});
  for(const k of ["revenue","cost","contribution"])totals[k]=round2(totals[k]);
  return {totals,shipments};
}

function csvCell(value){let v=String(value??"");if(/^[\s\x00-\x1f]*[=+\-@]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
function dispatchCsv(items){const header=["Pedido","Rastreio","Origem","Destino","Ponto","Pacotes","Leituras","Entregas internas","Última etapa","Prazo de referência","Alerta de referência","Receita Postal","Custo base","Tipo de custo","Contribuição"];
  const rows=items.map(x=>[x.id,x.trackingCode,x.origin,x.destination,x.storeName,x.packages,x.read,x.delivered,x.stage,x.target,x.sla,x.postalRevenue,x.costBasis,x.costType,x.contribution]);
  return "\ufeff"+[header,...rows].map(row=>row.map(csvCell).join(";")).join("\r\n")+"\r\n";
}
module.exports={dispatchSql,summarizeDispatch,dispatchCsv};

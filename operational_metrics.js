"use strict";

const MAX_ROWS = 2000;
const max0 = value => Math.max(0, Number(value) || 0);
const count = value => Math.floor(max0(value));

function custodyReportSql(whereSql) {
  return `WITH selected AS (
            SELECT * FROM freight_orders f
             WHERE ${whereSql}
             ORDER BY f.created_at DESC,f.id DESC LIMIT ${MAX_ROWS+1}
          )
          SELECT f.id,f.tracking_code,f.carrier,f.service_name,f.created_at,f.package_count,
                 COALESCE(s.name,'Sem ponto') AS store_name,
                 COALESCE(c.scanned_codes,0) AS scanned_codes,
                 COALESCE(c.delivered_codes,0) AS delivered_codes,
                 c.last_scan_at
            FROM selected f
            LEFT JOIN stores s ON s.id=f.store_id
            LEFT JOIN LATERAL (
              SELECT COUNT(DISTINCT tracking_code)::int AS scanned_codes,
                     COUNT(DISTINCT tracking_code) FILTER (WHERE stage='DELIVERY_RECORDED')::int AS delivered_codes,
                     MAX(created_at) AS last_scan_at
                FROM custody_scans WHERE order_id=f.id
            ) c ON TRUE
           ORDER BY f.created_at DESC,f.id DESC`;
}

function summarizeCustody(rows, { now = Date.now(), inactivityHours = 24 } = {}) {
  const thresholdMs = Math.max(1, Number(inactivityHours) || 24) * 3600000;
  const items = (rows || []).map(row => {
    const packages = Math.max(1, count(row.package_count));
    const scanned = Math.min(packages, count(row.scanned_codes));
    const delivered = Math.min(scanned, count(row.delivered_codes));
    const lastScanAt = row.last_scan_at ? new Date(row.last_scan_at) : null;
    const lastScanMs = lastScanAt && Number.isFinite(lastScanAt.getTime()) ? lastScanAt.getTime() : null;
    const noFirstScan = scanned === 0;
    const internallyComplete = delivered >= packages;
    const inactive = !noFirstScan && !internallyComplete && lastScanMs !== null && now - lastScanMs >= thresholdMs;
    const attention = noFirstScan ? "SEM_LEITURA" : inactive ? "SEM_MOVIMENTACAO" : internallyComplete ? "CONCLUIDO_INTERNO" : "EM_MOVIMENTACAO";
    return {
      id: String(row.id || ""),
      trackingCode: String(row.tracking_code || ""),
      storeName: String(row.store_name || "Sem ponto"),
      carrier: String(row.carrier || "Não informada"),
      service: String(row.service_name || ""),
      createdAt: row.created_at || null,
      lastScanAt: lastScanMs === null ? null : new Date(lastScanMs).toISOString(),
      packages, scanned, delivered, attention
    };
  });
  const shipments = items.length;
  const packages = items.reduce((sum,row) => sum + row.packages, 0);
  const scannedPackages = items.reduce((sum,row) => sum + row.scanned, 0);
  const deliveredInternally = items.reduce((sum,row) => sum + row.delivered, 0);
  const noFirstScan = items.filter(row => row.attention === "SEM_LEITURA").length;
  const inactiveShipments = items.filter(row => row.attention === "SEM_MOVIMENTACAO").length;
  return {
    summary: {
      shipments, packages, scannedPackages, deliveredInternally, noFirstScan, inactiveShipments,
      scanCoveragePercent: packages ? Math.round(scannedPackages / packages * 1000) / 10 : 0,
      inactivityHours: Math.max(1, Number(inactivityHours) || 24)
    },
    attention: items.filter(row => ["SEM_LEITURA","SEM_MOVIMENTACAO"].includes(row.attention))
      .sort((a,b) => (a.attention === "SEM_MOVIMENTACAO" ? -1 : 1) - (b.attention === "SEM_MOVIMENTACAO" ? -1 : 1)
        || new Date(a.lastScanAt || a.createdAt || 0) - new Date(b.lastScanAt || b.createdAt || 0)).slice(0,15),
    items
  };
}

function escapeCsvCell(value) {
  let content = String(value ?? "");
  // Spreadsheet programs treat leading =, +, -, @ or control characters as formulas.
  if (/^[\s\x00-\x1f]*[=+\-@]/.test(content) || /^[\t\r\n]/.test(content)) content = "'" + content;
  return '"' + content.replaceAll('"','""') + '"';
}

function custodyCsv(items) {
  const headers = ["Pedido","Rastreio","Ponto","Transportadora","Serviço","Criado em","Última leitura","Volumes","Volumes lidos","Entregas internas","Situação interna"];
  const rows = items.map(row => [row.id,row.trackingCode,row.storeName,row.carrier,row.service,row.createdAt,row.lastScanAt,row.packages,row.scanned,row.delivered,row.attention]);
  return "\uFEFF" + [headers,...rows].map(row => row.map(escapeCsvCell).join(";")).join("\r\n") + "\r\n";
}

module.exports = { MAX_ROWS, custodyReportSql, summarizeCustody, custodyCsv };

const test=require("node:test"),assert=require("node:assert/strict");
const {summarizeDispatch,dispatchCsv}=require("./postal_operations");
test("painel diferencia custo realizado, estimado e risco de prazo",()=>{
 const now=Date.UTC(2026,10,18);
 const report=summarizeDispatch([
   {id:"1",package_count:2,read_codes:1,delivered_codes:0,deadline:2,paid_at:"2026-11-17T00:00:00Z",postal_revenue_total:30,estimated_cost:12,cost_entries:0,package_data:{ownRoute:{originCity:"Xinguara",destinationCity:"Redenção"}}},
   {id:"2",package_count:1,read_codes:1,delivered_codes:1,deadline:1,paid_at:"2026-11-10T00:00:00Z",postal_revenue_total:40,actual_cost:20,cost_entries:1}
 ],{now});
 assert.equal(report.totals.atRisk,1);assert.equal(report.totals.delivered,1);
 assert.equal(report.shipments[0].costType,"ESTIMADO");assert.equal(report.shipments[1].costType,"REGISTRADO");
 assert.equal(report.totals.contribution,38);
});
test("CSV neutraliza fórmulas",()=>assert.match(dispatchCsv([{origin:"=HYPERLINK(1)"}]),/"'=HYPERLINK\(1\)"/));

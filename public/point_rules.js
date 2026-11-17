/* Regras operacionais compartilhadas pelo servidor e pela interface. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PostalPointRules=factory();})(globalThis,()=>{
  const terminal=['COLLECTED','RECEIVED_AT_POINT','COMPLETED','CANCELED'];
  const flows={
    PICKUP:{REQUESTED:['ASSIGNED','CANCELED'],ASSIGNED:['ACCEPTED','DECLINED','CANCELED'],ACCEPTED:['EN_ROUTE','COLLECTED','CANCELED'],EN_ROUTE:['COLLECTED','CANCELED'],COLLECTED:['COMPLETED'],DECLINED:['ASSIGNED','CANCELED'],COMPLETED:[],CANCELED:[]},
    DROPOFF:{REQUESTED:['ASSIGNED','WAITING_DROPOFF','CANCELED'],ASSIGNED:['WAITING_DROPOFF','RECEIVED_AT_POINT','CANCELED'],WAITING_DROPOFF:['RECEIVED_AT_POINT','CANCELED'],RECEIVED_AT_POINT:['COMPLETED'],COMPLETED:[],CANCELED:[]}
  };
  function assert(condition,message,status=400){if(!condition)throw Object.assign(new Error(message),{status});}
  function collectionPricing(count,fee,rate){
    assert(Number.isInteger(count)&&count>=1&&count<=200,'Informe uma quantidade inteira de 1 a 200 pacotes.');
    assert(Number.isFinite(fee)&&fee>=0&&Number.isFinite(rate)&&rate>=0&&rate<=fee,'Configuração financeira de coleta inválida.',503);
    const cents=x=>Math.round(x*100);
    return {packageCount:count,feePerPackage:cents(fee)/100,pointRate:cents(rate)/100,totalFee:cents(fee)*count/100,pointCompensation:cents(rate)*count/100,postalCompensation:(cents(fee)-cents(rate))*count/100};
  }
  function canTransition(type,from,to){return from===to||Boolean(flows[type]?.[from]?.includes(to));}
  function canReassign(status){return !terminal.includes(status);}
  function earningStatus(collection,order){
    if(!order||order.payment_status!=='PAID'||['CANCELED','CANCELLED','REFUNDED'].includes(order.status)||!Number.isFinite(Number(order.first_mile_fee))||!Number.isFinite(Number(collection.total_fee))||Number(order.first_mile_fee)<Number(collection.total_fee)||Number(order.first_mile_fee)<=0)return null;
    return order.is_simulation?'SIMULATED':'EARNED';
  }
  return {assert,collectionPricing,canTransition,canReassign,earningStatus};
});

"use strict";
const $=id=>document.getElementById(id);
const state={csrf:"",role:"",shipments:[],tariffs:[],cities:[],inFlight:new Map()};
const money=x=>Number(x||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const fmt=x=>x?new Date(x).toLocaleString("pt-BR"):"—";
function show(message,success=false){$("message").classList.remove("hidden");$("message").textContent=message;$("message").style.background=success?"#e8f8ee":"#fff3e5";}
function cell(tr,text,tag="td") {const el=document.createElement(tag);el.textContent=String(text??"");tr.append(el);return el;}
function button(label,action){const b=document.createElement("button");b.type="button";b.className="secondary";b.textContent=label;b.addEventListener("click",action);return b;}
async function api(path,options={}){
 const response=await fetch(path,{credentials:"same-origin",cache:"no-store",...options,headers:{"Content-Type":"application/json",...(options.method?{"x-csrf-token":state.csrf}:{}),...(options.headers||{})}});
 let data={};try{data=await response.json();}catch{}
 if(!response.ok)throw new Error(data.error||"Não foi possível concluir a operação.");return data;
}

function labelStage(stage){return ({SEM_LEITURA:"Sem leitura",RECEIVED_POINT:"No ponto",TRANSFERRED:"Em transferência",RECEIVED_HUB:"Recebido no hub",OUT_FOR_DELIVERY:"Saiu para entrega",DELIVERY_RECORDED:"Entrega registrada"})[stage]||stage;}
function labelSla(sla){return ({REFERENCIA_VENCIDA:"Referência vencida",ALERTA_24H:"Atenção 24h",ENTREGA_INTERNA:"Concluída internamente",SEM_PRAZO:"Sem prazo",DENTRO_DA_REFERENCIA:"Dentro da referência"})[sla]||sla;}
function riskClass(sla){return sla==="REFERENCIA_VENCIDA"?"danger":sla==="ALERTA_24H"?"warning":sla==="ENTREGA_INTERNA"?"okay":"info";}

function render(){
 const search=$("search").value.trim().toLowerCase(),risk=$("risk").value,stage=$("stage").value;
 const filtered=state.shipments.filter(x=>{
   if(risk&&x.sla!==risk||stage&&x.stage!==stage)return false;
   return !search||[x.trackingCode,x.origin,x.destination,x.storeName,x.id].some(v=>String(v||"").toLowerCase().includes(search));
 });
 $("dispatchRows").replaceChildren();$("costRows").replaceChildren();
 if(!filtered.length){const tr=document.createElement("tr");cell(tr,"Nenhum envio corresponde ao filtro.").colSpan=7;$("dispatchRows").append(tr);}
 for(const x of filtered){
   const tr=document.createElement("tr");
   const link=document.createElement("a");link.href="/rastreio?codigo="+encodeURIComponent(x.trackingCode||"");link.textContent=x.trackingCode||String(x.id).slice(0,8);link.target="_blank";link.rel="noopener";
   const first=document.createElement("td");first.append(link);tr.append(first);
   cell(tr,x.origin+" → "+x.destination);cell(tr,x.storeName);cell(tr,x.read+" / "+x.packages);
   const stageCell=cell(tr,labelStage(x.stage));
   if(x.offPointScans){const caution=document.createElement("small");caution.textContent=x.offPointScans+" leitura(s) fora do ponto de origem — conferir";stageCell.append(caution);}
   const due=cell(tr,x.target?fmt(x.target):"—");due.title="Prazo de referência, não garantia contratual";
   const alert=cell(tr,"");const pill=document.createElement("span");pill.className="pill "+riskClass(x.sla);pill.textContent=labelSla(x.sla);alert.append(pill);
   $("dispatchRows").append(tr);
   const cr=document.createElement("tr");cell(cr,x.trackingCode||x.id);cell(cr,x.origin+" → "+x.destination);
   cell(cr,money(x.postalRevenue));cell(cr,money(x.costBasis));
   cell(cr,x.costType==="REGISTRADO"?"Registrado":x.costType==="ESTIMADO"?"Estimado":"Não informado");
   cell(cr,money(x.contribution));
   const action=cell(cr,"");if(state.role==="ADMIN")action.append(button("Adicionar custo",()=>addCost(x)));else action.textContent="—";
   $("costRows").append(cr);
 }
}

async function refresh(){
 try{
  const data=await api("/api/postal/dispatch");state.shipments=data.shipments||[];
  const t=data.totals||{};
  $("totalShipments").textContent=(t.shipments||0)+" / "+(t.packages||0);
  $("pendingChecks").textContent=t.pendingChecks||0;$("pendingTransfers").textContent=t.pendingTransfers||0;
  $("atRisk").textContent=t.atRisk||0;$("overdue").textContent=t.overdue||0;$("offPointScans").textContent=t.offPointScans||0;
  $("revenue").textContent=money(t.revenue);$("cost").textContent=money(t.cost);$("contribution").textContent=money(t.contribution);
  render();show("Dados atualizados. Exibindo os 500 envios Postal pagos mais recentes.",true);
 }catch(error){show(error.message);}
}

async function addCost(shipment){
 const description=prompt("Descreva o custo operacional REAL deste envio (ex.: motorista, combustível, redespacho):");
 if(description===null)return;
 const input=prompt("Valor do custo operacional em reais:");if(input===null)return;
 const amount=Number(String(input).replace(",","."));
 if(description.trim().length<3||!Number.isFinite(amount)||amount<=0||amount>100000){show("Informe descrição e custo válido.");return;}
 if(!confirm("Registrar "+money(amount)+" como custo real do envio "+shipment.trackingCode+"? O lançamento será auditável e não altera o pagamento do cliente."))return;
 const last=state.inFlight.get(shipment.id);
 const idempotencyKey=last&&last.amount===amount&&last.description===description.trim()?last.key:crypto.randomUUID();
 state.inFlight.set(shipment.id,{amount,description:description.trim(),key:idempotencyKey});
 try{
  await api("/api/postal/orders/"+encodeURIComponent(shipment.id)+"/operating-costs",{method:"POST",body:JSON.stringify({description:description.trim(),amount,idempotencyKey})});
  state.inFlight.delete(shipment.id);await refresh();show("Custo registrado; resultado atualizado.",true);
 }catch(error){show(error.message+" Se a rede caiu, repita o mesmo custo para recuperar a operação sem duplicar.");}
}

function citySelect(id){const select=$(id);select.replaceChildren();for(const name of state.cities){const option=document.createElement("option");option.value=name;option.textContent=name;select.append(option);}}
function renderTariffs(){const host=$("tariffRows");host.replaceChildren();if(!state.tariffs.length){const tr=document.createElement("tr");cell(tr,"Nenhuma tarifa própria configurada.").colSpan=7;host.append(tr);return;}
 for(const t of state.tariffs){const tr=document.createElement("tr");cell(tr,t.origin_city);cell(tr,t.destination_city);cell(tr,money(t.price));cell(tr,t.deadline_days+" dia(s)");cell(tr,money(t.estimated_operating_cost));
  cell(tr,t.active?"Ativa":"Suspensa");const action=cell(tr,"");if(state.role==="ADMIN")action.append(button("Editar",()=>{
   $("tariffOrigin").value=t.origin_city;$("tariffDestination").value=t.destination_city;$("tariffPrice").value=t.price;
   $("tariffDays").value=t.deadline_days;$("tariffCost").value=t.estimated_operating_cost;$("tariffActive").value=String(t.active);
   $("tariffForm").scrollIntoView({behavior:"smooth"});
  }));host.append(tr);
 }
}
async function loadTariffs(){if(!["ADMIN","SUPERVISOR"].includes(state.role))return;
 try{const data=await api("/api/postal/tariffs");state.cities=data.cities||[];state.tariffs=data.tariffs||[];
  citySelect("tariffOrigin");citySelect("tariffDestination");renderTariffs();$("tariffsPanel").classList.remove("hidden");
  if(state.role!=="ADMIN")$("tariffForm").classList.add("hidden");
 }catch(error){show(error.message);}
}
$("tariffForm").addEventListener("submit",async event=>{
 event.preventDefault();const btn=$("saveTariff");btn.disabled=true;
 const body={originCity:$("tariffOrigin").value,destinationCity:$("tariffDestination").value,price:Number($("tariffPrice").value),
  deadlineDays:Number($("tariffDays").value),estimatedOperatingCost:Number($("tariffCost").value),active:$("tariffActive").value==="true"};
 try{await api("/api/postal/tariffs",{method:"PUT",body:JSON.stringify(body)});await loadTariffs();show("Tarifa regional atualizada.",true);}catch(error){show(error.message);}finally{btn.disabled=false;}
});
$("refresh").addEventListener("click",refresh);
for(const id of ["search","risk","stage"])$(id).addEventListener(id==="search"?"input":"change",render);
async function boot(){
 try{const auth=await api("/api/ops/scanner-session");state.csrf=auth.csrfToken;state.role=auth.role;
  if(!["ADMIN","SUPERVISOR","STORE_OWNER","OPS"].includes(auth.role))throw new Error("Conta sem acesso à expedição.");
  $("dashboard").classList.remove("hidden");await Promise.all([refresh(),loadTariffs()]);
  setInterval(()=>{if(document.visibilityState==="visible")refresh();},60000);
 }catch(error){show(error.message+" Retorne ao painel e entre com uma conta autorizada.");}}
boot();

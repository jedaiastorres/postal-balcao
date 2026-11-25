/* Rede cooperativa Postal + White Labels; operações permanecem sem débito até conciliação. */
(function(global){
"use strict";
const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const brl=c=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(c||0)/100);
const dig=v=>String(v||"").replace(/\D/g,"");
const labels={COLLECTION:"Coleta",TRANSFER:"Transferência",DELIVERY:"Entrega"};
const statuses={PENDING_ACCEPTANCE:"Aguardando aceite",READY:"Etapas aceitas",IN_PROGRESS:"Em execução",
  COMPLETED:"Concluída",NEEDS_REPLAN:"Recusada — replanejar",CANCELED:"Cancelada",
  OFFERED:"Aguardando aceite",ACCEPTED:"Aceita",REJECTED:"Recusada"};
const mounts=new WeakMap();
function mount(root,{prefix,request}){
 if(!root||typeof request!=="function")return null;
 if(mounts.has(root))return mounts.get(root);
 let active=false,offers=[],orders=[],pendingKey=null,operatorKey="";
 root.classList.add("interline-root");
 root.innerHTML='<div class="interline-banner"><div><span class="eyebrow">REDE POSTAL · COOPERAÇÃO</span>'+
   '<h3>Rede integrada de transportadoras</h3><p>O cliente pertence à empresa vendedora. Coletas, transferências e entregas podem ser aceitas por bases de outras empresas.</p></div>'+
   '<div class="interline-membership"><span data-network-status>Verificando participação…</span>'+
   '<button class="ghost" type="button" data-network-join>Ativar participação</button></div></div>'+
   '<div class="interline-warning">As propostas e os aceites já podem ser registrados. <strong>Execução, cobranças, repasses e emissão ficam bloqueados</strong> até a conexão financeira e conciliação de cada empresa.</div>'+
   '<div class="interline-cols">'+
     '<section class="interline-block"><h4>Publicar serviço para a rede</h4><p class="note">Cadastre o preço que sua empresa deseja receber por etapa. A publicação é voluntária.</p>'+
       '<form data-network-lane class="interline-form">'+
       '<label>Etapa<select name="stage" required><option value="COLLECTION">Coleta</option><option value="TRANSFER">Transferência</option><option value="DELIVERY">Entrega</option></select></label>'+
       '<label>Nome do serviço<input name="name" required maxlength="100" placeholder="Coleta urbana Marabá"></label>'+
       '<label>CEP origem início<input name="originStart" inputmode="numeric" maxlength="9" required placeholder="68500-000"></label>'+
       '<label>CEP origem fim<input name="originEnd" inputmode="numeric" maxlength="9" required placeholder="68599-999"></label>'+
       '<label>CEP destino início<input name="destinationStart" inputmode="numeric" maxlength="9" required placeholder="68500-000"></label>'+
       '<label>CEP destino fim<input name="destinationEnd" inputmode="numeric" maxlength="9" required placeholder="68599-999"></label>'+
       '<label>Peso mín. (g)<input name="minWeight" type="number" min="1" max="30000" value="1" required></label>'+
       '<label>Peso máx. (g)<input name="maxWeight" type="number" min="1" max="30000" value="30000" required></label>'+
       '<label>Recebimento pela etapa (R$)<input name="price" type="number" min="1" step="0.01" required placeholder="15,00"></label>'+
       '<label>Prazo (horas)<input name="leadHours" type="number" min="1" max="2160" value="24" required></label>'+
       '<button class="primary" type="submit">Publicar serviço</button></form></section>'+
     '<section class="interline-block"><h4>Encontrar operadores da rede</h4><p class="note">A disponibilidade depende da cobertura e do aceite de cada parceiro.</p>'+
       '<form data-network-search class="interline-form">'+
       '<label>CEP de coleta<input name="origin" required maxlength="9" inputmode="numeric"></label>'+
       '<label>CEP de entrega<input name="destination" required maxlength="9" inputmode="numeric"></label>'+
       '<label>Peso (g)<input name="weight" type="number" min="1" max="30000" value="1000" required></label>'+
       '<button type="submit" class="ghost">Buscar cobertura</button></form>'+
       '<div data-network-offers class="interline-results">Busque uma rota para comparar os operadores disponíveis.</div>'+
       '<h4>Criar proposta de frete compartilhado</h4>'+
       '<form data-network-order class="interline-form">'+
       '<label>Cliente / referência<input name="customerReference" maxlength="100" placeholder="Opcional"></label>'+
       '<label>Remetente<input name="senderName" required maxlength="160"></label>'+
       '<label>Destinatário<input name="recipientName" required maxlength="160"></label>'+
       '<label>Coleta<select name="COLLECTION" required></select></label>'+
       '<label>Transferência (opcional)<select name="TRANSFER"></select></label>'+
       '<label>Entrega<select name="DELIVERY" required></select></label>'+
       '<label>Preço comercial do frete (R$)<input name="salePrice" type="number" min="1" step="0.01" required></label>'+
       '<button class="primary" type="submit">Solicitar aceite das empresas</button>'+
       '<p class="note">A comissão Postal e as remunerações serão congeladas no pedido. Não ocorre débito nesta fase.</p></form></section></div>'+
   '<section class="interline-block"><div class="section-head"><h4>Meus serviços publicados</h4><button type="button" class="ghost" data-network-refresh>Atualizar rede</button></div>'+
     '<div data-network-lanes class="interline-results">Carregando…</div></section>'+
   '<section class="interline-block"><h4>Solicitações e etapas da rede</h4><div data-network-orders class="interline-results">Carregando…</div></section>'+
   '<section class="interline-block"><h4>Financeiro e repasses</h4><p data-network-finance class="note">Verificando requisitos de integração Asaas…</p></section>';
 const one=selector=>root.querySelector(selector),all=selector=>[...root.querySelectorAll(selector)];
 const err=message=>{const field=one("[data-network-status]");field.textContent=message;field.setAttribute("role","alert");};
 async function api(path,opts){return request(prefix+path,opts||{});}
 function renderLanes(rows){
  one("[data-network-lanes]").innerHTML=rows.length?rows.map(l=>'<div class="interline-item">'+
    '<div><strong>'+esc(labels[l.stage])+' · '+esc(l.name)+'</strong>'+
    '<small>'+esc(l.originStart)+'–'+esc(l.originEnd)+' → '+esc(l.destinationStart)+'–'+esc(l.destinationEnd)+
    ' · '+brl(l.priceCents)+'</small></div>'+
    '<button class="ghost" type="button" data-network-toggle="'+esc(l.id)+'" data-setactive="'+(!l.active)+'">'+
    (l.active?"Suspender":"Reativar")+'</button></div>').join(""):'<div class="empty">Nenhum serviço publicado.</div>';
 }
 function renderOffers(){
  one("[data-network-offers]").innerHTML=offers.length?offers.map(l=>
   '<div class="interline-item"><div><strong>'+esc(labels[l.stage])+' · '+esc(l.operatorName)+'</strong>'+
   '<small>'+esc(l.name)+' · '+brl(l.priceCents)+' · '+esc(l.leadHours)+' h</small></div></div>'
  ).join(""):'<div class="empty">Nenhum operador disponível para os CEPs/peso informados.</div>';
  const form=one("[data-network-order]");
  for(const stage of ["COLLECTION","TRANSFER","DELIVERY"]){
   const select=form.elements.namedItem(stage);
   select.innerHTML='<option value="">'+(stage==="TRANSFER"?"Sem transferência":"Selecione o operador")+'</option>'+
     offers.filter(l=>l.stage===stage).map(l=>'<option value="'+esc(l.id)+'">'+
       esc(l.operatorName)+' · '+esc(l.name)+' · '+brl(l.priceCents)+'</option>').join("");
  }
 }
 function renderOrders(){
  const host=one("[data-network-orders]");
  host.innerHTML=orders.length?orders.map(o=>{
   const own=o.sellerOperatorKey===operatorKey;
   const legs=(o.legs||[]).map(l=>{
    const mine=l.operatorKey===operatorKey;
    const canAccept=mine&&l.status==="OFFERED"&&o.status==="PENDING_ACCEPTANCE";
    return '<div class="interline-leg"><span>'+esc(labels[l.stage])+' · '+esc(l.operatorName)+' — '+esc(statuses[l.status]||l.status)+
      ' · '+brl(l.amountCents)+'</span>'+
      (canAccept?'<button type="button" class="ghost" data-leg-id="'+esc(l.id)+'" data-leg-action="ACCEPTED">Aceitar</button>'+
      '<button type="button" class="ghost" data-leg-id="'+esc(l.id)+'" data-leg-action="REJECTED">Recusar</button>':"")+
      '</div>';
   }).join("");
   const financial=own||operatorKey==="POSTAL"?
     '<small>Venda: '+brl(o.grossCents)+' · Postal: '+brl(o.postalCommissionCents)+
     ' · Etapas: '+brl(o.stageTotalCents)+' · Vendedor: '+brl(o.sellerMarginCents)+'</small>':"";
   return '<article class="interline-order"><div class="interline-order-head"><strong>'+
     esc(o.trackingCode)+'</strong><span>'+esc(statuses[o.status]||o.status)+'</span></div>'+
     '<small>'+esc(o.origin)+' → '+esc(o.destination)+' · '+esc(o.senderName)+' → '+esc(o.recipientName)+'</small>'+
     financial+legs+
     (own&&["PENDING_ACCEPTANCE","READY","NEEDS_REPLAN"].includes(o.status)?
       '<button class="ghost" type="button" data-cancel-order="'+esc(o.id)+'">Cancelar proposta</button>':"")+
     '</article>';
  }).join(""):'<div class="empty">Ainda não existem solicitações entre transportadoras.</div>';
 }
 async function refresh(){
  try{
   const result=await api("/overview");
   operatorKey=result.membership.operatorKey;
   active=result.membership.enabled;
   one("[data-network-status]").textContent=active?"Empresa participante":"Participação desativada";
   one("[data-network-join]").textContent=active?"Suspender novas ofertas":"Ativar participação";
   renderLanes(result.lanes||[]);
   orders=result.orders||[];renderOrders();
   const finance=await api("/finance");
   one("[data-network-finance]").textContent=finance.ready?
     "Gateway conectado. Verifique contratos e liquidações.":
     "Pagamentos e repasses ainda bloqueados: "+(finance.requirements||[]).join(" · ");
  }catch(e){err(e.message);}
 }
 one("[data-network-join]").addEventListener("click",async()=>{
  const next=!active;
  if(!global.confirm(next?"Autorizar sua empresa a oferecer serviços para outras transportadoras?":"Suspender a divulgação de novos serviços? Solicitações já aceitas permanecem registradas."))return;
  try{await api("/membership",{method:"POST",body:JSON.stringify({enabled:next})});await refresh();}
  catch(e){err(e.message);}
 });
 one("[data-network-lane]").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget;
  const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{
   const get=k=>form.elements.namedItem(k).value;
   const body={stage:get("stage"),name:get("name"),
     originStart:dig(get("originStart")),originEnd:dig(get("originEnd")),
     destinationStart:dig(get("destinationStart")),destinationEnd:dig(get("destinationEnd")),
     minWeight:Number(get("minWeight")),maxWeight:Number(get("maxWeight")),
     priceCents:Math.round(Number(get("price"))*100),leadHours:Number(get("leadHours"))};
   await api("/lanes",{method:"POST",body:JSON.stringify(body)});
   form.reset();await refresh();
  }catch(error){err(error.message);}finally{button.disabled=false;}
 });
 root.addEventListener("click",async event=>{
  const btn=event.target.closest("[data-network-toggle],[data-leg-id],[data-cancel-order],[data-network-refresh]");
  if(!btn||!root.contains(btn))return;
  if(btn.hasAttribute("data-network-refresh"))return refresh();
  btn.disabled=true;
  try{
   if(btn.dataset.networkToggle){
    await api("/lanes/"+encodeURIComponent(btn.dataset.networkToggle),{
      method:"PATCH",body:JSON.stringify({active:btn.dataset.setactive==="true"})});
   }else if(btn.dataset.legId){
    const action=btn.dataset.legAction;
    if(action==="REJECTED"&&!global.confirm("Recusar esta etapa? A empresa vendedora precisará replanejar."))return;
    await api("/legs/"+encodeURIComponent(btn.dataset.legId),{
      method:"PATCH",body:JSON.stringify({status:action})});
   }else if(btn.dataset.cancelOrder){
    if(!global.confirm("Cancelar esta proposta?"))return;
    await api("/orders/"+encodeURIComponent(btn.dataset.cancelOrder)+"/cancel",{
      method:"POST",body:"{}"});
   }
   await refresh();
  }catch(error){err(error.message);}finally{btn.disabled=false;}
 });
 one("[data-network-search]").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget;
  const origin=dig(form.elements.namedItem("origin").value),
    destination=dig(form.elements.namedItem("destination").value),
    weight=Number(form.elements.namedItem("weight").value);
  try{
   const result=await api("/match?"+new URLSearchParams({origin,destination,weight}));
   offers=result.offers||[];renderOffers();
  }catch(error){err(error.message);}
 });
 one("[data-network-order]").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget;
  const get=k=>form.elements.namedItem(k).value;
  const selection=["COLLECTION","TRANSFER","DELIVERY"].map(k=>get(k)).filter(Boolean);
  const route=one("[data-network-search]");
  const origin=dig(route.elements.namedItem("origin").value);
  const destination=dig(route.elements.namedItem("destination").value);
  const weight=Number(route.elements.namedItem("weight").value);
  if(!origin||!destination||!offers.length){err("Consulte a cobertura antes de solicitar.");return;}
  if(!global.crypto?.randomUUID){err("Use conexão HTTPS para enviar solicitações.");return;}
  if(!pendingKey)pendingKey=global.crypto.randomUUID();
  const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{
   await api("/orders",{method:"POST",body:JSON.stringify({
     requestKey:pendingKey,customerReference:get("customerReference"),
     senderName:get("senderName"),recipientName:get("recipientName"),
     origin,destination,weight,laneIds:selection,
     priceCents:Math.round(Number(get("salePrice"))*100)})});
   pendingKey=null;form.reset();await refresh();
  }catch(error){err(error.message);}finally{button.disabled=false;}
 });
 const apiRef={refresh};mounts.set(root,apiRef);
 void refresh();return apiRef;
}
global.InterlineNetwork=Object.freeze({mount});
})(window);

(() => {
  const client = {
    walletBalance: 0,
    points: [],
    collections: [],
    connections: [],
    adminStores: [],
    pickupCoords: null
  };

  function isClient(){ return state.user?.role === "CLIENT"; }
  function isPoint(){ return ["STORE_OWNER","STORE_CLERK","OPS"].includes(state.user?.role); }

  function initRegistration(){
    const params=new URLSearchParams(location.search);
    const ref=params.get("ref")||"";
    if(ref){
      $("#clientReferralCode").value=ref;
      $("#clientReferralNotice").textContent="Cadastro vinculado ao ponto indicador "+ref+".";
      $("#clientReferralNotice").classList.remove("hidden");
    }
    if(location.pathname==="/cliente"||ref){
      $("#loginForm").classList.add("hidden");
      $("#clientRegisterForm").classList.remove("hidden");
    }
    $("#clientRegisterToggle")?.addEventListener("click",()=>{
      $("#loginForm").classList.add("hidden"); $("#clientRegisterForm").classList.remove("hidden");
    });
    $("#backToLoginBtn")?.addEventListener("click",()=>{
      $("#clientRegisterForm").classList.add("hidden"); $("#loginForm").classList.remove("hidden");
    });
    $("#clientRegisterForm")?.addEventListener("submit",async e=>{
      e.preventDefault();
      const btn=e.currentTarget.querySelector("button[type='submit']");
      btn.disabled=true; btn.textContent="Criando...";
      try{
        await api("/api/client/register",{method:"POST",body:JSON.stringify({
          name:$("#clientRegisterName").value.trim(),
          email:$("#clientRegisterEmail").value.trim(),
          document:$("#clientRegisterDocument").value,
          phone:$("#clientRegisterPhone").value,
          password:$("#clientRegisterPassword").value,
          referralCode:$("#clientReferralCode").value
        })});
        $("#loginEmail").value=$("#clientRegisterEmail").value.trim();
        $("#loginPassword").value=$("#clientRegisterPassword").value;
        $("#clientRegisterForm").classList.add("hidden"); $("#loginForm").classList.remove("hidden");
        toast("Conta criada. Entre com seu e-mail e senha.");
      }catch(err){toast(err.message,"error");}
      finally{btn.disabled=false;btn.textContent="Criar minha conta";}
    });
  }

  async function onShowApp(user){
    const clientMode=user?.role==="CLIENT";
    $("#clientNavSection")?.classList.toggle("hidden",!clientMode);
    document.querySelector('[data-view="inventory"]')?.classList.toggle("hidden",clientMode||!["ADMIN","STORE_OWNER","OPS"].includes(user?.role));
    document.querySelector('[data-view="credit"]')?.classList.toggle("hidden",clientMode||!["ADMIN","STORE_OWNER","STORE_CLERK"].includes(user?.role));
    document.querySelector('[data-view="cash"]')?.classList.toggle("hidden",clientMode||!["ADMIN","STORE_OWNER"].includes(user?.role));
    document.querySelector('[data-view="clients"]')?.classList.toggle("hidden",clientMode);
    document.querySelector('[data-view="receive"]')?.classList.toggle("hidden",clientMode);
    document.querySelector('[data-view="returns"]')?.classList.toggle("hidden",clientMode);
    document.querySelector('[data-view="referrals"]')?.classList.toggle("hidden",clientMode||!["STORE_OWNER","STORE_CLERK"].includes(user?.role));
    document.querySelector('[data-view="collections"]')?.classList.toggle("hidden",!["ADMIN","STORE_OWNER","STORE_CLERK","OPS","CLIENT"].includes(user?.role));
    document.querySelector('[data-view="connections"]')?.classList.toggle("hidden",!clientMode);
    document.querySelector('[data-view="wallet"]')?.classList.toggle("hidden",!clientMode);

    document.querySelector('[data-view="dashboard"]')?.classList.toggle("hidden",clientMode);
    if(clientMode){
      $("#partnerEmail").textContent=user.name||user.email;
      $(".page-kicker").textContent="POSTAL SERVIÇOS · CLIENTE";
      const badge=$("#apiBadge");
      badge.className="status-badge connected";
      badge.innerHTML='<span class="dot"></span> Rede Postal conectada';
      $("#quoteModeLabel").textContent="Cotação Postal em tempo real";
      const quoteText=document.querySelector("#quoteView .quote-head p");
      if(quoteText) quoteText.textContent="Compare transportadoras, escolha o melhor frete e pague com seu saldo Postal.";
      await loadClientHome();
      navigate("clientHome");
    }
  }

  async function loadClientHome(){
    if(!isClient())return;
    try{
      const d=await api("/api/client/dashboard");
      client.walletBalance=Number(d.balance||0);
      $("#clientBalance").textContent=money(d.balance);
      $("#clientShipments").textContent=d.totalShipments||0;
      $("#clientCollectionsPending").textContent=d.pendingCollections||0;
      $("#clientConnections").textContent=d.connections||0;
    }catch(err){toast(err.message,"error");}
  }

  async function loadWallet(){
    if(!isClient())return;
    const d=await api("/api/client/wallet");
    client.walletBalance=Number(d.balance||0);
    $("#walletBalanceHero").textContent=money(d.balance);
    await previewTopup();
    $("#walletModeNote").textContent=state.config?.paymentsConfigured
      ?"Recargas são confirmadas automaticamente pelo gateway de pagamento."
      :"Homologação ativa: a recarga adiciona saldo de teste, sem dinheiro real.";
    const host=$("#walletTransactions");
    host.innerHTML=d.transactions.length?d.transactions.map(t=>`
      <div class="inventory-row">
        <div><span class="addon-type">${escapeHtml(t.type)}</span><strong>${escapeHtml(t.description||"Movimentação")}</strong><small>${new Date(t.createdAt).toLocaleString("pt-BR")}</small></div>
        <div><span>Valor</span><strong class="${Number(t.amount)>=0?"positive-money":"negative-money"}">${money(t.amount)}</strong></div>
        <div><span>Status</span><strong>${escapeHtml(t.status)}</strong></div>
      </div>`).join(""):'<div class="empty-state">Nenhuma movimentação ainda.</div>';
  }

  async function previewTopup(){
    if(!isClient())return;
    const amount=Number($("#walletTopupAmount")?.value||0);
    const method=$("#walletTopupMethod")?.value||"PIX";
    if(!(amount>=10)){
      $("#walletPreviewCredit").textContent=money(amount||0);
      $("#walletPreviewFee").textContent="—";
      $("#walletPreviewTotal").textContent="—";
      return;
    }
    try{
      const p=await api("/api/client/wallet/topup-preview",{method:"POST",body:JSON.stringify({amount,paymentMethod:method})});
      $("#walletPreviewCredit").textContent=money(p.credit);
      $("#walletPreviewFee").textContent=money(p.fee);
      $("#walletPreviewTotal").textContent=money(p.total);
    }catch{
      $("#walletPreviewFee").textContent="—";$("#walletPreviewTotal").textContent="—";
    }
  }

  async function topup(e){
    e.preventDefault(); const btn=e.currentTarget.querySelector("button"); btn.disabled=true;
    try{
      const r=await api("/api/client/wallet/topups",{method:"POST",body:JSON.stringify({
        amount:Number($("#walletTopupAmount").value),paymentMethod:$("#walletTopupMethod").value
      })});
      if(r.checkoutUrl){location.href=r.checkoutUrl;return;}
      if(r.balance!=null) toast("Saldo de homologação adicionado.");
      await loadWallet(); await loadClientHome();
    }catch(err){toast(err.message,"error");}
    finally{btn.disabled=false;}
  }

  async function loadConnections(){
    if(!isClient())return;
    const d=await api("/api/client/connections"); client.connections=d.connections||[];
    $("#platformCards").innerHTML=(d.supported||[]).map(p=>`
      <article class="platform-card">
        <div class="platform-logo">${escapeHtml(p.name.slice(0,2).toUpperCase())}</div>
        <div><strong>${escapeHtml(p.name)}</strong><p>Importe pedidos e centralize fretes, etiquetas, coletas e rastreamento na Postal.</p></div>
        <button class="primary" type="button" data-platform="${escapeHtml(p.code)}">Conectar</button>
      </article>`).join("");
    $$("#platformCards [data-platform]").forEach(btn=>btn.addEventListener("click",async()=>{
      const name=prompt("Nome desta loja na Postal (opcional):","Minha loja")||"";
      try{
        const r=await api("/api/client/connections",{method:"POST",body:JSON.stringify({platform:btn.dataset.platform,displayName:name})});
        toast(r.message||"Conexão preparada."); await loadConnections();
      }catch(err){toast(err.message,"error");}
    }));
    $("#connectionsList").innerHTML=client.connections.length?client.connections.map(x=>`
      <div class="inventory-row">
        <div><span class="addon-type">${escapeHtml(x.platform)}</span><strong>${escapeHtml(x.displayName||"Loja")}</strong><small>Conexão Postal</small></div>
        <div><span>Status</span><strong>${escapeHtml(x.status)}</strong></div>
        <div><span>Pedidos</span><strong>${Number(x.importedOrders||0)}</strong></div>
      </div>`).join(""):'<div class="empty-state">Nenhuma loja conectada ainda.</div>';
    $("#ecommerceOrdersList").innerHTML=(d.orders||[]).length?(d.orders||[]).map(o=>`
      <div class="inventory-row"><div><span class="addon-type">${escapeHtml(o.platform)}</span><strong>#${escapeHtml(o.external_order_id)}</strong><small>${escapeHtml(o.connection_name||"")}</small></div>
      <div><span>Cliente</span><strong>${escapeHtml(o.customer_name||"—")}</strong></div><div><span>Status</span><strong>${escapeHtml(o.external_status||o.import_status)}</strong></div></div>`).join("")
      :'<div class="empty-state">Nenhum pedido importado ainda.</div>';
  }

  async function loadPoints(){
    if(!isClient())return;
    const d=await api("/api/client/points"); client.points=d.points||[];
    const sel=$("#clientDropoffStore");
    sel.innerHTML=client.points.length?client.points.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${escapeHtml(p.address?.city||p.code)}</option>`).join("")
      :'<option value="">Nenhum ponto disponível</option>';
  }

  async function prepareShipment(){
    if(!isClient())return false;
    await Promise.all([loadPoints(),loadWallet()]);
    $("#clientFirstMilePanel").classList.remove("hidden");
    $(".addons-panel")?.classList.add("hidden");
    $("#paymentMethod").value="SALDO";
    $("#paymentMethod").closest("label")?.classList.add("hidden");
    $("#paymentMethodNote").textContent="O envio será debitado do seu saldo Postal. A coleta ou postagem no ponto custa R$ 5,00 por pacote.";
    $("#paymentFee").textContent=money(0);
    $("#paymentAddons").previousElementSibling && ($("#paymentAddons").previousElementSibling.textContent="Primeira milha");
    $("#createShipmentBtn").textContent="Pagar com saldo e gerar envio";
    $("#shipmentLockNote").textContent="Saldo disponível: "+money(client.walletBalance);
    refreshFirstMileTotal();
    return true;
  }

  function refreshFirstMileTotal(){
    if(!isClient()||!state.selectedOption)return;
    const count=Math.max(1,Number($("#clientPackageCount")?.value||1));
    const fee=Number(state.config?.clientPickupFeePerPackage||5)*count;
    $("#paymentFreight").textContent=money(state.selectedOption.precoVenda);
    $("#paymentAddons").textContent=money(fee);
    $("#paymentFee").textContent=money(0);
    $("#paymentTotal").textContent=money(Number(state.selectedOption.precoVenda||0)+fee);
    $("#shipPrice").textContent=money(Number(state.selectedOption.precoVenda||0)+fee);
  }

  async function submitShipment(){
    if(!isClient())return false;
    const firstMileType=document.querySelector('input[name="firstMileType"]:checked')?.value||"PICKUP";
    const payload={
      selectionToken:state.selectedOption.selectionToken,
      carrier:state.selectedOption.transportadora,
      sender:partyData("sender"),recipient:partyData("recipient"),items:contentData(),
      invoiceNumber:currentInvoiceNumber(),firstMileType,
      packageCount:Number($("#clientPackageCount").value||1),
      dropoffStoreId:firstMileType==="DROPOFF"?$("#clientDropoffStore").value:null,
      latitude:firstMileType==="PICKUP"?client.pickupCoords?.latitude:null,
      longitude:firstMileType==="PICKUP"?client.pickupCoords?.longitude:null,
      scheduledFor:$("#clientScheduledFor").value||null,collectionNotes:$("#clientCollectionNotes").value.trim()
    };
    const r=await api("/api/client/orders",{method:"POST",body:JSON.stringify(payload)});
    client.walletBalance=Number(r.balance||client.walletBalance);
    toast(r.order?.isSimulation?"Envio de homologação criado com saldo teste.":"Envio criado com saldo Postal.");
    navigate("orders"); return true;
  }

  function renderCollectionCard(x,role){
    const addr=x.address||{};
    const div=document.createElement("article"); div.className="order-card";
    div.innerHTML=`
      <div class="order-top"><div><div class="order-id">#${escapeHtml(String(x.id).slice(0,8).toUpperCase())}</div>
      <h3>${x.service_type==="PICKUP"?"Coleta no cliente":"Postagem no ponto"} <span>${Number(x.package_count)} pacote(s)</span></h3>
      <p>${escapeHtml(addr.address||addr.logradouro||"")} ${escapeHtml(addr.number||"")} · ${escapeHtml(addr.city||"")}</p></div>
      <span class="order-status info">${escapeHtml(x.status)}</span></div>
      <div class="order-metrics"><div><span>Taxa cliente</span><strong>${money(x.total_fee)}</strong></div>
      <div><span>Ponto</span><strong>${escapeHtml(x.store_name||"Aguardando direção")}</strong></div>
      <div><span>Remuneração ponto</span><strong>${money(x.point_compensation)}</strong></div>
      <div><span>Solicitado</span><strong>${new Date(x.requested_at).toLocaleDateString("pt-BR")}</strong></div></div>
      <div class="order-actions"></div>`;
    const actions=div.querySelector(".order-actions");
    if(role==="ADMIN"){
      const sel=document.createElement("select"); sel.className="compact-select";
      sel.innerHTML='<option value="">Atribuir ponto...</option>'+client.adminStores.filter(s=>s.active).map(s=>`<option value="${s.id}" ${s.id===x.assigned_store_id?"selected":""}>${escapeHtml(s.name)}</option>`).join("");
      const btn=document.createElement("button");btn.className="primary";btn.textContent="Direcionar";btn.onclick=async()=>{
        if(!sel.value)return; await api("/api/collections/"+x.id,{method:"PATCH",body:JSON.stringify({status:"ASSIGNED",assignedStoreId:sel.value})}); await loadCollections();
      };actions.append(sel,btn);
    }else if(["STORE_OWNER","STORE_CLERK","OPS"].includes(role)){
      const stages=x.service_type==="PICKUP"?["ACCEPTED","EN_ROUTE","COLLECTED"]:["RECEIVED_AT_POINT"];
      stages.forEach(s=>{const b=document.createElement("button");b.className=s.includes("COLLECTED")||s.includes("RECEIVED")?"primary":"ghost";b.textContent=s==="ACCEPTED"?"Aceitar":s==="EN_ROUTE"?"A caminho":s==="COLLECTED"?"Coletado":"Recebido no ponto";b.onclick=async()=>{await api("/api/collections/"+x.id,{method:"PATCH",body:JSON.stringify({status:s})});await loadCollections();};actions.appendChild(b);});
    }
    return div;
  }

  async function loadCollections(){
    const role=state.user?.role; if(!role)return;
    $("#pickupSettingsCard")?.classList.toggle("hidden",role!=="STORE_OWNER");
    if(role==="STORE_OWNER"){
      const s=await api("/api/store/pickup-settings");
      $("#pickupEnabled").checked=Boolean(s.enabled);$("#pickupRadius").value=s.radiusKm||10;
      $("#pickupLatitude").value=s.latitude??"";$("#pickupLongitude").value=s.longitude??"";
    }
    let d;
    if(role==="CLIENT") d=await api("/api/client/collections");
    else if(role==="ADMIN"){
      const [cols,stores]=await Promise.all([api("/api/admin/collections"),api("/api/admin/stores")]);
      d=cols;client.adminStores=stores.stores||[];
    }else d=await api("/api/store/collections");
    client.collections=d.collections||[];
    $("#collectionsSubtitle").textContent=role==="CLIENT"?"Acompanhe a coleta no seu endereço ou a postagem no ponto escolhido.":role==="ADMIN"?"Direcione coletas para a rede de pontos Postal.":"Veja as coletas direcionadas ao seu ponto.";
    const host=$("#collectionsList");host.innerHTML="";
    if(!client.collections.length){host.innerHTML='<div class="empty-state">Nenhuma coleta pendente.</div>';return;}
    client.collections.forEach(x=>host.appendChild(renderCollectionCard(x,role)));
  }

  async function loadReferrals(){
    if(!isPoint()||!["STORE_OWNER","STORE_CLERK"].includes(state.user.role))return;
    const d=await api("/api/store/referral");
    $("#refClients").textContent=d.stats.referredClients;$("#refShipments").textContent=d.stats.referredShipments;
    $("#refEarnings").textContent=money(d.stats.referralEarnings);
    $("#refLogisticsEarnings").textContent=money(Number(d.stats.pickupEarnings||0)+Number(d.stats.dropoffEarnings||0));
    $("#referralLink").value=d.link;
    $("#referredClientsList").innerHTML=d.clients.length?d.clients.map(x=>`
      <div class="inventory-row"><div><strong>${escapeHtml(x.name)}</strong><small>${escapeHtml(x.email)}</small></div>
      <div><span>Envios</span><strong>${Number(x.shipments||0)}</strong></div><div><span>Desde</span><strong>${new Date(x.created_at).toLocaleDateString("pt-BR")}</strong></div></div>`).join("")
      :'<div class="empty-state">Nenhum cliente indicado ainda.</div>';
  }

  function bind(){
    initRegistration();
    $("#walletTopupForm")?.addEventListener("submit",topup);
    $("#walletTopupAmount")?.addEventListener("input",previewTopup);
    $("#walletTopupMethod")?.addEventListener("change",previewTopup);
    $("#refreshCollectionsBtn")?.addEventListener("click",loadCollections);
    $("#pickupSettingsForm")?.addEventListener("submit",async e=>{
      e.preventDefault();
      try{await api("/api/store/pickup-settings",{method:"PATCH",body:JSON.stringify({
        enabled:$("#pickupEnabled").checked,radiusKm:Number($("#pickupRadius").value||10),
        latitude:$("#pickupLatitude").value||null,longitude:$("#pickupLongitude").value||null
      })});toast("Disponibilidade de coletas atualizada.");}catch(err){toast(err.message,"error");}
    });
    $$('input[name="firstMileType"]').forEach(r=>r.addEventListener("change",()=>{
      const type=document.querySelector('input[name="firstMileType"]:checked')?.value;
      $("#clientDropoffField").classList.toggle("hidden",type!=="DROPOFF");refreshFirstMileTotal();
    }));
    $("#clientPackageCount")?.addEventListener("input",refreshFirstMileTotal);
    $("#clientGeoBtn")?.addEventListener("click",()=>{
      const status=$("#clientGeoStatus");
      if(!navigator.geolocation){status.textContent="Localização não disponível neste navegador.";return;}
      status.textContent="Obtendo localização...";
      navigator.geolocation.getCurrentPosition(pos=>{
        client.pickupCoords={latitude:pos.coords.latitude,longitude:pos.coords.longitude};
        status.textContent="Localização confirmada para roteamento da coleta.";
        toast("Localização vinculada à solicitação de coleta.");
      },()=>{
        client.pickupCoords=null;
        status.textContent="Não foi possível obter a localização. Usaremos CEP e cidade para direcionar.";
      },{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
    });
    $("#copyReferralLinkBtn")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#referralLink").value);toast("Link copiado.");});
    $("#referredClientForm")?.addEventListener("submit",async e=>{
      e.preventDefault();
      try{
        const r=await api("/api/store/clients",{method:"POST",body:JSON.stringify({
          name:$("#referredClientName").value.trim(),email:$("#referredClientEmail").value.trim(),
          phone:$("#referredClientPhone").value,document:$("#referredClientDocument").value,
          password:$("#referredClientPassword").value||undefined
        })});
        toast(r.temporaryPassword?"Cliente criado. Senha inicial: "+r.temporaryPassword:"Cliente criado e vinculado.");
        e.currentTarget.reset();await loadReferrals();
      }catch(err){toast(err.message,"error");}
    });
  }

  window.PostalClient={
    bind,onShowApp,loadClientHome,loadWallet,loadConnections,loadCollections,loadReferrals,
    prepareShipment,submitShipment,refreshFirstMileTotal
  };
  bind();
})();
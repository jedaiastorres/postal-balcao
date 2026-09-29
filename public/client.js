(() => {
  const client = {
    walletBalance: 0,
    points: [],
    collections: [],
    connections: [],
    adminStores: [],
    pickupCoords: null,
    operations: [],
    selectedOperations: new Set(),
    opsStatus: "",
    pendingImport: null
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
    $("#clientTopBalance")?.classList.toggle("hidden",!clientMode);
    document.querySelector('[data-view="inventory"]')?.classList.toggle("hidden",clientMode||!["ADMIN","STORE_OWNER","OPS"].includes(user?.role));
    document.querySelector('[data-view="orders"]')?.classList.toggle("hidden",clientMode);
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
      $("#clientTopBalance")?.classList.remove("hidden");
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
      $("#clientImportedOrders").textContent=d.importedOrders||0;
      $("#clientReadyToShip").textContent=d.readyToShip||0;
      $("#clientSentOrders").textContent=d.sentOrders||0;
      $("#clientTopBalance strong").textContent=money(d.balance);
    }catch(err){toast(err.message,"error");}
  }


  function opsStatusMeta(status){
    return ({
      IMPORTED:["Importado","muted"],
      AWAITING_PAYMENT:["Aguardando pagamento","warning"],
      READY_TO_SHIP:["Pronto para envio","success"],
      SENT:["Enviado","info"]
    })[status]||[status||"—","muted"];
  }

  function visibleOperations(){
    const q=String($("#clientOpsSearch")?.value||"").trim().toLowerCase();
    const source=String($("#clientOpsSourceFilter")?.value||"");
    return (client.operations||[]).filter(item=>{
      if(client.opsStatus&&item.status!==client.opsStatus)return false;
      if(source&&String(item.sourcePlatform||"")!==source)return false;
      if(!q)return true;
      const hay=[
        item.externalOrderId,item.sourceOrderId,item.customerName,item.trackingCode,
        item.sourcePlatform,item.destination,item.id
      ].map(x=>String(x||"").toLowerCase()).join(" ");
      return hay.includes(q);
    });
  }

  function updateBulkBar(){
    const count=client.selectedOperations.size;
    $("#clientSelectedCount").textContent=count;
    $("#clientBulkBar").classList.toggle("hidden",!count);
    const visible=visibleOperations();
    const selectable=visible.filter(x=>x.kind==="SHIPMENT"||x.kind==="IMPORTED");
    $("#clientOpsSelectAll").checked=Boolean(selectable.length)&&selectable.every(x=>client.selectedOperations.has(x.id));
  }

  function renderOperations(){
    const items=visibleOperations();
    const host=$("#clientOpsRows");
    if(!host)return;
    host.innerHTML="";
    if(!items.length){
      host.innerHTML='<tr><td colspan="8"><div class="empty-state">Nenhum pedido neste filtro.</div></td></tr>';
      updateBulkBar(); return;
    }

    items.forEach(item=>{
      const [statusLabel,tone]=opsStatusMeta(item.status);
      const row=document.createElement("tr");
      row.className="client-ops-row";
      const orderCode=item.kind==="IMPORTED"
        ?("#"+escapeHtml(item.externalOrderId||String(item.id).slice(0,8)))
        :("#"+escapeHtml(item.sourceOrderId||String(item.id).slice(0,8).toUpperCase()));
      const source=escapeHtml(item.sourcePlatform||"POSTAL");
      const total=item.kind==="SHIPMENT"?money(item.total):"—";
      row.innerHTML=`
        <td class="check-col"><input type="checkbox" data-op-select="${escapeHtml(item.id)}" ${client.selectedOperations.has(item.id)?"checked":""} /></td>
        <td><strong>${orderCode}</strong><small>${source}</small></td>
        <td><strong>${escapeHtml(item.customerName||"—")}</strong><small>${escapeHtml(item.destination||item.sourceConnection||"")}</small></td>
        <td><span class="source-pill">${source}</span></td>
        <td><span class="order-status ${tone}">${escapeHtml(statusLabel)}</span><small>${escapeHtml(item.internalStatus||item.sourceStatus||"")}</small></td>
        <td><strong>${total}</strong></td>
        <td><strong class="tracking-mini">${escapeHtml(item.trackingCode||"—")}</strong></td>
        <td class="row-action-cell"></td>`;
      const actions=row.querySelector(".row-action-cell");
      if(item.kind==="IMPORTED"){
        const btn=document.createElement("button");btn.className="ghost";btn.type="button";btn.textContent="Preparar envio";
        btn.addEventListener("click",()=>prepareImportedOrder(item.id));
        actions.appendChild(btn);
      }else{
        if(item.status==="READY_TO_SHIP"&&!item.labelReady){
          const btn=document.createElement("button");btn.className="ghost";btn.type="button";btn.textContent="Emitir";
          btn.addEventListener("click",()=>bulkIssue([item.id]));
          actions.appendChild(btn);
        }
        if(item.labelReady){
          const btn=document.createElement("button");btn.className="ghost";btn.type="button";btn.textContent="Etiqueta";
          btn.addEventListener("click",()=>printLabels([item.id]));
          actions.appendChild(btn);
        }
      }
      row.querySelector("[data-op-select]")?.addEventListener("change",e=>{
        if(e.target.checked)client.selectedOperations.add(item.id);else client.selectedOperations.delete(item.id);
        updateBulkBar();
      });
      host.appendChild(row);
    });
    updateBulkBar();
  }

  async function loadOperations(){
    if(!isClient())return;
    const d=await api("/api/client/operations");
    client.operations=d.items||[];
    client.walletBalance=Number(d.balance||0);
    $("#opsBalance").textContent=money(d.balance);
    $("#clientTopBalance strong").textContent=money(d.balance);
    $("#opsCountImported").textContent=d.counts?.imported||0;
    $("#opsCountAwaiting").textContent=d.counts?.awaitingPayment||0;
    $("#opsCountReady").textContent=d.counts?.readyToShip||0;
    $("#opsCountSent").textContent=d.counts?.sent||0;
    $("#opsCountAll").textContent=client.operations.length;
    const sources=[...new Set(client.operations.map(x=>x.sourcePlatform).filter(Boolean))].sort();
    $("#clientOpsSourceFilter").innerHTML='<option value="">Todas</option>'+sources.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
    renderOperations();
  }

  function normalizedImportedPayload(payload){
    const p=payload||{};
    const sender=p.sender||p.remetente||p.origin||p.from||p.shipping_from||{};
    const recipient=p.recipient||p.destinatario||p.destination||p.to||p.shipping_address||p.customer||{};
    const pack=p.package||p.parcel||p.volume||p.shipping_package||{};
    const products=p.items||p.products||p.line_items||[];
    const value=(obj,...keys)=>{for(const k of keys){if(obj&&obj[k]!=null&&obj[k]!=="")return obj[k];}return "";};
    const party=(obj)=>({
      name:value(obj,"name","nome","full_name"),
      document:value(obj,"document","cpfCnpj","cpf_cnpj","cpf","cnpj"),
      phone:value(obj,"phone","telefone","mobile"),
      cep:value(obj,"cep","zip","zipcode","postal_code"),
      address:value(obj,"address","logradouro","street","street_name"),
      number:value(obj,"number","numero","street_number"),
      neighborhood:value(obj,"neighborhood","bairro","district"),
      complement:value(obj,"complement","complemento"),
      city:value(obj,"city","cidade"),
      state:value(obj,"state","uf")
    });
    return {
      sender:party(sender),recipient:party(recipient),
      package:{
        weightKg:Number(value(pack,"weightKg","weight_kg")||0)||Number(value(pack,"weight","peso")||0),
        length:Number(value(pack,"length","comprimento")||0),
        width:Number(value(pack,"width","largura")||0),
        height:Number(value(pack,"height","altura")||0),
        declaredValue:Number(value(pack,"declaredValue","declared_value","value","valor")||0)
      },
      items:(Array.isArray(products)?products:[]).map(x=>({
        description:String(value(x,"description","name","nome","title")||"Produto"),
        quantity:Number(value(x,"quantity","qty","quantidade")||1),
        value:Number(value(x,"value","price","preco","unit_price")||0)
      })),
      invoiceNumber:String(p.invoiceNumber||p.invoice_number||p.nfe||"")
    };
  }

  async function prepareImportedOrder(id){
    try{
      const r=await api("/api/client/imported-orders/"+encodeURIComponent(id));
      const normalized=normalizedImportedPayload(r.order.payload||{});
      client.pendingImport={id:r.order.id,normalized,externalOrderId:r.order.externalOrderId,platform:r.order.platform};
      if(normalized.sender.cep)$("#cepOrigem").value=String(normalized.sender.cep).replace(/\D/g,"");
      if(normalized.recipient.cep)$("#cepDestino").value=String(normalized.recipient.cep).replace(/\D/g,"");
      if(normalized.package.weightKg)$("#peso").value=normalized.package.weightKg;
      if(normalized.package.length)$("#comprimento").value=normalized.package.length;
      if(normalized.package.width)$("#largura").value=normalized.package.width;
      if(normalized.package.height)$("#altura").value=normalized.package.height;
      if(normalized.package.declaredValue)$("#vlDeclarado").value=normalized.package.declaredValue;
      navigate("quote");
      toast("Pedido importado carregado. Confira dimensões e escolha o frete.");
    }catch(err){toast(err.message,"error");}
  }

  function fillImportedShipment(){
    const imp=client.pendingImport?.normalized;if(!imp)return;
    const set=(id,value)=>{const el=$("#"+id);if(el&&value!=null&&String(value)!=="")el.value=value;};
    const apply=(prefix,p)=>{
      set(prefix+"Name",p.name);set(prefix+"Document",p.document);set(prefix+"Phone",p.phone);
      set(prefix+"Cep",p.cep);set(prefix+"Address",p.address);set(prefix+"Number",p.number);
      set(prefix+"Neighborhood",p.neighborhood);set(prefix+"Complement",p.complement);
      set(prefix+"City",[p.city,p.state].filter(Boolean).join("/"));
    };
    apply("sender",imp.sender);apply("recipient",imp.recipient);
    if(imp.items?.length){
      $("#contentItems").innerHTML="";
      imp.items.forEach(item=>addContentItem(item));
    }
    if(imp.invoiceNumber){
      document.querySelector('input[name="documentType"][value="invoice"]').checked=true;
      $("#invoiceField").classList.remove("hidden");$("#invoiceNumber").value=imp.invoiceNumber;
    }
    const later=document.querySelector('input[name="firstMileType"][value="LATER"]');
    if(later)later.checked=true;
  }

  async function bulkIssue(ids){
    const shipmentIds=(ids||[...client.selectedOperations]).filter(id=>{
      const item=client.operations.find(x=>x.id===id);
      return item?.kind==="SHIPMENT"&&item.status==="READY_TO_SHIP"&&!item.labelReady;
    });
    if(!shipmentIds.length){toast("Selecione envios pagos que ainda precisam de etiqueta.","error");return;}
    const r=await api("/api/client/orders/bulk-issue",{method:"POST",body:JSON.stringify({orderIds:shipmentIds})});
    toast(r.failed?`${r.issued} etiqueta(s) emitida(s); ${r.failed} com pendência.`:`${r.issued} etiqueta(s) pronta(s).`);
    await loadOperations();
  }

  async function postPdf(path,payload){
    const response=await fetch(path,{
      method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json","x-csrf-token":state.csrfToken},
      body:JSON.stringify(payload)
    });
    if(!response.ok){
      let message="Não foi possível gerar o arquivo.";
      try{message=(await response.json()).error||message;}catch{}
      throw new Error(message);
    }
    return response.blob();
  }

  async function printLabels(ids){
    const labelIds=(ids||[...client.selectedOperations]).filter(id=>{
      const item=client.operations.find(x=>x.id===id);
      return item?.kind==="SHIPMENT"&&item.labelReady;
    });
    if(!labelIds.length){toast("Selecione pedidos com etiqueta disponível.","error");return;}
    try{
      const blob=await postPdf("/api/client/orders/bulk-labels",{orderIds:labelIds});
      const url=URL.createObjectURL(blob);window.open(url,"_blank","noopener");
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(err){toast(err.message,"error");}
  }

  function openBulkCollection(){
    const selected=[...client.selectedOperations].map(id=>client.operations.find(x=>x.id===id)).filter(Boolean);
    const eligible=selected.filter(x=>x.kind==="SHIPMENT"&&x.status==="READY_TO_SHIP"&&x.labelReady&&!x.collectionId);
    if(!eligible.length){toast("Selecione envios prontos, com etiqueta e ainda sem coleta.","error");return;}
    const first=eligible[0],a=first.sender||{};
    $("#bulkPickupAddress").value=a.address||"";
    $("#bulkPickupNumber").value=a.number||"";
    $("#bulkPickupNeighborhood").value=a.neighborhood||"";
    $("#bulkPickupCep").value=a.cep||"";
    $("#bulkPickupCity").value=a.city||"";
    $("#bulkPickupCount").textContent=eligible.length;
    $("#bulkPickupTotal").textContent=money(eligible.length*Number(state.config?.clientPickupFeePerPackage||5));
    $("#bulkCollectionModal").dataset.orderIds=eligible.map(x=>x.id).join(",");
    $("#bulkCollectionModal").classList.remove("hidden");
  }

  function closeBulkCollection(){
    $("#bulkCollectionModal")?.classList.add("hidden");
  }

  async function confirmBulkCollection(){
    const modal=$("#bulkCollectionModal");
    const orderIds=String(modal.dataset.orderIds||"").split(",").filter(Boolean);
    if(!orderIds.length)return;
    const btn=$("#confirmBulkCollectionBtn");btn.disabled=true;btn.textContent="Solicitando...";
    try{
      const r=await api("/api/client/collections/bulk",{method:"POST",body:JSON.stringify({
        orderIds,
        address:{
          address:$("#bulkPickupAddress").value.trim(),number:$("#bulkPickupNumber").value.trim(),
          neighborhood:$("#bulkPickupNeighborhood").value.trim(),cep:$("#bulkPickupCep").value.trim(),
          city:$("#bulkPickupCity").value.trim()
        },
        scheduledFor:$("#bulkPickupScheduledFor").value||null,
        notes:$("#bulkPickupNotes").value.trim()
      })});
      client.walletBalance=Number(r.balance||client.walletBalance);
      $("#clientTopBalance strong").textContent=money(client.walletBalance);
      toast(r.assignedStore?`Coleta criada e direcionada para ${r.assignedStore.name}.`:"Coleta criada e enviada ao painel da Postal.");
      closeBulkCollection();client.selectedOperations.clear();await loadOperations();await loadClientHome();
    }catch(err){toast(err.message,"error");}
    finally{btn.disabled=false;btn.textContent="Confirmar coleta";}
  }

  async function loadWallet(){
    if(!isClient())return;
    const d=await api("/api/client/wallet");
    client.walletBalance=Number(d.balance||0);
    $("#walletBalanceHero").textContent=money(d.balance);
    $("#clientTopBalance strong").textContent=money(d.balance);
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
    $("#paymentMethodNote").textContent="O envio será debitado do seu Saldo Postal. Você pode gerar a etiqueta agora e solicitar a coleta depois em lote.";
    $("#paymentFee").textContent=money(0);
    $("#paymentAddons").previousElementSibling && ($("#paymentAddons").previousElementSibling.textContent="Primeira milha");
    $("#createShipmentBtn").textContent="Pagar com saldo e gerar envio";
    $("#shipmentLockNote").textContent="Saldo disponível: "+money(client.walletBalance);
    fillImportedShipment();
    refreshFirstMileTotal();
    return true;
  }

  function refreshFirstMileTotal(){
    if(!isClient()||!state.selectedOption)return;
    const count=Math.max(1,Number($("#clientPackageCount")?.value||1));
    const type=document.querySelector('input[name="firstMileType"]:checked')?.value||"LATER";
    const fee=type==="LATER"?0:Number(state.config?.clientPickupFeePerPackage||5)*count;
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
      scheduledFor:$("#clientScheduledFor").value||null,collectionNotes:$("#clientCollectionNotes").value.trim(),
      sourceEcommerceOrderId:client.pendingImport?.id||null
    };
    const r=await api("/api/client/orders",{method:"POST",body:JSON.stringify(payload)});
    client.walletBalance=Number(r.balance||client.walletBalance);
    toast(r.order?.isSimulation?"Envio de homologação criado com saldo Sandbox.":"Envio criado com saldo Postal.");
    client.pendingImport=null;
    client.selectedOperations.clear();
    navigate("clientOrders"); return true;
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
    $("#clientOpsRefreshBtn")?.addEventListener("click",loadOperations);
    $("#clientOpsSearch")?.addEventListener("input",renderOperations);
    $("#clientOpsSourceFilter")?.addEventListener("change",renderOperations);
    $(".client-status-tab").forEach(btn=>btn.addEventListener("click",()=>{
      client.opsStatus=btn.dataset.opsStatus||"";
      $(".client-status-tab").forEach(x=>x.classList.toggle("active",x===btn));
      renderOperations();
    }));
    $("#clientOpsSelectAll")?.addEventListener("change",e=>{
      visibleOperations().forEach(item=>{
        if(e.target.checked)client.selectedOperations.add(item.id);else client.selectedOperations.delete(item.id);
      });
      renderOperations();
    });
    $("#bulkIssueLabelsBtn")?.addEventListener("click",()=>bulkIssue());
    $("#bulkPrintLabelsBtn")?.addEventListener("click",()=>printLabels());
    $("#bulkPickupBtn")?.addEventListener("click",openBulkCollection);
    $("#closeBulkCollectionBtn")?.addEventListener("click",closeBulkCollection);
    $("#cancelBulkCollectionBtn")?.addEventListener("click",closeBulkCollection);
    $("#confirmBulkCollectionBtn")?.addEventListener("click",confirmBulkCollection);
    $("#bulkCollectionModal")?.addEventListener("click",e=>{if(e.target.id==="bulkCollectionModal")closeBulkCollection();});
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
    bind,onShowApp,loadClientHome,loadOperations,loadWallet,loadConnections,loadCollections,loadReferrals,
    prepareShipment,submitShipment,refreshFirstMileTotal
  };
  bind();
})();
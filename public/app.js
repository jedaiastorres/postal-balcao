const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  config: null,
  recent: JSON.parse(localStorage.getItem("postal_recent_quotes") || "[]"),
  currentQuote: null,
  selectedOption: null,
  shipmentResult: null,
  orders: [],
  catalog: [],
  selectedAddons: new Map(),
  inventory: [],
  paymentPreview: null,
  csrfToken: "",
  user: null,
  admin: { stores: [], users: [], catalog: [], creditPartners: [], creditProducts: [] },
  creditProducts: [],
  creditProposals: [],
  inventoryMovements: [],
  analytics: { stores: [], dashboardData: null, cashData: null }
};

const viewMap = {
  dashboard: { el: "#dashboardView", title: "Visão geral" },
  quote: { el: "#quoteView", title: "Simular Frete" },
  shipment: { el: "#shipmentView", title: "Nova Postagem" },
  orders: { el: "#ordersView", title: "Meus Fretes" },
  inventory: { el: "#inventoryView", title: "Produtos & Estoque" },
  master: { el: "#masterView", title: "Painel Master" },
  supervisor: { el: "#supervisorView", title: "Supervisão da Rede" },
  clientHome: { el: "#clientHomeView", title: "Minha Postal" },
  clientOrders: { el: "#clientOrdersView", title: "Pedidos" },
  wallet: { el: "#walletView", title: "Saldo" },
  connections: { el: "#connectionsView", title: "Integrações" },
  collections: { el: "#collectionsView", title: "Coletas" },
  referrals: { el: "#referralsView", title: "Indique & Ganhe" },
  financial: { el: "#financialView", title: "Recebimentos Asaas" },
  storeUsers: { el: "#storeUsersView", title: "Usuários do ponto" },
  cash: { el: "#cashView", title: "Meu Caixa" },
  clients: { placeholder: ["Clientes", "Cadastro rápido de remetentes frequentes para acelerar o atendimento no balcão."] }
};

function money(v) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v || 0));
}

function toast(message, type = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${type === "error" ? "error" : ""}`;
  setTimeout(() => el.classList.remove("show"), 3400);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.csrfToken && ["POST","PUT","PATCH","DELETE"].includes(String(options.method || "GET").toUpperCase())
        ? { "x-csrf-token": state.csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || "Não foi possível concluir a operação.");
  return data;
}

async function loadConfig() {
  const badge = $("#apiBadge");
  badge.className = "status-badge";
  badge.innerHTML = '<span class="dot"></span> Conectando...';
  try {
    state.config = await api("/api/public-config");
    if (state.config.providerConfigured) {
      badge.className = "status-badge connected";
      badge.innerHTML = '<span class="dot"></span> ConectEnvios conectada';
      $("#quoteModeLabel").textContent = "Cotação real pela ConectEnvios";
    } else {
      badge.className = "status-badge demo";
      badge.innerHTML = '<span class="dot"></span> Modo demonstração';
      $("#quoteModeLabel").textContent = "Dados demonstrativos";
    }
    $("#demoLoginHint").style.display = state.config.demoAuth ? "block" : "none";
    document.body.dataset.paymentsOperational = state.config.paymentsOperational ? "true" : "false";
    $("#commissionCaption").textContent = `${state.config.commissionPercent}% sobre o preço final`;
    $("#commissionBig").textContent = `${state.config.commissionPercent}%`;
    return state.config;
  } catch (error) {
    badge.className = "status-badge error";
    badge.innerHTML = '<span class="dot"></span> Falha de conexão';
    throw error;
  }
}

function showApp(user) {
  state.user = user || null;
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#partnerEmail").textContent = user?.storeName || user?.name || user?.email || "parceiro";
  $("#adminNavSection")?.classList.toggle("hidden", !["ADMIN","SUPERVISOR"].includes(user?.role));
  document.querySelectorAll(".master-only").forEach(el=>el.classList.toggle("hidden",user?.role!=="ADMIN"));
  document.querySelectorAll(".supervisor-only").forEach(el=>el.classList.toggle("hidden",user?.role!=="SUPERVISOR"));

  const canSell = ["ADMIN","STORE_OWNER","STORE_CLERK","CLIENT"].includes(user?.role);
  const canManageStock = ["ADMIN","STORE_OWNER","OPS"].includes(user?.role);
  const ownerFinance = ["ADMIN","SUPERVISOR","STORE_OWNER"].includes(user?.role);
  const managementAnalytics = ["ADMIN","SUPERVISOR","STORE_OWNER"].includes(user?.role);
  document.querySelectorAll(".management-analytics-only").forEach(el=>el.classList.toggle("hidden",!managementAnalytics));
  document.querySelectorAll(".local-dashboard-only").forEach(el=>el.classList.toggle("hidden",managementAnalytics));
  document.querySelectorAll(".analytics-global-filter").forEach(el=>el.classList.toggle("hidden",!["ADMIN","SUPERVISOR"].includes(user?.role)));
  document.querySelectorAll(".analytics-network-only").forEach(el=>el.classList.toggle("hidden",!["ADMIN","SUPERVISOR"].includes(user?.role)));

  document.querySelector('[data-view="quote"]')?.classList.toggle("hidden", !canSell);
  document.querySelector('[data-view="inventory"]')?.classList.toggle("hidden", !canManageStock);
  document.querySelector('[data-view="cash"]')?.classList.toggle("hidden", !ownerFinance);
  document.querySelectorAll(".owner-finance-only").forEach(el => el.classList.toggle("hidden", user?.role !== "STORE_OWNER"));

  const clerkPostingOnly = user?.role === "STORE_CLERK";
  const clerkAllowedViews = new Set(["quote","orders","collections"]);
  document.querySelectorAll(".sidebar .nav-item").forEach(btn => {
    if (clerkPostingOnly && !clerkAllowedViews.has(btn.dataset.view)) {
      btn.dataset.clerkHidden = "1";
      btn.classList.add("hidden");
    } else if (!clerkPostingOnly && btn.dataset.clerkHidden === "1") {
      delete btn.dataset.clerkHidden;
      btn.classList.remove("hidden");
    }
  });
  $("#metricCommission")?.closest(".metric-card")?.classList.toggle("hidden", clerkPostingOnly);
  $("#commissionBig")?.closest(".accent-panel")?.classList.toggle("hidden", clerkPostingOnly);

  window.PostalClient?.onShowApp?.(user);
  $("#inventorySalePrice")?.toggleAttribute("disabled", user?.role !== "ADMIN");

  if (user?.storeCommissionPercent != null && user?.role !== "STORE_CLERK") {
    const pct = Number(user.storeCommissionPercent).toFixed(1).replace(".0","");
    $("#commissionCaption").textContent = pct + "% sobre o preço final";
    $("#commissionBig").textContent = pct + "%";
  }

  refreshDashboard();
  if (managementAnalytics) loadManagementAnalytics();

  const params = new URLSearchParams(window.location.search);
  if (!params.get("payment") && user?.role === "STORE_CLERK") {
    navigate("quote");
  }
  if (!params.get("payment") && user?.role === "SUPERVISOR") {
    navigate("supervisor");
  }
  if (params.get("payment")) {
    const isTopup = user?.role === "CLIENT" && String(params.get("order") || "").startsWith("TOPUP-");
    navigate(isTopup ? "wallet" : "orders");
    toast(params.get("payment") === "success"
      ? (isTopup ? "Pagamento concluído. Seu saldo será atualizado após a confirmação." : "Pagamento concluído. Estamos confirmando pelo webhook.")
      : (isTopup ? "Recarga não concluída. Você pode tentar novamente." : "Pagamento não concluído. Você pode tentar novamente em Meus Fretes."));
    history.replaceState({}, "", window.location.pathname);
  }
}

function showLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}

async function checkSession() {
  try {
    await loadConfig();
  } catch (error) {
    console.error("Falha ao carregar configuração:", error);
    showLogin();
    toast("Não foi possível conectar ao servidor. Atualize a página.", "error");
    return;
  }
  try {
    const session = await api("/api/session");
    state.csrfToken = session.csrfToken || "";
    showApp(session.user);
  } catch {
    showLogin();
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = event.currentTarget.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#loginEmail").value.trim(),
        password: $("#loginPassword").value
      })
    });
    state.csrfToken = result.csrfToken || "";
    showApp(result.user);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar no painel";
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  state.csrfToken = "";
  state.user = null;
  showLogin();
});

function closeChangePasswordModal(){
  $("#changePasswordModal")?.classList.add("hidden");
  $("#changePasswordForm")?.reset();
}
$("#changePasswordBtn")?.addEventListener("click",()=>$("#changePasswordModal")?.classList.remove("hidden"));
$("#closeChangePasswordBtn")?.addEventListener("click",closeChangePasswordModal);
$("#cancelChangePasswordBtn")?.addEventListener("click",closeChangePasswordModal);
$("#changePasswordModal")?.addEventListener("click",e=>{if(e.target.id==="changePasswordModal")closeChangePasswordModal();});
$("#changePasswordForm")?.addEventListener("submit",async event=>{
  event.preventDefault();
  const currentPassword=$("#currentPassword").value;
  const newPassword=$("#newPassword").value;
  const confirm=$("#confirmNewPassword").value;
  if(newPassword!==confirm){
    toast("A confirmação da nova senha não confere.","error");
    return;
  }
  const btn=event.currentTarget.querySelector('button[type="submit"]');
  btn.disabled=true;btn.textContent="Salvando...";
  try{
    const r=await api("/api/account/password",{
      method:"POST",
      body:JSON.stringify({currentPassword,newPassword})
    });
    closeChangePasswordModal();
    state.csrfToken="";
    state.user=null;
    showLogin();
    $("#loginPassword").value="";
    toast(r.message||"Senha alterada. Entre novamente.");
  }catch(err){
    toast(err.message,"error");
  }finally{
    btn.disabled=false;btn.textContent="Salvar nova senha";
  }
});

function navigate(name) {
  if (name === "master" && state.user?.role !== "ADMIN") {
    toast("Área exclusiva da administração Postal.", "error");
    return;
  }
  if (name === "supervisor" && !["ADMIN","SUPERVISOR"].includes(state.user?.role)) {
    toast("Área exclusiva da supervisão da rede.", "error");
    return;
  }
  if (state.user?.role === "STORE_CLERK" && !["quote","shipment","orders","collections"].includes(name)) {
    toast("Este usuário possui acesso às postagens e coletas do ponto.", "error");
    return;
  }
  if (["quote","shipment"].includes(name) && !["ADMIN","STORE_OWNER","STORE_CLERK","CLIENT"].includes(state.user?.role)) {
    toast("Este perfil não possui permissão para vender fretes.", "error");
    return;
  }
  if (name === "inventory" && !["ADMIN","STORE_OWNER","OPS"].includes(state.user?.role)) {
    toast("Este perfil não possui permissão para gerenciar estoque.", "error");
    return;
  }
  if (["financial","storeUsers"].includes(name) && state.user?.role !== "STORE_OWNER") {
    toast("A conta de recebimento só pode ser alterada pelo dono do ponto.", "error");
    return;
  }
  if (["clientHome","clientOrders","wallet","connections"].includes(name) && state.user?.role !== "CLIENT") {
    toast("Área exclusiva para clientes Postal.", "error");
    return;
  }
  if (name === "referrals" && state.user?.role !== "STORE_OWNER") {
    toast("Área disponível para pontos parceiros.", "error");
    return;
  }
  if (name === "collections" && !["ADMIN","SUPERVISOR","STORE_OWNER","STORE_CLERK","OPS","CLIENT"].includes(state.user?.role)) {
    toast("Perfil sem acesso ao painel de coletas.", "error");
    return;
  }

  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".nav-item").forEach(v => v.classList.toggle("active", v.dataset.view === name));

  const spec = viewMap[name] || viewMap.dashboard;
  if (spec.el) {
    $(spec.el).classList.remove("hidden");
    $("#pageTitle").textContent = spec.title;
  } else {
    $("#placeholderView").classList.remove("hidden");
    $("#placeholderTitle").textContent = spec.placeholder[0];
    $("#placeholderText").textContent = spec.placeholder[1];
    $("#pageTitle").textContent = spec.placeholder[0];
  }
  $(".sidebar").classList.remove("open");
  if (name === "dashboard" && ["ADMIN","SUPERVISOR","STORE_OWNER"].includes(state.user?.role)) loadManagementAnalytics();
  if (name === "orders") loadOrders();
  if (name === "inventory") loadInventory();
  if (name === "financial") loadStoreFinancialSettings();
  if (name === "storeUsers") loadStoreUsers();
  if (name === "cash") loadCash();
  if (name === "supervisor") loadSupervisor();
  if (name === "master" && state.user?.role === "ADMIN") loadMaster();
  if (name === "clientHome") window.PostalClient?.loadClientHome?.();
  if (name === "clientOrders") window.PostalClient?.loadOperations?.();
  if (name === "wallet") window.PostalClient?.loadWallet?.();
  if (name === "connections") window.PostalClient?.loadConnections?.();
  if (name === "collections") window.PostalClient?.loadCollections?.();
  if (name === "referrals") window.PostalClient?.loadReferrals?.();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$(".nav-item").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.view)));
$$("[data-go]").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.go)));
$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));

["altura","largura","comprimento"].forEach(id => {
  $(`#${id}`).addEventListener("input", () => {
    const total = ["altura","largura","comprimento"].reduce((sum, key) => sum + Number($(`#${key}`).value || 0), 0);
    $("#dimensionTotal").textContent = `${total.toFixed(total % 1 ? 1 : 0)} cm`;
  });
});

function onlyDigits(value) { return String(value || "").replace(/\D/g, ""); }

function formatCepInput(el) {
  const digits = onlyDigits(el.value).slice(0,8);
  el.value = digits.length > 5 ? `${digits.slice(0,5)}-${digits.slice(5)}` : digits;
}
$("#cepOrigem").addEventListener("input", e => formatCepInput(e.target));
$("#cepDestino").addEventListener("input", e => formatCepInput(e.target));


function invalidateQuoteSelection() {
  state.selectedOption = null;
  state.shipmentResult = null;
  $("#resultsWrap")?.classList.add("hidden");
  $("#selectionSummary")?.classList.add("hidden");
}

function primaryVolumeData() {
  return {
    peso:Number($("#peso").value || 0),
    comprimento:Number($("#comprimento").value || 0),
    largura:Number($("#largura").value || 0),
    altura:Number($("#altura").value || 0),
    vlDeclarado:Number($("#vlDeclarado").value || 0)
  };
}

function quoteVolumePayloads() {
  const volumes = [primaryVolumeData()];

  document.querySelectorAll("#extraQuoteVolumes .extra-volume-card").forEach(card => {
    volumes.push({
      peso: Number(card.querySelector('[data-field="peso"]').value || 0),
      comprimento: Number(card.querySelector('[data-field="comprimento"]').value || 0),
      largura: Number(card.querySelector('[data-field="largura"]').value || 0),
      altura: Number(card.querySelector('[data-field="altura"]').value || 0),
      vlDeclarado: Number(card.querySelector('[data-field="vlDeclarado"]').value || 0)
    });
  });
  return volumes;
}

function updateQuoteVolumeUi() {
  const cards = [...document.querySelectorAll("#extraQuoteVolumes .extra-volume-card")];
  cards.forEach((card,index) => {
    const number=index + 2;
    card.dataset.volumeNumber=String(number);
    card.querySelector("[data-volume-title]").textContent="VOLUME "+number;
  });
  const count=1 + cards.length;
  $("#quoteVolumeCount").textContent=count+" volume"+(count===1?"":"s");
  if($("#clientPackageCount")) $("#clientPackageCount").value=String(count);
}

function addQuoteVolume(data = {}) {
  const current=1 + document.querySelectorAll("#extraQuoteVolumes .extra-volume-card").length;
  if(current>=50){
    toast("O limite é de 50 volumes por envio.","error");
    return;
  }
  const number=current + 1;
  const card=document.createElement("section");
  card.className="extra-volume-card";
  card.innerHTML=`
    <div class="extra-volume-head">
      <div><span data-volume-title>VOLUME ${number}</span><strong>Caixa</strong></div>
      <div class="quote-volume-actions">
        <button class="ghost compact duplicate-volume-btn" type="button">Duplicar</button>
        <button class="ghost compact remove-volume-btn" type="button">Remover</button>
      </div>
    </div>
    <div class="extra-volume-grid">
      <label><span>PESO*</span><div class="inline-input"><input data-field="peso" type="number" min="0.01" step="0.01" value="${Number(data.peso ?? 1)}" required /><em>kg</em></div></label>
      <label><span>ALTURA*</span><div class="inline-input"><input data-field="altura" type="number" min="1" step="0.1" value="${Number(data.altura ?? 10)}" required /><em>cm</em></div></label>
      <label><span>LARGURA*</span><div class="inline-input"><input data-field="largura" type="number" min="1" step="0.1" value="${Number(data.largura ?? 15)}" required /><em>cm</em></div></label>
      <label><span>COMPRIMENTO*</span><div class="inline-input"><input data-field="comprimento" type="number" min="1" step="0.1" value="${Number(data.comprimento ?? 20)}" required /><em>cm</em></div></label>
      <label><span>VALOR DECLARADO*</span><div class="inline-input"><em>R$</em><input data-field="vlDeclarado" type="number" min="0" step="0.01" value="${Number(data.vlDeclarado ?? 0)}" required /></div></label>
    </div>`;
  card.querySelector(".duplicate-volume-btn").addEventListener("click",()=>{
    addQuoteVolume({
      peso:Number(card.querySelector('[data-field="peso"]').value || 0),
      comprimento:Number(card.querySelector('[data-field="comprimento"]').value || 0),
      largura:Number(card.querySelector('[data-field="largura"]').value || 0),
      altura:Number(card.querySelector('[data-field="altura"]').value || 0),
      vlDeclarado:Number(card.querySelector('[data-field="vlDeclarado"]').value || 0)
    });
  });
  card.querySelector(".remove-volume-btn").addEventListener("click",()=>{
    card.remove();
    updateQuoteVolumeUi();
    invalidateQuoteSelection();
  });
  card.querySelectorAll("input").forEach(input=>input.addEventListener("input",invalidateQuoteSelection));
  $("#extraQuoteVolumes").appendChild(card);
  updateQuoteVolumeUi();
  invalidateQuoteSelection();
}

$("#duplicatePrimaryVolumeBtn")?.addEventListener("click",()=>addQuoteVolume(primaryVolumeData()));
$("#addQuoteVolumeBtn")?.addEventListener("click",()=>addQuoteVolume());
["peso","altura","largura","comprimento","vlDeclarado"].forEach(id=>{
  $("#"+id)?.addEventListener("input",invalidateQuoteSelection);
});

$("#quoteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#quoteBtn");
  btn.disabled = true;
  btn.textContent = "Consultando...";
  $("#resultsWrap").classList.add("hidden");

  const volumes = quoteVolumePayloads();
  const payload = {
    cepOrigem: onlyDigits($("#cepOrigem").value),
    cepDestino: onlyDigits($("#cepDestino").value),
    peso: String($("#peso").value),
    comprimento: String($("#comprimento").value),
    largura: String($("#largura").value),
    altura: String($("#altura").value),
    vlDeclarado: String($("#vlDeclarado").value),
    volumes
  };

  try {
    if (payload.cepOrigem.length !== 8 || payload.cepDestino.length !== 8) {
      throw new Error("Informe CEPs com 8 dígitos.");
    }
    const invalidVolume = volumes.findIndex(v =>
      !(Number(v.peso)>0) || !(Number(v.comprimento)>0) || !(Number(v.largura)>0) || !(Number(v.altura)>0) || Number(v.vlDeclarado)<0
    );
    if (invalidVolume >= 0) throw new Error("Revise peso e dimensões do volume "+(invalidVolume+1)+".");
    const result = await api("/api/cotacao", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.currentQuote = payload;
    state.selectedOption = null;
    state.shipmentResult = null;
    if (result.commissionPercent != null) {
      const pct = Number(result.commissionPercent).toFixed(1).replace(".0","");
      $("#commissionCaption").textContent = pct + "% sobre o preço final";
      $("#commissionBig").textContent = pct + "%";
    }
    renderResults(result, payload);
    saveRecent(result, payload);
    refreshDashboard();
    if (result.demo) toast("Cotação demonstrativa concluída. Adicione o token da ConectEnvios para consultar a API real.");
    else toast("Cotação real concluída.");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcular frete";
  }
});

function renderResults(result, payload) {
  const speedInfo = Number.isFinite(Number(result.quoteElapsedMs))
    ? ` • ${(Number(result.quoteElapsedMs)/1000).toFixed(1).replace(".",",")}s${Number(result.cacheHits||0)>0?` • ${Number(result.cacheHits)} em cache`:""}`
    : "";
  $("#resultsInfo").textContent = `${result.options.length} opção(ões) • ${result.volumeCount || payload.volumes?.length || 1} volume(s) • menor preço primeiro${speedInfo}`;
  const list = $("#resultsList");
  list.innerHTML = "";
  $("#selectionSummary")?.classList.add("hidden");

  const minPrice = Math.min(...result.options.map(o => o.precoVenda));
  const minDays = Math.min(...result.options.map(o => o.prazoEntrega || 999));

  result.options.forEach((option, index) => {
    const card = document.createElement("article");
    card.className = "result-card";
    card.dataset.optionIndex = String(index);

    let badge = "";
    if (option.precoVenda === minPrice) badge = "Menor preço";
    else if (option.prazoEntrega === minDays) badge = "Mais rápido";

    card.innerHTML = `
      <div class="result-brand">
        <strong>${escapeHtml(option.transportadora)}</strong>
        <span>${escapeHtml(option.produto)}</span>
        ${badge ? `<em class="result-badge">${badge}</em>` : ""}
      </div>
      <div class="result-block">
        <span>Prazo</span>
        <strong>${option.prazoEntrega || "—"} dias</strong>
      </div>
      <div class="result-block result-price price-reveal" tabindex="0" role="button"
           aria-label="Preço ao cliente ${money(option.precoVenda)}. Passe o mouse ou toque para ver a comissão do ponto.">
        <span class="price-total-label">Valor do frete</span>
        <strong class="price-total">${money(option.precoVenda)}</strong>
        <span class="price-commission-label">Sua comissão</span>
        <strong class="price-commission">${money(option.comissaoParceiro)}</strong>
        <small>${option.hubTransferApplied ? "Inclui "+money(option.hubTransferTotal)+" de transferência ao hub • " : ""}Taxa de pagamento é somada no fechamento • passe o mouse para ver sua comissão</small>
      </div>
      <button class="select-btn" type="button">Selecionar</button>
    `;

    const priceReveal = card.querySelector(".price-reveal");
    if (["CLIENT","STORE_CLERK"].includes(state.user?.role)) {
      card.querySelector(".price-commission-label")?.classList.add("hidden");
      card.querySelector(".price-commission")?.classList.add("hidden");
      const hint = priceReveal.querySelector("small");
      if (hint) hint.textContent = (option.hubTransferApplied ? "Inclui "+money(option.hubTransferTotal)+" de transferência ao hub · " : "") + (state.user?.role === "STORE_CLERK" ? "Valor a cobrar do cliente" : "Preço Postal para sua conta");
    }
    priceReveal.addEventListener("click", () => {
      priceReveal.classList.toggle("show-commission");
    });
    priceReveal.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        priceReveal.classList.toggle("show-commission");
      }
    });

    card.querySelector(".select-btn").addEventListener("click", () => {
      state.selectedOption = option;
      list.querySelectorAll(".result-card").forEach(el => {
        el.classList.remove("selected");
        const button = el.querySelector(".select-btn");
        if (button) button.textContent = "Selecionar";
      });
      card.classList.add("selected");
      card.querySelector(".select-btn").textContent = "Selecionado";

      const summary = $("#selectionSummary");
      if (summary) {
        $("#selectedCarrier").textContent = option.transportadora;
        $("#selectedService").textContent = option.produto;
        $("#selectedDeadline").textContent = `${option.prazoEntrega || "—"} dias`;
        $("#selectedPrice").textContent = money(option.precoVenda);
        summary.classList.remove("hidden");
        summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });

    list.appendChild(card);
  });

  $("#resultsWrap").classList.remove("hidden");
  $("#resultsWrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

function saveRecent(result, payload) {
  const best = result.options[0];
  state.recent.unshift({
    when: new Date().toISOString(),
    origem: payload.cepOrigem,
    destino: payload.cepDestino,
    transportadora: best.transportadora,
    produto: best.produto,
    price: best.precoVenda,
    commission: best.comissaoParceiro,
    volumeCount: payload.volumes?.length || 1
  });
  state.recent = state.recent.slice(0, 8);
  localStorage.setItem("postal_recent_quotes", JSON.stringify(state.recent));
}

function refreshDashboard() {
  const count = state.recent.length;
  const revenue = state.recent.reduce((s, q) => s + Number(q.price || 0), 0);
  const commission = state.recent.reduce((s, q) => s + Number(q.commission || 0), 0);
  $("#metricQuotes").textContent = count;
  $("#metricRevenue").textContent = money(revenue);
  $("#metricCommission").textContent = money(commission);

  const host = $("#recentQuotes");
  if (!count) {
    host.className = "empty-state";
    host.textContent = "Nenhuma cotação realizada ainda.";
    return;
  }
  host.className = "recent-list";
  host.innerHTML = state.recent.slice(0,5).map(q => `
    <div class="recent-item">
      <div>
        <strong>${escapeHtml(q.transportadora)} • ${escapeHtml(q.produto)}</strong>
        <span>${maskCep(q.origem)} → ${maskCep(q.destino)}</span>
      </div>
      <small>${money(q.price)}</small>
      <b>+ ${money(q.commission)}</b>
    </div>
  `).join("");
}

function maskCep(v) {
  const s = onlyDigits(v);
  return s.length === 8 ? `${s.slice(0,5)}-${s.slice(5)}` : s;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function addContentItem(data = {}) {
  const host = $("#contentItems");
  const row = document.createElement("div");
  row.className = "content-item";
  row.innerHTML = `
    <label class="content-description">Descrição*<input class="item-description" value="${escapeHtml(data.description || "")}" required /></label>
    <label>Qtd.*<input class="item-quantity" type="number" min="1" step="1" value="${Number(data.quantity || 1)}" required /></label>
    <label>Valor unitário*<div class="money-field"><span>R$</span><input class="item-value" type="number" min="0" step="0.01" value="${Number(data.value || 0).toFixed(2)}" required /></div></label>
    <button class="remove-item" type="button" aria-label="Remover item">×</button>
  `;
  row.querySelector(".remove-item").addEventListener("click", () => {
    if ($(".content-item").length <= 1) {
      toast("A declaração precisa ter pelo menos um item.", "error");
      return;
    }
    row.remove();
  });
  host.appendChild(row);
}

function partyData(prefix) {
  return {
    name: $(`#${prefix}Name`).value.trim(),
    document: $(`#${prefix}Document`).value.trim(),
    phone: $(`#${prefix}Phone`).value.trim(),
    email: $(`#${prefix}Email`).value.trim(),
    cep: onlyDigits($(`#${prefix}Cep`).value),
    address: $(`#${prefix}Address`).value.trim(),
    number: $(`#${prefix}Number`).value.trim(),
    neighborhood: $(`#${prefix}Neighborhood`).value.trim(),
    complement: $(`#${prefix}Complement`).value.trim(),
    city: $(`#${prefix}City`).value.trim()
  };
}

function contentData() {
  return $$(".content-item").map(row => ({
    description: row.querySelector(".item-description").value.trim(),
    quantity: Number(row.querySelector(".item-quantity").value || 1),
    value: Number(row.querySelector(".item-value").value || 0)
  }));
}

function selectedAddonPayload() {
  return [...state.selectedAddons.entries()]
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([code, quantity]) => ({ code, quantity: Number(quantity) }));
}

async function loadShipmentCatalog() {
  const host = $("#addonsCatalog");
  if (!host) return;
  host.innerHTML = '<div class="empty-state">Carregando produtos e serviços...</div>';
  try {
    const result = await api("/api/catalog");
    state.catalog = result.items || [];
    renderShipmentCatalog();
  } catch (err) {
    host.innerHTML = `<div class="empty-state">Não foi possível carregar o catálogo. ${escapeHtml(err.message)}</div>`;
  }
}

function renderShipmentCatalog() {
  const host = $("#addonsCatalog");
  if (!host) return;
  const items = (state.catalog || []).filter(item => {
    if (item.itemType === "PRODUCT") {
      return Number(item.unitPrice || 0) > 0 && Number(item.availableQuantity || 0) > 0;
    }
    return Number(item.unitPrice || 0) >= 0;
  });

  if (!items.length) {
    host.innerHTML = '<div class="empty-state">Nenhum produto com estoque e preço disponível. Use Produtos & Estoque para receber embalagens e definir preço.</div>';
    return;
  }

  host.innerHTML = "";
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "addon-item";
    const current = Number(state.selectedAddons.get(item.code) || 0);
    const stockText = item.itemType === "PRODUCT"
      ? `${Number(item.availableQuantity || 0)} disponível(is)`
      : "Serviço";
    row.innerHTML = `
      <div class="addon-main">
        <span class="addon-type">${item.itemType === "PRODUCT" ? "PRODUTO" : "SERVIÇO"} · ${escapeHtml(item.category || "")}</span>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.description || stockText)}</small>
      </div>
      <div class="addon-stock">${escapeHtml(stockText)}</div>
      <div class="addon-price">${money(item.unitPrice)}</div>
      <label class="addon-qty">Qtd.
        <input type="number" min="0" step="1" value="${current}" />
      </label>
    `;

    const input = row.querySelector("input");
    input.max = item.itemType === "PRODUCT" ? String(item.availableQuantity || 0) : "999";
    input.addEventListener("input", async () => {
      let qty = Math.max(0, Number(input.value || 0));
      if (item.itemType === "PRODUCT") qty = Math.min(qty, Number(item.availableQuantity || 0));
      input.value = String(qty);
      if (qty > 0) state.selectedAddons.set(item.code, qty);
      else state.selectedAddons.delete(item.code);
      await refreshPaymentPreview();
    });
    host.appendChild(row);
  });
}

async function refreshPaymentPreview() {
  const option = state.selectedOption;
  if (!option) return;

  $("#paymentFreight").textContent = money(option.precoVenda);
  const method = $("#paymentMethod")?.value || "";
  if (!method) {
    const addonsTotal = selectedAddonPayload().reduce((sum, selected) => {
      const item = state.catalog.find(x => x.code === selected.code);
      return sum + Number(item?.unitPrice || 0) * Number(selected.quantity || 0);
    }, 0);
    $("#paymentAddons").textContent = money(addonsTotal);
    $("#paymentFee").textContent = "Selecione o pagamento";
    $("#paymentTotal").textContent = money(Number(option.precoVenda || 0) + addonsTotal);
    $("#shipPrice").textContent = money(Number(option.precoVenda || 0) + addonsTotal);
    return;
  }

  try {
    const preview = await api("/api/payment-preview", {
      method: "POST",
      body: JSON.stringify({
        selectionToken: option.selectionToken,
        paymentMethod: method,
        addons: selectedAddonPayload()
      })
    });
    state.paymentPreview = preview;
    const hubTransfer=Number(preview.hubTransferTotal||0);
    $("#paymentFreight").textContent = money(Number(preview.freightPrice||0)-hubTransfer);
    $("#paymentHubTransfer").textContent = money(hubTransfer);
    $("#paymentHubTransferRow").classList.toggle("hidden",hubTransfer<=0);
    $("#paymentAddons").textContent = money(preview.addonsTotal);
    $("#paymentFee").textContent = money(preview.paymentFee);
    $("#paymentTotal").textContent = money(preview.total);
    $("#shipPrice").textContent = money(preview.total);

    const note = $("#paymentMethodNote");
    if (method === "DINHEIRO") {
      note.textContent = state.user?.role === "STORE_CLERK" ? `O cliente paga ${money(preview.total)} em dinheiro. A etiqueta será liberada após o responsável financeiro do ponto concluir o repasse.` : `O cliente paga ${money(preview.total)} em dinheiro. O ponto mantém sua receita e depois repassa ${money(preview.cashRemittance)} via PIX para liberar a etiqueta.`;
    } else {
      note.textContent = `A taxa do Asaas (${money(preview.paymentFee)}) já foi somada. A receita do ponto e a margem da Postal permanecem preservadas.`;
    }
  } catch (err) {
    $("#paymentFee").textContent = "—";
    toast(err.message, "error");
  }
}

async function loadInventory() {
  const host = $("#inventoryList");
  const select = $("#inventoryProduct");
  const movementsHost = $("#inventoryMovementsList");
  if (!host || !select) return;
  host.innerHTML = '<div class="empty-state">Atualizando estoque...</div>';

  try {
    const [result,movementsResult] = await Promise.all([
      api("/api/inventory"),
      api("/api/inventory/movements?limit=120")
    ]);
    state.inventory = result.items || [];
    state.inventoryMovements = movementsResult.movements || [];
    const products = state.inventory.filter(item => item.itemType === "PRODUCT" && item.trackStock);

    select.innerHTML = products.length
      ? products.map(item => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name)}</option>`).join("")
      : '<option value="">Nenhum produto cadastrado</option>';

    if (!state.inventory.length) {
      host.innerHTML = '<div class="empty-state">Nenhum item no catálogo.</div>';
    } else {
      host.innerHTML = "";
      state.inventory.forEach(item => {
        const row = document.createElement("div");
        row.className = "inventory-row";
        const low = item.trackStock && Number(item.availableQuantity || 0) <= Number(item.minQuantity || 0);
        const cost = Number(item.averageCost || 0);
        const price = Number(item.unitPrice || 0);
        const margin = price > 0 ? ((price-cost)/price)*100 : 0;
        row.innerHTML = `
          <div>
            <span class="addon-type">${item.itemType === "PRODUCT" ? "PRODUTO" : "SERVIÇO"} · ${escapeHtml(item.category || "")}</span>
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.code)}${low ? " · REPOR ESTOQUE" : ""}</small>
          </div>
          <div><span>Custo médio</span><strong>${money(cost)}</strong></div>
          <div><span>Preço</span><strong>${money(price)}</strong><small>Margem ${Number(margin||0).toFixed(1)}%</small></div>
          <div><span>Disponível</span><strong class="${low ? "stock-low" : ""}">${Number(item.availableQuantity || 0)}</strong></div>
          <div><span>Reservado</span><strong>${Number(item.reservedQuantity || 0)}</strong></div>
          <div class="inventory-actions"><button type="button" class="ghost">Ajustar</button></div>
        `;
        row.querySelector(".inventory-actions button")?.addEventListener("click", async () => {
          const currentQty = Number(item.stockQuantity || 0);
          const qtyText = window.prompt("Estoque físico atual:", String(currentQty));
          if (qtyText == null) return;
          const minText = window.prompt("Estoque mínimo para alerta:", String(Number(item.minQuantity || 0)));
          if (minText == null) return;
          try {
            const adjustment={
              code:item.code,
              quantity:Number(qtyText),
              minQuantity:Number(minText),
              note:"Ajuste manual pelo ponto"
            };
            if(state.user?.role==="ADMIN") adjustment.salePrice=price;
            await api("/api/inventory/adjust", {
              method: "POST",
              body: JSON.stringify(adjustment)
            });
            toast("Estoque ajustado.");
            await loadInventory();
          } catch (err) {
            toast(err.message, "error");
          }
        });
        host.appendChild(row);
      });
    }

    if (movementsHost) {
      movementsHost.innerHTML = state.inventoryMovements.length
        ? state.inventoryMovements.map(m => `
          <div class="inventory-row movement-row">
            <div><span class="addon-type">${escapeHtml(m.movementType)}</span><strong>${escapeHtml(m.name)}</strong><small>${escapeHtml(m.note || m.code)}</small></div>
            <div><span>Quantidade</span><strong>${Number(m.quantity||0)}</strong></div>
            <div><span>Custo un.</span><strong>${m.unitCost ? money(m.unitCost) : "—"}</strong></div>
            <div><span>Lote</span><strong>${escapeHtml(m.lotCode || "—")}</strong></div>
            <div><span>Data</span><strong>${new Date(m.createdAt).toLocaleString("pt-BR")}</strong></div>
          </div>`).join("")
        : '<div class="empty-state">Nenhuma movimentação registrada.</div>';
    }

    const selected = products[0];
    if (selected) {
      $("#inventorySalePrice").value = Number(selected.unitPrice || 0).toFixed(2);
      $("#inventoryUnitCost").value = Number(selected.averageCost || 0).toFixed(2);
    }
  } catch (err) {
    host.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function prepareShipmentView() {
  if (!state.selectedOption || !state.currentQuote) return false;
  $("#shipCarrier").textContent = state.selectedOption.transportadora;
  $("#shipService").textContent = state.selectedOption.produto;
  $("#shipDeadline").textContent = `${state.selectedOption.prazoEntrega || "—"} dias`;
  $("#shipPrice").textContent = money(state.selectedOption.precoVenda);
  $("#senderCep").value = maskCep(state.currentQuote.cepOrigem);
  $("#recipientCep").value = maskCep(state.currentQuote.cepDestino);
  fillAddressFromCep("sender");
  fillAddressFromCep("recipient");
  $("#shipmentForm").classList.remove("hidden");
  $("#shipmentSuccess").classList.add("hidden");
  $("#paymentMethod").value = "";
  $("#trackingLink")?.classList.add("hidden");
  state.selectedAddons = new Map();
  state.paymentPreview = null;
  const initialHubTransfer=Number(state.selectedOption.hubTransferTotal||0);
  $("#paymentFreight").textContent = money(Number(state.selectedOption.precoVenda||0)-initialHubTransfer);
  $("#paymentHubTransfer").textContent = money(initialHubTransfer);
  $("#paymentHubTransferRow").classList.toggle("hidden",initialHubTransfer<=0);
  $("#paymentAddons").textContent = money(0);
  $("#paymentFee").textContent = "Selecione o pagamento";
  $("#paymentTotal").textContent = money(state.selectedOption.precoVenda);
  loadShipmentCatalog();

  if (!$("#contentItems").children.length) {
    addContentItem({ quantity: 1, value: Number(state.currentQuote.vlDeclarado || 0) });
  }

  const createBtn = $("#createShipmentBtn");
  createBtn.disabled = false;
  createBtn.textContent = "Continuar para pagamento";

  const lockNote = $("#shipmentLockNote");
  lockNote.textContent = state.config?.paymentsConfigured
    ? "A etiqueta só será criada após a confirmação do pagamento."
    : (state.config?.paymentSimulatorEnabled
        ? "Modo homologação ativo: o pagamento pode ser simulado em Meus Fretes sem movimentar dinheiro."
        : "A integração Asaas está preparada e aguarda a chave da conta para processar cobranças.");

  const saldoOption = $("#paymentMethod")?.querySelector('option[value="SALDO"]');
  if (state.user?.role === "CLIENT") {
    saldoOption?.classList.remove("hidden");
    window.PostalClient?.prepareShipment?.();
  } else {
    $("#clientFirstMilePanel")?.classList.add("hidden");
    $(".addons-panel")?.classList.remove("hidden");
    $("#paymentMethod")?.closest("label")?.classList.remove("hidden");
    saldoOption?.classList.add("hidden");
  }
  return true;
}

function currentInvoiceNumber() {
  const type = document.querySelector('input[name="documentType"]:checked')?.value;
  return type === "invoice" ? $("#invoiceNumber").value.trim() : "";
}

function receiptPayload(preview = false) {
  const q = state.currentQuote || {};
  const o = state.selectedOption || {};
  const r = state.shipmentResult || {};
  return {
    preview,
    createdAt: r.postedAt || r.createdAt || new Date().toISOString(),
    trackingCode: preview ? "SERA GERADO APOS A POSTAGEM" : (r.trackingCode || ""),
    publicTrackingUrl: preview ? "" : (r.trackingCode ? ("/rastreio?codigo="+encodeURIComponent(r.trackingCode)) : ""),
    cartId: preview ? "" : (r.cartId || ""),
    packageId: preview ? "" : (r.packageId || ""),
    carrier: o.transportadora || r.carrier || "",
    service: o.produto || r.service || "",
    deadline: o.prazoEntrega || r.deadline || "",
    salePrice: state.paymentPreview?.total || o.precoVenda || r.salePrice || 0,
    freightPrice: (state.paymentPreview?.freightPrice || o.precoVenda || r.salePrice || 0) - Number(state.paymentPreview?.hubTransferTotal ?? o.hubTransferTotal ?? r.hubTransferTotal ?? 0),
    hubTransferTotal: Number(state.paymentPreview?.hubTransferTotal ?? o.hubTransferTotal ?? r.hubTransferTotal ?? 0),
    addonsTotal: state.paymentPreview?.addonsTotal || 0,
    paymentFee: state.paymentPreview?.paymentFee || 0,
    addons: selectedAddonPayload().map(selected => {
      const item = state.catalog.find(x => x.code === selected.code);
      return {
        name: item?.name || selected.code,
        quantity: selected.quantity,
        totalPrice: Number(item?.unitPrice || 0) * Number(selected.quantity || 0)
      };
    }),
    declaredValue: Number(q.vlDeclarado || 0),
    weightKg: Number(q.peso || 0),
    dimensions: `${q.comprimento || "-"} x ${q.largura || "-"} x ${q.altura || "-"} cm`,
    invoiceNumber: currentInvoiceNumber(),
    paymentMethod: r.paymentMethod || $("#paymentMethod")?.value || "",
    sender: partyData("sender"),
    recipient: partyData("recipient"),
    items: contentData()
  };
}

function addressText(p) {
  return [p.address, p.number ? "n. " + p.number : "", p.complement, p.neighborhood, p.city, maskCep(p.cep)]
    .filter(Boolean).join(" - ");
}

function buildReceiptHtml(data) {
  const width = Number(state.config?.receiptWidthMm || 80);
  const inner = width === 58 ? 52 : 72;
  const created = new Date(data.createdAt || Date.now()).toLocaleString("pt-BR");
  const sender = data.sender || {};
  const recipient = data.recipient || {};
  const items = (data.items || []).map(item =>
    `<div class="item"><span>${escapeHtml(item.description)} x${Number(item.quantity || 1)}</span><b>${money(Number(item.value || 0))}</b></div>`
  ).join("");
  const extras = (data.addons || []).map(item =>
    `<div class="item"><span>${escapeHtml(item.name)} x${Number(item.quantity || 1)}</span><b>${money(Number(item.totalPrice || 0))}</b></div>`
  ).join("");
  const preview = data.preview ? '<div class="preview">PRÉVIA — SEM VALIDADE</div>' : "";
  const trackingCodes = Array.isArray(data.trackingCodes) && data.trackingCodes.length
    ? data.trackingCodes.filter(Boolean)
    : [data.trackingCode].filter(Boolean);
  const trackingUrl = data.publicTrackingUrl ? `<div class="tiny">${escapeHtml(data.publicTrackingUrl)}</div>` : "";
  const trackingBlock = trackingCodes.length > 1
    ? `<div class="label">${trackingCodes.length} códigos de rastreio</div>${trackingCodes.map((code,index)=>`<div class="row"><span>Volume ${index+1}</span><b class="tiny">${escapeHtml(code)}</b></div>`).join("")}`
    : `<div class="label">Código de rastreio</div><div class="tracking">${escapeHtml(trackingCodes[0] || "AGUARDANDO")}</div>${trackingUrl}`;
  const invoice = data.invoiceNumber
    ? `<div class="row"><span>Nota fiscal</span><b>${escapeHtml(data.invoiceNumber)}</b></div>`
    : '<div class="row"><span>Documento</span><b>Declaração de conteúdo</b></div>';
  const ids = `${data.packageId ? `<div class="row tiny"><span>ID pacote</span><b>${escapeHtml(data.packageId)}</b></div>` : ""}${data.cartId ? `<div class="row tiny"><span>ID postagem</span><b>${escapeHtml(data.cartId)}</b></div>` : ""}`;
  const origin = [sender.city, maskCep(sender.cep)].filter(Boolean).join(" · ");
  const destination = [recipient.city, maskCep(recipient.cep)].filter(Boolean).join(" · ");
  const volumeRows = Array.isArray(data.volumes) && data.volumes.length > 1
    ? `<div class="dash"></div><div class="section">VOLUMES</div>${data.volumes.map(v => `<div class="volume"><b>Volume ${v.index}</b><br>${escapeHtml(String(v.weightKg))} kg · ${escapeHtml(v.dimensions)}<br>Valor declarado: ${money(v.declaredValue)}${v.trackingCode ? `<br>Rastreio: <b>${escapeHtml(v.trackingCode)}</b>` : ""}</div>`).join("")}`
    : "";
  const paidLabel = data.preview ? "PRÉVIA — NÃO PAGO" : (String(data.paymentStatus || "PAID").toUpperCase() === "PAID" ? "PAGO" : String(data.paymentStatus || ""));

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante Postal</title>
  <style>
  @page{size:${width}mm auto;margin:2mm}*{box-sizing:border-box}body{width:${inner}mm;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;font-size:10.5px;line-height:1.28}
  .receipt{width:100%;padding:1mm 0}.center{text-align:center}.brand{font-size:18px;font-weight:900;letter-spacing:.7px}.brand-sub{font-size:9px;font-weight:800;letter-spacing:1.2px}
  h1{font-size:12px;margin:3mm 0 1mm}.preview{border:1px solid #000;padding:1.5mm;margin:2mm 0;font-weight:900;text-align:center}.dash{border-top:1px dashed #000;margin:2.2mm 0}
  .label{font-size:8px;text-transform:uppercase;font-weight:800}.tracking{font-family:"Courier New",monospace;font-size:17px;font-weight:900;letter-spacing:.5px;word-break:break-all;margin:1mm 0}
  .section{font-weight:900;font-size:10px;margin-bottom:1mm}.person{font-weight:900;font-size:11px}.small{font-size:9px}.tiny{font-size:8px;word-break:break-all}.row,.item{display:flex;justify-content:space-between;gap:2mm;margin:.7mm 0}
  .volume{font-size:8.5px;border-top:1px dotted #000;padding:1.2mm 0}.volume:first-of-type{border-top:0}.total{font-size:14px;font-weight:900}.footer{text-align:center;font-size:8.5px;margin-top:3mm}.no-print{text-align:center;margin-top:4mm}.print-btn{padding:3mm 6mm;border:1px solid #000;background:#fff;font-weight:900}@media print{.no-print{display:none}body{width:${inner}mm}}
  </style></head><body><div class="receipt">
  <div class="center"><div class="brand">POSTAL</div><div class="brand-sub">SERVIÇOS</div><h1>COMPROVANTE DE PAGAMENTO E POSTAGEM</h1><div class="small">${escapeHtml(created)}</div>${data.storeName ? `<div class="small">Ponto: ${escapeHtml(data.storeName)}</div>` : ""}${data.orderId ? `<div class="tiny">Pedido: ${escapeHtml(String(data.orderId).slice(0,12).toUpperCase())}</div>` : ""}</div>
  ${preview}<div class="dash"></div>
  <div class="center">${trackingBlock}</div>
  <div class="dash"></div><div class="section">REMETENTE</div><div class="person">${escapeHtml(sender.name)}</div><div>Doc.: ${escapeHtml(sender.document)}</div><div>Tel.: ${escapeHtml(sender.phone)}</div>${sender.email ? `<div>E-mail: ${escapeHtml(sender.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(sender))}</div>
  <div class="dash"></div><div class="section">DESTINATÁRIO</div><div class="person">${escapeHtml(recipient.name)}</div><div>Doc.: ${escapeHtml(recipient.document)}</div><div>Tel.: ${escapeHtml(recipient.phone)}</div>${recipient.email ? `<div>E-mail: ${escapeHtml(recipient.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(recipient))}</div>
  <div class="dash"></div><div class="section">ROTA</div><div class="row"><span>Origem</span><b>${escapeHtml(origin || "-")}</b></div><div class="row"><span>Destino</span><b>${escapeHtml(destination || "-")}</b></div>
  <div class="dash"></div><div class="section">PACOTE / ENVIO</div><div class="row"><span>Transportadora</span><b>${escapeHtml(data.carrier)}</b></div><div class="row"><span>Serviço</span><b>${escapeHtml(data.service)}</b></div><div class="row"><span>Prazo estimado</span><b>${escapeHtml(data.deadline ? data.deadline + " dias úteis" : "-")}</b></div>${Number(data.volumeCount||1)>1 ? `<div class="row"><span>Volumes</span><b>${Number(data.volumeCount)}</b></div>` : ""}<div class="row"><span>Peso total</span><b>${escapeHtml(data.weightKg + " kg")}</b></div><div class="row"><span>Medidas</span><b class="tiny">${escapeHtml(data.dimensions)}</b></div><div class="row"><span>Valor declarado</span><b>${money(data.declaredValue)}</b></div>${invoice}
  ${volumeRows}
  <div class="dash"></div><div class="section">CONTEÚDO</div>${items || '<div class="small">Conteúdo não informado</div>'}
  ${extras ? `<div class="dash"></div><div class="section">PRODUTOS / SERVIÇOS</div>${extras}` : ""}
  <div class="dash"></div><div class="section">PAGAMENTO</div>
  <div class="row"><span>Frete</span><b>${money(data.freightPrice || data.salePrice)}</b></div>
  ${Number(data.hubTransferTotal || 0) ? `<div class="row"><span>Transferência ao hub</span><b>${money(data.hubTransferTotal)}</b></div>` : ""}
  ${Number(data.addonsTotal || 0) ? `<div class="row"><span>Adicionais</span><b>${money(data.addonsTotal)}</b></div>` : ""}
  ${Number(data.paymentFee || 0) ? `<div class="row"><span>Taxa pagamento</span><b>${money(data.paymentFee)}</b></div>` : ""}
  <div class="row total"><span>TOTAL PAGO</span><b>${money(data.salePrice)}</b></div><div class="row"><span>Forma</span><b>${escapeHtml(data.paymentMethod || "-")}</b></div><div class="row"><span>Status</span><b>${escapeHtml(paidLabel)}</b></div>${ids}
  <div class="dash"></div><div class="footer">Guarde este comprovante até a conclusão da entrega.<br>Acompanhe pelo código de rastreio.<br>Este comprovante não substitui documento fiscal.</div>
  <div class="no-print"><button class="print-btn" onclick="window.print()">IMPRIMIR</button></div></div></body></html>`;
}

function showReceiptPreview(data) {
  const modal = $("#receiptPreviewModal");
  const frame = $("#receiptPreviewFrame");
  if (!modal || !frame) return;
  frame.srcdoc = buildReceiptHtml(data);
  modal.classList.remove("hidden");
}

function closeReceiptPreview() {
  $("#receiptPreviewModal")?.classList.add("hidden");
}

function openReceipt(data, autoPrint = false) {
  const target = window.open("", "_blank");
  if (!target) {
    toast("Permita pop-ups para imprimir o comprovante.", "error");
    return;
  }
  target.document.open();
  target.document.write(buildReceiptHtml(data));
  target.document.close();
  if (autoPrint) setTimeout(() => { target.focus(); target.print(); }, 350);
}

async function openProviderDocument(url) {
  if (!url) { toast("Documento ainda não disponível.", "error"); return; }
  const target = window.open("", "_blank");
  if (!target) { toast("Permita pop-ups para imprimir a etiqueta.", "error"); return; }
  target.document.write("<p style=\"font-family:Arial\">Carregando documento...</p>");
  try {
    const response = await fetch("/api/documento-proxy", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url })
    });
    if (!response.ok) throw new Error("Não foi possível abrir o documento.");
    const blob = await response.blob();
    target.location.href = URL.createObjectURL(blob);
  } catch (err) { target.close(); toast(err.message, "error"); }
}

async function openOrderLabels(order) {
  const volumes=Array.isArray(order?.shipmentVolumes)?order.shipmentVolumes:[];
  if(volumes.length<=1){
    return openProviderDocument(order?.labelA6Url||order?.labelA4Url||volumes[0]?.labelA6Url||volumes[0]?.labelA4Url);
  }
  const target=window.open("","_blank");
  if(!target){toast("Permita pop-ups para imprimir as etiquetas.","error");return;}
  target.document.write("<p style=\"font-family:Arial\">Montando etiquetas dos volumes...</p>");
  try{
    const response=await fetch("/api/orders/"+encodeURIComponent(order.id)+"/labels",{credentials:"same-origin"});
    if(!response.ok){
      let message="Não foi possível montar as etiquetas.";
      try{message=(await response.json()).error||message;}catch{}
      throw new Error(message);
    }
    const blob=await response.blob();
    target.location.href=URL.createObjectURL(blob);
  }catch(err){target.close();toast(err.message,"error");}
}

$("#continueShipmentBtn")?.addEventListener("click", async () => {
  if (!state.selectedOption) { toast("Selecione uma opção de frete primeiro.", "error"); return; }
  prepareShipmentView();
  if (state.user?.role === "CLIENT") await window.PostalClient?.prepareShipment?.();
  navigate("shipment");
});

$("#backToQuoteBtn")?.addEventListener("click", () => navigate("quote"));
$("#addContentItemBtn")?.addEventListener("click", () => addContentItem({ quantity: 1, value: 0 }));

$$(`input[name="documentType"]`).forEach(radio => radio.addEventListener("change", () => {
  const invoice = document.querySelector('input[name="documentType"]:checked')?.value === "invoice";
  $("#invoiceField").classList.toggle("hidden", !invoice);
  $("#invoiceNumber").required = invoice;
}));

async function fillAddressFromCep(prefix) {
  const cepInput = $(`#${prefix}Cep`);
  const cep = onlyDigits(cepInput?.value);
  if (cep.length !== 8) return;
  try {
    const response = await api(`/api/cep/${cep}`);
    const data = response?.data || response;
    if (!data || typeof data !== "object") return;
    const address = $(`#${prefix}Address`);
    const neighborhood = $(`#${prefix}Neighborhood`);
    const city = $(`#${prefix}City`);
    if (data.address && !address.value.trim()) address.value = data.address;
    if (data.neighborhood && !neighborhood.value.trim()) neighborhood.value = data.neighborhood;
    if (data.city_title) city.value = `${data.city_title}${data.state_abbreviation ? "/" + data.state_abbreviation : ""}`;
  } catch (err) {
    console.warn("CEP lookup failed:", err.message);
  }
}

["senderCep","recipientCep"].forEach(id => {
  const input = $(`#${id}`);
  input?.addEventListener("input", e => formatCepInput(e.target));
  input?.addEventListener("blur", () => fillAddressFromCep(id.startsWith("sender") ? "sender" : "recipient"));
});

$("#previewReceiptBtn")?.addEventListener("click", () => {
  if (!state.selectedOption) {
    toast("Selecione um frete antes de visualizar o comprovante.", "error");
    return;
  }
  showReceiptPreview(receiptPayload(true));
});

function orderStatusMeta(status) {
  const map = {
    CASH_REMITTANCE_PENDING: ["Repasse pendente", "warning", "O cliente pagou em dinheiro. O ponto mantém sua receita e precisa quitar o repasse."],
    CASH_REMITTANCE_PAYMENT_PENDING: ["Aguardando PIX do ponto", "warning", "O repasse foi criado e ainda não foi confirmado."],
    SIMULATED_REMITTANCE_PENDING: ["Repasse teste pendente", "info", "Homologação: confirme o repasse simulado para liberar a etiqueta de teste."],
    SIMULATED_PAYMENT_PENDING: ["Pagamento teste pendente", "info", "Homologação: confirme o pagamento simulado para testar o fluxo completo."],
    PAYMENT_SETUP_PENDING: ["Pagamento em configuração", "muted", "Aguardando integração financeira."],
    PARTNER_FINANCIAL_SETUP_REQUIRED: ["Conta financeira pendente", "warning", "Este ponto ainda precisa ser vinculado a uma carteira Asaas."],
    PAYMENT_PENDING: ["Aguardando pagamento", "warning", "A etiqueta não será criada enquanto o pagamento não for confirmado."],
    PAYMENT_CONFIRMED: ["Pagamento confirmado", "info", "Pagamento recebido. Preparando a postagem."],
    PAID_WAITING_SHIPMENT: ["Pago • etiqueta pendente", "info", "Pagamento confirmado. A emissão real da etiqueta está bloqueada até a homologação final."],
    PROVIDER_PAYMENT_PENDING: ["Aguardando ConectEnvios", "warning", "O pagamento do cliente está confirmado; a plataforma aguarda a liberação financeira/etiqueta da ConectEnvios."],
    LABEL_AVAILABLE: ["Etiqueta disponível", "success", "Pagamento e postagem confirmados."],
    LABEL_AVAILABLE_SIMULATED: ["Etiqueta de teste", "info", "Homologação concluída sem movimentação financeira ou postagem real."],
    SHIPMENT_ERROR: ["Revisão necessária", "danger", "O pagamento foi confirmado, mas houve erro ao gerar a postagem."],
    PAYMENT_CANCELED: ["Pagamento cancelado", "muted", "O checkout foi cancelado."],
    PAYMENT_EXPIRED: ["Pagamento expirado", "muted", "O checkout expirou sem confirmação."]
  };
  return map[status] || [status || "Pendente", "muted", ""];
}

function paymentMethodLabel(method) {
  return ({ PIX: "PIX", CARTAO: "Cartão", DINHEIRO: "Dinheiro", SALDO: "Saldo Postal" })[method] || method || "-";
}

function receiptPayloadFromOrder(order) {
  const p = order.packageData || {};
  const volumes = Array.isArray(p.volumes) && p.volumes.length ? p.volumes : [{
    weightGrams: Number(p.weightGrams || 0),
    length: p.length, width: p.width, height: p.height, declaredValue: Number(p.declaredValue || 0)
  }];
  const shipmentVolumes = Array.isArray(order.shipmentVolumes) ? order.shipmentVolumes : [];
  const trackingCodes = shipmentVolumes.map(v => v.trackingCode).filter(Boolean);
  const totalWeightKg = volumes.reduce((sum,v) => sum + Number(v.weightGrams || 0), 0) / 1000;
  const declaredValue = Number(p.declaredValue || volumes.reduce((sum,v) => sum + Number(v.declaredValue || 0), 0) || 0);
  const volumeDetails = volumes.map((v,index) => ({
    index: index + 1,
    weightKg: Number((Number(v.weightGrams || 0) / 1000).toFixed(3)),
    dimensions: `${v.length || "-"} x ${v.width || "-"} x ${v.height || "-"} cm`,
    declaredValue: Number(v.declaredValue || 0),
    trackingCode: shipmentVolumes[index]?.trackingCode || (index === 0 ? order.trackingCode || "" : "")
  }));
  const dimensions = volumeDetails.length > 1
    ? volumeDetails.map(v => `V${v.index}: ${v.dimensions}`).join(" · ")
    : (volumeDetails[0]?.dimensions || "-");
  return {
    preview: false,
    orderId: order.id || "",
    storeName: order.storeName || state.user?.storeName || "",
    createdAt: order.paidAt || order.shippedAt || order.createdAt || new Date().toISOString(),
    paidAt: order.paidAt || "",
    paymentStatus: order.paymentStatus || "",
    trackingCode: order.trackingCode || trackingCodes[0] || "",
    trackingCodes,
    publicTrackingUrl: order.publicTrackingUrl || "",
    cartId: "", packageId: "",
    carrier: order.carrier || "",
    service: order.serviceName || "",
    deadline: order.deadline || 0,
    salePrice: order.totalToCustomer || order.salePrice || 0,
    freightPrice: order.salePrice || 0,
    addonsTotal: order.addonsTotal || 0,
    paymentFee: order.paymentSurcharge || 0,
    addons: (order.addons || []).map(addon => ({
      name: addon.itemName, quantity: addon.quantity, totalPrice: addon.totalPrice
    })),
    declaredValue,
    weightKg: Number(totalWeightKg.toFixed(3)),
    dimensions,
    volumes: volumeDetails,
    volumeCount: Number(order.packageCount || volumes.length || 1),
    invoiceNumber: order.invoiceNumber || "",
    paymentMethod: paymentMethodLabel(order.paymentMethod),
    sender: order.sender || {},
    recipient: order.recipient || {},
    items: order.items || []
  };
}

async function payCashRemittance(orderId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Gerando repasse...";
  try {
    const result = await api(`/api/orders/${orderId}/remittance`, { method: "POST", body: "{}" });
    if (result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
      return;
    }
    if (result.simulator) toast("Repasse preparado em modo homologação.");
    await loadOrders();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function simulateOrderPayment(orderId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Homologando...";
  try {
    const result = await api(`/api/orders/${orderId}/simulate-payment`, { method: "POST", body: "{}" });
    toast("Pagamento homologado e etiqueta de teste liberada.");
    await loadOrders();
    if (result.order) openOrderDetails(result.order);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function openSimulatedLabel(order) {
  const p = order.packageData || {};
  const win = window.open("", "_blank");
  if (!win) return toast("Permita pop-ups para imprimir a etiqueta de teste.", "error");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Etiqueta de Homologação</title>
  <style>@page{size:100mm 140mm;margin:4mm}body{font-family:Arial;margin:0;color:#000}.label{width:92mm;min-height:130mm;border:2px solid #000;padding:5mm;box-sizing:border-box}.warning{border:3px solid #000;padding:4mm;text-align:center;font-weight:900;font-size:18px}.brand{font-size:24px;font-weight:900;margin:5mm 0}.track{font-family:monospace;font-size:21px;font-weight:900;letter-spacing:1px;margin:4mm 0;text-align:center}.row{border-top:1px solid #000;padding:3mm 0}.small{font-size:11px}.no-print{text-align:center;margin-top:5mm}@media print{.no-print{display:none}}</style></head>
  <body><div class="label"><div class="warning">HOMOLOGAÇÃO — NÃO POSTAR</div><div class="brand">POSTAL SERVIÇOS</div>
  <div class="track">${escapeHtml(order.trackingCode || "SIMULADO")}</div>
  <div class="row"><b>De:</b> ${escapeHtml(order.sender?.name || "")}<br><span class="small">${escapeHtml(addressText(order.sender||{}))}</span></div>
  <div class="row"><b>Para:</b> ${escapeHtml(order.recipient?.name || "")}<br><span class="small">${escapeHtml(addressText(order.recipient||{}))}</span></div>
  <div class="row"><b>${escapeHtml(order.carrier||"")}</b> — ${escapeHtml(order.serviceName||"")}<br>Peso: ${Number(p.weightGrams||0)/1000} kg · ${p.length||"-"}x${p.width||"-"}x${p.height||"-"} cm</div>
  <div class="warning">DOCUMENTO SEM VALIDADE LOGÍSTICA</div><div class="no-print"><button onclick="window.print()">IMPRIMIR TESTE</button></div></div></body></html>`;
  win.document.open(); win.document.write(html); win.document.close();
}

function orderMatchesFilters(order) {
  const search = String($("#ordersSearch")?.value || "").trim().toLowerCase();
  const status = $("#ordersStatusFilter")?.value || "";
  const payment = $("#ordersPaymentFilter")?.value || "";
  if (status && order.status !== status) return false;
  if (payment && order.paymentMethod !== payment) return false;
  if (!search) return true;
  const haystack = [
    order.id, order.trackingCode, ...(order.shipmentVolumes||[]).map(v=>v.trackingCode), order.sender?.name, order.sender?.document,
    order.recipient?.name, order.recipient?.document, order.sender?.city,
    order.recipient?.city, order.carrier, order.serviceName, order.storeName, order.storeCode
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search);
}

function openOrderDetails(order) {
  const modal = $("#orderDetailModal");
  if (!modal) return;
  $("#orderDetailTitle").textContent = `Pedido #${String(order.id||"").slice(0,8).toUpperCase()}`;
  $("#orderDetailSubtitle").textContent = `${order.carrier || ""} · ${order.serviceName || ""}`;
  const events = order.events || [];
  const addons = order.addons || [];
  $("#orderDetailBody").innerHTML = `
    <div class="detail-grid">
      <div><span>Status</span><strong>${escapeHtml(orderStatusMeta(order.status)[0])}</strong></div>
      <div><span>Total cliente</span><strong>${money(order.totalToCustomer)}</strong></div>
      ${state.user?.role==="STORE_CLERK" ? "" : `<div><span>Receita do ponto</span><strong>${money(order.pointRevenueTotal)}</strong></div>`}
      <div><span>Pagamento</span><strong>${escapeHtml(paymentMethodLabel(order.paymentMethod))}</strong></div>
      <div><span>Rastreio</span><strong>${escapeHtml(order.trackingCode || "—")}</strong></div>
      <div><span>Volumes</span><strong>${Number(order.packageCount||1)}</strong></div>
      <div><span>Prazo</span><strong>${Number(order.deadline||0) || "—"} dias</strong></div>
    </div>
    ${Array.isArray(order.shipmentVolumes)&&order.shipmentVolumes.length>1?`<div class="detail-section"><h4>Rastreios por volume</h4>${order.shipmentVolumes.map((v,index)=>`<div class="detail-line"><span>Volume ${index+1}</span><b>${escapeHtml(v.trackingCode||"Aguardando")}</b></div>`).join("")}</div>`:""}
    <div class="detail-party"><h4>Remetente</h4><b>${escapeHtml(order.sender?.name||"")}</b><span>${escapeHtml(addressText(order.sender||{}))}</span></div>
    <div class="detail-party"><h4>Destinatário</h4><b>${escapeHtml(order.recipient?.name||"")}</b><span>${escapeHtml(addressText(order.recipient||{}))}</span></div>
    ${addons.length ? `<div class="detail-section"><h4>Produtos e serviços</h4>${addons.map(a=>`<div class="detail-line"><span>${escapeHtml(a.itemName)} ×${Number(a.quantity)}</span><b>${money(a.totalPrice)}</b></div>`).join("")}</div>` : ""}
    <div class="detail-section"><h4>Linha do tempo</h4>
      <div class="order-timeline">${events.length ? events.map(e=>`<div class="timeline-event"><i></i><div><b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.detail||"")}</span><small>${new Date(e.createdAt).toLocaleString("pt-BR")}</small></div></div>`).join("") : '<div class="empty-state">Sem eventos registrados.</div>'}</div>
    </div>`;
  modal.classList.remove("hidden");
}

async function reprocessOrderShipment(orderId, button) {
  if (!orderId || button.disabled) return;
  button.disabled=true;
  const original=button.textContent;
  button.textContent="Consultando postagem...";
  try {
    const result=await api("/api/orders/"+encodeURIComponent(orderId)+"/reprocess-shipment",{
      method:"POST",body:JSON.stringify({})
    });
    showToast(result.message || (result.ready?"Etiqueta disponível.":"Postagem em processamento."),result.ready?"success":"info");
    await loadOrders();
  } catch(error) {
    showToast(error.message || "Não foi possível reprocessar a postagem.","error");
    await loadOrders();
  } finally {
    button.disabled=false;
    button.textContent=original;
  }
}

function renderOrders() {
  const host = $("#ordersList");
  if (!host) return;
  const allOrders = state.orders || [];
  const orders = allOrders.filter(orderMatchesFilters);

  const pendingStatuses = new Set(["CASH_REMITTANCE_PENDING","CASH_REMITTANCE_PAYMENT_PENDING","SIMULATED_REMITTANCE_PENDING","SIMULATED_PAYMENT_PENDING","PAYMENT_PENDING","PAYMENT_SETUP_PENDING","PARTNER_FINANCIAL_SETUP_REQUIRED","PAID_WAITING_SHIPMENT","PAYMENT_CONFIRMED"]);
  const commissionStatuses = new Set(["CASH_REMITTANCE_PENDING","CASH_REMITTANCE_PAYMENT_PENDING","SIMULATED_REMITTANCE_PENDING","PAYMENT_CONFIRMED","PAID_WAITING_SHIPMENT","LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED","SHIPMENT_ERROR"]);
  $("#ordersPendingCount").textContent = allOrders.filter(o => pendingStatuses.has(o.status)).length;
  $("#ordersReadyCount").textContent = allOrders.filter(o => ["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(o.status)).length;
  const clientOrdersMode = state.user?.role === "CLIENT";
  const clerkMode = state.user?.role === "STORE_CLERK";
  const financialSummaryTile = document.querySelector("#ordersView .orders-summary > div:nth-child(3)");
  financialSummaryTile?.classList.toggle("hidden", clerkMode);
  const summaryLabel = document.querySelector("#ordersView .orders-summary > div:nth-child(3) span");
  if (summaryLabel) summaryLabel.textContent = clientOrdersMode ? "Total utilizado" : "Comissão acumulada";
  if (!clerkMode) {
    $("#ordersCommissionTotal").textContent = clientOrdersMode
      ? money(allOrders.reduce((s,o) => s + Number(o.totalToCustomer || o.salePrice || 0), 0))
      : money(allOrders.filter(o => commissionStatuses.has(o.status)).reduce((s,o) => s + Number(o.pointRevenueTotal || o.partnerCommission || 0), 0));
  }

  if (!orders.length) {
    host.innerHTML = `<div class="orders-empty"><strong>Nenhum frete encontrado.</strong><span>Ajuste os filtros ou faça uma nova cotação.</span><button class="primary" type="button" data-empty-new>Nova cotação</button></div>`;
    host.querySelector("[data-empty-new]")?.addEventListener("click", () => navigate("quote"));
    return;
  }

  host.innerHTML = "";
  orders.forEach(order => {
    const [label, tone, description] = orderStatusMeta(order.status);
    const card = document.createElement("article");
    card.className = "order-card";
    const date = new Date(order.createdAt).toLocaleString("pt-BR");
    const route = `${escapeHtml(order.sender?.city || maskCep(order.sender?.cep))} → ${escapeHtml(order.recipient?.city || maskCep(order.recipient?.cep))}`;
    card.innerHTML = `
      <div class="order-top">
        <div>
          <div class="order-id">#${escapeHtml(order.id.slice(0,8).toUpperCase())} · ${escapeHtml(date)}${order.storeName ? " · " + escapeHtml(order.storeName) : ""}${order.isSimulation ? " · HOMOLOGAÇÃO" : ""}</div>
          <h3>${escapeHtml(order.carrier)} <span>${escapeHtml(order.serviceName)}</span></h3>
          <p>${route}</p>
        </div>
        <span class="order-status ${tone}">${escapeHtml(label)}</span>
      </div>
      <div class="order-metrics">
        <div><span>Total cliente</span><strong>${money(order.totalToCustomer || order.salePrice)}</strong></div>
        <div><span>${clerkMode ? "Prazo" : (clientOrdersMode ? "Primeira milha" : "Sua receita")}</span><strong>${clerkMode ? ((Number(order.deadline||0)||"—")+" dias") : (clientOrdersMode ? money(order.firstMileFee || 0) : money(order.pointRevenueTotal || order.partnerCommission))}</strong></div>
        <div><span>Pagamento</span><strong>${escapeHtml(paymentMethodLabel(order.paymentMethod))}</strong></div>
        <div><span>${Number(order.packageCount||1)>1?"Volumes":"Rastreio"}</span><strong>${Number(order.packageCount||1)>1?Number(order.packageCount):escapeHtml(order.trackingCode || "—")}</strong></div>
      </div>
      ${order.addons?.length ? `<div class="order-addons"><strong>Adicionais:</strong> ${order.addons.map(a => `${escapeHtml(a.itemName)} ×${Number(a.quantity)} (${money(a.totalPrice)})`).join(" · ")}</div>` : ""}
      <div class="order-bottom"><span>${escapeHtml(description)}</span><div class="order-actions"></div></div>`;
    const actions = card.querySelector(".order-actions");

    if (!clerkMode && order.status === "CASH_REMITTANCE_PENDING") {
      const due = Number(order.cashRemittanceTotal || order.cashRemittanceAmount || 0);
      const btn = document.createElement("button"); btn.className="primary"; btn.type="button";
      btn.textContent = state.config?.paymentSimulatorEnabled ? `Preparar repasse teste ${money(due)}` : `Pagar ${money(due)} e liberar etiqueta`;
      btn.addEventListener("click", () => payCashRemittance(order.id, btn)); actions.appendChild(btn);
    }

    if (["SIMULATED_PAYMENT_PENDING","SIMULATED_REMITTANCE_PENDING"].includes(order.status)) {
      const btn=document.createElement("button"); btn.className="primary"; btn.type="button"; btn.textContent="Confirmar pagamento teste";
      btn.addEventListener("click",()=>simulateOrderPayment(order.id,btn)); actions.appendChild(btn);
    }

    if (order.paymentCheckoutUrl && ["PAYMENT_PENDING","CASH_REMITTANCE_PAYMENT_PENDING"].includes(order.status)) {
      const btn=document.createElement("button"); btn.className="primary"; btn.type="button"; btn.textContent="Abrir pagamento";
      btn.addEventListener("click",()=>{window.location.href=order.paymentCheckoutUrl;}); actions.appendChild(btn);
    }

    if (order.paymentStatus === "PAID" && !order.isSimulation &&
        ["SHIPMENT_ERROR","PROVIDER_PAYMENT_PENDING","PAID_WAITING_SHIPMENT","PAYMENT_CONFIRMED"].includes(order.status)) {
      const retryBtn=document.createElement("button");
      retryBtn.className="primary"; retryBtn.type="button";
      retryBtn.textContent="Reprocessar emissão";
      retryBtn.addEventListener("click",()=>reprocessOrderShipment(order.id,retryBtn));
      actions.appendChild(retryBtn);
    }

    if (order.status === "LABEL_AVAILABLE") {
      const labelBtn=document.createElement("button"); labelBtn.className="primary"; labelBtn.type="button"; labelBtn.textContent=Number(order.packageCount||1)>1?`Imprimir ${Number(order.packageCount)} etiquetas`:"Imprimir etiqueta A6";
      labelBtn.addEventListener("click",()=>openOrderLabels(order)); actions.appendChild(labelBtn);
    }
    if (order.status === "LABEL_AVAILABLE_SIMULATED") {
      const labelBtn=document.createElement("button"); labelBtn.className="primary"; labelBtn.type="button"; labelBtn.textContent="Etiqueta teste";
      labelBtn.addEventListener("click",()=>openSimulatedLabel(order)); actions.appendChild(labelBtn);
    }
    if (["LABEL_AVAILABLE","LABEL_AVAILABLE_SIMULATED"].includes(order.status)) {
      const receiptBtn=document.createElement("button"); receiptBtn.className="ghost"; receiptBtn.type="button";
      const allTracking=(order.shipmentVolumes||[]).filter(v=>v.trackingCode).length || (order.trackingCode?1:0);
      const expected=Math.max(1,Number(order.packageCount||1));
      receiptBtn.textContent=allTracking>=expected ? "Imprimir comprovante 80 mm" : "Comprovante: rastreio pendente";
      receiptBtn.disabled=allTracking<expected;
      receiptBtn.addEventListener("click",()=>openReceipt(receiptPayloadFromOrder(order),true)); actions.appendChild(receiptBtn);
    }

    if (order.trackingCode && !order.isSimulation) {
      const trackBtn=document.createElement("button"); trackBtn.className="ghost"; trackBtn.type="button"; trackBtn.textContent="Rastrear";
      trackBtn.addEventListener("click",()=>window.open(order.publicTrackingUrl || ("/rastreio?codigo="+encodeURIComponent(order.trackingCode)),"_blank"));
      actions.appendChild(trackBtn);
    }

    const detailBtn=document.createElement("button"); detailBtn.className="ghost"; detailBtn.type="button"; detailBtn.textContent="Detalhes";
    detailBtn.addEventListener("click",()=>openOrderDetails(order)); actions.appendChild(detailBtn);
    host.appendChild(card);
  });
}

async function loadOrders() {
  const host = $("#ordersList");
  if (!host) return;
  host.innerHTML = '<div class="empty-state">Atualizando seus fretes...</div>';
  try {
    const result = await api("/api/orders");
    state.orders = result.orders || [];
    renderOrders();
  } catch (err) {
    host.innerHTML = `<div class="orders-empty"><strong>Não foi possível carregar Meus Fretes.</strong><span>${escapeHtml(err.message)}</span></div>`;
  }
}

["ordersSearch","ordersStatusFilter","ordersPaymentFilter"].forEach(id => {
  $("#"+id)?.addEventListener(id === "ordersSearch" ? "input" : "change", renderOrders);
});
$("#clearOrderFilters")?.addEventListener("click", () => {
  $("#ordersSearch").value=""; $("#ordersStatusFilter").value=""; $("#ordersPaymentFilter").value=""; renderOrders();
});
$("#closeOrderDetailBtn")?.addEventListener("click",()=>$("#orderDetailModal")?.classList.add("hidden"));
$("#orderDetailModal")?.addEventListener("click",event=>{if(event.target.id==="orderDetailModal") event.currentTarget.classList.add("hidden");});

async function loadStoreUsers() {
  if (state.user?.role !== "STORE_OWNER") return;
  const host=$("#storeUsersList");
  if(!host) return;
  host.innerHTML='<div class="empty-state">Carregando usuários...</div>';
  try{
    const result=await api("/api/store/users");
    const users=Array.isArray(result.users)?result.users:[];
    if(!users.length){
      host.innerHTML='<div class="empty-state">Nenhum atendente cadastrado ainda.</div>';
      return;
    }
    host.innerHTML=users.map(user=>`
      <div class="inventory-row" data-store-user-id="${escapeHtml(user.id)}">
        <div>
          <span class="addon-type">ATENDENTE</span>
          <strong>${escapeHtml(user.name||"")}</strong>
          <small>${escapeHtml(user.email||"")}</small>
        </div>
        <div><span>Status</span><strong>${user.active?"Ativo":"Bloqueado"}</strong></div>
        <div><span>Último acesso</span><strong>${user.lastLoginAt?new Date(user.lastLoginAt).toLocaleString("pt-BR"):"Nunca"}</strong></div>
        <div class="row-actions">
          <button class="ghost" type="button" data-toggle-user="${escapeHtml(user.id)}">${user.active?"Bloquear":"Ativar"}</button>
          <button class="ghost" type="button" data-password-user="${escapeHtml(user.id)}">Nova senha</button>
        </div>
      </div>`).join("");

    host.querySelectorAll("[data-toggle-user]").forEach(btn=>btn.addEventListener("click",async()=>{
      const user=users.find(item=>item.id===btn.dataset.toggleUser);
      if(!user) return;
      try{
        await api("/api/store/users/"+encodeURIComponent(user.id),{
          method:"PATCH",
          body:JSON.stringify({active:!user.active})
        });
        toast(user.active?"Acesso bloqueado.":"Acesso ativado.");
        await loadStoreUsers();
      }catch(err){toast(err.message,"error");}
    }));

    host.querySelectorAll("[data-password-user]").forEach(btn=>btn.addEventListener("click",async()=>{
      const user=users.find(item=>item.id===btn.dataset.passwordUser);
      if(!user) return;
      const password=window.prompt("Nova senha para "+user.name+" (mínimo 10 caracteres):","");
      if(password===null) return;
      if(password.length<10) return toast("A senha precisa ter ao menos 10 caracteres.","error");
      try{
        await api("/api/store/users/"+encodeURIComponent(user.id),{
          method:"PATCH",
          body:JSON.stringify({password})
        });
        toast("Senha do atendente atualizada.");
      }catch(err){toast(err.message,"error");}
    }));
  }catch(err){
    host.innerHTML=`<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

$("#storeUserForm")?.addEventListener("submit",async event=>{
  event.preventDefault();
  const btn=event.currentTarget.querySelector('button[type="submit"]');
  btn.disabled=true;
  const original=btn.textContent;
  btn.textContent="Criando...";
  try{
    await api("/api/store/users",{
      method:"POST",
      body:JSON.stringify({
        name:$("#storeUserName").value.trim(),
        email:$("#storeUserEmail").value.trim(),
        password:$("#storeUserPassword").value
      })
    });
    event.currentTarget.reset();
    toast("Usuário do ponto criado.");
    await loadStoreUsers();
  }catch(err){
    toast(err.message,"error");
  }finally{
    btn.disabled=false;
    btn.textContent=original;
  }
});

$("#refreshStoreUsersBtn")?.addEventListener("click",loadStoreUsers);

async function loadStoreFinancialSettings() {
  if (state.user?.role !== "STORE_OWNER") return;
  const summary = $("#storeFinancialSummary");
  const status = $("#asaasWalletStatus");
  try {
    const result = await api("/api/store/financial-settings");
    const wallet = String(result.asaas?.walletId || "");
    $("#storeAsaasWalletId").value = wallet;
    if (status) {
      status.className = "order-status " + (result.asaas?.configured ? "success" : "warning");
      status.textContent = result.asaas?.configured ? "Carteira vinculada" : "Configuração pendente";
    }
    if (summary) {
      summary.innerHTML = `<div class="inventory-row">
        <div><span class="addon-type">PONTO</span><strong>${escapeHtml(result.store?.name || state.user?.storeName || "")}</strong><small>${escapeHtml(result.store?.cnpj || "CNPJ não informado")}</small></div>
        <div><span>Conta Asaas</span><strong>${wallet ? ("•••• " + escapeHtml(wallet.slice(-8))) : "Não vinculada"}</strong></div>
      </div>`;
    }
  } catch (err) {
    if (summary) summary.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    if (status) { status.className = "order-status danger"; status.textContent = "Erro"; }
  }
}

$("#storeFinancialForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const walletId = $("#storeAsaasWalletId").value.trim();
  if (!walletId) return toast("Informe a Wallet ID da sua conta Asaas.", "error");
  const btn = event.currentTarget.querySelector('button[type="submit"]');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Salvando...";
  try {
    const result = await api("/api/store/financial-settings", {
      method: "PATCH",
      body: JSON.stringify({ asaasWalletId: walletId })
    });
    toast(result.message || "Conta Asaas salva.");
    await loadStoreFinancialSettings();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
async function loadCredit() {
  try {
    const [productsResult, proposalsResult] = await Promise.all([
      api("/api/credit/products"),
      api("/api/credit/proposals")
    ]);
    state.creditProducts = productsResult.products || [];
    state.creditProposals = proposalsResult.proposals || [];

    const select = $("#creditProduct");
    const list = $("#creditProductsList");
    if (select) {
      select.innerHTML = state.creditProducts.length
        ? state.creditProducts.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${escapeHtml(p.partnerName)}</option>`).join("")
        : '<option value="">Nenhum produto disponível</option>';
    }

    if (list) {
      if (!state.creditProducts.length) {
        list.innerHTML = '<div class="empty-state">Nenhuma linha de crédito habilitada ainda. O módulo já está preparado para receber parceiros.</div>';
      } else {
        list.innerHTML = state.creditProducts.map(p => `
          <article class="credit-product-card">
            <span class="addon-type">${escapeHtml(p.partnerName)}</span>
            <strong>${escapeHtml(p.name)}</strong>
            <p>${escapeHtml(p.description || "Produto financeiro disponível no balcão.")}</p>
            <div><span>Faixa</span><b>${p.minAmount ? money(p.minAmount) : "—"} a ${p.maxAmount ? money(p.maxAmount) : "—"}</b></div>
            <div><span>Comissão do ponto</span><b>${Number(p.pointCommissionPercent || 0).toFixed(1)}%</b></div>
          </article>`).join("");
      }
    }

    const proposals = $("#creditProposalsList");
    if (proposals) {
      proposals.innerHTML = state.creditProposals.length
        ? state.creditProposals.map(p => `
          <div class="inventory-row">
            <div><span class="addon-type">${escapeHtml(p.partner_name || "PARCEIRO")}</span><strong>${escapeHtml(p.product_name || "")}</strong><small>#${escapeHtml(String(p.id).slice(0,8).toUpperCase())}</small></div>
            <div><span>Cliente</span><strong>${escapeHtml(p.applicant_name || "")}</strong></div>
            <div><span>Valor</span><strong>${money(p.requested_amount)}</strong></div>
            <div><span>Status</span><strong>${escapeHtml(p.status || "LEAD")}</strong></div>
          </div>`).join("")
        : '<div class="empty-state">Nenhuma intenção de crédito registrada.</div>';
    }
  } catch (err) {
    toast(err.message, "error");
  }
}



function compactMoney(value){
  const n=Number(value||0);
  if(Math.abs(n)>=1000000) return "R$ "+(n/1000000).toFixed(1).replace(".",",")+" mi";
  if(Math.abs(n)>=1000) return "R$ "+(n/1000).toFixed(1).replace(".",",")+" mil";
  return money(n);
}

async function ensureAnalyticsStores(){
  if(!["ADMIN","SUPERVISOR"].includes(state.user?.role)) return;
  if(!state.analytics.stores.length){
    const result=await api("/api/admin/stores");
    state.analytics.stores=(result.stores||[]).filter(s=>s.active);
  }
  [["#analyticsStore","Todos os pontos"],["#cashAnalyticsStore","Toda a rede"]].forEach(([selector,label])=>{
    const el=$(selector); if(!el) return;
    const selected=el.value;
    el.innerHTML='<option value="">'+label+'</option>'+
      state.analytics.stores.map(s=>'<option value="'+escapeHtml(s.id)+'">'+escapeHtml(s.name)+' ('+escapeHtml(s.code)+')</option>').join("");
    if([...el.options].some(o=>o.value===selected)) el.value=selected;
  });
}

function appendSelectOptions(selector,values){
  const el=$(selector); if(!el) return;
  const current=el.value;
  const existing=new Set([...el.options].map(o=>o.value));
  (values||[]).filter(Boolean).forEach(value=>{
    if(existing.has(String(value))) return;
    const option=document.createElement("option");
    option.value=String(value); option.textContent=String(value);
    el.appendChild(option); existing.add(String(value));
  });
  if([...el.options].some(o=>o.value===current)) el.value=current;
}

function filterQuery(prefix){
  const period=$("#"+prefix+"Period")?.value||"30d";
  const params=new URLSearchParams({period});
  const from=$("#"+prefix+"From")?.value||"";
  const to=$("#"+prefix+"To")?.value||"";
  const store=$("#"+prefix+"Store")?.value||"";
  const carrier=$("#"+prefix+"Carrier")?.value||"";
  const service=$("#"+prefix+"Service")?.value||"";
  const payment=$("#"+prefix+"Payment")?.value||"";
  if(period==="custom"&&from) params.set("from",from);
  if(period==="custom"&&to) params.set("to",to);
  if(store) params.set("storeId",store);
  if(carrier) params.set("carrier",carrier);
  if(service) params.set("service",service);
  if(payment) params.set("paymentMethod",payment);
  return params;
}

function drawLineChart(canvas,data,series){
  if(!canvas) return;
  const rows=Array.isArray(data)?data:[];
  const rect=canvas.getBoundingClientRect();
  const width=Math.max(320,Math.floor(rect.width||700));
  const height=Math.max(220,Math.floor(rect.height||300));
  const dpr=window.devicePixelRatio||1;
  canvas.width=Math.floor(width*dpr); canvas.height=Math.floor(height*dpr);
  const ctx=canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  const left=62,right=18,top=22,bottom=42;
  const plotW=width-left-right,plotH=height-top-bottom;
  ctx.font="10px Arial"; ctx.fillStyle="#7b808b"; ctx.strokeStyle="#e8e9ed"; ctx.lineWidth=1;

  if(!rows.length){
    ctx.textAlign="center"; ctx.fillText("Sem dados no período selecionado.",width/2,height/2); return;
  }

  const values=[];
  series.forEach(s=>rows.forEach(r=>values.push(Number(r[s.key]||0))));
  const max=Math.max(1,...values);
  for(let i=0;i<=4;i++){
    const y=top+(plotH*i/4);
    ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();
    ctx.textAlign="right";ctx.textBaseline="middle";
    ctx.fillText(compactMoney(max*(1-i/4)).replace("R$ ",""),left-8,y);
  }
  const step=rows.length>1?plotW/(rows.length-1):plotW;
  const labelEvery=Math.max(1,Math.ceil(rows.length/7));
  rows.forEach((r,i)=>{
    if(i%labelEvery!==0 && i!==rows.length-1) return;
    const x=rows.length>1?left+i*step:left+plotW/2;
    ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="#7b808b";
    ctx.fillText(String(r.label||""),x,height-bottom+12);
  });

  const root=getComputedStyle(document.documentElement);
  const defaultColors=[root.getPropertyValue("--postal").trim()||"#d9003d","#20242d","#7b808b"];
  series.forEach((s,seriesIndex)=>{
    ctx.strokeStyle=s.color||defaultColors[seriesIndex%defaultColors.length];
    ctx.fillStyle=ctx.strokeStyle; ctx.lineWidth=2.5; ctx.beginPath();
    rows.forEach((r,i)=>{
      const x=rows.length>1?left+i*step:left+plotW/2;
      const y=top+plotH-(Number(r[s.key]||0)/max)*plotH;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    });
    ctx.stroke();
    rows.forEach((r,i)=>{
      const x=rows.length>1?left+i*step:left+plotW/2;
      const y=top+plotH-(Number(r[s.key]||0)/max)*plotH;
      ctx.beginPath();ctx.arc(x,y,2.8,0,Math.PI*2);ctx.fill();
    });
  });

  if(series.length>1){
    let x=left;
    series.forEach((s,i)=>{
      ctx.fillStyle=s.color||defaultColors[i%defaultColors.length];
      ctx.fillRect(x,5,9,9); ctx.fillStyle="#555b66";ctx.textAlign="left";ctx.textBaseline="top";
      ctx.fillText(s.label,x+14,4); x+=ctx.measureText(s.label).width+42;
    });
  }
}

function renderBars(selector,items,valueKey){
  const host=$(selector); if(!host) return;
  const rows=Array.isArray(items)?items:[];
  if(!rows.length){host.innerHTML='<div class="empty-state">Sem dados no período.</div>';return;}
  const max=Math.max(1,...rows.map(r=>Number(r[valueKey]||0)));
  host.innerHTML=rows.map(r=>{
    const pct=Math.max(2,(Number(r[valueKey]||0)/max)*100);
    return '<div class="analytics-bar-row">'+
      '<div class="analytics-bar-meta"><strong>'+escapeHtml(r.label||"Não informado")+'</strong><span>'+Number(r.orders||0)+' envios · '+money(r[valueKey]||0)+'</span></div>'+
      '<div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:'+pct.toFixed(1)+'%"></div></div>'+
    '</div>';
  }).join("");
}

function rankRows(selector,items,mapper){
  const host=$(selector); if(!host) return;
  const rows=Array.isArray(items)?items:[];
  if(!rows.length){host.innerHTML='<div class="empty-state">Sem dados no período.</div>';return;}
  host.innerHTML=rows.map((item,index)=>{
    const row=mapper(item)||{};
    return '<div class="analytics-rank-row">'+
      '<div class="analytics-rank-index">'+(index+1)+'</div>'+
      '<div class="analytics-rank-main"><strong>'+escapeHtml(row.title||"—")+'</strong><small>'+escapeHtml(row.subtitle||"")+'</small></div>'+
      '<div class="analytics-rank-value"><strong>'+escapeHtml(row.value||"")+'</strong><small>'+escapeHtml(row.detail||"")+'</small></div>'+
    '</div>';
  }).join("");
}

async function loadManagementAnalytics(){
  if(!["ADMIN","SUPERVISOR","STORE_OWNER"].includes(state.user?.role)) return;
  try{
    await ensureAnalyticsStores();
    const data=await api("/api/analytics/overview?"+filterQuery("analytics").toString());
    state.analytics.dashboardData=data;
    const s=data.summary||{};
    $("#analyticsGross").textContent=money(s.grossSales||0);
    $("#analyticsOrders").textContent=Number(s.paidOrders||0);
    $("#analyticsPackagesCaption").textContent=Number(s.packages||0)+" pacote(s)";
    $("#analyticsTicket").textContent=money(s.avgTicket||0);
    $("#analyticsCustomers").textContent=Number(s.uniqueCustomers||0);
    $("#analyticsPostalRevenue").textContent=money(s.postalRevenue||0);
    $("#analyticsPointRevenue").textContent=money(s.pointRevenue||0);
    if($("#analyticsHubTransfer")) $("#analyticsHubTransfer").textContent=money(s.hubTransferRevenue||0);

    appendSelectOptions("#analyticsCarrier",data.filters?.carriers||[]);
    appendSelectOptions("#analyticsService",data.filters?.services||[]);
    drawLineChart($("#dashboardRevenueChart"),data.timeline,[{key:"grossSales",label:"Faturamento"}]);
    renderBars("#analyticsCarriersList",data.carriers,"grossSales");

    rankRows("#analyticsTopCustomers",data.topCustomers,item=>({
      title:item.name||"Cliente",
      subtitle:(item.document?item.document+" · ":"")+Number(item.packages||0)+" pacote(s)",
      value:Number(item.shipments||0)+" postagem(ns)",
      detail:money(item.grossSales||0)
    }));
    rankRows("#analyticsDestinations",data.topDestinations,item=>({
      title:item.city||"Não informado",
      subtitle:Number(item.packages||0)+" pacote(s)",
      value:Number(item.shipments||0)+" envio(s)",
      detail:money(item.grossSales||0)
    }));
    rankRows("#analyticsServicesList",data.services,item=>({
      title:item.label||"Serviço",
      subtitle:Number(item.orders||0)+" venda(s)",
      value:money(item.grossSales||0),
      detail:""
    }));
    rankRows("#analyticsPaymentsList",data.paymentMethods,item=>({
      title:item.label||"Pagamento",
      subtitle:Number(item.orders||0)+" pagamento(s)",
      value:money(item.grossSales||0),
      detail:""
    }));
    rankRows("#analyticsStoresList",data.stores,item=>({
      title:item.name||"Ponto",
      subtitle:Number(item.orders||0)+" postagem(ns) · "+Number(item.packages||0)+" pacote(s)",
      value:money(item.grossSales||0),
      detail:"Receita do ponto: "+money(item.pointRevenue||0)+(Number(item.hubTransferRevenue||0)>0?" · Hub: "+money(item.hubTransferRevenue):"")
    }));
    rankRows("#analyticsStatusesList",data.statuses,item=>({
      title:String(item.label||"Status").replaceAll("_"," "),
      subtitle:"Situação operacional",
      value:Number(item.orders||0)+" envio(s)",
      detail:""
    }));
  }catch(err){
    toast(err.message,"error");
  }
}

async function loadCashAnalytics(){
  if(!["ADMIN","SUPERVISOR","STORE_OWNER"].includes(state.user?.role)) return null;
  await ensureAnalyticsStores();
  const params=filterQuery("cashAnalytics");
  const data=await api("/api/analytics/overview?"+params.toString());
  state.analytics.cashData=data;
  appendSelectOptions("#cashAnalyticsCarrier",data.filters?.carriers||[]);
  const revenueKey="pointRevenue";
  const revenueLabel=state.user?.role==="STORE_OWNER"?"Receita do ponto":"Receita dos pontos";
  drawLineChart($("#cashRevenueChart"),data.timeline,[
    {key:"grossSales",label:"Faturamento"},
    {key:revenueKey,label:revenueLabel}
  ]);
  renderBars("#cashPaymentBreakdown",data.paymentMethods,"grossSales");
  return data;
}

function toggleCustomDates(prefix,selector){
  const custom=$("#"+prefix+"Period")?.value==="custom";
  document.querySelectorAll(selector).forEach(el=>el.classList.toggle("hidden",!custom));
}

async function loadCash() {
  if (!["ADMIN","SUPERVISOR","STORE_OWNER"].includes(state.user?.role)) return;
  const summaryHost=$("#cashSummaryList");
  const movementsHost=$("#cashMovementsList");
  if(summaryHost) summaryHost.innerHTML='<div class="empty-state">Carregando caixa...</div>';
  if(movementsHost) movementsHost.innerHTML='<div class="empty-state">Carregando movimentações...</div>';
  try{
    await ensureAnalyticsStores();
    const params=filterQuery("cashAnalytics");
    const results=await Promise.all([
      api("/api/store/cash?"+params.toString()),
      loadCashAnalytics()
    ]);
    const data=results[0];
    const s=data.summary||{};
    $("#cashTotalEarnings").textContent=money(s.totalEarnings||0);
    $("#cashSalesEarnings").textContent=money(s.salesEarnings||0);
    $("#cashExtraEarnings").textContent=money(s.extraEarnings||0);
    $("#cashPendingRemittance").textContent=money(s.pendingRemittance||0);
    if(summaryHost){
      summaryHost.innerHTML=
        '<div class="inventory-row"><div><span class="addon-type">VENDAS</span><strong>Pedidos pagos</strong></div><div><strong>'+Number(s.paidOrders||0)+'</strong><small>Clientes pagaram '+money(s.customerReceived||0)+'</small></div></div>'+
        '<div class="inventory-row"><div><span class="addon-type">COLETAS</span><strong>Remuneração por coleta</strong></div><div><strong>'+money(s.pickupEarnings||0)+'</strong></div></div>'+
        '<div class="inventory-row"><div><span class="addon-type">POSTAGEM</span><strong>Recebimento no ponto</strong></div><div><strong>'+money(s.dropoffEarnings||0)+'</strong></div></div>'+
        '<div class="inventory-row"><div><span class="addon-type">INDICAÇÃO</span><strong>Clientes indicados</strong></div><div><strong>'+money(s.referralEarnings||0)+'</strong></div></div>';
    }
    if(movementsHost){
      const movements=Array.isArray(data.movements)?data.movements:[];
      movementsHost.innerHTML=movements.length?movements.map(function(m){
        return '<div class="inventory-row">'+
          '<div><span class="addon-type">'+escapeHtml(m.type==="SALE"?"VENDA":"GANHO")+'</span><strong>'+escapeHtml(m.description||"Movimentação")+'</strong><small>'+escapeHtml(m.storeName||"")+' · '+new Date(m.createdAt).toLocaleString("pt-BR")+'</small></div>'+
          '<div><span>Status</span><strong>'+escapeHtml(m.status||"")+'</strong></div>'+
          '<div><span>Valor</span><strong>'+money(m.amount||0)+'</strong></div>'+
        '</div>';
      }).join(""):'<div class="empty-state">Ainda não há movimentações no período selecionado.</div>';
    }
  }catch(err){
    if(summaryHost) summaryHost.innerHTML='<div class="empty-state">'+escapeHtml(err.message)+'</div>';
    if(movementsHost) movementsHost.innerHTML='<div class="empty-state">Não foi possível carregar o extrato.</div>';
  }
}

async function loadSupervisor() {
  if (state.user?.role !== "SUPERVISOR") return;
  try{
    const results=await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/stores"),
      api("/api/admin/users")
    ]);
    const overview=results[0]||{};
    const allStores=results[1].stores||[];
    const allUsers=results[2].users||[];
    $("#supervisorStores").textContent=Number(overview.activeStores||0);
    $("#supervisorUsers").textContent=Number(overview.activeUsers||0);
    $("#supervisorOrders").textContent=Number(overview.totalOrders||0);
    $("#supervisorGross").textContent=money(overview.grossSales||0);
    const host=$("#supervisorStoresList");
    host.innerHTML=allStores.length?allStores.map(function(store){
      return '<div class="admin-row">'+
        '<div><strong>'+escapeHtml(store.name)+'</strong><span>'+escapeHtml(store.code)+' · '+(store.active?"Ativo":"Inativo")+'</span></div>'+
        '<div><span>Usuários ativos</span><strong>'+Number(store.activeUsers||0)+'</strong></div>'+
        '<div><span>Fretes</span><strong>'+Number(store.totalOrders||0)+'</strong></div>'+
        '<div><span>Venda bruta</span><strong>'+money(store.grossSales||0)+'</strong></div>'+
        '<div><span>Equipe cadastrada</span><strong>'+allUsers.filter(function(u){return u.store_id===store.id&&u.active;}).length+'</strong></div>'+
      '</div>';
    }).join(""):'<div class="empty-state">Nenhum ponto cadastrado.</div>';
  }catch(err){
    const host=$("#supervisorStoresList");
    if(host) host.innerHTML='<div class="empty-state">'+escapeHtml(err.message)+'</div>';
  }
}

$("#refreshCashBtn")?.addEventListener("click",loadCash);
$("#refreshSupervisorBtn")?.addEventListener("click",loadSupervisor);
$("#refreshAnalyticsBtn")?.addEventListener("click",loadManagementAnalytics);
$("#analyticsPeriod")?.addEventListener("change",()=>{toggleCustomDates("analytics",".analytics-custom-date");if($("#analyticsPeriod").value!=="custom")loadManagementAnalytics();});
["#analyticsFrom","#analyticsTo","#analyticsStore","#analyticsCarrier","#analyticsService","#analyticsPayment"].forEach(sel=>$(sel)?.addEventListener("change",loadManagementAnalytics));
$("#cashAnalyticsPeriod")?.addEventListener("change",()=>{toggleCustomDates("cashAnalytics",".cash-custom-date");if($("#cashAnalyticsPeriod").value!=="custom")loadCash();});
["#cashAnalyticsFrom","#cashAnalyticsTo","#cashAnalyticsStore","#cashAnalyticsCarrier","#cashAnalyticsPayment"].forEach(sel=>$(sel)?.addEventListener("change",loadCash));
window.addEventListener("resize",()=>{
  if(state.analytics.dashboardData) drawLineChart($("#dashboardRevenueChart"),state.analytics.dashboardData.timeline,[{key:"grossSales",label:"Faturamento"}]);
  if(state.analytics.cashData){
    const key="pointRevenue";
    drawLineChart($("#cashRevenueChart"),state.analytics.cashData.timeline,[{key:"grossSales",label:"Faturamento"},{key,label:state.user?.role==="STORE_OWNER"?"Receita do ponto":"Receita dos pontos"}]);
  }
});

async function loadMaster() {
  if (state.user?.role !== "ADMIN") return;
  try {
    const [overview, stores, users, catalog, partners, products, auditResult, readiness] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/stores"),
      api("/api/admin/users"),
      api("/api/admin/catalog"),
      api("/api/admin/credit/partners"),
      api("/api/admin/credit/products"),
      api("/api/admin/audit?limit=80"),
      api("/api/admin/go-live-readiness")
    ]);

    state.admin.stores = stores.stores || [];
    state.admin.users = users.users || [];
    state.admin.catalog = catalog.items || [];
    state.admin.creditPartners = partners.partners || [];
    state.admin.creditProducts = products.products || [];

    $("#masterStores").textContent = overview.activeStores || 0;
    $("#masterUsers").textContent = overview.activeUsers || 0;
    $("#masterOrders").textContent = overview.totalOrders || 0;
    $("#masterGross").textContent = money(overview.grossSales);
    $("#masterPostalRevenue").textContent = money(overview.postalRevenue);

    const readinessHost=$("#goLiveReadiness");
    if(readinessHost){
      const checks=readiness.checks||[];
      readinessHost.innerHTML=`
        <div class="payment-method-note">${readiness.ready
          ? "✅ Todos os bloqueios técnicos obrigatórios foram aprovados."
          : "⚠️ Operação real bloqueada por: "+(readiness.blockingFailures||[]).join(", ")}</div>
        ${checks.map(x=>`
          <div class="inventory-row">
            <div><span class="addon-type">${x.blocking?"OBRIGATÓRIO":"MONITORAMENTO"}</span><strong>${escapeHtml(x.label)}</strong><small>${escapeHtml(x.detail||"")}</small></div>
            <div><span>Status</span><strong>${x.ok?"✅ OK":"⚠️ PENDENTE"}</strong></div>
          </div>`).join("")}
      `;
    }

    const storeSelect = $("#adminUserStore");
    if (storeSelect) {
      storeSelect.innerHTML = '<option value="">Selecione...</option>' +
        state.admin.stores.filter(s=>s.active).map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.code)})</option>`).join("");
    }

    const storesHost = $("#adminStoresList");
    if (storesHost) {
      storesHost.innerHTML = state.admin.stores.length ? state.admin.stores.map(s=>`
        <div class="admin-row" data-store-id="${escapeHtml(s.id)}">
          <div><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(s.code)} · ${escapeHtml(s.cnpj || "CNPJ não informado")}</span></div>
          <div><span>Comissão</span><strong>${Number(s.commissionPercent||0).toFixed(1)}%</strong></div>
          <div><span>Usuários</span><strong>${Number(s.activeUsers||0)}</strong></div>
          <div><span>Fretes</span><strong>${Number(s.totalOrders||0)}</strong></div>
          <div><span>Venda</span><strong>${money(s.grossSales)}</strong></div>
          <div><span>Hub / origem operacional</span><strong>${escapeHtml(s.quoteOriginCep ? ((s.operationalHub?.name||"Hub")+" · "+maskCep(s.quoteOriginCep)) : "CEP real")}</strong></div>
          <div><span>Financeiro</span><strong>${s.asaasWalletId ? "Wallet vinculada" : "Pendente"}</strong></div>
          <button class="ghost" type="button" data-edit-store="${escapeHtml(s.id)}">Editar</button>
        </div>`).join("") : '<div class="empty-state">Nenhum ponto cadastrado.</div>';

      storesHost.querySelectorAll("[data-edit-store]").forEach(btn=>btn.addEventListener("click",async()=>{
        const store=state.admin.stores.find(s=>s.id===btn.dataset.editStore);
        if(!store) return;
        const commission=window.prompt("Comissão do ponto (%):",String(store.commissionPercent));
        if(commission==null) return;
        const wallet=window.prompt("Wallet Asaas (pode ficar vazia):",store.asaasWalletId||"");
        if(wallet==null) return;
        const quoteCep=window.prompt("CEP operacional para cotação/postagem (vazio = usar CEP real):",store.quoteOriginCep||"");
        if(quoteCep==null) return;
        const cleanQuoteCep=onlyDigits(quoteCep);
        if(cleanQuoteCep && cleanQuoteCep.length!==8) return toast("CEP máscara inválido.","error");
        let operationalHub={};
        if(cleanQuoteCep){
          const currentHub=store.operationalHub||{};
          const hubName=window.prompt("Nome do hub:",currentHub.name||"Hub Postal"); if(hubName==null) return;
          const hubAddress=window.prompt("Endereço do hub:",currentHub.address||""); if(hubAddress==null) return;
          const hubNumber=window.prompt("Número do hub:",currentHub.number||""); if(hubNumber==null) return;
          const hubNeighborhood=window.prompt("Bairro do hub:",currentHub.neighborhood||""); if(hubNeighborhood==null) return;
          const hubCity=window.prompt("Cidade do hub:",currentHub.city||""); if(hubCity==null) return;
          const hubState=window.prompt("UF do hub:",currentHub.state||"PA"); if(hubState==null) return;
          operationalHub={name:hubName.trim(),cep:cleanQuoteCep,address:hubAddress.trim(),number:hubNumber.trim(),neighborhood:hubNeighborhood.trim(),city:hubCity.trim(),state:hubState.trim().toUpperCase()};
        }
        const active=window.confirm("OK = ponto ativo. Cancelar = desativar o ponto.");
        try{
          await api(`/api/admin/stores/${store.id}`,{method:"PATCH",body:JSON.stringify({commissionPercent:Number(String(commission).replace(",",".")),asaasWalletId:wallet.trim(),quoteOriginCep:cleanQuoteCep,operationalHub,active})});
          toast("Ponto atualizado."); await loadMaster();
        }catch(err){toast(err.message,"error");}
      }));
    }

    const usersHost=$("#adminUsersList");
    if(usersHost){
      usersHost.innerHTML=state.admin.users.length?state.admin.users.map(u=>`
        <div class="admin-row admin-user-row">
          <div><strong>${escapeHtml(u.name)}</strong><span>${escapeHtml(u.email)}</span></div>
          <div><span>Perfil</span><strong>${escapeHtml(u.role)}</strong></div>
          <div><span>Ponto</span><strong>${escapeHtml(u.store_name || "Postal")}</strong></div>
          <div><span>Status</span><strong>${u.active ? "Ativo" : "Inativo"}</strong></div>
          <div><span>Último acesso</span><strong>${u.last_login_at ? new Date(u.last_login_at).toLocaleString("pt-BR") : "—"}</strong></div>
          <div class="row-actions">
            <button class="ghost" type="button" data-edit-user="${escapeHtml(u.id)}">Editar</button>
            <button class="ghost" type="button" data-reset-user="${escapeHtml(u.id)}">Resetar senha</button>
            <button class="danger-btn" type="button" data-delete-user="${escapeHtml(u.id)}">Excluir</button>
          </div>
        </div>`).join(""):'<div class="empty-state">Nenhum usuário cadastrado.</div>';

      usersHost.querySelectorAll("[data-edit-user]").forEach(btn=>btn.addEventListener("click",async()=>{
        const user=state.admin.users.find(u=>u.id===btn.dataset.editUser);
        if(!user) return;
        const active=window.confirm("OK = usuário ativo. Cancelar = desativar o usuário.");
        const roleInput=window.prompt("Perfil: ADMIN, SUPERVISOR, STORE_OWNER, STORE_CLERK ou OPS",user.role);
        if(roleInput==null) return;
        const role=String(roleInput).trim().toUpperCase();
        let storeId=user.store_id||null;
        if(!["ADMIN","SUPERVISOR"].includes(role)){
          const storeCode=window.prompt("Código do ponto:",user.store_code||"");
          if(storeCode==null) return;
          const store=state.admin.stores.find(s=>s.code.toLowerCase()===String(storeCode).trim().toLowerCase());
          if(!store) return toast("Ponto não encontrado pelo código informado.","error");
          storeId=store.id;
        } else {
          storeId=null;
        }
        const password=window.prompt("Nova senha (deixe em branco para manter):","");
        if(password==null) return;
        try{
          await api(`/api/admin/users/${user.id}`,{method:"PATCH",body:JSON.stringify({role,storeId,active,password})});
          toast("Usuário atualizado.");
          await loadMaster();
        }catch(err){toast(err.message,"error");}
      }));

      usersHost.querySelectorAll("[data-reset-user]").forEach(btn=>btn.addEventListener("click",async()=>{
        const user=state.admin.users.find(u=>u.id===btn.dataset.resetUser);
        if(!user) return;
        if(String(user.id)===String(state.user?.id)) return toast("Use 'Alterar minha senha' para o próprio MASTER.","error");
        if(!window.confirm("Redefinir a senha de "+user.name+"?")) return;
        try{
          const result=await api("/api/admin/users/"+encodeURIComponent(user.id)+"/reset-password",{method:"POST",body:"{}"});
          window.prompt("Senha temporária de "+user.name+" — copie e envie ao usuário:",result.temporaryPassword||"");
          toast("Senha redefinida.");
        }catch(err){toast(err.message,"error");}
      }));

      usersHost.querySelectorAll("[data-delete-user]").forEach(btn=>btn.addEventListener("click",async()=>{
        const user=state.admin.users.find(u=>u.id===btn.dataset.deleteUser);
        if(!user) return;
        if(String(user.id)===String(state.user?.id)) return toast("O MASTER não pode excluir o próprio acesso.","error");
        if(!window.confirm("Excluir definitivamente o usuário "+user.name+" ("+user.email+")?")) return;
        try{
          await api("/api/admin/users/"+encodeURIComponent(user.id),{method:"DELETE"});
          toast("Usuário excluído.");
          await loadMaster();
        }catch(err){toast(err.message,"error");}
      }));
    }

    const catalogHost=$("#adminCatalogList");
    if(catalogHost){
      catalogHost.innerHTML=state.admin.catalog.length?state.admin.catalog.map(item=>`
        <div class="inventory-row">
          <div><span class="addon-type">${escapeHtml(item.item_type)} · ${escapeHtml(item.category)}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)}</small></div>
          <div><span>Preço</span><strong>${money(item.unit_price)}</strong></div>
          <div><span>Ponto</span><strong>${Number(item.point_share_percent||0)}%</strong></div>
          <div><span>Postal</span><strong>${Number(item.postal_share_percent||0)}%</strong></div>
          <div><span>Fornecedor</span><strong>${Number(item.provider_share_percent||0)}%</strong></div>
        </div>`).join(""):'<div class="empty-state">Catálogo vazio.</div>';
    }

    const partnerSelect=$("#adminCreditProductPartner");
    if(partnerSelect){
      partnerSelect.innerHTML=state.admin.creditPartners.length
        ?state.admin.creditPartners.filter(p=>p.active).map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")
        :'<option value="">Cadastre um parceiro primeiro</option>';
    }

    const auditHost=$("#adminAuditList");
    const logs=auditResult.logs||[];
    if(auditHost){
      auditHost.innerHTML=logs.length?logs.map(log=>`
        <div class="audit-row">
          <span>${new Date(log.created_at).toLocaleString("pt-BR")}</span>
          <strong>${escapeHtml(log.action)}</strong>
          <span>${escapeHtml(log.user_email || "sistema")}</span>
          <small>${escapeHtml(log.entity_type || "")} ${escapeHtml(log.entity_id || "")}</small>
        </div>`).join(""):'<div class="empty-state">Sem eventos de auditoria.</div>';
    }
  } catch (err) {
    toast(err.message,"error");
  }
}

$("#refreshGoLiveBtn")?.addEventListener("click",loadMaster);
$("#refreshMasterBtn")?.addEventListener("click",loadMaster);
$("#exportBackupBtn")?.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/admin/export");
    if (!response.ok) throw new Error("Não foi possível gerar o backup.");
    const blob = await response.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "postal-backup-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Exportação operacional gerada.");
  } catch (err) {
    toast(err.message, "error");
  }
});
$("#refreshCreditBtn")?.addEventListener("click",loadCredit);

$("#adminStoreForm")?.addEventListener("submit",async event=>{
  event.preventDefault();
  const btn=event.currentTarget.querySelector("button[type='submit']");
  btn.disabled=true;
  try{
    await api("/api/admin/stores",{method:"POST",body:JSON.stringify({
      code:$("#adminStoreCode").value.trim(),
      name:$("#adminStoreName").value.trim(),
      cnpj:$("#adminStoreCnpj").value.trim(),
      email:$("#adminStoreEmail").value.trim(),
      address:{
        cep:onlyDigits($("#adminStoreCep").value),
        city:$("#adminStoreCity").value.trim(),
        state:$("#adminStoreUf").value.trim().toUpperCase(),
        address:$("#adminStoreAddress").value.trim(),
        number:$("#adminStoreNumber").value.trim()
      },
      commissionPercent:Number($("#adminStoreCommission").value||20),
      quoteOriginCep:onlyDigits($("#adminStoreQuoteCep").value),
      operationalHub:{
        name:$("#adminStoreHubName").value.trim(),
        cep:onlyDigits($("#adminStoreQuoteCep").value),
        address:$("#adminStoreHubAddress").value.trim(),
        number:$("#adminStoreHubNumber").value.trim(),
        neighborhood:$("#adminStoreHubNeighborhood").value.trim(),
        city:$("#adminStoreHubCity").value.trim(),
        state:$("#adminStoreHubUf").value.trim().toUpperCase()
      },
      asaasWalletId:$("#adminStoreWallet").value.trim()
    })});
    event.currentTarget.reset(); $("#adminStoreCommission").value="20"; toast("Ponto cadastrado."); await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#adminUserForm")?.addEventListener("submit",async event=>{
  event.preventDefault();
  const role=$("#adminUserRole").value;
  const btn=event.currentTarget.querySelector("button[type='submit']"); btn.disabled=true;
  try{
    await api("/api/admin/users",{method:"POST",body:JSON.stringify({
      name:$("#adminUserName").value.trim(),email:$("#adminUserEmail").value.trim(),
      password:$("#adminUserPassword").value,role,storeId:["ADMIN","SUPERVISOR"].includes(role)?null:$("#adminUserStore").value
    })});
    event.currentTarget.reset(); toast("Usuário criado."); await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#adminUserRole")?.addEventListener("change",()=>{
  $("#adminUserStore").disabled=["ADMIN","SUPERVISOR"].includes($("#adminUserRole").value);
});

$("#adminCatalogForm")?.addEventListener("submit",async event=>{
  event.preventDefault();
  const btn=event.currentTarget.querySelector("button[type='submit']"); btn.disabled=true;
  try{
    const code=$("#adminCatalogCode").value.trim().toUpperCase();
    await api("/api/admin/catalog/"+encodeURIComponent(code),{method:"PUT",body:JSON.stringify({
      name:$("#adminCatalogName").value.trim(),itemType:$("#adminCatalogType").value,
      category:$("#adminCatalogCategory").value.trim(),unitPrice:Number($("#adminCatalogPrice").value||0),
      trackStock:$("#adminCatalogStock").checked,
      pointSharePercent:Number($("#adminCatalogPointShare").value||0),
      postalSharePercent:Number($("#adminCatalogPostalShare").value||0),
      providerSharePercent:Number($("#adminCatalogProviderShare").value||0),
      externalProvider:$("#adminCatalogProvider").value.trim()
    })});
    event.currentTarget.reset(); $("#adminCatalogPointShare").value="100"; $("#adminCatalogPostalShare").value="0"; $("#adminCatalogProviderShare").value="0";
    toast("Item salvo no catálogo."); await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#adminCreditPartnerForm")?.addEventListener("submit",async event=>{
  event.preventDefault(); const btn=event.currentTarget.querySelector("button[type='submit']");btn.disabled=true;
  try{
    await api("/api/admin/credit/partners",{method:"POST",body:JSON.stringify({
      code:$("#adminCreditPartnerCode").value.trim(),name:$("#adminCreditPartnerName").value.trim(),
      integrationMode:$("#adminCreditPartnerMode").value,apiBaseUrl:$("#adminCreditPartnerApi").value.trim()
    })});
    event.currentTarget.reset();toast("Parceiro financeiro salvo.");await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#adminCreditProductForm")?.addEventListener("submit",async event=>{
  event.preventDefault(); const btn=event.currentTarget.querySelector("button[type='submit']");btn.disabled=true;
  try{
    await api("/api/admin/credit/products",{method:"POST",body:JSON.stringify({
      partnerId:$("#adminCreditProductPartner").value,code:$("#adminCreditProductCode").value.trim(),
      name:$("#adminCreditProductName").value.trim(),minAmount:Number($("#adminCreditMin").value||0),
      maxAmount:Number($("#adminCreditMax").value||0),pointCommissionPercent:Number($("#adminCreditPointCommission").value||0),
      postalCommissionPercent:Number($("#adminCreditPostalCommission").value||0)
    })});
    event.currentTarget.reset();toast("Produto financeiro salvo.");await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#creditProposalForm")?.addEventListener("submit",async event=>{
  event.preventDefault(); const btn=event.currentTarget.querySelector("button[type='submit']");btn.disabled=true;
  try{
    await api("/api/credit/proposals",{method:"POST",body:JSON.stringify({
      productId:$("#creditProduct").value,applicantName:$("#creditApplicantName").value.trim(),
      document:$("#creditDocument").value.trim(),phone:$("#creditPhone").value.trim(),
      requestedAmount:Number($("#creditAmount").value||0),consent:$("#creditConsent").checked
    })});
    event.currentTarget.reset();toast("Intenção de crédito registrada.");await loadCredit();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#paymentMethod")?.addEventListener("change", async () => {
  const method = $("#paymentMethod").value;
  const btn = $("#createShipmentBtn");
  if (method === "DINHEIRO") btn.textContent = "Registrar dinheiro e salvar frete";
  else if (method === "PIX") btn.textContent = "Continuar para PIX";
  else if (method === "CARTAO") btn.textContent = "Continuar para cartão";
  else btn.textContent = "Continuar para pagamento";
  await refreshPaymentPreview();
});

$("#inventoryReceiveForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const btn = event.currentTarget.querySelector("button[type='submit']");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Registrando...";

  try {
    await api("/api/inventory/receive", {
      method: "POST",
      body: JSON.stringify({
        code: $("#inventoryProduct").value,
        quantity: Number($("#inventoryQuantity").value || 0),
        salePrice: state.user?.role === "ADMIN" ? Number($("#inventorySalePrice").value || 0) : undefined,
        unitCost: Number($("#inventoryUnitCost").value || 0),
        lotCode: $("#inventoryLotCode").value.trim(),
        note: $("#inventoryNote").value.trim()
      })
    });
    $("#inventoryQuantity").value = "";
    $("#inventoryLotCode").value = "";
    $("#inventoryNote").value = "";
    toast("Entrada de estoque registrada.");
    await loadInventory();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$("#inventoryProduct")?.addEventListener("change", () => {
  const item = state.inventory.find(x => x.code === $("#inventoryProduct").value);
  if (item) {
    $("#inventorySalePrice").value = Number(item.unitPrice || 0).toFixed(2);
    $("#inventoryUnitCost").value = Number(item.averageCost || 0).toFixed(2);
  }
});

$("#refreshInventoryBtn")?.addEventListener("click", loadInventory);
$("#exportInventoryBtn")?.addEventListener("click", () => {
  const rows = [["Código","Item","Tipo","Custo médio","Preço venda","Estoque físico","Reservado","Disponível","Estoque mínimo"]];
  state.inventory.forEach(item => rows.push([
    item.code,item.name,item.itemType,Number(item.averageCost||0).toFixed(2),Number(item.unitPrice||0).toFixed(2),
    item.stockQuantity,item.reservedQuantity,item.availableQuantity,item.minQuantity
  ]));
  const csv = rows.map(row => row.map(value => '"' + String(value ?? "").replaceAll('"','""') + '"').join(";")).join("\n");
  const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="estoque-postal-"+new Date().toISOString().slice(0,10)+".csv"; a.click(); URL.revokeObjectURL(a.href);
});

$("#shipmentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.selectedOption?.selectionToken) {
    toast("A cotação expirou. Calcule novamente.", "error");
    return;
  }

  const declaration = contentData();
  if (!declaration.length || declaration.some(item => !item.description || item.quantity <= 0 || item.value < 0)) {
    toast("Revise a declaração de conteúdo.", "error");
    return;
  }

  if (state.user?.role === "CLIENT") {
    const btn = $("#createShipmentBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Gerando envio com saldo...";
    try {
      await window.PostalClient?.submitShipment?.();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    return;
  }

  const paymentMethod = $("#paymentMethod").value;
  if (!paymentMethod) {
    toast("Selecione a forma de pagamento.", "error");
    return;
  }

  const btn = $("#createShipmentBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = paymentMethod === "DINHEIRO" ? "Salvando frete..." : "Criando pagamento...";

  const payload = {
    selectionToken: state.selectedOption.selectionToken,
    carrier: state.selectedOption.transportadora,
    sender: partyData("sender"),
    recipient: partyData("recipient"),
    items: declaration,
    invoiceNumber: currentInvoiceNumber(),
    paymentMethod,
    addons: selectedAddonPayload()
  };

  try {
    const result = await api("/api/orders", { method: "POST", body: JSON.stringify(payload) });

    if (result.nextAction === "OPEN_CHECKOUT" && result.checkoutUrl) {
      toast("Pagamento criado. A etiqueta será liberada somente depois da confirmação.");
      window.location.href = result.checkoutUrl;
      return;
    }

    if (result.nextAction === "PAY_REMITTANCE") {
      toast("Dinheiro registrado. O frete ficou pendente em Meus Fretes até o ponto fazer o repasse.");
      navigate("orders");
      return;
    }

    if (result.paymentSetupRequired) {
      toast(result.message || "A configuração financeira deste ponto ainda precisa ser concluída.", "error");
      navigate("orders");
      return;
    }

    navigate("orders");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

$("#closeReceiptPreviewBtn")?.addEventListener("click", closeReceiptPreview);
$("#receiptPreviewModal")?.addEventListener("click", event => {
  if (event.target.id === "receiptPreviewModal") closeReceiptPreview();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeReceiptPreview();
});

$("#printReceiptBtn")?.addEventListener("click", () => {
  if (!state.shipmentResult) return;
  openReceipt(receiptPayload(false), true);
});
$("#printLabelBtn")?.addEventListener("click", () => openProviderDocument(state.shipmentResult?.labelA6Url || state.shipmentResult?.labelA4Url));

window.addEventListener("error", event => {
  console.error("Erro de interface:", event.error || event.message);
  const badge = $("#apiBadge");
  if (badge && badge.textContent.includes("Verificando")) {
    badge.className = "status-badge error";
    badge.innerHTML = '<span class="dot"></span> Erro na interface';
  }
});

window.addEventListener("unhandledrejection", event => {
  console.error("Falha assíncrona:", event.reason);
});

checkSession();

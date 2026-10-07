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
  inventoryMovements: []
};

const viewMap = {
  dashboard: { el: "#dashboardView", title: "Visão geral" },
  quote: { el: "#quoteView", title: "Simular Frete" },
  shipment: { el: "#shipmentView", title: "Nova Postagem" },
  orders: { el: "#ordersView", title: "Meus Fretes" },
  inventory: { el: "#inventoryView", title: "Produtos & Estoque" },
  credit: { el: "#creditView", title: "Crédito no Balcão" },
  master: { el: "#masterView", title: "Painel Master" },
  clientHome: { el: "#clientHomeView", title: "Minha Postal" },
  clientOrders: { el: "#clientOrdersView", title: "Pedidos" },
  wallet: { el: "#walletView", title: "Saldo" },
  connections: { el: "#connectionsView", title: "Integrações" },
  collections: { el: "#collectionsView", title: "Coletas" },
  referrals: { el: "#referralsView", title: "Indique & Ganhe" },
  receive: { placeholder: ["Receber Pacote", "Aqui o atendente fará a leitura do código e confirmará que a encomenda entrou fisicamente no ponto Postal."] },
  returns: { placeholder: ["Devolução", "Fluxo de logística reversa e devoluções ficará centralizado nesta área."] },
  cash: { placeholder: ["Meu Caixa", "Extrato de comissões, saldo, fechamento diário e solicitação de saque serão exibidos aqui."] },
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
  $("#adminNavSection")?.classList.toggle("hidden", user?.role !== "ADMIN");

  const canSell = ["ADMIN","STORE_OWNER","STORE_CLERK","CLIENT"].includes(user?.role);
  const canManageStock = ["ADMIN","STORE_OWNER","OPS"].includes(user?.role);
  const canUseCredit = ["ADMIN","STORE_OWNER","STORE_CLERK"].includes(user?.role);
  const ownerFinance = ["ADMIN","STORE_OWNER"].includes(user?.role);

  document.querySelector('[data-view="quote"]')?.classList.toggle("hidden", !canSell);
  document.querySelector('[data-view="credit"]')?.classList.toggle("hidden", !canUseCredit);
  document.querySelector('[data-view="inventory"]')?.classList.toggle("hidden", !canManageStock);
  document.querySelector('[data-view="cash"]')?.classList.toggle("hidden", !ownerFinance);
  window.PostalClient?.onShowApp?.(user);
  $("#inventorySalePrice")?.toggleAttribute("disabled", user?.role !== "ADMIN");

  if (user?.storeCommissionPercent != null) {
    const pct = Number(user.storeCommissionPercent).toFixed(1).replace(".0","");
    $("#commissionCaption").textContent = pct + "% sobre o preço final";
    $("#commissionBig").textContent = pct + "%";
  }

  refreshDashboard();

  const params = new URLSearchParams(window.location.search);
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
  if (name === "credit" && !["ADMIN","STORE_OWNER","STORE_CLERK"].includes(state.user?.role)) {
    toast("Este perfil não possui acesso ao crédito no balcão.", "error");
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
  if (["clientHome","clientOrders","wallet","connections"].includes(name) && state.user?.role !== "CLIENT") {
    toast("Área exclusiva para clientes Postal.", "error");
    return;
  }
  if (name === "referrals" && !["STORE_OWNER","STORE_CLERK"].includes(state.user?.role)) {
    toast("Área disponível para pontos parceiros.", "error");
    return;
  }
  if (name === "collections" && !["ADMIN","STORE_OWNER","STORE_CLERK","OPS","CLIENT"].includes(state.user?.role)) {
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
  if (name === "orders") loadOrders();
  if (name === "inventory") loadInventory();
  if (name === "credit") loadCredit();
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

function quoteVolumePayloads() {
  const volumes = [{
    peso: Number($("#peso").value || 0),
    comprimento: Number($("#comprimento").value || 0),
    largura: Number($("#largura").value || 0),
    altura: Number($("#altura").value || 0),
    vlDeclarado: Number($("#vlDeclarado").value || 0)
  }];

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
      <button class="ghost compact remove-volume-btn" type="button">Remover volume</button>
    </div>
    <div class="extra-volume-grid">
      <label><span>PESO*</span><div class="inline-input"><input data-field="peso" type="number" min="0.01" step="0.01" value="${Number(data.peso ?? 1)}" required /><em>kg</em></div></label>
      <label><span>ALTURA*</span><div class="inline-input"><input data-field="altura" type="number" min="1" step="0.1" value="${Number(data.altura ?? 10)}" required /><em>cm</em></div></label>
      <label><span>LARGURA*</span><div class="inline-input"><input data-field="largura" type="number" min="1" step="0.1" value="${Number(data.largura ?? 15)}" required /><em>cm</em></div></label>
      <label><span>COMPRIMENTO*</span><div class="inline-input"><input data-field="comprimento" type="number" min="1" step="0.1" value="${Number(data.comprimento ?? 20)}" required /><em>cm</em></div></label>
      <label><span>VALOR DECLARADO*</span><div class="inline-input"><em>R$</em><input data-field="vlDeclarado" type="number" min="0" step="0.01" value="${Number(data.vlDeclarado ?? 0)}" required /></div></label>
    </div>`;
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
  $("#resultsInfo").textContent = `${result.options.length} opção(ões) • ${result.volumeCount || payload.volumes?.length || 1} volume(s) • ordenadas por menor preço`;
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
        <small>Taxa de pagamento é somada no fechamento • passe o mouse para ver sua comissão</small>
      </div>
      <button class="select-btn" type="button">Selecionar</button>
    `;

    const priceReveal = card.querySelector(".price-reveal");
    if (state.user?.role === "CLIENT") {
      card.querySelector(".price-commission-label")?.classList.add("hidden");
      card.querySelector(".price-commission")?.classList.add("hidden");
      const hint = priceReveal.querySelector("small");
      if (hint) hint.textContent = "Preço Postal para sua conta";
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
    $("#paymentFreight").textContent = money(preview.freightPrice);
    $("#paymentAddons").textContent = money(preview.addonsTotal);
    $("#paymentFee").textContent = money(preview.paymentFee);
    $("#paymentTotal").textContent = money(preview.total);
    $("#shipPrice").textContent = money(preview.total);

    const note = $("#paymentMethodNote");
    if (method === "DINHEIRO") {
      note.textContent = `O cliente paga ${money(preview.total)} em dinheiro. O ponto mantém sua receita e depois repassa ${money(preview.cashRemittance)} via PIX para liberar a etiqueta.`;
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
  $("#paymentFreight").textContent = money(state.selectedOption.precoVenda);
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
    publicTrackingUrl: preview ? "" : (r.publicTrackingUrl || ""),
    cartId: preview ? "" : (r.cartId || ""),
    packageId: preview ? "" : (r.packageId || ""),
    carrier: o.transportadora || r.carrier || "",
    service: o.produto || r.service || "",
    deadline: o.prazoEntrega || r.deadline || "",
    salePrice: state.paymentPreview?.total || o.precoVenda || r.salePrice || 0,
    freightPrice: state.paymentPreview?.freightPrice || o.precoVenda || r.salePrice || 0,
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
  const invoice = data.invoiceNumber ?
    `<div class="row"><span>Nota fiscal</span><b>${escapeHtml(data.invoiceNumber)}</b></div>` :
    '<div class="row"><span>Documento</span><b>Declaração de conteúdo</b></div>';
  const ids = `${data.packageId ? `<div class="row tiny"><span>ID pacote</span><b>${escapeHtml(data.packageId)}</b></div>` : ""}${data.cartId ? `<div class="row tiny"><span>ID postagem</span><b>${escapeHtml(data.cartId)}</b></div>` : ""}`;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante de Postagem</title>
  <style>
  @page{size:${width}mm auto;margin:2mm}*{box-sizing:border-box}body{width:${inner}mm;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;font-size:10.5px;line-height:1.28}
  .receipt{width:100%;padding:1mm 0}.center{text-align:center}.brand{font-size:18px;font-weight:900;letter-spacing:.7px}.brand-sub{font-size:9px;font-weight:800;letter-spacing:1.2px}
  h1{font-size:13px;margin:3mm 0 1mm}.preview{border:1px solid #000;padding:1.5mm;margin:2mm 0;font-weight:900;text-align:center}.dash{border-top:1px dashed #000;margin:2.2mm 0}
  .label{font-size:8px;text-transform:uppercase;font-weight:800}.tracking{font-family:"Courier New",monospace;font-size:17px;font-weight:900;letter-spacing:.5px;word-break:break-all;margin:1mm 0}
  .section{font-weight:900;font-size:10px;margin-bottom:1mm}.person{font-weight:900;font-size:11px}.small{font-size:9px}.tiny{font-size:8px;word-break:break-all}.row,.item{display:flex;justify-content:space-between;gap:2mm;margin:.7mm 0}
  .total{font-size:14px;font-weight:900}.footer{text-align:center;font-size:8.5px;margin-top:3mm}.no-print{text-align:center;margin-top:4mm}.print-btn{padding:3mm 6mm;border:1px solid #000;background:#fff;font-weight:900}@media print{.no-print{display:none}body{width:${inner}mm}}
  </style></head><body><div class="receipt">
  <div class="center"><div class="brand">POSTAL</div><div class="brand-sub">SERVIÇOS</div><h1>COMPROVANTE DE POSTAGEM</h1><div class="small">${escapeHtml(created)}</div></div>
  ${preview}<div class="dash"></div>
  <div class="center">${trackingBlock}</div>
  <div class="dash"></div><div class="section">REMETENTE</div><div class="person">${escapeHtml(sender.name)}</div><div>Doc.: ${escapeHtml(sender.document)}</div><div>Tel.: ${escapeHtml(sender.phone)}</div>${sender.email ? `<div>E-mail: ${escapeHtml(sender.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(sender))}</div>
  <div class="dash"></div><div class="section">DESTINATÁRIO</div><div class="person">${escapeHtml(recipient.name)}</div><div>Doc.: ${escapeHtml(recipient.document)}</div><div>Tel.: ${escapeHtml(recipient.phone)}</div>${recipient.email ? `<div>E-mail: ${escapeHtml(recipient.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(recipient))}</div>
  <div class="dash"></div><div class="section">ENVIO</div><div class="row"><span>Transportadora</span><b>${escapeHtml(data.carrier)}</b></div><div class="row"><span>Serviço</span><b>${escapeHtml(data.service)}</b></div><div class="row"><span>Prazo estimado</span><b>${escapeHtml(data.deadline ? data.deadline + " dias úteis" : "-")}</b></div>${Number(data.volumeCount||1)>1?`<div class="row"><span>Volumes</span><b>${Number(data.volumeCount)} caixas</b></div>`:""}<div class="row"><span>Peso total</span><b>${escapeHtml(data.weightKg + " kg")}</b></div><div class="row"><span>Dimensões</span><b class="tiny">${escapeHtml(data.dimensions)}</b></div><div class="row"><span>Valor declarado</span><b>${money(data.declaredValue)}</b></div>${invoice}
  <div class="dash"></div><div class="section">CONTEÚDO</div>${items || '<div class="small">Conteúdo não informado</div>'}
  ${extras ? `<div class="dash"></div><div class="section">PRODUTOS / SERVIÇOS</div>${extras}` : ""}
  <div class="dash"></div>
  <div class="row"><span>Frete</span><b>${money(data.freightPrice || data.salePrice)}</b></div>
  ${Number(data.addonsTotal || 0) ? `<div class="row"><span>Adicionais</span><b>${money(data.addonsTotal)}</b></div>` : ""}
  ${Number(data.paymentFee || 0) ? `<div class="row"><span>Taxa pagamento</span><b>${money(data.paymentFee)}</b></div>` : ""}
  <div class="row total"><span>TOTAL PAGO</span><b>${money(data.salePrice)}</b></div><div class="row"><span>Pagamento</span><b>${escapeHtml(data.paymentMethod || "-")}</b></div>${ids}
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
  const volumes = Array.isArray(p.volumes) && p.volumes.length ? p.volumes : [];
  const shipmentVolumes = Array.isArray(order.shipmentVolumes) ? order.shipmentVolumes : [];
  const trackingCodes = shipmentVolumes.map(v=>v.trackingCode).filter(Boolean);
  const totalWeightKg = volumes.length
    ? volumes.reduce((sum,v)=>sum+Number(v.weightGrams||0),0)/1000
    : Number(p.weightGrams || 0)/1000;
  const dimensions = volumes.length > 1
    ? volumes.map((v,index)=>`V${index+1}: ${v.length||"-"} x ${v.width||"-"} x ${v.height||"-"} cm`).join(" · ")
    : `${p.length || volumes[0]?.length || "-"} x ${p.width || volumes[0]?.width || "-"} x ${p.height || volumes[0]?.height || "-"} cm`;
  return {
    preview: false,
    createdAt: order.shippedAt || order.paidAt || order.createdAt || new Date().toISOString(),
    trackingCode: order.trackingCode || trackingCodes[0] || "",
    trackingCodes,
    publicTrackingUrl: order.publicTrackingUrl || "",
    cartId: "",
    packageId: "",
    carrier: order.carrier || "",
    service: order.serviceName || "",
    deadline: order.deadline || 0,
    salePrice: order.totalToCustomer || order.salePrice || 0,
    freightPrice: order.salePrice || 0,
    addonsTotal: order.addonsTotal || 0,
    paymentFee: order.paymentSurcharge || 0,
    addons: (order.addons || []).map(addon => ({
      name: addon.itemName,
      quantity: addon.quantity,
      totalPrice: addon.totalPrice
    })),
    declaredValue: Number(p.declaredValue || volumes.reduce((sum,v)=>sum+Number(v.declaredValue||0),0) || 0),
    weightKg: Number(totalWeightKg.toFixed(3)),
    dimensions,
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
      <div><span>Receita do ponto</span><strong>${money(order.pointRevenueTotal)}</strong></div>
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
  const summaryLabel = document.querySelector("#ordersView .orders-summary > div:nth-child(3) span");
  if (summaryLabel) summaryLabel.textContent = clientOrdersMode ? "Total utilizado" : "Comissão acumulada";
  $("#ordersCommissionTotal").textContent = clientOrdersMode
    ? money(allOrders.reduce((s,o) => s + Number(o.totalToCustomer || o.salePrice || 0), 0))
    : money(allOrders.filter(o => commissionStatuses.has(o.status)).reduce((s,o) => s + Number(o.pointRevenueTotal || o.partnerCommission || 0), 0));

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
        <div><span>${clientOrdersMode ? "Primeira milha" : "Sua receita"}</span><strong>${clientOrdersMode ? money(order.firstMileFee || 0) : money(order.pointRevenueTotal || order.partnerCommission)}</strong></div>
        <div><span>Pagamento</span><strong>${escapeHtml(paymentMethodLabel(order.paymentMethod))}</strong></div>
        <div><span>${Number(order.packageCount||1)>1?"Volumes":"Rastreio"}</span><strong>${Number(order.packageCount||1)>1?Number(order.packageCount):escapeHtml(order.trackingCode || "—")}</strong></div>
      </div>
      ${order.addons?.length ? `<div class="order-addons"><strong>Adicionais:</strong> ${order.addons.map(a => `${escapeHtml(a.itemName)} ×${Number(a.quantity)} (${money(a.totalPrice)})`).join(" · ")}</div>` : ""}
      <div class="order-bottom"><span>${escapeHtml(description)}</span><div class="order-actions"></div></div>`;
    const actions = card.querySelector(".order-actions");

    if (order.status === "CASH_REMITTANCE_PENDING") {
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
      receiptBtn.textContent=allTracking>=expected ? "Comprovante com rastreios" : "Rastreio pendente";
      receiptBtn.disabled=allTracking<expected;
      receiptBtn.addEventListener("click",()=>openReceipt(receiptPayloadFromOrder(order),true)); actions.appendChild(receiptBtn);
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
          <div><span>Origem cotação</span><strong>${escapeHtml(s.quoteOriginCep ? maskCep(s.quoteOriginCep) : "CEP real")}</strong></div>
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
        if(cleanQuoteCep && cleanQuoteCep.length!==8) return toast("CEP operacional inválido.","error");
        const active=window.confirm("OK = ponto ativo. Cancelar = desativar o ponto.");
        try{
          await api(`/api/admin/stores/${store.id}`,{method:"PATCH",body:JSON.stringify({commissionPercent:Number(String(commission).replace(",",".")),asaasWalletId:wallet.trim(),quoteOriginCep:cleanQuoteCep,active})});
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
          <button class="ghost" type="button" data-edit-user="${escapeHtml(u.id)}">Editar</button>
        </div>`).join(""):'<div class="empty-state">Nenhum usuário cadastrado.</div>';

      usersHost.querySelectorAll("[data-edit-user]").forEach(btn=>btn.addEventListener("click",async()=>{
        const user=state.admin.users.find(u=>u.id===btn.dataset.editUser);
        if(!user) return;
        const active=window.confirm("OK = usuário ativo. Cancelar = desativar o usuário.");
        const roleInput=window.prompt("Perfil: ADMIN, STORE_OWNER, STORE_CLERK ou OPS",user.role);
        if(roleInput==null) return;
        const role=String(roleInput).trim().toUpperCase();
        let storeId=user.store_id||null;
        if(role!=="ADMIN"){
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
      password:$("#adminUserPassword").value,role,storeId:role==="ADMIN"?null:$("#adminUserStore").value
    })});
    event.currentTarget.reset(); toast("Usuário criado."); await loadMaster();
  }catch(err){toast(err.message,"error");}finally{btn.disabled=false;}
});

$("#adminUserRole")?.addEventListener("change",()=>{
  $("#adminUserStore").disabled=$("#adminUserRole").value==="ADMIN";
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

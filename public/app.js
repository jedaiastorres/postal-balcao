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
  paymentPreview: null
};

const viewMap = {
  dashboard: { el: "#dashboardView", title: "Visão geral" },
  quote: { el: "#quoteView", title: "Simular Frete" },
  shipment: { el: "#shipmentView", title: "Nova Postagem" },
  orders: { el: "#ordersView", title: "Meus Fretes" },
  inventory: { el: "#inventoryView", title: "Produtos & Estoque" },
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
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || "Não foi possível concluir a operação.");
  return data;
}

async function loadConfig() {
  state.config = await api("/api/public-config");
  const badge = $("#apiBadge");
  if (state.config.providerConfigured) {
    badge.className = "status-badge connected";
    badge.innerHTML = '<span class="dot"></span> API ConectEnvios conectada';
    $("#quoteModeLabel").textContent = "Cotação real pela ConectEnvios";
  } else {
    badge.className = "status-badge demo";
    badge.innerHTML = '<span class="dot"></span> Modo demonstração';
    $("#quoteModeLabel").textContent = "Dados demonstrativos";
  }
  $("#demoLoginHint").style.display = state.config.demoAuth ? "block" : "none";
  $("#commissionCaption").textContent = `${state.config.commissionPercent}% sobre o preço final`;
  $("#commissionBig").textContent = `${state.config.commissionPercent}%`;
}

function showApp(email) {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#partnerEmail").textContent = email || "parceiro";
  refreshDashboard();

  const params = new URLSearchParams(window.location.search);
  if (params.get("payment")) {
    navigate("orders");
    toast(params.get("payment") === "success"
      ? "Pagamento concluído. Estamos confirmando pelo webhook."
      : "Pagamento não concluído. Você pode tentar novamente em Meus Fretes.");
    history.replaceState({}, "", window.location.pathname);
  }
}

function showLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}

async function checkSession() {
  await loadConfig();
  try {
    const session = await api("/api/session");
    showApp(session.user.email);
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
    showApp(result.user.email);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar no painel";
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  showLogin();
});

function navigate(name) {
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

$("#quoteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#quoteBtn");
  btn.disabled = true;
  btn.textContent = "Consultando...";
  $("#resultsWrap").classList.add("hidden");

  const payload = {
    cepOrigem: onlyDigits($("#cepOrigem").value),
    cepDestino: onlyDigits($("#cepDestino").value),
    peso: String($("#peso").value),
    comprimento: String($("#comprimento").value),
    largura: String($("#largura").value),
    altura: String($("#altura").value),
    vlDeclarado: String($("#vlDeclarado").value)
  };

  try {
    if (payload.cepOrigem.length !== 8 || payload.cepDestino.length !== 8) {
      throw new Error("Informe CEPs com 8 dígitos.");
    }
    const result = await api("/api/cotacao", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.currentQuote = payload;
    state.selectedOption = null;
    state.shipmentResult = null;
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
  $("#resultsInfo").textContent = `${result.options.length} opção(ões) • ordenadas por menor preço`;
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
        <span class="price-total-label">Preço ao cliente</span>
        <strong class="price-total">${money(option.precoVenda)}</strong>
        <span class="price-commission-label">Sua comissão</span>
        <strong class="price-commission">${money(option.comissaoParceiro)}</strong>
        <small>Passe o mouse ou toque para ver a comissão</small>
      </div>
      <button class="select-btn" type="button">Selecionar</button>
    `;

    const priceReveal = card.querySelector(".price-reveal");
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
    commission: best.comissaoParceiro
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
  if (!host || !select) return;
  host.innerHTML = '<div class="empty-state">Atualizando estoque...</div>';

  try {
    const result = await api("/api/inventory");
    state.inventory = result.items || [];
    const products = state.inventory.filter(item => item.itemType === "PRODUCT" && item.trackStock);

    select.innerHTML = products.length
      ? products.map(item => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name)}</option>`).join("")
      : '<option value="">Nenhum produto cadastrado</option>';

    if (!state.inventory.length) {
      host.innerHTML = '<div class="empty-state">Nenhum item no catálogo.</div>';
      return;
    }

    host.innerHTML = "";
    state.inventory.forEach(item => {
      const row = document.createElement("div");
      row.className = "inventory-row";
      const low = item.trackStock && Number(item.availableQuantity || 0) <= Number(item.minQuantity || 0);
      row.innerHTML = `
        <div>
          <span class="addon-type">${item.itemType === "PRODUCT" ? "PRODUTO" : "SERVIÇO"} · ${escapeHtml(item.category || "")}</span>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.code)}</small>
        </div>
        <div><span>Preço</span><strong>${money(item.unitPrice)}</strong></div>
        <div><span>Disponível</span><strong class="${low ? "stock-low" : ""}">${Number(item.availableQuantity || 0)}</strong></div>
        <div><span>Reservado</span><strong>${Number(item.reservedQuantity || 0)}</strong></div>
      `;
      host.appendChild(row);
    });

    const selected = products[0];
    if (selected) $("#inventorySalePrice").value = Number(selected.unitPrice || 0).toFixed(2);
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
    : "A integração Asaas está preparada e aguarda a chave da conta para processar cobranças.";
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
  const trackingUrl = data.publicTrackingUrl ? `<div class="tiny">${escapeHtml(data.publicTrackingUrl)}</div>` : "";
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
  <div class="center"><div class="label">Código de rastreio</div><div class="tracking">${escapeHtml(data.trackingCode || "AGUARDANDO")}</div>${trackingUrl}</div>
  <div class="dash"></div><div class="section">REMETENTE</div><div class="person">${escapeHtml(sender.name)}</div><div>Doc.: ${escapeHtml(sender.document)}</div><div>Tel.: ${escapeHtml(sender.phone)}</div>${sender.email ? `<div>E-mail: ${escapeHtml(sender.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(sender))}</div>
  <div class="dash"></div><div class="section">DESTINATÁRIO</div><div class="person">${escapeHtml(recipient.name)}</div><div>Doc.: ${escapeHtml(recipient.document)}</div><div>Tel.: ${escapeHtml(recipient.phone)}</div>${recipient.email ? `<div>E-mail: ${escapeHtml(recipient.email)}</div>` : ""}<div class="small">${escapeHtml(addressText(recipient))}</div>
  <div class="dash"></div><div class="section">ENVIO</div><div class="row"><span>Transportadora</span><b>${escapeHtml(data.carrier)}</b></div><div class="row"><span>Serviço</span><b>${escapeHtml(data.service)}</b></div><div class="row"><span>Prazo estimado</span><b>${escapeHtml(data.deadline ? data.deadline + " dias úteis" : "-")}</b></div><div class="row"><span>Peso</span><b>${escapeHtml(data.weightKg + " kg")}</b></div><div class="row"><span>Dimensões</span><b>${escapeHtml(data.dimensions)}</b></div><div class="row"><span>Valor declarado</span><b>${money(data.declaredValue)}</b></div>${invoice}
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

$("#continueShipmentBtn")?.addEventListener("click", () => {
  if (!state.selectedOption) { toast("Selecione uma opção de frete primeiro.", "error"); return; }
  prepareShipmentView();
  navigate("shipment");
});

$("#backToQuoteBtn")?.addEventListener("click", () => navigate("quote"));
$("#addContentItemBtn")?.addEventListener("click", () => addContentItem({ quantity: 1, value: 0 }));

$(`input[name="documentType"]`).forEach(radio => radio.addEventListener("change", () => {
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
    CASH_REMITTANCE_PENDING: ["Repasse pendente", "warning", "O cliente pagou em dinheiro. Faça o repasse para liberar a etiqueta."],
    CASH_REMITTANCE_PAYMENT_PENDING: ["Aguardando PIX do ponto", "warning", "O repasse foi criado e ainda não foi confirmado."],
    PAYMENT_SETUP_PENDING: ["Pagamento em configuração", "muted", "Aguardando integração financeira."],
    PARTNER_FINANCIAL_SETUP_REQUIRED: ["Conta financeira pendente", "warning", "Este ponto ainda precisa ser vinculado a uma carteira Asaas."],
    PAYMENT_PENDING: ["Aguardando pagamento", "warning", "A etiqueta não será criada enquanto o pagamento não for confirmado."],
    PAYMENT_CONFIRMED: ["Pagamento confirmado", "info", "Pagamento recebido. Preparando a postagem."],
    PAID_WAITING_SHIPMENT: ["Pago • etiqueta pendente", "info", "Pagamento confirmado. A emissão da etiqueta está aguardando liberação operacional."],
    LABEL_AVAILABLE: ["Etiqueta disponível", "success", "Pagamento e postagem confirmados."],
    SHIPMENT_ERROR: ["Revisão necessária", "danger", "O pagamento foi confirmado, mas houve erro ao gerar a postagem."],
    PAYMENT_CANCELED: ["Pagamento cancelado", "muted", "O checkout foi cancelado."],
    PAYMENT_EXPIRED: ["Pagamento expirado", "muted", "O checkout expirou. Gere um novo pagamento quando necessário."]
  };
  return map[status] || [status || "Pendente", "muted", ""];
}

function paymentMethodLabel(method) {
  return ({ PIX: "PIX", CARTAO: "Cartão", DINHEIRO: "Dinheiro" })[method] || method || "-";
}

function receiptPayloadFromOrder(order) {
  const p = order.packageData || {};
  return {
    preview: false,
    createdAt: order.shippedAt || order.paidAt || order.createdAt || new Date().toISOString(),
    trackingCode: order.trackingCode || "",
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
    declaredValue: Number(p.declaredValue || 0),
    weightKg: Number(p.weightGrams || 0) / 1000,
    dimensions: `${p.length || "-"} x ${p.width || "-"} x ${p.height || "-"} cm`,
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
  button.textContent = "Gerando PIX...";
  try {
    const result = await api(`/api/orders/${orderId}/remittance`, { method: "POST", body: "{}" });
    if (result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
      return;
    }
    await loadOrders();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderOrders() {
  const host = $("#ordersList");
  if (!host) return;
  const orders = state.orders || [];

  const pendingStatuses = new Set(["CASH_REMITTANCE_PENDING","CASH_REMITTANCE_PAYMENT_PENDING","PAYMENT_PENDING","PAYMENT_SETUP_PENDING","PARTNER_FINANCIAL_SETUP_REQUIRED","PAID_WAITING_SHIPMENT","PAYMENT_CONFIRMED"]);
  const commissionStatuses = new Set(["CASH_REMITTANCE_PENDING","CASH_REMITTANCE_PAYMENT_PENDING","PAYMENT_CONFIRMED","PAID_WAITING_SHIPMENT","LABEL_AVAILABLE","SHIPMENT_ERROR"]);
  $("#ordersPendingCount").textContent = orders.filter(o => pendingStatuses.has(o.status)).length;
  $("#ordersReadyCount").textContent = orders.filter(o => o.status === "LABEL_AVAILABLE").length;
  $("#ordersCommissionTotal").textContent = money(orders.filter(o => commissionStatuses.has(o.status)).reduce((s,o) => s + Number(o.pointRevenueTotal || o.partnerCommission || 0), 0));

  if (!orders.length) {
    host.innerHTML = `<div class="orders-empty"><strong>Nenhum frete registrado ainda.</strong><span>Faça uma cotação e conclua os dados da postagem.</span><button class="primary" type="button" data-empty-new>Fazer primeira cotação</button></div>`;
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
          <div class="order-id">#${escapeHtml(order.id.slice(0,8).toUpperCase())} · ${escapeHtml(date)}</div>
          <h3>${escapeHtml(order.carrier)} <span>${escapeHtml(order.serviceName)}</span></h3>
          <p>${route}</p>
        </div>
        <span class="order-status ${tone}">${escapeHtml(label)}</span>
      </div>
      <div class="order-metrics">
        <div><span>Total cliente</span><strong>${money(order.totalToCustomer || order.salePrice)}</strong></div>
        <div><span>Sua receita</span><strong>${money(order.pointRevenueTotal || order.partnerCommission)}</strong></div>
        <div><span>Pagamento</span><strong>${escapeHtml(paymentMethodLabel(order.paymentMethod))}</strong></div>
        <div><span>Rastreio</span><strong>${escapeHtml(order.trackingCode || "—")}</strong></div>
      </div>
      ${order.addons?.length ? `<div class="order-addons"><strong>Adicionais:</strong> ${order.addons.map(a => `${escapeHtml(a.itemName)} ×${Number(a.quantity)} (${money(a.totalPrice)})`).join(" · ")}</div>` : ""}
      <div class="order-bottom">
        <span>${escapeHtml(description)}</span>
        <div class="order-actions"></div>
      </div>
    `;
    const actions = card.querySelector(".order-actions");

    if (order.status === "CASH_REMITTANCE_PENDING") {
      const due = Number(order.cashRemittanceTotal || order.cashRemittanceAmount || 0);
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.type = "button";
      btn.textContent = `Pagar ${money(due)} e liberar etiqueta`;
      btn.addEventListener("click", () => payCashRemittance(order.id, btn));
      actions.appendChild(btn);
    }

    if (order.paymentCheckoutUrl && ["PAYMENT_PENDING","CASH_REMITTANCE_PAYMENT_PENDING"].includes(order.status)) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.type = "button";
      btn.textContent = "Abrir pagamento";
      btn.addEventListener("click", () => { window.location.href = order.paymentCheckoutUrl; });
      actions.appendChild(btn);
    }

    if (order.status === "LABEL_AVAILABLE") {
      const labelBtn = document.createElement("button");
      labelBtn.className = "primary";
      labelBtn.type = "button";
      labelBtn.textContent = "Imprimir etiqueta A6";
      labelBtn.addEventListener("click", () => openProviderDocument(order.labelA6Url || order.labelA4Url));
      actions.appendChild(labelBtn);

      const receiptBtn = document.createElement("button");
      receiptBtn.className = "ghost";
      receiptBtn.type = "button";
      receiptBtn.textContent = "Comprovante 80 mm";
      receiptBtn.addEventListener("click", () => openReceipt(receiptPayloadFromOrder(order), true));
      actions.appendChild(receiptBtn);

      if (order.publicTrackingUrl) {
        const track = document.createElement("a");
        track.className = "ghost link-like";
        track.href = order.publicTrackingUrl;
        track.target = "_blank";
        track.rel = "noopener";
        track.textContent = "Rastrear";
        actions.appendChild(track);
      }
    }

    host.appendChild(card);
  });
}

async function loadOrders() {
  const host = $("#ordersList");
  if (!host) return;
  host.innerHTML = `<div class="empty-state">Atualizando seus fretes...</div>`;
  try {
    const result = await api("/api/orders");
    state.orders = result.orders || [];
    renderOrders();
  } catch (err) {
    host.innerHTML = `<div class="orders-empty"><strong>Não foi possível carregar Meus Fretes.</strong><span>${escapeHtml(err.message)}</span></div>`;
  }
}

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
        salePrice: Number($("#inventorySalePrice").value || 0),
        note: $("#inventoryNote").value.trim()
      })
    });
    $("#inventoryQuantity").value = "";
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
  if (item) $("#inventorySalePrice").value = Number(item.unitPrice || 0).toFixed(2);
});

$("#refreshInventoryBtn")?.addEventListener("click", loadInventory);

$("#shipmentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.selectedOption?.selectionToken) {
    toast("A cotação expirou. Calcule novamente.", "error");
    return;
  }

  const paymentMethod = $("#paymentMethod").value;
  const declaration = contentData();

  if (!paymentMethod) {
    toast("Selecione a forma de pagamento.", "error");
    return;
  }
  if (!declaration.length || declaration.some(item => !item.description || item.quantity <= 0 || item.value < 0)) {
    toast("Revise a declaração de conteúdo.", "error");
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

checkSession();

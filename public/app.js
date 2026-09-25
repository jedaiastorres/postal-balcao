const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  config: null,
  recent: JSON.parse(localStorage.getItem("postal_recent_quotes") || "[]"),
  currentQuote: null,
  selectedOption: null,
  shipmentResult: null
};

const viewMap = {
  dashboard: { el: "#dashboardView", title: "Visão geral" },
  quote: { el: "#quoteView", title: "Simular Frete" },
  shipment: { el: "#shipmentView", title: "Nova Postagem" },
  orders: { placeholder: ["Meus Envios", "A próxima etapa conecta a criação do envio, rastreamento e impressão da etiqueta 10x14."] },
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

$("#continueShipmentBtn")?.addEventListener("click", () => {
  toast("Frete reservado no atendimento. O próximo passo será preencher remetente, destinatário e conteúdo.");
});

checkSession();

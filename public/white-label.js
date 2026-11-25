"use strict";
const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const code=decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1)||"").toUpperCase();
const state={csrf:"",account:null,brand:null,routes:[],points:[],clients:[],collections:[],collectionRequestKey:null,finance:null};
const money=value=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value||0));
const esc=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const digit=value=>String(value||"").replace(/\D/g,"");
const cep=value=>digit(value).replace(/^(\d{5})(\d{1,3})$/,"$1-$2");
function errorText(message){
  if(!message){$("#errorPanel").classList.add("hidden");$("#errorPanel").textContent="";return;}
  $("#errorPanel").classList.remove("hidden");
  $("#errorPanel").textContent=message;
  $("#errorPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
}
async function api(url,options={}){
  const response=await fetch(url,{
    ...options,
    credentials:"same-origin",
    headers:{"content-type":"application/json",
      ...(state.csrf&&["POST","PATCH","PUT","DELETE"].includes(options.method) ? {"x-csrf-token":state.csrf}:{}),
      ...options.headers}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Não foi possível concluir a operação.");
  return data;
}
function applyBrand(brand){
  state.brand=brand;
  document.title=(brand.name||"Transportadora")+" · White Label";
  $("#brandTitle").textContent=brand.name;
  $("#loginBrandTitle").textContent=brand.name;
  $("#headerBrandTitle").textContent=String(brand.name||"WHITE LABEL").toUpperCase();
  document.documentElement.style.setProperty("--brand",brand.primary||"#d7083b");
  document.documentElement.style.setProperty("--brand-dark",brand.secondary||"#222638");
  const rgb=(brand.primary||"#d7083b").match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if(rgb){
    const channels=rgb.slice(1).map(x=>parseInt(x,16)/255);
    const linear=channels.map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
    const luminance=0.2126*linear[0]+0.7152*linear[1]+0.0722*linear[2];
    document.documentElement.style.setProperty("--on-brand",luminance>0.20?"#20232d":"#ffffff");
  }
  $("#welcomeSubtitle").textContent=(brand.baseCity||"")+" / "+(brand.baseState||"")+" · Rotas e gestão White Label";
  for(const [imgId,iconId] of [["brandLogo","brandIcon"],["loginBrandLogo","loginBrandIcon"]]){
    const img=$("#"+imgId),icon=$("#"+iconId);
    const hasLogo=Boolean(brand.logoUrl&&/^https:\/\/[^\s]+$/i.test(brand.logoUrl));
    img.classList.toggle("hidden",!hasLogo);
    icon.classList.toggle("hidden",hasLogo);
    if(hasLogo){
      img.src=brand.logoUrl;
      img.onerror=()=>{img.classList.add("hidden");icon.classList.remove("hidden");};
    } else img.removeAttribute("src");
  }
  $("#brandNameInput").value=brand.name||"";
  $("#brandLogoInput").value=brand.logoUrl||"";
  $("#brandPrimaryInput").value=brand.primary||"#d7083b";
  $("#brandSecondaryInput").value=brand.secondary||"#222638";
  $("#brandPreview").innerHTML='<div class="big-brand"><strong>'+esc(brand.name)+'</strong><span>'+esc(brand.baseCity)+' / '+esc(brand.baseState)+'</span></div><div><small>Cor principal</small><span class="swatch" style="background:'+esc(brand.primary)+'"></span><code>'+esc(brand.primary)+'</code></div><div><small>Cor secundária</small><span class="swatch" style="background:'+esc(brand.secondary)+'"></span><code>'+esc(brand.secondary)+'</code></div>';
}
$("#brandForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const button=event.currentTarget.querySelector("button");button.disabled=true;
  try {
    const result=await api("/api/wl/brand",{method:"PATCH",body:JSON.stringify({
      name:$("#brandNameInput").value,
      logoUrl:$("#brandLogoInput").value,
      primary:$("#brandPrimaryInput").value,
      secondary:$("#brandSecondaryInput").value
    })});
    applyBrand(result.brand);
  }catch(error){errorText(error.message);}finally{button.disabled=false;}
});
async function loadBrand(){
  const response=await api("/api/wl/public/"+encodeURIComponent(code));
  applyBrand(response.brand);
}
function showAuth(account,csrf,finance){
  state.account=account;state.csrf=csrf||"";state.finance=finance||null;
  $("#loginShell").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#sidebarEmail").textContent=account.email||"—";
  $("#sidebarRole").textContent=account.role==="WL_MASTER"?"MASTER da transportadora":"Operador do ponto";
  $("#wlCustomerPortalLink").href="/wl/"+encodeURIComponent(code)+"/cliente";
  $("#welcomeName").textContent="Painel "+(state.brand?.name||"White Label");
  $("#roleTag").textContent=account.role==="WL_MASTER"?"M":"O";
  $("#roleTag").title=account.role==="WL_MASTER"?"MASTER da transportadora":"Operador";
  $$(".master-only").forEach(element=>element.classList.toggle("hidden",account.role!=="WL_MASTER"));
  $("#passwordPanel").classList.toggle("hidden",!account.mustChangePassword);
  $("#wlOperatorCollectionPoint").classList.toggle("hidden",account.role==="WL_MASTER");
  $("#walletStatus").textContent=finance?.walletConfigured
    ?"Carteira cadastrada pelo MASTER Postal. Homologação financeira pendente."
    :"Carteira Asaas pendente. O MASTER Postal deve configurar e verificar a conta.";
  activate("overview");
  loadRoutes();
  loadPoints().then(()=>{if(account.role==="WL_MASTER")loadUsers();loadCollections();loadClients();});
}
function activate(name){
  if(["users","finance","points","network"].includes(name)){
    if(state.account?.role!=="WL_MASTER")return;
  }
  const titles={overview:"Dashboard",points:"Unidades e Pontos",collections:"Coletas",clients:"Clientes Fixos",network:"Rede Integrada",tariffs:"Rotas e Preços",
    quotes:"Simular Frete",users:"Equipe",brand:"Minha Marca",finance:"Carteira e Repasses"};
  $$(".tab").forEach(btn=>{
    const active=btn.dataset.tab===name;
    btn.classList.toggle("active",active);
    if(active)btn.setAttribute("aria-current","page");
    else btn.removeAttribute("aria-current");
  });
  $$(".tab-panel").forEach(panel=>panel.classList.toggle("hidden",panel.dataset.panel!==name));
  $("#wlPageTitle").textContent=titles[name]||"Dashboard";
  if(name==="collections"&&state.account)void loadCollections();
  if(name==="network"&&state.account?.role==="WL_MASTER"){
    const root=$("#wlNetworkRoot");
    if(window.InterlineNetwork){
      if(!state.networkPanel)state.networkPanel=window.InterlineNetwork.mount(root,{
        prefix:"/api/wl/network",request:api});
      else void state.networkPanel.refresh();
    }
  }
  closeMobileMenu();
  window.scrollTo({top:0,behavior:"smooth"});
  errorText("");
}
function closeMobileMenu(){
  $("#wlNavigation").classList.remove("open");
  $("#wlBackdrop").classList.add("hidden");
  $("#wlMobileMenu").setAttribute("aria-expanded","false");
}
$("#wlMobileMenu").addEventListener("click",()=>{
  const open=!$("#wlNavigation").classList.contains("open");
  $("#wlNavigation").classList.toggle("open",open);
  $("#wlBackdrop").classList.toggle("hidden",!open);
  $("#wlMobileMenu").setAttribute("aria-expanded",String(open));
});
$("#wlBackdrop").addEventListener("click",closeMobileMenu);
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeMobileMenu();});
window.addEventListener("resize",()=>{if(window.innerWidth>820)closeMobileMenu();});
$$(".tab").forEach(btn=>btn.addEventListener("click",()=>activate(btn.dataset.tab)));
$("#loginForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const btn=event.currentTarget.querySelector("button");
  btn.disabled=true;
  try{
    const data=await api("/api/wl/login",{method:"POST",body:JSON.stringify({
      code,email:$("#loginEmail").value,password:$("#loginPassword").value
    })});
    showAuth(data.account,data.csrf,{walletConfigured:false});
    const fresh=await api("/api/wl/session");
    state.finance=fresh.finance;
    $("#walletStatus").textContent=fresh.finance.walletConfigured
      ?"Carteira cadastrada; homologação e split ainda pendentes."
      :"Carteira Asaas ainda não cadastrada.";
    $("#loginPassword").value="";
  }catch(error){errorText(error.message);}finally{btn.disabled=false;}
});
$("#logoutBtn").addEventListener("click",async()=>{
  try{await api("/api/wl/logout",{method:"POST"});}catch{}
  location.href="/wl/"+encodeURIComponent(code);
});
$("#passwordForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const button=event.currentTarget.querySelector("button");button.disabled=true;
  try{
    await api("/api/wl/password",{method:"POST",body:JSON.stringify({
      currentPassword:$("#oldPassword").value,nextPassword:$("#newPassword").value
    })});
    alert("Senha alterada. Entre novamente com a nova senha.");
    location.href="/wl/"+encodeURIComponent(code);
  }catch(error){errorText(error.message);button.disabled=false;}
});

function selectOptions(items,first,selected){
  return '<option value="">'+esc(first)+'</option>'+items.map(item=>
    '<option value="'+esc(item.id)+'"'+(item.id===selected?' selected':'')+'>'+
    esc(item.name)+' · '+esc(item.city||item.pointName||"")+'</option>').join("");
}
function refreshClientPointSelectors(){
  for(const [id,label] of [
    ["wlClientPoint","Cliente direto do MASTER White Label"],
    ["wlQuotePoint","Venda direta do MASTER White Label"],
    ["wlPointCommissionPoint","Selecione a unidade"]
  ]){
    const node=$("#"+id),current=node.value;
    node.innerHTML=selectOptions(state.points.filter(p=>p.active),label,current);
    if(current&&state.points.some(p=>p.active&&p.id===current))node.value=current;
  }
}
function refreshFixedClientSelectors(){
  const clients=state.clients.filter(c=>c.active);
  for(const [id,empty] of [
    ["wlQuoteClient","Cotação avulsa / sem cliente cadastrado"],
    ["wlCollectionClient","Preencher manualmente"]
  ]){
    const node=$("#"+id),current=node.value;
    node.innerHTML=selectOptions(clients,empty,current);
    if(current&&clients.some(c=>c.id===current))node.value=current;
  }
}
function resetFixedClientForm(){
  $("#wlClientForm").reset();
  $("#wlClientId").value="";
  $("#wlClientPoint").value="";
  $("#wlClientCommissionOverride").value="";
}
function renderClients(){
  const master=state.account?.role==="WL_MASTER";
  $("#wlClientsList").innerHTML=state.clients.length?state.clients.map(c=>{
    const point=c.pointName||"Cliente direto";
    const commission=master?(c.pointId
      ?'<small>Comissão ponto: '+(c.pointCommissionOverride==null
          ?Number(c.pointCommissionDefault||0).toLocaleString("pt-BR",{maximumFractionDigits:2})+"% (padrão)"
          :Number(c.pointCommissionOverride).toLocaleString("pt-BR",{maximumFractionDigits:2})+"% (especial)")+
        ' da parcela White Label</small>':""):"";
    return '<div class="list-item wl-fixed-client-item"><div><strong>'+esc(c.name)+'</strong>'+
      '<span>'+esc(point)+' · '+esc(c.city||"Sem endereço")+' · '+esc(c.phone||"Sem telefone")+'</span>'+
      '<small>'+esc(c.document||"Sem CPF/CNPJ")+' · '+(c.active?"Ativo":"Inativo")+'</small>'+
      commission+'</div><div class="list-price"><button class="ghost" type="button" data-client-edit="'+esc(c.id)+'">Editar</button>'+
      (master&&c.active?'<button class="primary" type="button" data-client-access="'+esc(c.id)+'">Gerar acesso do cliente</button>':"")+
      (master?'<button class="ghost" type="button" data-client-status="'+esc(c.id)+'" data-active="'+(c.active?"false":"true")+'">'+(c.active?"Desativar":"Reativar")+'</button>':"")+
      '</div></div>';
  }).join(""):'<div class="empty">Nenhum cliente fixo cadastrado nesta unidade.</div>';
  refreshFixedClientSelectors();
}
async function loadClients(){
  try{
    const result=await api("/api/wl/clients");
    state.clients=Array.isArray(result.clients)?result.clients:[];
    renderClients();
  }catch(error){errorText(error.message);}
}
$("#wlRefreshClients").addEventListener("click",loadClients);
$("#wlClearClient").addEventListener("click",resetFixedClientForm);
$("#wlClientsList").addEventListener("click",async event=>{
  const access=event.target.closest("[data-client-access]");
  if(access){
    const selected=state.clients.find(x=>x.id===access.dataset.clientAccess);
    if(!selected)return;
    if(!selected.email){errorText("Cadastre primeiro o e-mail do cliente.");return;}
    if(!confirm("Gerar um novo acesso para "+selected.name+"? Caso já exista, a senha anterior e as sessões abertas serão invalidadas."))return;
    access.disabled=true;errorText("");
    try{
      const result=await api("/api/wl/clients/"+encodeURIComponent(selected.id)+"/access",{method:"POST",body:"{}"});
      credentials("Portal do cliente: "+location.origin+result.loginUrl+
        "\nE-mail: "+result.email+"\nSenha temporária: "+result.temporaryPassword+
        "\nTroca de senha obrigatória no primeiro acesso.");
    }catch(error){errorText(error.message);}finally{access.disabled=false;}
    return;
  }
  const edit=event.target.closest("[data-client-edit]");
  if(edit){
    const c=state.clients.find(item=>item.id===edit.dataset.clientEdit);
    if(!c)return;
    for(const [input,key] of [["wlClientId","id"],["wlClientName","name"],
      ["wlClientDocument","document"],["wlClientPhone","phone"],["wlClientEmail","email"],
      ["wlClientPoint","pointId"],["wlClientStreet","street"],["wlClientNumber","number"],
      ["wlClientNeighborhood","neighborhood"],["wlClientCep","cep"],["wlClientCity","city"],
      ["wlClientState","state"],["wlClientNotes","notes"]]){
      $("#"+input).value=c[key]||"";
    }
    $("#wlClientCommissionOverride").value=c.pointCommissionOverride==null?"":c.pointCommissionOverride;
    $("#wlClientForm").scrollIntoView({behavior:"smooth",block:"start"});
    return;
  }
  const toggle=event.target.closest("[data-client-status]");
  if(toggle){
    if(!confirm("Alterar a situação deste cliente fixo?"))return;
    toggle.disabled=true;
    try{
      await api("/api/wl/clients/"+encodeURIComponent(toggle.dataset.clientStatus)+"/status",{
        method:"PATCH",body:JSON.stringify({active:toggle.dataset.active==="true"})});
      await loadClients();
    }catch(error){errorText(error.message);toggle.disabled=false;}
  }
});
$("#wlClientForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
  const master=state.account?.role==="WL_MASTER";
  const id=$("#wlClientId").value;
  const data={name:$("#wlClientName").value,document:$("#wlClientDocument").value,
    phone:$("#wlClientPhone").value,email:$("#wlClientEmail").value,
    street:$("#wlClientStreet").value,number:$("#wlClientNumber").value,
    neighborhood:$("#wlClientNeighborhood").value,cep:$("#wlClientCep").value,
    city:$("#wlClientCity").value,state:$("#wlClientState").value,
    notes:$("#wlClientNotes").value};
  if(master){
    data.pointId=$("#wlClientPoint").value||null;
    data.pointCommissionOverride=$("#wlClientCommissionOverride").value||null;
    data.active=state.clients.find(item=>item.id===id)?.active!==false;
  }
  try{
    await api(id?"/api/wl/clients/"+encodeURIComponent(id):"/api/wl/clients",{
      method:id?"PUT":"POST",body:JSON.stringify(data)});
    resetFixedClientForm();
    await loadClients();
  }catch(error){errorText(error.message);}finally{btn.disabled=false;}
});
$("#wlPointCommissionPoint").addEventListener("change",()=>{
  const point=state.points.find(p=>p.id===$("#wlPointCommissionPoint").value);
  $("#wlPointCommissionRate").value=point?.pointCommissionPercent??0;
});
$("#wlPointCommissionForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const pointId=$("#wlPointCommissionPoint").value;
  if(!pointId){errorText("Selecione um ponto para ajustar a comissão.");return;}
  const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
  try{
    const saved=await api("/api/wl/points/"+encodeURIComponent(pointId)+"/commission",{
      method:"PATCH",body:JSON.stringify({pointCommissionPercent:Number($("#wlPointCommissionRate").value)})});
    const point=state.points.find(p=>p.id===pointId);
    if(point)point.pointCommissionPercent=saved.pointCommissionPercent;
    await loadClients();
  }catch(error){errorText(error.message);}finally{btn.disabled=false;}
});
$("#wlQuoteClient").addEventListener("change",()=>{
  const c=state.clients.find(x=>x.id===$("#wlQuoteClient").value);
  if(!c)return;
  if(c.cep&&c.cep.length===8)$("#quoteOrigin").value=c.cep.replace(/^(\d{5})(\d{3})$/,"$1-$2");
  if(state.account?.role==="WL_MASTER")$("#wlQuotePoint").value=c.pointId||"";
});
$("#wlQuotePoint").addEventListener("change",()=>{
  const c=state.clients.find(x=>x.id===$("#wlQuoteClient").value);
  if(c&&c.pointId!==($("#wlQuotePoint").value||null))$("#wlQuoteClient").value="";
});
$("#wlCollectionClient").addEventListener("change",()=>{
  const c=state.clients.find(x=>x.id===$("#wlCollectionClient").value);
  if(!c)return;
  for(const [target,key] of [["wlCollectionName","name"],["wlCollectionPhone","phone"],
    ["wlCollectionDocument","document"],["wlCollectionStreet","street"],
    ["wlCollectionNumber","number"],["wlCollectionNeighborhood","neighborhood"],
    ["wlCollectionCep","cep"],["wlCollectionCity","city"],["wlCollectionState","state"]]){
    $("#"+target).value=c[key]||"";
  }
  if(state.account?.role==="WL_MASTER")$("#wlCollectionPoint").value=c.pointId||"";
});

const collectionLabels={REQUESTED:"Solicitada",ASSIGNED:"Atribuída",IN_ROUTE:"Em rota",COLLECTED:"Coletada",CANCELED:"Cancelada"};
const collectionDate=value=>{
  if(!value)return "A combinar";
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"}):"A combinar";
};
function refreshCollectionPointSelect(){
  const host=$("#wlCollectionPoint");
  const selected=host.value;
  host.innerHTML='<option value="">Aguardar distribuição pelo MASTER</option>'+
    state.points.filter(p=>p.active).map(p=>
      '<option value="'+esc(p.id)+'">'+esc(p.name)+' · '+esc(p.city)+'/'+esc(p.state)+'</option>'
    ).join("");
  if(state.points.some(p=>p.active&&p.id===selected))host.value=selected;
}
function renderCollections(){
  const all=state.collections;
  $("#wlOpenCollections").textContent=all.filter(c=>!["COLLECTED","CANCELED"].includes(c.status)).length;
  const filter=$("#wlCollectionStatusFilter").value;
  const list=filter?all.filter(c=>c.status===filter):all;
  $("#wlCollectionsList").innerHTML=list.length?list.map(collection=>{
    const master=state.account?.role==="WL_MASTER";
    const point=state.points.find(p=>p.id===collection.pointId);
    const address=collection.address||{};
    const location=[address.street,address.number,address.neighborhood,address.city+"/"+address.state,address.cep]
      .filter(Boolean).join(", ");
    const status=collectionLabels[collection.status]||collection.status;
    const terminal=["COLLECTED","CANCELED"].includes(collection.status);
    const canAssign=master&&["REQUESTED","ASSIGNED"].includes(collection.status);
    const canRoute=collection.status==="ASSIGNED";
    const canComplete=["ASSIGNED","IN_ROUTE"].includes(collection.status);
    const canCancel=master&&!terminal;
    const assign=canAssign?
      '<div class="wl-collection-assignment"><label>Unidade responsável<select data-collection-point>'+
      '<option value="">Escolha a unidade</option>'+state.points.filter(p=>p.active).map(p=>
        '<option value="'+esc(p.id)+'"'+(p.id===collection.pointId?' selected':'')+'>'+
        esc(p.name)+' · '+esc(p.city)+'</option>').join("")+
      '</select></label><label>Motorista / responsável<input data-collection-driver maxlength="100" value="'+esc(collection.driverName||"")+'" placeholder="Nome do responsável"></label>'+
      '<button class="ghost" type="button" data-collection-action="assign">Atribuir</button></div>':"";
    const buttons=(canRoute?'<button class="ghost" type="button" data-collection-action="IN_ROUTE">Iniciar rota</button>':"")+
      (canComplete?'<button class="primary" type="button" data-collection-action="COLLECTED">Confirmar coleta</button>':"")+
      (canCancel?'<button class="ghost" type="button" data-collection-action="CANCELED">Cancelar</button>':"");
    return '<article class="wl-collection-item" data-collection-id="'+esc(collection.id)+'">'+
      '<div class="wl-collection-header"><div><small class="quote-source">COLETA · '+esc(status)+'</small>'+
      '<strong>'+esc(collection.requesterName)+'</strong><span>'+esc(collection.requesterPhone)+'</span></div>'+
      '<span class="wl-collection-status wl-status-'+esc(collection.status)+'">'+esc(status)+'</span></div>'+
      '<div class="wl-collection-details"><span>'+esc(collection.packageCount)+' pacote(s)</span>'+
      '<span>'+esc(location)+'</span><span>Agendamento: '+esc(collectionDate(collection.scheduledFor))+'</span>'+
      '<span>Unidade: '+esc(point?.name||"Aguardando distribuição")+'</span>'+
      (collection.driverName?'<span>Responsável: '+esc(collection.driverName)+'</span>':"")+
      (collection.notes?'<span>Observações: '+esc(collection.notes)+'</span>':"")+
      '</div>'+assign+(buttons?'<div class="action-row wl-collection-status-actions">'+buttons+'</div>':"")+
      '</article>';
  }).join(""):'<div class="empty">Nenhuma ordem de coleta encontrada para este filtro.</div>';
}
async function loadCollections(){
  try{
    const result=await api("/api/wl/collections");
    state.collections=Array.isArray(result.collections)?result.collections:[];
    renderCollections();
  }catch(error){errorText(error.message);}
}
$("#wlCollectionStatusFilter").addEventListener("change",renderCollections);
$("#wlRefreshCollections").addEventListener("click",loadCollections);
$("#wlQuoteCollectionShortcut").addEventListener("click",()=>{
  const origin=digit($("#quoteOrigin").value);
  if(origin.length===8&&!$("#wlCollectionCep").value)$("#wlCollectionCep").value=origin.replace(/^(\d{5})(\d{3})$/,"$1-$2");
  activate("collections");
  $("#wlCollectionForm").scrollIntoView({behavior:"smooth",block:"start"});
});
$("#wlCollectionForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const btn=event.currentTarget.querySelector('button[type="submit"]');
  btn.disabled=true;
  try{
    if(!globalThis.crypto?.randomUUID)throw new Error("Seu navegador precisa oferecer conexão segura para cadastrar coletas.");
    if(!state.collectionRequestKey)state.collectionRequestKey=globalThis.crypto.randomUUID();
    const scheduled=$("#wlCollectionSchedule").value;
    const data={
      requestKey:state.collectionRequestKey,
      pointId:state.account.role==="WL_MASTER"?$("#wlCollectionPoint").value:null,
      requesterName:$("#wlCollectionName").value,
      requesterPhone:digit($("#wlCollectionPhone").value),
      requesterDocument:digit($("#wlCollectionDocument").value),
      packageCount:Number($("#wlCollectionPackages").value),
      address:{
        street:$("#wlCollectionStreet").value,number:$("#wlCollectionNumber").value,
        complement:$("#wlCollectionComplement").value,
        neighborhood:$("#wlCollectionNeighborhood").value,
        cep:digit($("#wlCollectionCep").value),city:$("#wlCollectionCity").value,
        state:$("#wlCollectionState").value
      },
      scheduledFor:scheduled?new Date(scheduled).toISOString():null,
      notes:$("#wlCollectionNotes").value
    };
    const result=await api("/api/wl/collections",{method:"POST",body:JSON.stringify(data)});
    state.collectionRequestKey=null;
    event.currentTarget.reset();
    $("#wlCollectionPoint").value="";
    await loadCollections();
    $("#wlCollectionsList").scrollIntoView({behavior:"smooth",block:"start"});
    alert(result.created?"Ordem de coleta registrada.":"Ordem de coleta já registrada anteriormente.");
  }catch(error){errorText(error.message);}finally{btn.disabled=false;}
});
$("#wlCollectionsList").addEventListener("click",async event=>{
  const button=event.target.closest("[data-collection-action]");
  if(!button)return;
  const item=button.closest("[data-collection-id]");
  const id=item?.dataset.collectionId,action=button.dataset.collectionAction;
  if(!id||!action)return;
  let url,body;
  if(action==="assign"){
    const pointId=item.querySelector("[data-collection-point]")?.value;
    const driverName=item.querySelector("[data-collection-driver]")?.value||"";
    if(!pointId){errorText("Selecione uma unidade ativa para atribuir a coleta.");return;}
    url="/api/wl/collections/"+encodeURIComponent(id)+"/assign";
    body={pointId,driverName};
  }else{
    if(action==="CANCELED"&&!confirm("Cancelar esta ordem de coleta?"))return;
    url="/api/wl/collections/"+encodeURIComponent(id)+"/status";
    body={status:action};
  }
  errorText("");button.disabled=true;
  try{
    await api(url,{method:"PATCH",body:JSON.stringify(body)});
    await loadCollections();
  }catch(error){errorText(error.message);button.disabled=false;}
});

function renderPoints(){
  $("#statPoints").textContent=state.points.length;
  refreshCollectionPointSelect();
  refreshClientPointSelectors();
  const select=$("#employeePoint");
  select.innerHTML='<option value="">Selecione uma unidade ativa</option>'+
    state.points.filter(point=>point.active).map(point=>
      '<option value="'+esc(point.id)+'">'+esc(point.name)+' · '+esc(point.city)+'/'+esc(point.state)+'</option>'
    ).join("");
  $("#pointsList").innerHTML=state.points.length?state.points.map(point=>
    '<div class="list-item"><div><strong>'+esc(point.name)+'</strong><span>'+
    esc(point.code)+' · '+esc(cep(point.cep))+' · '+esc(point.city)+'/'+esc(point.state)+
    '</span><small>'+esc(point.address)+', '+esc(point.number)+' · '+(point.active?"Ativo":"Inativo")+
    '</small></div><div class="list-price"><button class="ghost" type="button" data-edit-point="'+esc(point.id)+'">Editar</button></div></div>'
  ).join(""):'<div class="empty">Nenhum ponto cadastrado.</div>';
  $$("#pointsList [data-edit-point]").forEach(button=>button.addEventListener("click",()=>{
    const point=state.points.find(item=>item.id===button.dataset.editPoint);
    if(!point)return;
    for(const [id,key] of [["pointId","id"],["pointCode","code"],["pointName","name"],
      ["pointCep","cep"],["pointCity","city"],["pointState","state"],
      ["pointAddress","address"],["pointNumber","number"]]){
      $("#"+id).value=point[key];
    }
    $("#pointActive").checked=point.active;
    $("#pointForm").scrollIntoView({behavior:"smooth",block:"start"});
  }));
}
async function loadPoints(){
  try{
    const result=await api("/api/wl/points");
    state.points=result.points||[];
    renderPoints();
  }catch(error){errorText(error.message);}
}
$("#reloadPoints").addEventListener("click",loadPoints);
$("#resetPoint").addEventListener("click",()=>{
  $("#pointForm").reset();$("#pointId").value="";
});
$("#pointForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
  const id=$("#pointId").value;
  const data={
    code:$("#pointCode").value,name:$("#pointName").value,
    cep:digit($("#pointCep").value),city:$("#pointCity").value,
    state:$("#pointState").value,address:$("#pointAddress").value,
    number:$("#pointNumber").value,active:$("#pointActive").checked
  };
  try{
    await api(id?"/api/wl/points/"+encodeURIComponent(id):"/api/wl/points",{
      method:id?"PUT":"POST",body:JSON.stringify(data)
    });
    $("#pointForm").reset();$("#pointId").value="";
    await loadPoints();
  }catch(error){errorText(error.message);}finally{btn.disabled=false;}
});
function routeLine(route){
  const left=esc(cep(route.originStart))+"–"+esc(cep(route.originEnd));
  const right=esc(cep(route.destinationStart))+"–"+esc(cep(route.destinationEnd));
  return '<div class="list-item"><div><strong>'+esc(route.name)+'</strong>'+
    '<span>'+left+' → '+right+'</span><small>'+route.minWeight+' a '+route.maxWeight+' g · '+
    route.days+' dia(s) · '+(route.active?"Ativa":"Inativa")+'</small></div>'+
    '<div class="list-price"><strong>'+money(route.price)+'</strong><small>+ '+money(route.perKg)+'/kg</small>'+
    (state.account?.role==="WL_MASTER"?'<button class="ghost" data-edit="'+esc(route.id)+'" type="button">Editar</button>':"")+
    '</div></div>';
}
function renderRoutes(){
  $("#statRoutes").textContent=state.routes.length;
  $("#statActiveRoutes").textContent=state.routes.filter(r=>r.active).length;
  $("#routesList").innerHTML=state.routes.length
    ?state.routes.map(routeLine).join("")
    :'<div class="empty">Nenhuma rota cadastrada. O MASTER pode criar a primeira tarifa acima.</div>';
  $$("#routesList [data-edit]").forEach(button=>button.addEventListener("click",()=>{
    const item=state.routes.find(route=>route.id===button.dataset.edit);
    if(!item)return;
    for(const [id,key] of [["tariffId","id"],["routeName","name"],["originStart","originStart"],
      ["originEnd","originEnd"],["destinationStart","destinationStart"],["destinationEnd","destinationEnd"],
      ["minWeight","minWeight"],["maxWeight","maxWeight"],["routePrice","price"],
      ["routePerKg","perKg"],["routeDays","days"]]){
      $("#"+id).value=item[key];
    }
    $("#routeActive").checked=item.active;
    $("#tariffForm").scrollIntoView({behavior:"smooth",block:"start"});
  }));
  $("#tariffForm").classList.toggle("hidden",state.account?.role!=="WL_MASTER");
}
async function loadRoutes(){
  try{
    const response=await api("/api/wl/routes");
    state.routes=response.routes||[];
    renderRoutes();
  }catch(error){errorText(error.message);}
}
$("#reloadRoutes").addEventListener("click",loadRoutes);
$("#resetTariff").addEventListener("click",()=>{
  $("#tariffForm").reset();
  $("#tariffId").value="";
});
$("#tariffForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;
  const id=$("#tariffId").value;
  const data={
    name:$("#routeName").value,
    originStart:digit($("#originStart").value),originEnd:digit($("#originEnd").value),
    destinationStart:digit($("#destinationStart").value),destinationEnd:digit($("#destinationEnd").value),
    minWeight:Number($("#minWeight").value),maxWeight:Number($("#maxWeight").value),
    price:Number($("#routePrice").value),perKg:Number($("#routePerKg").value),
    days:Number($("#routeDays").value),active:$("#routeActive").checked
  };
  try{
    await api(id?"/api/wl/routes/"+encodeURIComponent(id):"/api/wl/routes",
      {method:id?"PUT":"POST",body:JSON.stringify(data)});
    $("#tariffForm").reset();$("#tariffId").value="";
    await loadRoutes();
  }catch(error){errorText(error.message);}finally{button.disabled=false;}
});
// Mesmo catálogo local de logomarcas utilizado nas cotações do Postal Balcão.
// Não confiar em URL arbitrária recebida de APIs de frete.
function quoteCarrierLogo(option){
  if(option?.source==="OWN"){
    const ownLogo=String(state.brand?.logoUrl||"").trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(ownLogo)?ownLogo:"";
  }
  const local=globalThis.PostalBrand?.carrierLogo?.(option?.carrier)||"";
  return /^\/assets\/brands\/[a-z0-9-]+\.(?:svg|png)$/i.test(local)?local:"";
}
function quoteCarrierMark(option){
  const name=String(option?.carrier||state.brand?.name||"Transportadora");
  const initials=name.trim().split(/\s+/).slice(0,2).map(part=>part.charAt(0)).join("").toUpperCase()||"TR";
  const fallback='<span class="wl-quote-carrier-fallback'+(quoteCarrierLogo(option)?' hidden':'')+'" aria-hidden="true">'+esc(initials)+'</span>';
  const src=quoteCarrierLogo(option);
  return '<span class="wl-quote-carrier-mark">'+
    (src?'<img class="wl-quote-carrier-logo" src="'+esc(src)+'" alt="Logomarca de '+esc(name)+'" width="100" height="40" loading="lazy" decoding="async">':"")+
    fallback+'</span>';
}
function activateQuoteLogoFallbacks(){
  $$("#quoteResults .wl-quote-carrier-logo").forEach(img=>{
    img.addEventListener("error",()=>{
      img.classList.add("hidden");
      img.parentElement?.querySelector(".wl-quote-carrier-fallback")?.classList.remove("hidden");
    },{once:true});
  });
}
$("#quoteForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const button=event.currentTarget.querySelector('button[type="submit"]');
  button.disabled=true;
  $("#quoteResults").textContent="Consultando as rotas próprias e as transportadoras da rede...";
  $("#quoteComparisonStatus").textContent="";
  const params=new URLSearchParams({
    origin:digit($("#quoteOrigin").value),
    destination:digit($("#quoteDestination").value),
    weight:$("#quoteWeight").value,
    length:$("#quoteLength").value,
    width:$("#quoteWidth").value,
    height:$("#quoteHeight").value,
    declaredValue:$("#quoteDeclaredValue").value||"0",
    clientId:$("#wlQuoteClient").value||"",
    ...(state.account.role==="WL_MASTER"?{pointId:$("#wlQuotePoint").value||""}:{})
  });
  try {
    const result=await api("/api/wl/quote?"+params);
    const options=Array.isArray(result.options)?result.options:[];
    const ownCount=Number(result.count?.own||0);
    const integratedCount=Number(result.count?.integrated||0);
    const stateText=result.integrated?.status==="UNAVAILABLE"
      ?"Rede integrada temporariamente indisponível. As tarifas próprias continuam disponíveis."
      :result.integrated?.status==="NONE"
      ?"A rede integrada não apresentou tarifas para este trajeto, peso e dimensões."
      :"Opções da rede integrada consultadas em tempo real.";
    $("#quoteComparisonStatus").textContent=
      ownCount+" rota(s) própria(s) · "+integratedCount+" opção(ões) integrada(s). "+stateText;
    $("#quoteResults").innerHTML=options.length
      ?'<p class="note">Simulação sem pagamento ou emissão. O valor exibido é o preço final estimado de venda.</p>'+
        options.map(option=>{
          const own=option.source==="OWN";
          const carrier=esc(option.carrier||state.brand?.name||"Transportadora");
          const service=esc(option.name||"Serviço");
          const type=own?"Rota própria":"Transportadora integrada";
          const deadline=Number(option.days)>0?Number(option.days)+" dia(s) previstos":"Prazo sob consulta";
          const earning=state.account.role==="WL_MASTER" && option.masterShare!=null
            ?'<small>MASTER White Label: '+money(option.masterShare)+'</small>'+
              '<small>Ponto parceiro: '+money(option.pointShare||0)+'</small>'+
              (option.postalShare!=null
                ?'<small>Postal (rota própria): '+money(option.postalShare)+'</small>'
                :'<small>Rede integrada: margem Postal e custo do provedor apurados internamente.</small>')
            :"";
          return '<div class="list-item quote-option"><div class="wl-quote-carrier-profile">'+
            quoteCarrierMark(option)+
            '<div class="wl-quote-carrier-copy"><small class="quote-source">'+esc(type)+'</small>'+
            '<strong>'+carrier+'</strong><span>'+service+'</span><small>'+esc(deadline)+'</small></div></div>'+
            '<div class="list-price"><strong>'+money(option.total)+'</strong>'+earning+'</div></div>';
        }).join("")
      :'<div class="empty">Nenhuma opção disponível para os dados informados. Verifique as rotas e tente novamente.</div>';
    activateQuoteLogoFallbacks();
  }catch(error){
    $("#quoteResults").textContent="";
    $("#quoteComparisonStatus").textContent="";
    errorText(error.message);
  }finally{button.disabled=false;}
});
async function loadUsers(){
  try{
    const data=await api("/api/wl/users");
    $("#userList").innerHTML=data.users.map(user=>
      '<div class="list-item"><div><strong>'+esc(user.name)+'</strong><span>'+esc(user.email)+'</span>'+
      '<small>'+(user.role==="WL_MASTER"?"MASTER":"Operador")+
      (user.pointId?" · "+esc(state.points.find(p=>p.id===user.pointId)?.name||"Unidade vinculada"):"")+'</small></div><div class="list-price">'+
      '<span>'+(user.active?"Ativo":"Suspenso")+'</span>'+
      (user.role==="WL_OPERATOR"?'<button class="ghost" data-user="'+esc(user.id)+'" data-active="'+(user.active?"false":"true")+'" type="button">'+
       (user.active?"Suspender":"Reativar")+'</button>':"")+'</div></div>'
    ).join("")||'<div class="empty">Nenhum colaborador cadastrado.</div>';
    $$("#userList [data-user]").forEach(button=>button.addEventListener("click",async()=>{
      if(!confirm("Alterar o acesso deste colaborador?"))return;
      try{
        await api("/api/wl/users/"+encodeURIComponent(button.dataset.user),{
          method:"PATCH",body:JSON.stringify({active:button.dataset.active==="true"})});
        await loadUsers();
      }catch(error){errorText(error.message);}
    }));
  }catch(error){errorText(error.message);}
}
function credentials(content){
  $("#credentialText").textContent=content;
  $("#credentialsDialog").showModal();
}
$("#userForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  const button=event.currentTarget.querySelector("button");button.disabled=true;
  try{
    const result=await api("/api/wl/users",{method:"POST",body:JSON.stringify({
      name:$("#employeeName").value,email:$("#employeeEmail").value,pointId:$("#employeePoint").value
    })});
    credentials("Portal: "+location.href+"\nE-mail: "+result.user.email+"\nSenha temporária: "+result.temporaryPassword);
    event.currentTarget.reset();await loadUsers();
  }catch(error){errorText(error.message);}finally{button.disabled=false;}
});
$("#closeCredentials").addEventListener("click",()=>{
  $("#credentialText").textContent="";
  $("#credentialsDialog").close();
});
$("#copyCredentials").addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText($("#credentialText").textContent);
    $("#copyCredentials").textContent="Copiado!";
  }catch{alert("Selecione o texto para copiar.");}
});
(async()=>{
  if(!/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code)){
    errorText("Endereço de transportadora inválido.");return;
  }
  try{
    await loadBrand();
    const current=await api("/api/wl/session").catch(()=>null);
    if(current?.ok)showAuth(current.account,current.csrf,current.finance);
  }catch(error){errorText(error.message);}
})();

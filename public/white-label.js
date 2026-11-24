"use strict";
const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const code=decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1)||"").toUpperCase();
const state={csrf:"",account:null,brand:null,routes:[],finance:null};
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
  document.documentElement.style.setProperty("--brand",brand.primary||"#d7083b");
  document.documentElement.style.setProperty("--brand-dark",brand.secondary||"#222638");
  $("#welcomeSubtitle").textContent=(brand.baseCity||"")+" / "+(brand.baseState||"")+" · Rotas e gestão White Label";
  if(brand.logoUrl&&/^https:\/\/[^\s]+$/i.test(brand.logoUrl)){
    $("#brandLogo").src=brand.logoUrl;
    $("#brandLogo").classList.remove("hidden");
    $("#brandIcon").classList.add("hidden");
    $("#brandLogo").onerror=()=>{$("#brandLogo").classList.add("hidden");$("#brandIcon").classList.remove("hidden");};
  }
  $("#brandPreview").innerHTML='<div class="big-brand"><strong>'+esc(brand.name)+'</strong><span>'+esc(brand.baseCity)+' / '+esc(brand.baseState)+'</span></div><div><small>Cor principal</small><span class="swatch" style="background:'+esc(brand.primary)+'"></span><code>'+esc(brand.primary)+'</code></div><div><small>Cor secundária</small><span class="swatch" style="background:'+esc(brand.secondary)+'"></span><code>'+esc(brand.secondary)+'</code></div>';
}
async function loadBrand(){
  const response=await api("/api/wl/public/"+encodeURIComponent(code));
  applyBrand(response.brand);
}
function showAuth(account,csrf,finance){
  state.account=account;state.csrf=csrf||"";state.finance=finance||null;
  $("#loginPanel").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#welcomeName").textContent="Painel "+(state.brand?.name||"White Label");
  $("#roleTag").textContent=account.role==="WL_MASTER"?"MASTER da transportadora":"Operador";
  $$(".master-only").forEach(element=>element.classList.toggle("hidden",account.role!=="WL_MASTER"));
  $("#passwordPanel").classList.toggle("hidden",!account.mustChangePassword);
  $("#walletStatus").textContent=finance?.walletConfigured
    ?"Carteira cadastrada pelo MASTER Postal. Homologação financeira pendente."
    :"Carteira Asaas pendente. O MASTER Postal deve configurar e verificar a conta.";
  activate("overview");
  loadRoutes();
  if(account.role==="WL_MASTER")loadUsers();
}
function activate(name){
  if(name==="users"||name==="finance"){
    if(state.account?.role!=="WL_MASTER")return;
  }
  $$(".tab").forEach(btn=>btn.classList.toggle("active",btn.dataset.tab===name));
  $$(".tab-panel").forEach(panel=>panel.classList.toggle("hidden",panel.dataset.panel!==name));
  errorText("");
}
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
$("#quoteForm").addEventListener("submit",async event=>{
  event.preventDefault();errorText("");
  $("#quoteResults").textContent="Calculando...";
  const params=new URLSearchParams({
    origin:digit($("#quoteOrigin").value),
    destination:digit($("#quoteDestination").value),
    weight:$("#quoteWeight").value
  });
  try {
    const result=await api("/api/wl/quote?"+params);
    const options=result.options||[];
    $("#quoteResults").innerHTML=options.length
      ?'<p class="note">Simulação: não gera etiqueta nem pagamento.</p>'+options.map(option=>
        '<div class="list-item"><div><strong>'+esc(option.name)+'</strong><span>'+
        option.days+' dia(s) previstos</span></div><div class="list-price"><strong>'+
        money(option.total)+'</strong>'+
        (state.account.role==="WL_MASTER" ? '<small>Repasse Postal estimado: '+money(option.postalShare)+'</small>':"")+
        '</div></div>').join("")
      :'<div class="empty">Nenhuma tarifa ativa atende a estes CEPs e ao peso informado.</div>';
  }catch(error){$("#quoteResults").textContent="";errorText(error.message);}
});
async function loadUsers(){
  try{
    const data=await api("/api/wl/users");
    $("#userList").innerHTML=data.users.map(user=>
      '<div class="list-item"><div><strong>'+esc(user.name)+'</strong><span>'+esc(user.email)+'</span>'+
      '<small>'+(user.role==="WL_MASTER"?"MASTER":"Operador")+'</small></div><div class="list-price">'+
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
      name:$("#employeeName").value,email:$("#employeeEmail").value
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

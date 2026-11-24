"use strict";
(() => {
  const $=selector=>document.querySelector(selector);
  const $$=selector=>Array.from(document.querySelectorAll(selector));
  const digits=value=>String(value||"").replace(/\D/g,"");
  const escapeHtml=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const money=value=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value||0));
  const pathParts=location.pathname.split("/").filter(Boolean);
  const code=String(pathParts[1]||"").toUpperCase();
  const state={brand:null,account:null,csrf:"",fiscal:null,addresses:[],profile:null,volumeCount:0};
  function notice(message){
    const node=$("#wlcNotice");
    node.textContent=message||"";
    node.classList.toggle("hidden",!message);
    if(message)node.scrollIntoView({block:"nearest",behavior:"smooth"});
  }
  async function api(path,options={}){
    const method=String(options.method||"GET").toUpperCase();
    const response=await fetch(path,{credentials:"same-origin",...options,
      headers:{"Content-Type":"application/json",
        ...(state.csrf&&!["GET","HEAD"].includes(method)?{"x-csrf-token":state.csrf}:{}),
        ...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||"Não foi possível concluir a operação.");
    return data;
  }
  function brand(branding){
    state.brand=branding;
    const color=branding.primary||"#d7083b";
    document.documentElement.style.setProperty("--brand",color);
    document.documentElement.style.setProperty("--brand-dark",branding.secondary||"#222638");
    const rgb=color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if(rgb){
      const channels=rgb.slice(1).map(x=>parseInt(x,16)/255)
        .map(x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4));
      document.documentElement.style.setProperty("--on-brand",
        .2126*channels[0]+.7152*channels[1]+.0722*channels[2]>.2?"#20232d":"#fff");
    }
    for(const selector of ["#wlcLoginName","#wlcSideName","#wlcHeaderBrand"])
      $(selector).textContent=branding.name||"Minha transportadora";
    document.title=(branding.name||"Transportadora")+" · Minha Conta";
    for(const [imgId,iconId] of [["#wlcLoginLogo","#wlcLoginIcon"],["#wlcSideLogo","#wlcSideIcon"]]){
      const img=$(imgId),icon=$(iconId);
      const src=String(branding.logoUrl||"");
      const allowed=/^https:\/\/[^\s"'<>]+$/i.test(src);
      img.classList.toggle("hidden",!allowed);
      icon.classList.toggle("hidden",allowed);
      if(allowed){
        img.src=src;
        img.onerror=()=>{img.classList.add("hidden");icon.classList.remove("hidden");};
      }else img.removeAttribute("src");
    }
  }
  function closeMenu(){
    $("#wlcSidebar").classList.remove("open");
    $("#wlcBackdrop").classList.add("hidden");
    $("#wlcMenu").setAttribute("aria-expanded","false");
  }
  function go(section){
    const labels={home:"Início",quote:"Simular Frete",bulk:"Postagens por Planilha",
      orders:"Meus Pedidos",collections:"Coletas",profile:"Meu Cadastro",
      addresses:"Endereços Salvos",wallet:"Carteira e Saldo",connections:"Integrações E-commerce"};
    if(!(section in labels))return;
    $$(".nav-item[data-client-view]").forEach(btn=>{
      const active=btn.dataset.clientView===section;
      btn.classList.toggle("active",active);
      if(active)btn.setAttribute("aria-current","page");else btn.removeAttribute("aria-current");
    });
    $$(".wlc-panel").forEach(panel=>panel.classList.toggle("hidden",panel.dataset.clientPanel!==section));
    $("#wlcTitle").textContent=labels[section];
    if(section==="addresses")void loadAddresses();
    if(section==="profile")void loadProfile();
    notice("");
    closeMenu();
    window.scrollTo({top:0,behavior:"smooth"});
  }
  function showSession(session){
    state.account=session.account;
    state.csrf=session.csrf;
    if(session.brand)brand(session.brand);
    $("#wlcLoginShell").classList.add("hidden");
    $("#wlcApp").classList.remove("hidden");
    $("#wlcSideUser").textContent=session.account.name||"Cliente";
    $("#wlcSideEmail").textContent=session.account.email||"";
    $("#wlcAvatar").textContent=String(session.account.name||"C")[0].toUpperCase();
    $("#wlcWelcome").textContent="Olá, "+(session.account.name||"cliente")+
      ". Compare as opções de frete com a "+(state.brand?.name||"sua transportadora")+".";
    $("#wlcPasswordPanel").classList.toggle("hidden",!session.account.mustChangePassword);
    if(session.account.mustChangePassword){
      $("#wlcPasswordPanel").scrollIntoView({behavior:"smooth",block:"start"});
    }else{
      void loadProfile();
      void loadAddresses();
    }
    go("home");
  }
  async function start(){
    $("#wlcOperatorLink").href="/wl/"+encodeURIComponent(code);
    try{
      const response=await api("/api/wl/public/"+encodeURIComponent(code));
      brand(response.brand);
    }catch(error){notice(error.message);}
    try{
      const session=await api("/api/wl/customer/session");
      showSession(session);
    }catch{}
    addVolume();
  }
  $("#wlcLoginForm").addEventListener("submit",async event=>{
    event.preventDefault();notice("");
    const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
    try{
      const result=await api("/api/wl/customer/login",{method:"POST",body:JSON.stringify({
        code,email:$("#wlcEmail").value.trim(),password:$("#wlcPassword").value
      })});
      $("#wlcPassword").value="";
      const session=await api("/api/wl/customer/session");
      showSession(session);
    }catch(error){notice(error.message);}finally{btn.disabled=false;}
  });
  $("#wlcPasswordForm").addEventListener("submit",async event=>{
    event.preventDefault();notice("");
    const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
    try{
      await api("/api/wl/customer/password",{method:"POST",body:JSON.stringify({
        currentPassword:$("#wlcOldPassword").value,nextPassword:$("#wlcNewPassword").value
      })});
      notice("Senha alterada. Entre novamente com a nova senha.");
      location.href="/wl/"+encodeURIComponent(code)+"/cliente";
    }catch(error){notice(error.message);}finally{btn.disabled=false;}
  });
  $("#wlcLogout").addEventListener("click",async()=>{
    try{await api("/api/wl/customer/logout",{method:"POST"});}catch{}
    location.href="/wl/"+encodeURIComponent(code)+"/cliente";
  });
  $$(".nav-item[data-client-view]").forEach(node=>node.addEventListener("click",()=>go(node.dataset.clientView)));
  $$("[data-client-go]").forEach(node=>node.addEventListener("click",()=>go(node.dataset.clientGo)));
  $("#wlcStartQuote").addEventListener("click",()=>go("quote"));
  $("#wlcMenu").addEventListener("click",()=>{
    const open=!$("#wlcSidebar").classList.contains("open");
    $("#wlcSidebar").classList.toggle("open",open);
    $("#wlcBackdrop").classList.toggle("hidden",!open);
    $("#wlcMenu").setAttribute("aria-expanded",String(open));
  });
  $("#wlcBackdrop").addEventListener("click",closeMenu);
  document.addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu();});
  window.addEventListener("resize",()=>{if(innerWidth>820)closeMenu();});
  function mode(){
    const type=$('input[name="wlcInputMode"]:checked')?.value||"MANUAL";
    $("#wlcXmlPanel").classList.toggle("hidden",type!=="XML");
    $("#wlcKeyPanel").classList.toggle("hidden",type!=="KEY");
  }
  $$('input[name="wlcInputMode"]').forEach(node=>node.addEventListener("change",mode));
  function applyFiscal(doc){
    if(!doc||!["NFE","DCE"].includes(doc.type))throw Error("Documento não reconhecido.");
    const sender=doc.sender||{},recipient=doc.recipient||{};
    state.fiscal=doc;
    $("#wlcSenderName").value=sender.name||"";
    $("#wlcOrigin").value=sender.cep||"";
    $("#wlcRecipientName").value=recipient.name||"";
    $("#wlcDestination").value=recipient.cep||"";
    if(Number(doc.declaredValue)>=0&&state.volumeCount===1){
      const field=$("#wlcVolumes input[data-vol-field=declaredValue]");
      if(field)field.value=doc.declaredValue||0;
    }
    if(Number(doc.grossWeightKg)>0&&state.volumeCount===1){
      const field=$("#wlcVolumes input[data-vol-field=weight]");
      if(field)field.value=Math.ceil(Number(doc.grossWeightKg)*1000);
    }
    $("#wlcFiscalResult").classList.remove("hidden");
    $("#wlcFiscalResult").textContent=(doc.type==="DCE"?"DC-e":"NF-e")+" reconhecida: "+
      (doc.key||"sem chave")+" · Valor: "+money(doc.declaredValue||0)+
      ". Revise o peso, dimensões e destinatário.";
  }
  $("#wlcXmlFile").addEventListener("change",async event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    try{
      if(file.size>3000000)throw Error("XML acima de 3 MB.");
      if(!/\.xml$/i.test(file.name))throw Error("Escolha um arquivo .xml.");
      if(!window.PostalFiscalDocument?.parse)throw Error("Leitor XML não carregado.");
      applyFiscal(window.PostalFiscalDocument.parse(await file.text()));
      notice("");
    }catch(error){notice(error.message);}
  });
  $("#wlcLookupFiscal").addEventListener("click",async()=>{
    const key=digits($("#wlcFiscalKey").value);
    if(key.length!==44){notice("Informe a chave de 44 dígitos.");return;}
    if(!$("#wlcFiscalConsent").checked){notice("Confirme sua autorização para consultar a chave fiscal.");return;}
    const btn=$("#wlcLookupFiscal");btn.disabled=true;notice("");
    try{
      const result=await api("/api/wl/customer/fiscal-lookup",{
        method:"POST",body:JSON.stringify({type:$("#wlcFiscalType").value,key,consent:true})
      });
      applyFiscal(result.document);
    }catch(error){notice(error.message);}finally{btn.disabled=false;}
  });
  function addVolume(){
    if(state.volumeCount>=5){notice("Limite de 5 volumes por cotação.");return;}
    const index=++state.volumeCount;
    const node=document.createElement("div");
    node.className="wlc-volume";
    node.innerHTML='<div class="section-head"><strong>Volume '+index+'</strong>'+
      '<span class="eyebrow">MEDIDAS REAIS</span></div>'+
      '<div class="fields grid-form">'+
      '<label>Peso (g)<input data-vol-field="weight" type="number" min="1" max="30000" step="1" value="1000" required></label>'+
      '<label>Comprimento (cm)<input data-vol-field="length" type="number" min="1" max="100" step="1" value="20" required></label>'+
      '<label>Largura (cm)<input data-vol-field="width" type="number" min="1" max="100" step="1" value="15" required></label>'+
      '<label>Altura (cm)<input data-vol-field="height" type="number" min="1" max="100" step="1" value="10" required></label>'+
      '<label>Valor declarado (R$)<input data-vol-field="declaredValue" type="number" min="0" max="50000" step="0.01" value="0"></label>'+
      (index>1?'<button class="ghost wlc-remove-volume" type="button">Remover</button>':"")+
      '</div>';
    $("#wlcVolumes").appendChild(node);
    node.querySelector(".wlc-remove-volume")?.addEventListener("click",()=>{
      node.remove();
      state.volumeCount--;
      $$("#wlcVolumes .wlc-volume").forEach((v,i)=>{
        const strong=v.querySelector("strong");if(strong)strong.textContent="Volume "+(i+1);
      });
    });
  }
  $("#wlcAddVolume").addEventListener("click",addVolume);
  function quoteLogo(option){
    const src=option.source==="OWN"?String(state.brand?.logoUrl||""):
      String(window.PostalBrand?.carrierLogo?.(option.carrier)||"");
    if(option.source==="OWN"&&!/^https:\/\/[^\s"'<>]+$/i.test(src))return "";
    if(option.source!=="OWN"&&!/^\/assets\/brands\/[a-z0-9-]+\.(svg|png)$/i.test(src))return "";
    return src;
  }
  function renderQuote(data){
    const items=Array.isArray(data.options)?data.options:[];
    const message=data.networkStatus==="UNAVAILABLE"?"Rede integrada indisponível neste momento. "+
      "As opções próprias continuam disponíveis.":
      data.networkStatus==="NONE"?"Não foram encontradas opções integradas para todos os volumes.":
      "Cotação calculada com as opções disponíveis.";
    $("#wlcQuoteStatus").textContent=message+" "+items.length+" resultado(s), para "+data.volumeCount+" volume(s).";
    $("#wlcQuoteResults").innerHTML=items.length?items.map(o=>{
      const src=quoteLogo(o);
      const carrier=String(o.carrier||"Transportadora");
      return '<article class="list-item wlc-option">'+
        '<div class="wlc-option-main"><div class="wlc-logo">'+
        (src?'<img src="'+escapeHtml(src)+'" alt="Logomarca '+escapeHtml(carrier)+'" loading="lazy">':
          '<span>'+escapeHtml(carrier.substring(0,2).toUpperCase())+'</span>')+
        '</div><div><strong>'+escapeHtml(carrier)+'</strong><span>'+escapeHtml(o.name||"Serviço")+
        '</span><small>'+(o.days?o.days+" dia(s) previstos":"Prazo sob consulta")+
        ' · '+escapeHtml(o.source==="OWN"?"Rota regional":"Rede integrada")+'</small></div></div>'+
        '<div class="list-price"><strong>'+money(o.total)+'</strong><small>Estimativa</small></div></article>';
    }).join(""):'<div class="empty-state">Nenhuma tarifa disponível para todos os volumes.</div>';
    $$("#wlcQuoteResults img").forEach(img=>img.addEventListener("error",()=>{
      img.parentElement.textContent=String(img.alt||"TR").replace("Logomarca ","").slice(0,2).toUpperCase();
    },{once:true}));
  }
  $("#wlcQuoteForm").addEventListener("submit",async event=>{
    event.preventDefault();notice("");
    const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
    const volumes=$$("#wlcVolumes .wlc-volume").map(node=>
      Object.fromEntries(["weight","length","width","height","declaredValue"].map(key=>
        [key,node.querySelector('[data-vol-field="'+key+'"]').value]))
    );
    const input={origin:digits($("#wlcOrigin").value),
      destination:digits($("#wlcDestination").value),volumes};
    if(state.fiscal){
      if(digits(state.fiscal.sender?.cep)!==input.origin||
         digits(state.fiscal.recipient?.cep)!==input.destination){
        notice("Os CEPs divergem do XML/chave consultado. Revise ou mude para entrada manual.");
        btn.disabled=false;return;
      }
    }
    $("#wlcQuoteResults").textContent="Consultando transportadoras...";
    try{
      const data=await api("/api/wl/customer/quote",{method:"POST",body:JSON.stringify(input)});
      renderQuote(data);
    }catch(error){$("#wlcQuoteResults").textContent="";notice(error.message);}
    finally{btn.disabled=false;}
  });
  async function loadProfile(){
    try{
      const data=await api("/api/wl/customer/profile");
      state.profile=data;
      $("#wlcProfile").innerHTML='<p><strong>'+escapeHtml(data.name)+'</strong></p>'+
        '<p>E-mail: '+escapeHtml(data.email||"—")+'</p>'+
        '<p>CPF/CNPJ: '+escapeHtml(data.document||"Não informado")+'</p>'+
        '<p>Telefone: '+escapeHtml(data.phone||"Não informado")+'</p>'+
        '<p>Remetente padrão: '+escapeHtml(data.sender?.address||"Não cadastrado")+
        ', '+escapeHtml(data.sender?.number||"")+' · '+escapeHtml(data.sender?.city||"")+'</p>';
      if(data.sender?.cep){
        $("#wlcOrigin").value=data.sender.cep;
        $("#wlcSenderName").value=data.name||"";
      }
    }catch(error){notice(error.message);}
  }
  async function loadAddresses(){
    try{
      const response=await api("/api/wl/customer/addresses");
      state.addresses=response.addresses||[];
      $("#wlcAddressesList").innerHTML=state.addresses.length?state.addresses.map(a=>
        '<div class="list-item wlc-address"><div><strong>'+escapeHtml(a.label)+'</strong>'+
        '<span>'+escapeHtml(a.data?.name||"")+' · '+escapeHtml(a.data?.address||"")+
        ', '+escapeHtml(a.data?.number||"")+' · '+escapeHtml(a.data?.cep||"")+
        '</span><small>'+(a.kind==="SENDER"?"Remetente":"Destinatário")+'</small></div>'+
        '<div class="list-price"><button class="ghost" type="button" data-use-address="'+escapeHtml(a.id)+'">Usar na cotação</button>'+
        '<button class="ghost" type="button" data-delete-address="'+escapeHtml(a.id)+'">Excluir</button></div></div>'
      ).join(""):'<div class="empty-state">Nenhum endereço salvo.</div>';
    }catch(error){notice(error.message);}
  }
  $("#wlcReloadAddresses").addEventListener("click",loadAddresses);
  $("#wlcAddressForm").addEventListener("submit",async event=>{
    event.preventDefault();notice("");
    const btn=event.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;
    const data={label:$("#wlcAddressLabel").value,kind:$("#wlcAddressKind").value,
      data:{name:$("#wlcAddressName").value,document:$("#wlcAddressDocument").value,
        phone:$("#wlcAddressPhone").value,email:$("#wlcAddressEmail").value,
        cep:$("#wlcAddressCep").value,address:$("#wlcAddressStreet").value,
        number:$("#wlcAddressNumber").value,neighborhood:$("#wlcAddressNeighborhood").value,
        complement:$("#wlcAddressComplement").value,city:$("#wlcAddressCity").value}};
    try{
      await api("/api/wl/customer/addresses",{method:"POST",body:JSON.stringify(data)});
      event.currentTarget.reset();await loadAddresses();
    }catch(error){notice(error.message);}finally{btn.disabled=false;}
  });
  $("#wlcAddressesList").addEventListener("click",async event=>{
    const use=event.target.closest("[data-use-address]");
    if(use){
      const data=state.addresses.find(a=>a.id===use.dataset.useAddress);
      if(!data)return;
      const address=data.data||{};
      if(data.kind==="SENDER"){
        $("#wlcSenderName").value=address.name||"";
        $("#wlcOrigin").value=address.cep||"";
      }else{
        $("#wlcRecipientName").value=address.name||"";
        $("#wlcDestination").value=address.cep||"";
      }
      state.fiscal=null;$("#wlcFiscalResult").classList.add("hidden");
      go("quote");return;
    }
    const del=event.target.closest("[data-delete-address]");
    if(!del||!confirm("Excluir este endereço salvo?"))return;
    try{
      await api("/api/wl/customer/addresses/"+encodeURIComponent(del.dataset.deleteAddress),{method:"DELETE"});
      await loadAddresses();
    }catch(error){notice(error.message);}
  });
  $("#wlcBulkFile").addEventListener("change",async event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    if(file.size>900000||!/\.(xlsx|csv)$/i.test(file.name)){
      notice("Utilize planilha .xlsx ou .csv de até 900 KB.");return;
    }
    $("#wlcBulkResults").textContent="Lendo e validando planilha...";
    try{
      const bytes=new Uint8Array(await file.arrayBuffer());
      let encoded="";
      for(let i=0;i<bytes.length;i+=16384)
        encoded+=String.fromCharCode(...bytes.subarray(i,i+16384));
      const result=await api("/api/wl/customer/bulk/parse",{method:"POST",body:JSON.stringify({
        name:file.name,contentBase64:btoa(encoded)
      })});
      $("#wlcBulkResults").innerHTML='<p><strong>'+result.valid+' linha(s) válida(s); '+
        result.invalid+' com erro(s).</strong> A emissão está bloqueada nesta fase.</p>'+
        '<div class="wlc-bulk-preview">'+(result.rows||[]).slice(0,30).map(row=>
          '<div class="list-item"><div><strong>'+escapeHtml(row.ref||row.name||"Linha")+'</strong>'+
          '<span>'+escapeHtml((row.errors||[]).join("; ")||"Pronto para revisão")+
          '</span></div></div>').join("")+'</div>';
    }catch(error){$("#wlcBulkResults").textContent="";notice(error.message);}
  });
  start();
})();

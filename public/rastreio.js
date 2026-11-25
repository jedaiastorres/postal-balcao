const $ = s => document.querySelector(s);
const neutralDisplay = value => String(value ?? "").replace(/conect\s*envios/gi, "plataforma logística");
const escapeHtml = value => neutralDisplay(value)
  .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replaceAll('"',"&quot;").replaceAll("'","&#039;");

function formatCep(value){
  const digits=String(value||"").replace(/\D/g,"");
  return digits.length===8 ? digits.slice(0,5)+"-"+digits.slice(5) : digits;
}
function routeLabel(route){
  if(!route) return "—";
  return [route.city,route.cep?formatCep(route.cep):""].filter(Boolean).join(" · ") || "—";
}
function dateLabel(value){
  if(!value) return "";
  const d=new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("pt-BR",{timeZone:"America/Belem"});
}
function showError(message){
  $("#errorBox").textContent=neutralDisplay(message);
  $("#errorBox").classList.remove("hidden");
  $("#trackingResult").classList.add("hidden");
}
function clearError(){ $("#errorBox").classList.add("hidden"); }
function showCarrier(carrier){
  const name=neutralDisplay(carrier).trim()||"Postal Serviços";
  const isPartner=Boolean(String(carrier||"").trim());
  $("#carrierHeading").textContent=isPartner?"Transportadora do envio":"Operação";
  $("#carrierName").textContent=name;
  const logo=$("#carrierLogo"),fallback=$("#carrierFallback");
  const logoPath=isPartner?globalThis.PostalBrand?.carrierLogo(name):"/assets/brands/postal.svg";
  fallback.textContent=/j\s*&?\s*t|jtexpress/i.test(name)?"J&T":name.replace(/[^\p{L}\p{N} ]/gu,"").slice(0,2).toUpperCase()||"?";
  fallback.classList.toggle("hidden",Boolean(logoPath));
  logo.classList.toggle("hidden",!logoPath);
  if(logoPath)logo.src=logoPath;
  logo.onerror=()=>{logo.classList.add("hidden");fallback.classList.remove("hidden");};
}

async function track(code){
  const clean=String(code||"").trim().replace(/\s+/g,"");
  if(!/^[A-Za-z0-9]{6,40}$/.test(clean)){
    showError("Informe um código de rastreio válido.");
    return;
  }
  clearError();
  const btn=$("#trackBtn");
  btn.disabled=true; btn.textContent="Consultando...";
  $("#trackingForm").setAttribute("aria-busy","true");
  $("#trackingResult").classList.add("hidden");
  try{
    const endpoint=/^NET[A-F0-9]{17}$/i.test(clean)?"/api/public/network-tracking/":"/api/public/rastreio/";
    const response=await fetch(endpoint+encodeURIComponent(clean),{headers:{"accept":"application/json"},signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||"Não foi possível consultar o rastreio.");
    $("#trackingCode").value=data.trackingCode||clean;
    $("#trackingDisplay").textContent=data.trackingCode||clean;
    $("#statusLabel").innerHTML='<i class="dot"></i>'+escapeHtml(data.statusLabel||"Em acompanhamento");
    showCarrier(data.carrier);
    $("#service").textContent=neutralDisplay(data.service||"Entrega");
    $("#senderName").textContent=data.sender?.name||"—";
    $("#recipientName").textContent=data.recipient?.name||"—";
    const recipientAddress=[data.recipient?.address,data.recipient?.number,data.recipient?.complement,data.recipient?.neighborhood,data.recipient?.city,data.recipient?.cep?formatCep(data.recipient.cep):""].filter(Boolean).join(", ");
    $("#recipientAddress").textContent=recipientAddress;
    const pkg=data.package||{};
    $("#shipmentInfo").classList.toggle("hidden", !(data.sender?.name || data.recipient?.name || Number(pkg.weightKg)>0 || Number(pkg.declaredValue)>0));
    $(".route").classList.toggle("hidden", !(data.origin?.city || data.origin?.cep || data.destination?.city || data.destination?.cep));
    const firstVolume=Array.isArray(pkg.volumes)&&pkg.volumes.length?pkg.volumes[0]:null;
    const dims=firstVolume?.dimensions;
    const dimensionsText=dims && (dims.length||dims.width||dims.height)
      ? `${Number(dims.length||0)} × ${Number(dims.width||0)} × ${Number(dims.height||0)} cm`
      : "";
    $("#packageSummary").textContent=`${Number(pkg.volumeCount||1)} volume(s) · ${Number(pkg.weightKg||0).toLocaleString("pt-BR",{minimumFractionDigits:0,maximumFractionDigits:3})} kg`;
    const packageDetails=[];
    if(dimensionsText) packageDetails.push("Medidas: "+dimensionsText);
    if(Number(pkg.declaredValue||0)>0) packageDetails.push(`Valor declarado: ${Number(pkg.declaredValue).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}`);
    $("#packageDeclared").textContent=packageDetails.join(" · ");
    $("#origin").textContent=routeLabel(data.origin);
    $("#destination").textContent=routeLabel(data.destination);
    $("#updatedAt").textContent=data.updatedAt ? "Atualizado em "+dateLabel(data.updatedAt) : "";
    const events=Array.isArray(data.events)?data.events:[];
    $("#timeline").innerHTML=events.length ? events.map(event=>`
      <div class="event" role="listitem">
        <div class="rail"><i class="pin"></i></div>
        <div>
          <strong>${escapeHtml(event.description||"Atualização do envio")}</strong>
          ${event.city||event.uf ? `<p>${escapeHtml([event.city,event.uf].filter(Boolean).join(" / "))}</p>` : ""}
          <time>${escapeHtml(dateLabel(event.date))}</time>
        </div>
      </div>`).join("") : '<div class="empty">Ainda não há movimentações registradas para este envio.</div>';
    $("#trackingResult").classList.remove("hidden");
    history.replaceState({}, "", "/rastreio?codigo="+encodeURIComponent(data.trackingCode||clean));
  }catch(err){
    showError(err.name === "TimeoutError" ? "A consulta demorou mais que o esperado. Tente novamente em instantes." : err.message);
  }finally{
    btn.disabled=false; btn.textContent="Rastrear envio";
    $("#trackingForm").setAttribute("aria-busy","false");
  }
}
$("#copyTrackingBtn")?.addEventListener("click",async()=>{
  const code=$("#trackingDisplay")?.textContent?.trim();
  if(!code || code==="—")return;
  try {
    await navigator.clipboard.writeText(code);
    const btn=$("#copyTrackingBtn");
    btn.textContent="Copiado!";
    btn.setAttribute("aria-label","Código copiado");
  } catch {
    $("#trackingCode").select();
    document.execCommand("copy");
  }
});
$("#trackingForm").addEventListener("submit",event=>{
  event.preventDefault();
  track($("#trackingCode").value);
});
const initial=new URLSearchParams(location.search).get("codigo");
if(initial){ $("#trackingCode").value=initial; track(initial); }

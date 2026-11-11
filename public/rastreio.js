const $ = s => document.querySelector(s);
const escapeHtml = value => String(value ?? "")
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
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("pt-BR");
}
function showError(message){
  $("#errorBox").textContent=message;
  $("#errorBox").classList.remove("hidden");
  $("#trackingResult").classList.add("hidden");
}
function clearError(){ $("#errorBox").classList.add("hidden"); }

async function track(code){
  const clean=String(code||"").trim().replace(/\s+/g,"");
  if(!/^[A-Za-z0-9]{6,40}$/.test(clean)){
    showError("Informe um código de rastreio válido.");
    return;
  }
  clearError();
  const btn=$("#trackBtn");
  btn.disabled=true; btn.textContent="Consultando...";
  try{
    const response=await fetch("/api/public/rastreio/"+encodeURIComponent(clean),{headers:{"accept":"application/json"}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||"Não foi possível consultar o rastreio.");
    $("#trackingCode").value=data.trackingCode||clean;
    $("#trackingDisplay").textContent=data.trackingCode||clean;
    $("#statusLabel").innerHTML='<i class="dot"></i>'+escapeHtml(data.statusLabel||"Em acompanhamento");
    $("#carrier").textContent=data.carrier||"—";
    $("#service").textContent=data.service||"—";
    $("#origin").textContent=routeLabel(data.origin);
    $("#destination").textContent=routeLabel(data.destination);
    $("#updatedAt").textContent=data.updatedAt ? "Atualizado em "+dateLabel(data.updatedAt) : "";
    const events=Array.isArray(data.events)?data.events:[];
    $("#timeline").innerHTML=events.length ? events.map(event=>`
      <div class="event">
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
    showError(err.message);
  }finally{
    btn.disabled=false; btn.textContent="Rastrear envio";
  }
}
$("#trackingForm").addEventListener("submit",event=>{
  event.preventDefault();
  track($("#trackingCode").value);
});
const initial=new URLSearchParams(location.search).get("codigo");
if(initial){ $("#trackingCode").value=initial; track(initial); }
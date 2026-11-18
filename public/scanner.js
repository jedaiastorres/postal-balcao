"use strict";
const $=id=>document.getElementById(id);
let csrf="",stream=null,active=false,scanKey=crypto.randomUUID(),lastCode="";
const text=(element,value)=>{element.textContent=String(value||"");};
function notice(message,ok=false){const el=$("status");text(el,message);el.className="status"+(ok?" success":"");}
function codeValue(){return $("trackingCode").value.trim();}
function resetScanKey(){scanKey=crypto.randomUUID();}
function extractCode(raw){
  const value=String(raw||"").trim();
  if(/^[A-Za-z0-9]{6,40}$/.test(value))return value;
  try{
    const url=new URL(value);
    if(url.protocol!=="https:"&&url.protocol!=="http:")return "";
    const code=url.searchParams.get("codigo")||url.searchParams.get("tracking")||url.searchParams.get("stamp")||url.searchParams.get("code");
    return /^[A-Za-z0-9]{6,40}$/.test(code||"")?code:"";
  }catch{return "";}
}
async function api(path,options={}){
  const response=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});
  let data={};try{data=await response.json();}catch{}
  if(!response.ok)throw new Error(data.error||"Falha na consulta operacional.");
  return data;
}
async function boot(){
  try{
    const session=await api("/api/ops/scanner-session");csrf=session.csrfToken;
    $("auth").classList.add("hidden");$("work").classList.remove("hidden");
  }catch(error){
    $("auth").replaceChildren();text($("auth"),error.message+" Entre no painel com uma conta operacional da Postal Serviços. ");
    const link=document.createElement("a");link.href="/";link.textContent="Entrar no painel";$("auth").append(link);
  }
}
async function loadHistory(){
  const code=codeValue();if(!/^[A-Za-z0-9]{6,40}$/.test(code))return notice("Informe um código de rastreio válido.");
  try{
    const data=await api("/api/ops/scans/"+encodeURIComponent(code));
    const host=$("history");host.replaceChildren();
    text($("carrier"),data.carrier+(data.paymentConfirmed?" · Envio pago":" · Pagamento não confirmado"));
    if(!data.scans.length){const li=document.createElement("li");li.textContent="Nenhuma etapa interna registrada. Inicie pelo recebimento no ponto.";host.append(li);}
    for(const scan of data.scans){
      const li=document.createElement("li"),name=document.createElement("strong"),date=document.createElement("span");
      text(name,scan.label);text(date,new Date(scan.createdAt).toLocaleString("pt-BR"));li.append(name,date);host.append(li);
    }
    const stages=["RECEIVED_POINT","TRANSFERRED","RECEIVED_HUB","OUT_FOR_DELIVERY","DELIVERY_RECORDED"];
    const last=data.scans.at(-1)?.stage;
    const next={RECEIVED_POINT:"TRANSFERRED",TRANSFERRED:"RECEIVED_HUB",RECEIVED_HUB:"OUT_FOR_DELIVERY",OUT_FOR_DELIVERY:"DELIVERY_RECORDED"};
    $("stage").value=next[last]||(!last?stages[0]:last);
    $("recipientWrap").classList.toggle("hidden",$("stage").value!=="DELIVERY_RECORDED");
    notice("Histórico consultado.",true);
  }catch(error){notice(error.message);}
}
$("search").addEventListener("click",loadHistory);
$("trackingCode").addEventListener("input",()=>{if(lastCode!==codeValue()){lastCode=codeValue();resetScanKey();}});
$("stage").addEventListener("change",()=>{resetScanKey();$("recipientWrap").classList.toggle("hidden",$("stage").value!=="DELIVERY_RECORDED");});
$("recipientName").addEventListener("input",resetScanKey);
$("record").addEventListener("click",async()=>{
  const code=codeValue();if(!/^[A-Za-z0-9]{6,40}$/.test(code))return notice("Leia um código válido antes de registrar.");
  const button=$("record");button.disabled=true;
  try{
    const data=await api("/api/ops/scans",{method:"POST",headers:{"Content-Type":"application/json","x-csrf-token":csrf},
      body:JSON.stringify({trackingCode:code,stage:$("stage").value,recipientName:$("recipientName").value,idempotencyKey:scanKey})});
    notice(data.replayed?"Leitura anterior já registrada.":data.label+" registrado com sucesso.",true);
    resetScanKey();await loadHistory();
  }catch(error){notice(error.message+" Se a conexão falhou, tente novamente para recuperar a mesma leitura.");}
  finally{button.disabled=false;}
});

async function stopCamera(){
  active=false;if(stream){for(const track of stream.getTracks())track.stop();stream=null;}
  $("camera").srcObject=null;$("camera").classList.add("hidden");$("closeCamera").classList.add("hidden");
}
$("openCamera").addEventListener("click",async()=>{
  if(!navigator.mediaDevices?.getUserMedia||typeof BarcodeDetector==="undefined")return notice("Leitura por câmera indisponível neste navegador. Digite o código manualmente.");
  try{
    const formats=await BarcodeDetector.getSupportedFormats();
    const requested=["qr_code","code_128","ean_13"].filter(x=>formats.includes(x));
    if(!requested.length)throw new Error("Leitor de QR Code ou código de barras não suportado.");
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    const video=$("camera");video.srcObject=stream;video.classList.remove("hidden");await video.play();
    $("closeCamera").classList.remove("hidden");active=true;
    const detector=new BarcodeDetector({formats:requested});
    const loop=async()=>{
      if(!active)return;
      try{
        for(const result of await detector.detect(video)){
          const code=extractCode(result.rawValue);
          if(code){$("trackingCode").value=code;lastCode=code;resetScanKey();await stopCamera();await loadHistory();return;}
        }
      }catch{}
      if(active)setTimeout(loop,300);
    };loop();
  }catch(error){await stopCamera();notice("Não foi possível abrir a câmera: "+error.message);}
});
$("closeCamera").addEventListener("click",stopCamera);
addEventListener("pagehide",stopCamera);
boot();

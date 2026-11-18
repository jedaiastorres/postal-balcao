"use strict";
const $=id=>document.getElementById(id);
const money=value=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value)||0);
const cep=value=>String(value||"").replace(/(\d{5})(\d{3})/,"$1-$2");
const token=new URLSearchParams(location.search).get("c")||"";
async function load(){
  if(!/^[A-Za-z0-9_-]{32}$/.test(token)){
    throw new Error("Este link é inválido. Peça uma nova cotação à Postal Serviços.");
  }
  const response=await fetch("/api/public/quotes/"+encodeURIComponent(token),{credentials:"omit",cache:"no-store"});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||"Cotação temporariamente indisponível.");
  const quote=data.quote||{};
  $("origin").textContent=cep(quote.originCep);
  $("destination").textContent=cep(quote.destinationCep);
  $("volumes").textContent=String(quote.volumeCount||1);
  const host=$("options");
  host.replaceChildren();
  (quote.options||[]).forEach((option,index)=>{
    const article=document.createElement("article");article.className="option";
    const brand=document.createElement("div");
    const name=document.createElement("strong");name.className="carrier";name.textContent=String(option.carrier||"Transportadora");
    const service=document.createElement("span");service.className="service";service.textContent=String(option.service||"Serviço de envio");
    brand.append(name,service);
    if(index===0){const badge=document.createElement("span");badge.className="pill";badge.textContent="Menor preço";brand.append(badge);}
    const deadline=document.createElement("div");
    const dlabel=document.createElement("span");dlabel.className="label";dlabel.textContent="Prazo estimado";
    const days=document.createElement("strong");days.className="value";days.textContent=option.deadline==null?"A confirmar":String(option.deadline)+" dias";
    deadline.append(dlabel,days);
    const price=document.createElement("div");
    const plabel=document.createElement("span");plabel.className="label";plabel.textContent="Valor do frete";
    const amount=document.createElement("strong");amount.className="price";amount.textContent=money(option.price);
    price.append(plabel,amount);
    article.append(brand,deadline,price);host.append(article);
  });
  const until=new Date(quote.expiresAt).toLocaleString("pt-BR");
  $("disclaimer").textContent=(quote.demo?"Valores demonstrativos. ":"")+
    "Consulta gerada para referência. Link disponível até "+until+
    ". Valores e disponibilidade podem mudar; confirme o preço e o prazo na nova cotação antes de pagar ou postar. Esta página não autoriza a emissão de etiqueta.";
  $("loading").classList.add("hidden");$("result").classList.remove("hidden");
}
$("copyLink").addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText(location.href);$("copyLink").textContent="Link copiado!";}
  catch{$("copyLink").textContent="Use a barra de endereços para copiar";}
});
load().catch(error=>{
  $("loading").classList.add("hidden");
  $("error").textContent=error.message||"Não foi possível exibir a cotação.";
  $("error").classList.remove("hidden");
});

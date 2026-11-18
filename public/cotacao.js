"use strict";
const $=id=>document.getElementById(id);
const money=value=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value)||0);
const numbers=value=>String(value||"").replace(/\D/g,"");
let volumes=0;
let latest=null;

function showStatus(message,positive=false){
  const element=$("status");element.textContent=message;element.className="message"+(positive?" success":"");
}
function addVolume(){
  if(volumes>=3)return;
  volumes++;
  const card=document.createElement("section");card.className="volume-card";card.dataset.volume=String(volumes);
  const heading=document.createElement("div");heading.className="volume-head";
  const strong=document.createElement("strong");strong.textContent=`Volume ${volumes}`;
  const remove=document.createElement("button");remove.type="button";remove.className="secondary";remove.textContent="Remover";
  remove.hidden=volumes===1;
  remove.addEventListener("click",()=>{card.remove();recount();});
  heading.append(strong,remove);
  const fields=document.createElement("div");fields.className="volume-grid";
  for(const [key,label,value,step] of [["peso","Peso (kg)","1","0.01"],["comprimento","Comp. (cm)","20","0.1"],["largura","Larg. (cm)","15","0.1"],["altura","Altura (cm)","10","0.1"],["vlDeclarado","Valor (R$)","100","0.01"]]){
    const wrap=document.createElement("label"),span=document.createElement("span"),input=document.createElement("input");
    span.textContent=label;input.name=key;input.type="number";input.min=key==="vlDeclarado"?"0":key==="peso"?"0.01":"1";input.max=key==="peso"?"30":key==="vlDeclarado"?"50000":"200";input.step=step;input.value=value;input.required=true;
    wrap.append(span,input);fields.append(wrap);
  }
  card.append(heading,fields);$("volumes").append(card);
  $("addVolume").disabled=volumes>=3;
}
function recount(){
  const cards=[...$("volumes").querySelectorAll(".volume-card")];
  volumes=cards.length;
  cards.forEach((card,index)=>{card.dataset.volume=String(index+1);card.querySelector("strong").textContent=`Volume ${index+1}`;card.querySelector("button").hidden=index===0;});
  $("addVolume").disabled=volumes>=3;
  latest=null;$("resultPanel").classList.add("hidden");
}
$("addVolume").addEventListener("click",addVolume);
addVolume();
for(const id of ["cepOrigem","cepDestino"]){
  $(id).addEventListener("input",event=>{
    const raw=numbers(event.target.value).slice(0,8);
    event.target.value=raw.length>5?raw.slice(0,5)+"-"+raw.slice(5):raw;
  });
}
$("quoteForm").addEventListener("input",()=>{$("resultPanel").classList.add("hidden");latest=null;});

$("quoteForm").addEventListener("submit",async event=>{
  event.preventDefault();
  const btn=$("calculate");btn.disabled=true;btn.textContent="Consultando transportadoras...";
  $("resultPanel").classList.add("hidden");
  try{
    const payload={cepOrigem:numbers($("cepOrigem").value),cepDestino:numbers($("cepDestino").value),volumes:[]};
    for(const card of $("volumes").querySelectorAll(".volume-card")){
      const volume={};for(const input of card.querySelectorAll("input"))volume[input.name]=Number(input.value);
      payload.volumes.push(volume);
    }
    if(payload.cepOrigem.length!==8||payload.cepDestino.length!==8)throw new Error("Informe CEPs válidos, com 8 dígitos.");
    showStatus("Consultando preços e prazos em tempo real...");
    const response=await fetch("/api/public/cotacao",{method:"POST",credentials:"omit",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"Não foi possível consultar o frete.");
    latest=data;const host=$("results");host.replaceChildren();
    for(const option of data.options||[]){
      const row=document.createElement("article");row.className="result";
      const name=document.createElement("div"),brand=document.createElement("strong"),service=document.createElement("span");
      brand.className="carrier";brand.textContent=option.carrier;service.className="service";service.textContent=option.service;name.append(brand,service);
      const deadline=document.createElement("div"),deadlineLabel=document.createElement("span"),deadlineValue=document.createElement("strong");
      deadlineLabel.className="metric";deadlineLabel.textContent="Prazo estimado";deadlineValue.textContent=option.deadline==null?"A confirmar":option.deadline+" dias";deadline.append(deadlineLabel,deadlineValue);
      const price=document.createElement("div"),priceLabel=document.createElement("span"),priceValue=document.createElement("strong");
      priceLabel.className="metric";priceLabel.textContent="Valor do frete";priceValue.className="price";priceValue.textContent=money(option.price);price.append(priceLabel,priceValue);
      row.append(name,deadline,price);host.append(row);
    }
    $("resultsTitle").textContent=`${data.options.length} opção(ões) para ${data.volumeCount} volume(s)`;
    $("resultPanel").classList.remove("hidden");showStatus("Cotação concluída! Compare abaixo.",true);
    $("resultPanel").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(error){showStatus(error.message||"Erro temporário na cotação.");}
  finally{btn.disabled=false;btn.textContent="Calcular frete grátis";}
});

$("share").addEventListener("click",async()=>{
  if(!latest)return;
  const lines=["Cotação Postal Serviços",`Origem: ${latest.originCep} | Destino: ${latest.destinationCep}`,`Volumes: ${latest.volumeCount}`,
    ...(latest.options||[]).map(item=>`${item.carrier} · ${item.service}: ${money(item.price)} · ${item.deadline??"A confirmar"} dias`),
    "Valores e prazos sujeitos a confirmação no momento da contratação.","Faça sua própria cotação: "+location.origin+"/cotacao"];
  const text=lines.join("\n");
  try{if(navigator.share)await navigator.share({title:"Cotação Postal Serviços",text});else await navigator.clipboard.writeText(text);showStatus("Cotação pronta para compartilhar.",true);}
  catch(error){if(error.name!=="AbortError")showStatus("Não foi possível compartilhar. Tente copiar o texto novamente.");}
});

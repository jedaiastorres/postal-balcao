"use strict";
const input=document.getElementById("search"),list=document.getElementById("list"),counter=document.getElementById("count");
let points=[],position=null;
const normalize=value=>String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const locationText=p=>{
  const a=p.address||{};
  return [
    [a.street,a.number].filter(Boolean).join(", "),
    a.neighborhood,
    [a.city,a.state].filter(Boolean).join("/"),
    a.cep
  ].filter(Boolean).join(" · ");
};
function distance(lat1,lon1,lat2,lon2){
  const deg=Math.PI/180,dlat=(lat2-lat1)*deg,dlon=(lon2-lon1)*deg;
  const a=Math.sin(dlat/2)**2+Math.cos(lat1*deg)*Math.cos(lat2*deg)*Math.sin(dlon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function render(){
  const q=normalize(input.value).trim();
  const visible=points.filter(p=>
    normalize([p.name,p.code,locationText(p)].join(" ")).includes(q)||
    (/^[0-9-]+$/.test(q)&&String(p.address?.cep||"").replace(/\D/g,"").includes(q.replace(/\D/g,"")))
  );
  if(position)visible.sort((a,b)=>{
    const da=a.latitude!=null&&a.longitude!=null?distance(position.lat,position.lon,a.latitude,a.longitude):Infinity;
    const db=b.latitude!=null&&b.longitude!=null?distance(position.lat,position.lon,b.latitude,b.longitude):Infinity;
    return da-db;
  });
  counter.textContent=visible.length+" ponto(s) encontrado(s)"+(position?" · ordenados por proximidade quando possível":"");
  list.replaceChildren();
  if(!visible.length){
    const empty=document.createElement("p");empty.className="message";empty.textContent="Nenhum ponto encontrado com esse filtro. Experimente outra cidade ou bairro.";
    list.append(empty);return;
  }
  visible.forEach(p=>{
    const card=document.createElement("article");card.className="card";
    const name=document.createElement("h2");name.textContent=p.name||"Ponto Postal";
    const address=document.createElement("p");address.className="address";address.textContent=locationText(p)||"Endereço ainda não informado";
    const badges=document.createElement("div");badges.className="badges";
    const tag=document.createElement("span");tag.className="badge";tag.textContent="Ponto da Rede Postal";
    badges.append(tag);
    if(p.pickupEnabled){const pickup=document.createElement("span");pickup.className="badge muted";pickup.textContent="Coletas habilitadas";badges.append(pickup);}
    const actions=document.createElement("div");actions.className="actions";
    const full=locationText(p);
    if(full){
      const map=document.createElement("a");
      map.href="https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(full);
      map.target="_blank";map.rel="noopener noreferrer";map.textContent="Ver localização no mapa";actions.append(map);
    }
    if(position&&p.latitude!=null&&p.longitude!=null){
      const km=document.createElement("small");
      km.textContent=distance(position.lat,position.lon,p.latitude,p.longitude).toLocaleString("pt-BR",{maximumFractionDigits:1})+" km em linha reta";
      actions.append(km);
    }
    card.append(name,address,badges,actions);list.append(card);
  });
}
input.addEventListener("input",render);
document.getElementById("clear").addEventListener("click",()=>{input.value="";position=null;render();});
document.getElementById("nearby").addEventListener("click",()=>{
  if(!navigator.geolocation){counter.textContent="Este navegador não permite consultar a localização.";return;}
  const button=document.getElementById("nearby");button.disabled=true;
  navigator.geolocation.getCurrentPosition(pos=>{
    position={lat:pos.coords.latitude,lon:pos.coords.longitude};button.disabled=false;render();
  },()=>{button.disabled=false;counter.textContent="Localização não autorizada. A busca por cidade e CEP continua disponível.";},
  {enableHighAccuracy:false,timeout:12000,maximumAge:300000});
});
fetch("/api/public/points",{cache:"no-store",credentials:"omit"}).then(async response=>{
  const result=await response.json();
  if(!response.ok)throw Error(result.error||"Pontos temporariamente indisponíveis.");
  points=result.points||[];render();
}).catch(error=>{counter.textContent=error.message;});

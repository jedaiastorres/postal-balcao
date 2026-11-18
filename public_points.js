"use strict";

function validCoordinate(value,min,max){
  if(value==null||value==="")return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>=min&&number<=max?number:null;
}

function sanitizePoint(store){
  const raw=store?.address&&typeof store.address==="object"&&!Array.isArray(store.address)?store.address:{};
  const value=(...keys)=>{
    for(const key of keys){
      const field=String(raw[key]||"").trim();
      if(field)return field.slice(0,140);
    }
    return "";
  };
  return {
    name:String(store.name||"Ponto Postal").slice(0,120),
    code:String(store.code||"").slice(0,40),
    address:{
      street:value("address","street","logradouro","rua"),
      number:value("number","numero"),
      neighborhood:value("neighborhood","bairro"),
      city:value("city","cidade"),
      state:value("uf","state","estado"),
      cep:value("cep","zip")
    },
    pickupEnabled:Boolean(store.pickup_enabled),
    latitude:validCoordinate(store.latitude,-90,90),
    longitude:validCoordinate(store.longitude,-180,180)
  };
}

// Não publique cadastros de teste ou unidades sem endereço suficiente para
// orientar um cliente até o local. Não apaga nem altera o cadastro interno.
function isPublishablePoint(point){
  const name=String(point?.name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  if(/\b(teste|test|demo|homologacao|exemplo|sandbox|mock)\b/i.test(name))return false;
  const address=point?.address||{};
  return Boolean(String(address.street||"").trim()&&String(address.city||"").trim()&&String(address.state||"").trim());
}

module.exports={sanitizePoint,isPublishablePoint};

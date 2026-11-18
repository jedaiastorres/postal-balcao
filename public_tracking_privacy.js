"use strict";

function maskName(value){
  return String(value||"").trim().split(/\s+/).filter(Boolean)
    .map(word=>word.charAt(0)+"***").join(" ");
}

function publicParty(value){
  const party=value&&typeof value==="object"?value:{};
  return {
    name:maskName(party.name),
    city:String(party.city||"").slice(0,120),
    cep:""
  };
}

function publicRoute(value){
  const party=value&&typeof value==="object"?value:{};
  return {city:String(party.city||"").slice(0,120),cep:""};
}

function publicPackage(packageData){
  const pkg=packageData&&typeof packageData==="object"?packageData:{};
  return {
    volumeCount:Number(pkg.volumeCount||1),
    weightKg:Number(pkg.weightKg||0),
    declaredValue:null,
    volumes:Array.isArray(pkg.volumes)?pkg.volumes.map(v=>({
      index:v.index,weightKg:v.weightKg,dimensions:v.dimensions,declaredValue:null
    })):[]
  };
}

module.exports={maskName,publicParty,publicRoute,publicPackage};

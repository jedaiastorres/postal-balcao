const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

test("public quote and point pages load scripts allowed by the production CSP",()=>{
  for(const name of ["pontos","cotacao-compartilhada","cotacao","scanner","rastreio"]){
    const html=fs.readFileSync(path.resolve(__dirname,"../public",name+".html"),"utf8");
    const js=fs.readFileSync(path.resolve(__dirname,"../public",name+".js"),"utf8");
    assert.match(html,new RegExp('<script src="/'+name+'\\.js" defer></script>'));
    assert.doesNotMatch(html,/<script\s*>/i);
    assert.doesNotThrow(()=>new vm.Script(js,{filename:name+".js"}));
  }
});

test("tracking and point finder show Postal identity, partner logos and verified company contact",()=>{
  for(const name of ["rastreio","pontos"]){
    const html=fs.readFileSync(path.resolve(__dirname,"../public",name+".html"),"utf8");
    assert.match(html,/assets\/brands\/postal\.svg/);
    assert.match(html,/5594991683301/);
    assert.match(html,/31\.306\.215\/0001-69/);
  }
  const pointsPage=fs.readFileSync(path.resolve(__dirname,"../public/pontos.html"),"utf8");
  assert.doesNotMatch(pointsPage,/TRANSPORTADORAS DA REDE DE COTAÇÃO/);
  const trackingPage=fs.readFileSync(path.resolve(__dirname,"../public/rastreio.html"),"utf8");
  for(const asset of ["loggi.svg","jadlog.svg","azul-cargo.png","correios.svg"]){
    assert.ok(trackingPage.includes("/assets/brands/"+asset));
  }
  const tracking=fs.readFileSync(path.resolve(__dirname,"../public/rastreio.js"),"utf8");
  assert.match(tracking,/PostalBrand\?\.carrierLogo\(name\)/);
  assert.match(tracking,/showCarrier\(data\.carrier\)/);
  const server=fs.readFileSync(path.resolve(__dirname,"../server.js"),"utf8");
  assert.match(server,/points:stores\.map\(publicPoints\.sanitizePoint\)\.filter\(publicPoints\.isPublishablePoint\)/);
});

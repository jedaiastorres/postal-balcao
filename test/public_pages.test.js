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
    assert.match(html,/assets\/brands\/loggi\.svg/);
    assert.match(html,/assets\/brands\/jadlog\.svg/);
    assert.match(html,/assets\/brands\/azul-cargo\.png/);
    assert.match(html,/assets\/brands\/correios\.svg/);
    assert.match(html,/5594991683301/);
    assert.match(html,/31\.306\.215\/0001-69/);
  }
  const tracking=fs.readFileSync(path.resolve(__dirname,"../public/rastreio.js"),"utf8");
  assert.match(tracking,/PostalBrand\?\.carrierLogo\(name\)/);
  assert.match(tracking,/showCarrier\(data\.carrier\)/);
  const server=fs.readFileSync(path.resolve(__dirname,"../server.js"),"utf8");
  assert.match(server,/points:stores\.map\(publicPoints\.sanitizePoint\)\.filter\(publicPoints\.isPublishablePoint\)/);
});

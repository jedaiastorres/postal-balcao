"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const read=path=>fs.readFileSync(require.resolve("../"+path),"utf8");
const html=read("public/white-label.html");
const js=read("public/white-label.js");
const css=read("public/white-label.css");
const brandScript=read("public/branding.js");

function logosContext(logoUrl=""){
  const globalThis={};
  vm.runInNewContext(brandScript,{globalThis},{timeout:2000});
  const state={brand:{name:"André Silva",logoUrl}};
  const esc=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
  const helpers=[
    js.match(/function quoteCarrierLogo\(option\)\{[\s\S]*?\n\}/)?.[0],
    js.match(/function quoteCarrierMark\(option\)\{[\s\S]*?\n\}/)?.[0]
  ];
  assert.ok(helpers.every(Boolean),"funções de logos foram removidas");
  const ctx={globalThis,state,esc};
  vm.runInNewContext(helpers.join("\n")+"\nthis.logo=quoteCarrierLogo;this.mark=quoteCarrierMark;",ctx,{timeout:2000});
  return ctx;
}
test("White Label carrega branding.js antes do script do portal",()=>{
  const first=html.indexOf('<script defer src="/branding.js"></script>');
  const second=html.indexOf('<script defer src="/white-label.js?v=1.3.2"></script>');
  assert.ok(first>=0 && second>first);
  new vm.Script(js);
  new vm.Script(brandScript);
});
test("logomarcas integradas usam os mesmos arquivos locais do Postal Balcão",()=>{
  const ctx=logosContext();
  for(const [name,path] of [
    ["Loggi","/assets/brands/loggi.svg"],["Jadlog","/assets/brands/jadlog.svg"],
    ["Correios","/assets/brands/correios.svg"],["Azul Cargo","/assets/brands/azul-cargo.png"],
    ["FedEx","/assets/brands/fedex.svg"],["DHL","/assets/brands/dhl.svg"],
    ["UPS","/assets/brands/ups.svg"]]){
    assert.equal(ctx.logo({source:"INTEGRATED",carrier:name}),path,name);
    const markup=ctx.mark({source:"INTEGRATED",carrier:name});
    assert.match(markup,/class="wl-quote-carrier-logo"/);
    assert.ok(markup.includes(path));
  }
});
test("rota própria usa marca White Label; sem imagem externa da transportadora integrada",()=>{
  const ctx=logosContext("https://cdn.example.org/marca.png");
  assert.equal(ctx.logo({source:"OWN",carrier:"André Silva"}),"https://cdn.example.org/marca.png");
  assert.equal(ctx.logo({source:"INTEGRATED",carrier:"Transportadora desconhecida",logoUrl:"https://evil.test/track.svg"}),"");
  assert.equal(ctx.logo({source:"OWN",carrier:"André Silva",logoUrl:"javascript:alert(1)"}),"https://cdn.example.org/marca.png");
  assert.equal(logosContext("javascript:alert(1)").logo({source:"OWN"}),"");
});
test("sem logo conhecido, mostra iniciais em vez de imagem quebrada ou imagem incorreta",()=>{
  const ctx=logosContext();
  const markup=ctx.mark({source:"INTEGRATED",carrier:"Transportadora Regional"});
  assert.doesNotMatch(markup,/<img\s/);
  assert.match(markup,/wl-quote-carrier-fallback/);
  assert.match(markup,/>TR<\/span>/);
  assert.match(js,/activateQuoteLogoFallbacks\(\);/);
  assert.match(js,/img\.addEventListener\("error"/);
});
test("cartão mantém nome, serviço, prazo, valor e comissão ao lado da logo",()=>{
  assert.match(js,/quoteCarrierMark\(option\)/);
  assert.match(js,/class="wl-quote-carrier-profile"/);
  assert.match(js,/'<strong>'\+carrier\+'<\/strong><span>'\+service/);
  assert.match(js,/money\(option\.total\)/);
  assert.match(js,/option\.partnerShare/);
  assert.match(css,/\.wl-quote-carrier-logo\{[\s\S]*?width:100px;height:40px/);
  assert.match(css,/@media\(max-width:580px\)/);
  assert.doesNotMatch(html+js,/ConectEnvios/i);
});

"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const read=name=>fs.readFileSync(require.resolve("../"+name),"utf8");
const html=read("public/white-label.html"),css=read("public/white-label.css"),js=read("public/white-label.js");

test("White Label compartilha layout, estilos e navegação do Postal Balcão",()=>{
  assert.match(html, /href="\/styles\.css\?v=1\.19\.0"/);
  assert.match(html, /id="dashboard" class="app-shell hidden"/);
  assert.match(html, /id="wlNavigation" class="sidebar"/);
  assert.match(html, /class="main wl-main"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="view wl-content"/);
  assert.match(html, /class="login-card wl-login-card"/);
  assert.match(html, /class="page-kicker" id="headerBrandTitle"/);
  assert.match(css, /#dashboard \.nav-item\.active\{background:var\(--brand\)/);
  assert.match(css, /#dashboard \.sidebar\{/);
  assert.match(css, /\.wl-content \.card\{/);
});
test("todas as telas e formulários existentes permanecem navegáveis e os IDs são únicos",()=>{
  const tabs=[...html.matchAll(/data-tab="([a-z]+)"/g)].map(match=>match[1]);
  const panels=[...html.matchAll(/data-panel="([a-z]+)"/g)].map(match=>match[1]);
  assert.equal(tabs.length,8);
  assert.deepEqual(new Set(tabs),new Set(["overview","points","tariffs","quotes","collections","users","brand","finance"]));
  assert.deepEqual(new Set(tabs),new Set(panels));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(ids.length,new Set(ids).size,"há ids HTML duplicados");
  for(const id of ["loginForm","passwordForm","quoteForm","pointForm","tariffForm",
    "userForm","brandForm","quoteResults","brandPreview","walletStatus","wlCollectionForm","wlCollectionsList"])
    assert.ok(ids.includes(id),"faltou "+id);
});
test("marca é aplicada ao login, sidebar e topbar, sem confundir transportadoras",()=>{
  for(const id of ["brandLogo","brandTitle","brandIcon","loginBrandLogo","loginBrandIcon",
    "loginBrandTitle","headerBrandTitle"])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/for\(const \[imgId,iconId\] of \[\["brandLogo","brandIcon"\],\["loginBrandLogo","loginBrandIcon"\]\]\)/);
  assert.match(js,/document\.documentElement\.style\.setProperty\("--brand"/);
  assert.match(js,/document\.documentElement\.style\.setProperty\("--on-brand"/);
  assert.doesNotMatch(html,/Postal Serviços|ConectEnvios/i);
});
test("menu mobile abre, fecha ao navegar ou ESC e respeita permissões MASTER",()=>{
  assert.match(html,/id="wlMobileMenu"/);
  assert.match(html,/id="wlBackdrop"/);
  assert.match(css,/@media\(max-width:820px\)/);
  assert.match(css,/#dashboard \.sidebar\.open\{transform:translateX\(0\)/);
  assert.match(js,/function closeMobileMenu\(\)/);
  assert.match(js,/event\.key==="Escape"/);
  assert.match(js,/btn\.setAttribute\("aria-current","page"\)/);
  assert.match(js,/\["users","finance","points"\]\.includes\(name\)/);
  assert.match(js,/account\.role!=="WL_MASTER"/);
});
test("nova estrutura não mexe no contrato de APIs, fretes e pagamentos",()=>{
  assert.match(js,/api\("\/api\/wl\/quote\?"/);
  assert.match(js,/api\("\/api\/wl\/session"/);
  assert.match(js,/api\("\/api\/wl\/routes"/);
  assert.match(html,/Transações financeiras desativadas/);
  new vm.Script(js);
});

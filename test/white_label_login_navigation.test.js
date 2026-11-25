"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const src=fs.readFileSync(require.resolve("../public/white-label.js"),"utf8");

function mockDom(){
  const elements=new Map();
  const buttons=["overview","points","tariffs","quotes","collections","clients","network","users","brand","finance"];
  function element(id){
    if(!elements.has(id)){
      const set=new Set(id==="dashboard"?["hidden"]:id==="loginShell"?[]:["hidden"]);
      const listeners={};
      const node={
        id,dataset:{},textContent:"",innerHTML:"",value:"",style:{},
        disabled:false,checked:false,attributes:{},
        classList:{
          add(name){set.add(name);},remove(name){set.delete(name);},
          contains(name){return set.has(name);},toggle(name,force){
            if(force===undefined){if(set.has(name))set.delete(name);else set.add(name);}
            else if(force)set.add(name);else set.delete(name);
          }
        },
        setAttribute(key,value){this.attributes[key]=String(value);},
        removeAttribute(key){delete this.attributes[key];},
        removeAttribute(){},addEventListener(type,fn){listeners[type]=fn;},
        trigger(type,ev){return listeners[type]?.(ev);},
        scrollIntoView(){},querySelector(){return element("button")},
        reset(){},select(){},appendChild(){},remove(){},
      };
      node._listeners=listeners;
      elements.set(id,node);
    }
    return elements.get(id);
  }
  const tabs=buttons.map(id=>{const node=element("tab-"+id);node.dataset.tab=id;return node;});
  const panels=buttons.map(id=>{const node=element("panel-"+id);node.dataset.panel=id;return node;});
  const document={
    documentElement:{style:{setProperty(){}}},
    querySelector(selector){return element(selector);},
    querySelectorAll(selector){
      if(selector===".tab")return tabs;
      if(selector===".tab-panel")return panels;
      if(selector===".master-only")return [tabs[1],tabs[2],tabs[3]];
      return [];
    },
    addEventListener(){},
  };
  return {elements,element,tabs,panels,document};
}
test("navegação White Label não usa querySelector singular em um forEach",()=>{
  assert.doesNotMatch(src,/(?<!\$)\$\("[^"]+"\)\.forEach/);
  assert.match(src,/\$\$\("\.tab"\)\.forEach\(btn=>btn\.addEventListener/);
  assert.match(src,/\$\$\("\.tab-panel"\)\.forEach/);
  assert.match(src,/\$\$\("#pointsList \[data-edit-point\]"\)\.forEach/);
});
test("login aceito abre dashboard e habilita navegação sem erro de JavaScript",async()=>{
  const {document,element,tabs,panels}=mockDom();
  element("#dashboard").classList.add("hidden");
  const calls=[];
  const responses={
    "/api/wl/public/MARABAANDRE":{brand:{code:"MARABAANDRE",name:"Transportadora Teste",baseCity:"Marabá",baseState:"PA",primary:"#d7083b",secondary:"#222638",logoUrl:""}},
    "/api/wl/login":{ok:true,csrf:"fake-csrf",account:{id:"test",email:"teste@example.com",role:"WL_MASTER",mustChangePassword:false}},
    "/api/wl/session":{ok:true,finance:{walletConfigured:false},csrf:"fake-csrf",
      account:{id:"test",email:"teste@example.com",role:"WL_MASTER",mustChangePassword:false}},
    "/api/wl/routes":{routes:[]},
    "/api/wl/points":{points:[]},
    "/api/wl/users":{users:[]},
    "/api/wl/collections":{collections:[]},
    "/api/wl/clients":{clients:[]}
  };
  const win={scrollTo(){},addEventListener(){},innerWidth:1300};
  const context={
    document,window:win,location:{pathname:"/wl/MARABAANDRE",href:"https://example.test/wl/MARABAANDRE"},
    console,Intl,URLSearchParams,
    fetch:async url=>{
      calls.push(url);
      const data=responses[url];
      return {ok:Boolean(data),json:async()=>data||{error:"Not found"}};
    },
    navigator:{clipboard:{writeText:async()=>{}}},
    alert(){},confirm(){return false;},setTimeout,clearTimeout,
    URL,
  };
  vm.runInNewContext(src,context,{timeout:2000});
  await new Promise(resolve=>setImmediate(resolve));
  // Inputs preenchidos pelo usuário, mas o teste não usa dados reais.
  element("#loginEmail").value="teste@example.com";
  element("#loginPassword").value="senha-ficticia";
  const event={preventDefault(){},currentTarget:{querySelector(){return element("#loginSubmitBtn");}}};
  const submit=element("#loginForm")._listeners.submit;
  assert.equal(typeof submit,"function","o formulário precisa registrar evento de login");
  await submit(event);
  assert.ok(element("#loginShell").classList.contains("hidden"),"login deve desaparecer");
  assert.ok(!element("#dashboard").classList.contains("hidden"),"dashboard precisa abrir");
  assert.ok(tabs.find(v=>v.dataset.tab==="overview").classList.contains("active"));
  assert.ok(!panels.find(v=>v.dataset.panel==="overview").classList.contains("hidden"));
  assert.equal(element("#wlPageTitle").textContent,"Dashboard");
  assert.ok(calls.includes("/api/wl/login"));
  tabs.find(v=>v.dataset.tab==="quotes").trigger("click");
  assert.equal(element("#wlPageTitle").textContent,"Simular Frete");
  tabs.find(v=>v.dataset.tab==="collections").trigger("click");
  assert.equal(element("#wlPageTitle").textContent,"Coletas");
});

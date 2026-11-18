const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

test("public quote and point pages load scripts allowed by the production CSP",()=>{
  for(const name of ["pontos","cotacao-compartilhada"]){
    const html=fs.readFileSync(path.resolve(__dirname,"../public",name+".html"),"utf8");
    const js=fs.readFileSync(path.resolve(__dirname,"../public",name+".js"),"utf8");
    assert.match(html,new RegExp('<script src="/'+name+'\\.js" defer></script>'));
    assert.doesNotMatch(html,/<script\s*>/i);
    assert.doesNotThrow(()=>new vm.Script(js,{filename:name+".js"}));
  }
});

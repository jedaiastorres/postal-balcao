"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {modules,draw}=require("../code39");

test("código Code 39 usa o rastreio da etiqueta com start/stop e margem disponível",()=>{
  const code="PS89AA11B23A9E45F88C1201";
  const bits=modules(code);
  assert.equal(bits.length,25 + code.length*13);
  assert.equal(bits[0],true);
  assert.equal(bits[bits.length-1],true);
  const bars=[];
  const result=draw({drawRectangle:rect=>bars.push(rect)},code,{x:19,y:67,width:245,height:45});
  assert.equal(result.moduleCount,bits.length);
  assert.ok(bars.length>30);
  assert.ok(bars.every(bar=>bar.x>=19&&bar.x+bar.width<=264.01&&bar.height===45));
  assert.throws(()=>modules("código-invalido"),/Código de rastreio inválido/);
});

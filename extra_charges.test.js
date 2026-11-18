const test = require("node:test");
const assert = require("node:assert/strict");
const {resolveExtraCharges} = require("./extra_charges");

test("custo avulso divide exatamente 90/10 e preserva centavos", () => {
  const [a,b] = resolveExtraCharges([{description:"Manuseio delicado",amount:"15,55"},{description:"Paletização",amount:1.01}]);
  assert.equal(a.totalPrice,15.55); assert.equal(a.pointRevenue,14);assert.equal(a.postalRevenue,1.55);
  assert.equal(b.pointRevenue,0.91);assert.equal(b.postalRevenue,0.10);
  assert.equal(a.pointRevenue+a.postalRevenue,a.totalPrice);
});
test("impede valores incorretos, quantidade excessiva e descrição vazia", () => {
  for (const value of [0,-1,1001,"1.001","abc",Infinity])
    assert.throws(()=>resolveExtraCharges([{description:"Manuseio",amount:value}]));
  assert.throws(()=>resolveExtraCharges(Array(9).fill({description:"Manuseio",amount:1})));
  assert.throws(()=>resolveExtraCharges([{description:"x",amount:1}]));
});

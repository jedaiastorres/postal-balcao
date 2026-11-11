"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCarrier, listEligibleCarriers, resolveCarrier } = require("../carrier_registry");
const carriers = [
  {id:"postal",name:"Postal Serviços",provider:"SSW",active:true,capabilities:["quote","track"],credentialRef:"secret/postal-ssw"},
  {id:"outra",name:"Outra Transportadora",provider:"SSW",active:true,capabilities:["track"],credentialRef:"secret/outra-ssw"},
  {id:"inativa",name:"Inativa",provider:"CUSTOM_API",active:false,capabilities:["quote"]}
];
test("two SSW carriers remain distinct", () => {
  assert.equal(resolveCarrier(carriers,"postal","quote").credentialRef,"secret/postal-ssw");
  assert.equal(resolveCarrier(carriers,"outra","track").credentialRef,"secret/outra-ssw");
  assert.notEqual(resolveCarrier(carriers,"postal","track").id,resolveCarrier(carriers,"outra","track").id);
});
test("inactive carriers and unsupported operations cannot be used", () => {
  assert.deepEqual(listEligibleCarriers(carriers,"quote").map(x=>x.id),["postal"]);
  assert.throws(()=>resolveCarrier(carriers,"outra","quote"));
  assert.throws(()=>resolveCarrier(carriers,"inativa","quote"));
});
test("reject invalid provider or capability", () => {
  assert.throws(()=>normalizeCarrier({id:"c1",name:"X",provider:"UNKNOWN"}));
  assert.throws(()=>normalizeCarrier({id:"c1",name:"X",provider:"SSW",capabilities:["deletePayments"]}));
});

const test=require('node:test');const assert=require('node:assert/strict');const rules=require('../public/point_rules');
test('collection pricing uses configured rates and rejects invalid counts and negative splits',()=>{
 assert.deepEqual(rules.collectionPricing(3,7.5,4),{packageCount:3,feePerPackage:7.5,pointRate:4,totalFee:22.5,pointCompensation:12,postalCompensation:10.5});
 for(const count of [0,-1,1.5,NaN,Infinity,201])assert.throws(()=>rules.collectionPricing(count,5,3));
 for(const rates of [[5,6],[NaN,3],[5,-1]])assert.throws(()=>rules.collectionPricing(1,...rates));
});
test('no earnings without confirmed first-mile payment; simulations stay simulated',()=>{
 const collection={total_fee:10};
 assert.equal(rules.earningStatus(collection,null),null);
 assert.equal(rules.earningStatus(collection,{payment_status:'PENDING',first_mile_fee:10}),null);
 assert.equal(rules.earningStatus(collection,{payment_status:'PAID',first_mile_fee:0}),null);
 assert.equal(rules.earningStatus(collection,{payment_status:'PAID',first_mile_fee:5}),null);
 assert.equal(rules.earningStatus(collection,{payment_status:'PAID',first_mile_fee:10,is_simulation:true}),'SIMULATED');
 assert.equal(rules.earningStatus(collection,{payment_status:'PAID',first_mile_fee:10}),'EARNED');
});
test('completed or canceled collections cannot regress or be reassigned',()=>{
 assert.ok(rules.canTransition('PICKUP','ASSIGNED','ACCEPTED'));
 assert.ok(!rules.canTransition('PICKUP','ASSIGNED','COLLECTED'));
 assert.ok(!rules.canTransition('PICKUP','CANCELED','COLLECTED'));
 assert.ok(!rules.canTransition('PICKUP','COLLECTED','ASSIGNED'));
 assert.ok(!rules.canReassign('COLLECTED'));
 assert.ok(!rules.canReassign('COMPLETED'));
 assert.ok(rules.canTransition('PICKUP','COLLECTED','COLLECTED'));
});

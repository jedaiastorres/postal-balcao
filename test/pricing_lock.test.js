"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {PGlite} = require("@electric-sql/pglite");
const {pricingLockSql} = require("../pricing_lock");

test("após emitir a etiqueta o banco bloqueia reajustes, novas cobranças e estornos silenciosos",async()=>{
  const db = new PGlite();
  const id="11111111-2222-4333-8444-555555555555";
  const addonId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    await db.exec(`
      CREATE TABLE freight_orders (
        id UUID PRIMARY KEY, status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
        shipped_at TIMESTAMPTZ, tracking_code TEXT, price_locked_at TIMESTAMPTZ,
        sale_price NUMERIC(12,2), payment_amount NUMERIC(12,2),
        postal_revenue_total NUMERIC(12,2), first_mile_fee NUMERIC(12,2)
      );
      CREATE TABLE order_addons (
        id UUID PRIMARY KEY,order_id UUID REFERENCES freight_orders(id),
        item_name TEXT,total_price NUMERIC(12,2)
      );
    `);
    await db.exec(pricingLockSql);
    await db.query("INSERT INTO freight_orders (id,sale_price,payment_amount) VALUES ($1,33.51,33.51)",[id]);
    await db.query("INSERT INTO order_addons VALUES ($1,$2,'Manuseio especial',5)",[addonId,id]);
    // Antes da postagem, o checkout ainda pode registrar taxas oficiais.
    await db.query("UPDATE freight_orders SET payment_amount=34.01 WHERE id=$1",[id]);
    await db.query("UPDATE freight_orders SET tracking_code='PSABCDE123456',status='LABEL_AVAILABLE' WHERE id=$1",[id]);
    const stored=await db.query("SELECT price_locked_at FROM freight_orders WHERE id=$1",[id]);
    assert.ok(stored.rows[0].price_locked_at,"a emissão deve gravar o lacre financeiro");

    await assert.rejects(db.query("UPDATE freight_orders SET sale_price=100 WHERE id=$1",[id]),/valores da postagem estão bloqueados/);
    await assert.rejects(db.query("UPDATE freight_orders SET first_mile_fee=1 WHERE id=$1",[id]),/valores da postagem estão bloqueados/);
    await assert.rejects(db.query("UPDATE freight_orders SET tracking_code=NULL WHERE id=$1",[id]),/identificação de um envio postado/);
    await assert.rejects(db.query("INSERT INTO order_addons VALUES ($1,$2,'Cobrança tardia',50)",["ffffffff-2222-4444-8888-555555555555",id]),/Não é permitido adicionar/);
    await assert.rejects(db.query("UPDATE order_addons SET total_price=90 WHERE id=$1",[addonId]),/Não é permitido adicionar/);
    await assert.rejects(db.query("DELETE FROM order_addons WHERE id=$1",[addonId]),/Não é permitido adicionar/);

    // Atualizações de rastreio/status continuam funcionando sem alterar valores.
    await db.query("UPDATE freight_orders SET status='DELIVERED' WHERE id=$1",[id]);
    await assert.rejects(db.query("UPDATE freight_orders SET payment_amount=999 WHERE id=$1",[id]),/valores da postagem estão bloqueados/);
    const after=await db.query("SELECT status,sale_price,payment_amount FROM freight_orders WHERE id=$1",[id]);
    assert.equal(after.rows[0].status,"DELIVERED");
    assert.equal(Number(after.rows[0].payment_amount),34.01);
    assert.equal(Number(after.rows[0].sale_price),33.51);
  } finally {await db.close();}
});

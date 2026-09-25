const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000
    })
  : null;

function requireDb() {
  if (!pool) {
    const err = new Error("Banco de dados ainda não configurado.");
    err.code = "DB_NOT_CONFIGURED";
    throw err;
  }
  return pool;
}

async function initDb() {
  if (!pool) {
    console.warn("DATABASE_URL ausente: pedidos e pagamentos persistentes estão desativados.");
    return false;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_accounts (
      email TEXT PRIMARY KEY,
      asaas_wallet_id TEXT,
      display_name TEXT,
      financial_status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS freight_orders (
      id UUID PRIMARY KEY,
      partner_email TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      payment_provider TEXT,
      payment_checkout_id TEXT,
      payment_checkout_url TEXT,
      payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_surcharge NUMERIC(12,2) NOT NULL DEFAULT 0,
      cash_remittance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,

      sale_price NUMERIC(12,2) NOT NULL,
      addons_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      customer_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      point_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      postal_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      provider_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      partner_commission NUMERIC(12,2) NOT NULL,
      postal_margin NUMERIC(12,2) NOT NULL,
      provider_cost NUMERIC(12,2) NOT NULL,

      postal_company_id INTEGER,
      carrier TEXT,
      service_name TEXT,
      deadline INTEGER,
      quote_token TEXT,

      sender JSONB NOT NULL,
      recipient JSONB NOT NULL,
      items JSONB NOT NULL,
      invoice_number TEXT,
      package_data JSONB NOT NULL,

      conect_cart_id TEXT,
      conect_package_id TEXT,
      tracking_code TEXT,
      label_a4_url TEXT,
      label_a6_url TEXT,
      declaration_url TEXT,
      public_tracking_url TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS freight_orders_partner_created_idx
      ON freight_orders(partner_email, created_at DESC);

    CREATE INDEX IF NOT EXISTS freight_orders_checkout_idx
      ON freight_orders(payment_checkout_id);

    CREATE TABLE IF NOT EXISTS catalog_items (
      id UUID PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('PRODUCT','SERVICE')),
      category TEXT NOT NULL DEFAULT 'OUTROS',
      name TEXT NOT NULL,
      description TEXT,
      unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      track_stock BOOLEAN NOT NULL DEFAULT FALSE,
      point_share_percent NUMERIC(6,3) NOT NULL DEFAULT 100,
      postal_share_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
      provider_share_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
      external_provider TEXT,
      external_ref TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS partner_inventory (
      partner_email TEXT NOT NULL,
      item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      reserved_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      min_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(partner_email,item_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id UUID PRIMARY KEY,
      partner_email TEXT NOT NULL,
      item_id UUID NOT NULL REFERENCES catalog_items(id),
      movement_type TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      note TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS inventory_movements_partner_idx
      ON inventory_movements(partner_email, created_at DESC);

    CREATE TABLE IF NOT EXISTS order_addons (
      id UUID PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES freight_orders(id) ON DELETE CASCADE,
      item_id UUID REFERENCES catalog_items(id),
      item_code TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL,
      point_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
      postal_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
      provider_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS order_addons_order_idx ON order_addons(order_id);

    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      checkout_id TEXT,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      processing_error TEXT
    );

    CREATE INDEX IF NOT EXISTS payment_webhook_pending_idx
      ON payment_webhook_events(provider, processed_at)
      WHERE processed_at IS NULL;
  `);

  await pool.query(`
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS addons_total NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS customer_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS point_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS postal_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS provider_revenue_total NUMERIC(12,2) NOT NULL DEFAULT 0;
  `);

  return true;
}

async function ensurePartner(email, displayName = null) {
  const db = requireDb();
  await db.query(
    `INSERT INTO partner_accounts(email, display_name)
     VALUES ($1,$2)
     ON CONFLICT (email) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, partner_accounts.display_name),
           updated_at = NOW()`,
    [email, displayName]
  );
  return getPartner(email);
}

async function getPartner(email) {
  const db = requireDb();
  const { rows } = await db.query(
    "SELECT * FROM partner_accounts WHERE email=$1 LIMIT 1",
    [email]
  );
  return rows[0] || null;
}

async function setPartnerWallet(email, walletId, status = "ACTIVE") {
  const db = requireDb();
  const { rows } = await db.query(
    `INSERT INTO partner_accounts(email, asaas_wallet_id, financial_status)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE
       SET asaas_wallet_id=EXCLUDED.asaas_wallet_id,
           financial_status=EXCLUDED.financial_status,
           updated_at=NOW()
     RETURNING *`,
    [email, walletId || null, status]
  );
  return rows[0];
}

async function insertOrder(order) {
  const db = requireDb();
  const { rows } = await db.query(
    `INSERT INTO freight_orders(
      id, partner_email, status, payment_method, payment_status, payment_provider,
      payment_amount, payment_surcharge, cash_remittance_amount,
      sale_price, addons_total, customer_subtotal,
      point_revenue_total, postal_revenue_total, provider_revenue_total,
      partner_commission, postal_margin, provider_cost,
      postal_company_id, carrier, service_name, deadline, quote_token,
      sender, recipient, items, invoice_number, package_data
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,
      $10,$11,$12,
      $13,$14,$15,
      $16,$17,$18,
      $19,$20,$21,$22,$23,
      $24::jsonb,$25::jsonb,$26::jsonb,$27,$28::jsonb
    )
    RETURNING *`,
    [
      order.id, order.partnerEmail, order.status, order.paymentMethod, order.paymentStatus, order.paymentProvider || null,
      order.paymentAmount || 0, order.paymentSurcharge || 0, order.cashRemittanceAmount || 0,
      order.salePrice, order.addonsTotal || 0, order.customerSubtotal || order.salePrice || 0,
      order.pointRevenueTotal || order.partnerCommission || 0,
      order.postalRevenueTotal || order.postalMargin || 0,
      order.providerRevenueTotal || order.providerCost || 0,
      order.partnerCommission, order.postalMargin, order.providerCost,
      order.postalCompanyId || null, order.carrier || "", order.serviceName || "", order.deadline || 0, order.quoteToken,
      JSON.stringify(order.sender || {}), JSON.stringify(order.recipient || {}), JSON.stringify(order.items || []),
      order.invoiceNumber || "", JSON.stringify(order.packageData || {})
    ]
  );
  return rows[0];
}

async function listOrders(partnerEmail, limit = 100) {
  const db = requireDb();
  const { rows } = await db.query(
    `SELECT * FROM freight_orders
     WHERE partner_email=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [partnerEmail, Math.max(1, Math.min(250, Number(limit) || 100))]
  );
  return rows;
}

async function getOrder(id, partnerEmail = null) {
  const db = requireDb();
  const params = [id];
  let sql = "SELECT * FROM freight_orders WHERE id=$1";
  if (partnerEmail) {
    sql += " AND partner_email=$2";
    params.push(partnerEmail);
  }
  sql += " LIMIT 1";
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function getOrderByCheckoutId(checkoutId) {
  const db = requireDb();
  const { rows } = await db.query(
    "SELECT * FROM freight_orders WHERE payment_checkout_id=$1 ORDER BY created_at DESC LIMIT 1",
    [checkoutId]
  );
  return rows[0] || null;
}

async function setCheckout(id, { checkoutId, checkoutUrl, paymentAmount, surcharge, status = "PAYMENT_PENDING", paymentStatus = "PENDING" }) {
  const db = requireDb();
  const { rows } = await db.query(
    `UPDATE freight_orders SET
       payment_checkout_id=$2,
       payment_checkout_url=$3,
       payment_amount=$4,
       payment_surcharge=$5,
       status=$6,
       payment_status=$7,
       updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id, checkoutId, checkoutUrl, paymentAmount, surcharge, status, paymentStatus]
  );
  return rows[0] || null;
}

async function markPaid(id, status = "PAID_WAITING_SHIPMENT") {
  const db = requireDb();
  const { rows } = await db.query(
    `UPDATE freight_orders SET
       payment_status='PAID',
       status=$2,
       paid_at=COALESCE(paid_at,NOW()),
       updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

async function updateStatus(id, status, paymentStatus = null) {
  const db = requireDb();
  const { rows } = await db.query(
    `UPDATE freight_orders SET
       status=$2,
       payment_status=COALESCE($3,payment_status),
       updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id, status, paymentStatus]
  );
  return rows[0] || null;
}

async function saveShipment(id, shipment) {
  const db = requireDb();
  const { rows } = await db.query(
    `UPDATE freight_orders SET
       status='LABEL_AVAILABLE',
       conect_cart_id=$2,
       conect_package_id=$3,
       tracking_code=$4,
       label_a4_url=$5,
       label_a6_url=$6,
       declaration_url=$7,
       public_tracking_url=$8,
       shipped_at=NOW(),
       updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [
      id,
      shipment.cartId || null,
      shipment.packageId || null,
      shipment.trackingCode || "",
      shipment.labelA4Url || "",
      shipment.labelA6Url || "",
      shipment.declarationUrl || "",
      shipment.publicTrackingUrl || ""
    ]
  );
  return rows[0] || null;
}

async function listCatalogItems({ itemType = null, activeOnly = true } = {}) {
  const db = requireDb();
  const params = [];
  const where = [];
  if (itemType) {
    params.push(itemType);
    where.push(`item_type=${params.length}`);
  }
  if (activeOnly) where.push("active=TRUE");
  const { rows } = await db.query(
    `SELECT * FROM catalog_items ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY category,name`,
    params
  );
  return rows;
}

async function getCatalogItemByCode(code) {
  const db = requireDb();
  const { rows } = await db.query(
    "SELECT * FROM catalog_items WHERE code=$1 LIMIT 1",
    [code]
  );
  return rows[0] || null;
}

async function upsertCatalogItem(item) {
  const db = requireDb();
  const id = item.id || require("crypto").randomUUID();
  const { rows } = await db.query(
    `INSERT INTO catalog_items(
      id,code,item_type,category,name,description,unit_price,cost_price,track_stock,
      point_share_percent,postal_share_percent,provider_share_percent,
      external_provider,external_ref,active,metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT (code) DO UPDATE SET
      item_type=EXCLUDED.item_type,
      category=EXCLUDED.category,
      name=EXCLUDED.name,
      description=EXCLUDED.description,
      unit_price=EXCLUDED.unit_price,
      cost_price=EXCLUDED.cost_price,
      track_stock=EXCLUDED.track_stock,
      point_share_percent=EXCLUDED.point_share_percent,
      postal_share_percent=EXCLUDED.postal_share_percent,
      provider_share_percent=EXCLUDED.provider_share_percent,
      external_provider=EXCLUDED.external_provider,
      external_ref=EXCLUDED.external_ref,
      active=EXCLUDED.active,
      metadata=EXCLUDED.metadata,
      updated_at=NOW()
    RETURNING *`,
    [
      id,
      item.code,
      item.itemType,
      item.category || "OUTROS",
      item.name,
      item.description || "",
      item.unitPrice || 0,
      item.costPrice || 0,
      Boolean(item.trackStock),
      item.pointSharePercent ?? 100,
      item.postalSharePercent ?? 0,
      item.providerSharePercent ?? 0,
      item.externalProvider || null,
      item.externalRef || null,
      item.active !== false,
      JSON.stringify(item.metadata || {})
    ]
  );
  return rows[0];
}

async function getPartnerCatalog(partnerEmail) {
  const db = requireDb();
  const { rows } = await db.query(
    `SELECT
       c.*,
       COALESCE(i.quantity,0) AS stock_quantity,
       COALESCE(i.reserved_quantity,0) AS reserved_quantity,
       COALESCE(i.min_quantity,0) AS min_quantity,
       (COALESCE(i.quantity,0)-COALESCE(i.reserved_quantity,0)) AS available_quantity
     FROM catalog_items c
     LEFT JOIN partner_inventory i
       ON i.item_id=c.id AND i.partner_email=$1
     WHERE c.active=TRUE
     ORDER BY c.item_type,c.category,c.name`,
    [partnerEmail]
  );
  return rows;
}

async function setInventory(partnerEmail, itemId, quantity, minQuantity = 0, note = "Ajuste de estoque") {
  const db = requireDb();
  await db.query("BEGIN");
  try {
    const { rows } = await db.query(
      `INSERT INTO partner_inventory(partner_email,item_id,quantity,min_quantity)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (partner_email,item_id) DO UPDATE
         SET quantity=EXCLUDED.quantity,
             min_quantity=EXCLUDED.min_quantity,
             updated_at=NOW()
       RETURNING *`,
      [partnerEmail,itemId,quantity,minQuantity]
    );
    await db.query(
      `INSERT INTO inventory_movements(
        id,partner_email,item_id,movement_type,quantity,reference_type,reference_id,note
      ) VALUES ($1,$2,$3,'ADJUSTMENT',$4,'MANUAL',NULL,$5)`,
      [require("crypto").randomUUID(),partnerEmail,itemId,quantity,note]
    );
    await db.query("COMMIT");
    return rows[0];
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function receiveInventory(partnerEmail, itemId, quantity, note = "Recebimento de produtos") {
  const db = requireDb();
  await db.query("BEGIN");
  try {
    const { rows } = await db.query(
      `INSERT INTO partner_inventory(partner_email,item_id,quantity)
       VALUES ($1,$2,$3)
       ON CONFLICT (partner_email,item_id) DO UPDATE
         SET quantity=partner_inventory.quantity + EXCLUDED.quantity,
             updated_at=NOW()
       RETURNING *`,
      [partnerEmail,itemId,quantity]
    );
    await db.query(
      `INSERT INTO inventory_movements(
        id,partner_email,item_id,movement_type,quantity,reference_type,note
      ) VALUES ($1,$2,$3,'IN',$4,'RECEIPT',$5)`,
      [require("crypto").randomUUID(),partnerEmail,itemId,quantity,note]
    );
    await db.query("COMMIT");
    return rows[0];
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function insertOrderAddons(orderId, partnerEmail, addons) {
  const db = requireDb();
  if (!Array.isArray(addons) || !addons.length) return [];
  const inserted = [];
  await db.query("BEGIN");
  try {
    for (const addon of addons) {
      const { rows } = await db.query(
        `INSERT INTO order_addons(
          id,order_id,item_id,item_code,item_type,item_name,quantity,unit_price,total_price,
          point_revenue,postal_revenue,provider_revenue,metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        RETURNING *`,
        [
          require("crypto").randomUUID(),
          orderId,
          addon.itemId || null,
          addon.itemCode,
          addon.itemType,
          addon.itemName,
          addon.quantity,
          addon.unitPrice,
          addon.totalPrice,
          addon.pointRevenue,
          addon.postalRevenue,
          addon.providerRevenue,
          JSON.stringify(addon.metadata || {})
        ]
      );
      inserted.push(rows[0]);

      if (addon.trackStock && addon.itemId) {
        const lock = await db.query(
          `SELECT quantity,reserved_quantity FROM partner_inventory
           WHERE partner_email=$1 AND item_id=$2
           FOR UPDATE`,
          [partnerEmail,addon.itemId]
        );
        const inv = lock.rows[0];
        const available = Number(inv?.quantity || 0) - Number(inv?.reserved_quantity || 0);
        if (!inv || available < Number(addon.quantity)) {
          throw new Error(`Estoque insuficiente para ${addon.itemName}.`);
        }
        await db.query(
          `UPDATE partner_inventory
           SET reserved_quantity=reserved_quantity+$3, updated_at=NOW()
           WHERE partner_email=$1 AND item_id=$2`,
          [partnerEmail,addon.itemId,addon.quantity]
        );
        await db.query(
          `INSERT INTO inventory_movements(
            id,partner_email,item_id,movement_type,quantity,reference_type,reference_id,note
          ) VALUES ($1,$2,$3,'RESERVE',$4,'ORDER',$5,'Reserva para venda')`,
          [require("crypto").randomUUID(),partnerEmail,addon.itemId,addon.quantity,orderId]
        );
      }
    }
    await db.query("COMMIT");
    return inserted;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function getOrderAddons(orderId) {
  const db = requireDb();
  const { rows } = await db.query(
    "SELECT * FROM order_addons WHERE order_id=$1 ORDER BY created_at",
    [orderId]
  );
  return rows;
}

async function consumeOrderInventory(orderId, partnerEmail) {
  const db = requireDb();
  const addons = await getOrderAddons(orderId);
  await db.query("BEGIN");
  try {
    for (const addon of addons.filter(a => a.item_id)) {
      const { rows } = await db.query(
        "SELECT track_stock FROM catalog_items WHERE id=$1",
        [addon.item_id]
      );
      if (!rows[0]?.track_stock) continue;
      await db.query(
        `UPDATE partner_inventory SET
         quantity=quantity-$3,
         reserved_quantity=GREATEST(0,reserved_quantity-$3),
         updated_at=NOW()
         WHERE partner_email=$1 AND item_id=$2`,
        [partnerEmail,addon.item_id,addon.quantity]
      );
      await db.query(
        `INSERT INTO inventory_movements(
          id,partner_email,item_id,movement_type,quantity,reference_type,reference_id,note
        ) VALUES ($1,$2,$3,'OUT',$4,'ORDER',$5,'Venda confirmada')`,
        [require("crypto").randomUUID(),partnerEmail,addon.item_id,addon.quantity,orderId]
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function releaseOrderInventory(orderId, partnerEmail) {
  const db = requireDb();
  const addons = await getOrderAddons(orderId);
  await db.query("BEGIN");
  try {
    for (const addon of addons.filter(a => a.item_id)) {
      const { rows } = await db.query(
        "SELECT track_stock FROM catalog_items WHERE id=$1",
        [addon.item_id]
      );
      if (!rows[0]?.track_stock) continue;
      await db.query(
        `UPDATE partner_inventory SET
         reserved_quantity=GREATEST(0,reserved_quantity-$3),
         updated_at=NOW()
         WHERE partner_email=$1 AND item_id=$2`,
        [partnerEmail,addon.item_id,addon.quantity]
      );
      await db.query(
        `INSERT INTO inventory_movements(
          id,partner_email,item_id,movement_type,quantity,reference_type,reference_id,note
        ) VALUES ($1,$2,$3,'RELEASE',$4,'ORDER',$5,'Reserva liberada')`,
        [require("crypto").randomUUID(),partnerEmail,addon.item_id,addon.quantity,orderId]
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function insertWebhookEvent({ id, provider, eventType, checkoutId, payload }) {
  const db = requireDb();
  const { rowCount } = await db.query(
    `INSERT INTO payment_webhook_events(id,provider,event_type,checkout_id,payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, provider, eventType, checkoutId || null, JSON.stringify(payload || {})]
  );
  return rowCount === 1;
}

async function getPendingWebhookEvents(provider, limit = 20) {
  const db = requireDb();
  const { rows } = await db.query(
    `SELECT * FROM payment_webhook_events
     WHERE provider=$1 AND processed_at IS NULL
     ORDER BY received_at ASC
     LIMIT $2`,
    [provider, Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  return rows;
}

async function markWebhookProcessed(id, error = null) {
  const db = requireDb();
  await db.query(
    `UPDATE payment_webhook_events SET
       processed_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE NULL END,
       processing_error = $2,
       received_at = received_at
     WHERE id=$1`,
    [id, error]
  );
}

module.exports = {
  pool,
  initDb,
  ensurePartner,
  getPartner,
  setPartnerWallet,
  insertOrder,
  listOrders,
  getOrder,
  getOrderByCheckoutId,
  setCheckout,
  markPaid,
  updateStatus,
  saveShipment,
  listCatalogItems,
  getCatalogItemByCode,
  upsertCatalogItem,
  getPartnerCatalog,
  setInventory,
  receiveInventory,
  insertOrderAddons,
  getOrderAddons,
  consumeOrderInventory,
  releaseOrderInventory,
  insertWebhookEvent,
  getPendingWebhookEvents,
  markWebhookProcessed
};

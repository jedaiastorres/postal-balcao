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
      sale_price, partner_commission, postal_margin, provider_cost,
      postal_company_id, carrier, service_name, deadline, quote_token,
      sender, recipient, items, invoice_number, package_data
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,
      $10,$11,$12,$13,
      $14,$15,$16,$17,$18,
      $19::jsonb,$20::jsonb,$21::jsonb,$22,$23::jsonb
    )
    RETURNING *`,
    [
      order.id, order.partnerEmail, order.status, order.paymentMethod, order.paymentStatus, order.paymentProvider || null,
      order.paymentAmount || 0, order.paymentSurcharge || 0, order.cashRemittanceAmount || 0,
      order.salePrice, order.partnerCommission, order.postalMargin, order.providerCost,
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
  insertWebhookEvent,
  getPendingWebhookEvents,
  markWebhookProcessed
};

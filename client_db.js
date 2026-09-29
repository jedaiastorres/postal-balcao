const crypto = require("crypto");
const core = require("./db");

function database() {
  if (!core.pool) throw new Error("Banco de dados não configurado.");
  return core.pool;
}
function id() { return crypto.randomUUID(); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

async function initClientDb() {
  const db = database();

  await db.query(`
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='app_users'::regclass AND conname='app_users_role_check_v2'
      ) THEN
        ALTER TABLE app_users
        ADD CONSTRAINT app_users_role_check_v2
        CHECK (role IN ('ADMIN','STORE_OWNER','STORE_CLERK','OPS','CLIENT'));
      END IF;
    END $$;

    ALTER TABLE stores ADD COLUMN IF NOT EXISTS pickup_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS pickup_radius_km NUMERIC(8,2) NOT NULL DEFAULT 10;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS pickup_rate NUMERIC(12,2) NOT NULL DEFAULT 3;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS dropoff_rate NUMERIC(12,2) NOT NULL DEFAULT 2;

    UPDATE stores
       SET referral_code=UPPER(code)
     WHERE referral_code IS NULL OR referral_code='';

    CREATE UNIQUE INDEX IF NOT EXISTS stores_referral_code_uidx
      ON stores(referral_code)
      WHERE referral_code IS NOT NULL;

    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS client_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS referral_store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS referral_commission NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS first_mile_type TEXT;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS first_mile_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE freight_orders ADD COLUMN IF NOT EXISTS package_count INTEGER NOT NULL DEFAULT 1;

    CREATE INDEX IF NOT EXISTS freight_orders_client_idx
      ON freight_orders(client_user_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS customer_accounts (
      user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      document TEXT,
      phone TEXT,
      company_name TEXT,
      referral_store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
      wallet_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      default_sender JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS customer_accounts_referral_idx
      ON customer_accounts(referral_store_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'POSTED',
      description TEXT,
      external_ref TEXT,
      order_id UUID REFERENCES freight_orders(id) ON DELETE SET NULL,
      idempotency_key TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx
      ON wallet_transactions(user_id,created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_idempotency_uidx
      ON wallet_transactions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS wallet_topups (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL,
      fee NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount NUMERIC(14,2) NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      provider TEXT NOT NULL DEFAULT 'ASAAS',
      checkout_id TEXT,
      checkout_url TEXT,
      is_simulation BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS wallet_topups_user_idx
      ON wallet_topups(user_id,created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_topups_checkout_uidx
      ON wallet_topups(checkout_id)
      WHERE checkout_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ecommerce_connections (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'CONECTENVIOS',
      display_name TEXT,
      external_store_id TEXT,
      status TEXT NOT NULL DEFAULT 'AWAITING_AUTH',
      authorization_url TEXT,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS ecommerce_connections_user_idx
      ON ecommerce_connections(user_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS ecommerce_orders (
      id UUID PRIMARY KEY,
      connection_id UUID NOT NULL REFERENCES ecommerce_connections(id) ON DELETE CASCADE,
      external_order_id TEXT NOT NULL,
      customer_name TEXT,
      external_status TEXT,
      import_status TEXT NOT NULL DEFAULT 'IMPORTED',
      freight_order_id UUID REFERENCES freight_orders(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(connection_id,external_order_id)
    );

    CREATE TABLE IF NOT EXISTS collection_requests (
      id UUID PRIMARY KEY,
      client_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      freight_order_id UUID REFERENCES freight_orders(id) ON DELETE SET NULL,
      service_type TEXT NOT NULL CHECK (service_type IN ('PICKUP','DROPOFF')),
      status TEXT NOT NULL,
      package_count INTEGER NOT NULL DEFAULT 1,
      fee_per_package NUMERIC(12,2) NOT NULL DEFAULT 5,
      total_fee NUMERIC(12,2) NOT NULL,
      assigned_store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
      point_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      point_compensation NUMERIC(12,2) NOT NULL DEFAULT 0,
      postal_compensation NUMERIC(12,2) NOT NULL DEFAULT 0,
      address JSONB NOT NULL DEFAULT '{}'::jsonb,
      latitude NUMERIC(10,7),
      longitude NUMERIC(10,7),
      scheduled_for TIMESTAMPTZ,
      notes TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS collection_requests_client_idx
      ON collection_requests(client_user_id,requested_at DESC);

    CREATE INDEX IF NOT EXISTS collection_requests_store_idx
      ON collection_requests(assigned_store_id,status,requested_at DESC);

    CREATE TABLE IF NOT EXISTS point_earnings (
      id UUID PRIMARY KEY,
      store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      client_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
      earning_type TEXT NOT NULL CHECK (earning_type IN ('PICKUP','DROPOFF','REFERRAL')),
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'EARNED',
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS point_earnings_reference_uidx
      ON point_earnings(store_id,earning_type,reference_type,reference_id);

    CREATE INDEX IF NOT EXISTS point_earnings_store_idx
      ON point_earnings(store_id,created_at DESC);
  `);
}

async function createCustomerAccount({ userId, document="", phone="", companyName="", referralStoreId=null, defaultSender={} }) {
  const db = database();
  const { rows } = await db.query(
    `INSERT INTO customer_accounts(user_id,document,phone,company_name,referral_store_id,default_sender)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(user_id) DO UPDATE SET
       document=COALESCE(NULLIF(EXCLUDED.document,''),customer_accounts.document),
       phone=COALESCE(NULLIF(EXCLUDED.phone,''),customer_accounts.phone),
       company_name=COALESCE(NULLIF(EXCLUDED.company_name,''),customer_accounts.company_name),
       referral_store_id=COALESCE(customer_accounts.referral_store_id,EXCLUDED.referral_store_id),
       default_sender=CASE WHEN EXCLUDED.default_sender='{}'::jsonb THEN customer_accounts.default_sender ELSE EXCLUDED.default_sender END,
       updated_at=NOW()
     RETURNING *`,
    [userId,document,phone,companyName,referralStoreId,JSON.stringify(defaultSender||{})]
  );
  return rows[0];
}

async function getCustomerAccount(userId) {
  const db = database();
  const { rows } = await db.query(
    `SELECT c.*,u.email,u.name,s.name AS referral_store_name,s.code AS referral_store_code
       FROM customer_accounts c
       JOIN app_users u ON u.id=c.user_id
       LEFT JOIN stores s ON s.id=c.referral_store_id
      WHERE c.user_id=$1 LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function findStoreByReferralCode(code) {
  const db = database();
  const { rows } = await db.query(
    "SELECT * FROM stores WHERE active=TRUE AND (UPPER(referral_code)=UPPER($1) OR UPPER(code)=UPPER($1)) LIMIT 1",
    [String(code||"").trim()]
  );
  return rows[0] || null;
}

async function listPublicStores() {
  const db = database();
  const { rows } = await db.query(
    `SELECT id,code,name,address,pickup_enabled,pickup_radius_km,latitude,longitude,
            referral_code
       FROM stores
      WHERE active=TRUE
      ORDER BY name`
  );
  return rows;
}

async function listPickupStores() {
  const db = database();
  const { rows } = await db.query(
    `SELECT id,code,name,address,pickup_enabled,pickup_radius_km,latitude,longitude,
            pickup_rate,dropoff_rate,referral_code
       FROM stores
      WHERE active=TRUE AND pickup_enabled=TRUE
      ORDER BY name`
  );
  return rows;
}

async function updateStorePickupSettings(storeId,{enabled,radiusKm,latitude,longitude}){
  const db=database();
  const {rows}=await db.query(
    `UPDATE stores SET
       pickup_enabled=$2,
       pickup_radius_km=$3,
       latitude=$4,
       longitude=$5,
       updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [storeId,Boolean(enabled),Math.max(1,Number(radiusKm||10)),
     latitude==null||latitude===""?null:Number(latitude),
     longitude==null||longitude===""?null:Number(longitude)]
  );
  return rows[0]||null;
}

async function getWallet(userId) {
  const account = await getCustomerAccount(userId);
  if (!account) return null;
  return { balance: Number(account.wallet_balance||0), account };
}

async function listWalletTransactions(userId, limit=100) {
  const db = database();
  const { rows } = await db.query(
    `SELECT * FROM wallet_transactions
      WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId,Math.max(1,Math.min(250,Number(limit)||100))]
  );
  return rows;
}

async function creditWallet(userId, amount, { type="TOPUP", description="", externalRef=null, orderId=null, idempotencyKey=null, metadata={} }={}) {
  const db = database();
  amount=round2(amount);
  if (!(amount>0)) throw new Error("Valor de crédito inválido.");
  await db.query("BEGIN");
  try {
    if (idempotencyKey) {
      const existing=await db.query("SELECT id FROM wallet_transactions WHERE idempotency_key=$1 LIMIT 1",[idempotencyKey]);
      if (existing.rows[0]) {
        const wallet=await db.query("SELECT wallet_balance FROM customer_accounts WHERE user_id=$1",[userId]);
        await db.query("ROLLBACK");
        return { duplicate:true, balance:Number(wallet.rows[0]?.wallet_balance||0) };
      }
    }
    const updated=await db.query(
      `UPDATE customer_accounts SET wallet_balance=wallet_balance+$2,updated_at=NOW()
        WHERE user_id=$1 RETURNING wallet_balance`,
      [userId,amount]
    );
    if(!updated.rows[0]) throw new Error("Conta cliente não encontrada.");
    await db.query(
      `INSERT INTO wallet_transactions(
        id,user_id,transaction_type,amount,status,description,external_ref,order_id,idempotency_key,metadata
      ) VALUES($1,$2,$3,$4,'POSTED',$5,$6,$7,$8,$9::jsonb)`,
      [id(),userId,type,amount,description,externalRef,orderId,idempotencyKey,JSON.stringify(metadata||{})]
    );
    await db.query("COMMIT");
    return { duplicate:false,balance:Number(updated.rows[0].wallet_balance) };
  } catch(error) {
    await db.query("ROLLBACK"); throw error;
  }
}

async function debitWallet(userId, amount, { description="", orderId=null, idempotencyKey=null, metadata={} }={}) {
  const db=database();
  amount=round2(amount);
  if (!(amount>0)) throw new Error("Valor de débito inválido.");
  await db.query("BEGIN");
  try {
    if(idempotencyKey){
      const existing=await db.query("SELECT id FROM wallet_transactions WHERE idempotency_key=$1 LIMIT 1",[idempotencyKey]);
      if(existing.rows[0]){
        const wallet=await db.query("SELECT wallet_balance FROM customer_accounts WHERE user_id=$1",[userId]);
        await db.query("ROLLBACK");
        return {duplicate:true,balance:Number(wallet.rows[0]?.wallet_balance||0)};
      }
    }
    const updated=await db.query(
      `UPDATE customer_accounts SET wallet_balance=wallet_balance-$2,updated_at=NOW()
        WHERE user_id=$1 AND wallet_balance >= $2 RETURNING wallet_balance`,
      [userId,amount]
    );
    if(!updated.rows[0]) throw new Error("Saldo insuficiente.");
    await db.query(
      `INSERT INTO wallet_transactions(
        id,user_id,transaction_type,amount,status,description,order_id,idempotency_key,metadata
      ) VALUES($1,$2,'SHIPMENT_DEBIT',$3,'POSTED',$4,$5,$6,$7::jsonb)`,
      [id(),userId,-amount,description,orderId,idempotencyKey,JSON.stringify(metadata||{})]
    );
    await db.query("COMMIT");
    return {duplicate:false,balance:Number(updated.rows[0].wallet_balance)};
  }catch(error){ await db.query("ROLLBACK"); throw error; }
}

async function createTopup({ userId, amount, fee=0, totalAmount, paymentMethod, provider="ASAAS", isSimulation=false }) {
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO wallet_topups(id,user_id,amount,fee,total_amount,payment_method,status,provider,is_simulation)
     VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8) RETURNING *`,
    [id(),userId,round2(amount),round2(fee),round2(totalAmount),paymentMethod,provider,isSimulation]
  );
  return rows[0];
}

async function setTopupCheckout(topupId,{checkoutId,checkoutUrl,fee,totalAmount}) {
  const db=database();
  const {rows}=await db.query(
    `UPDATE wallet_topups SET checkout_id=$2,checkout_url=$3,fee=$4,total_amount=$5
      WHERE id=$1 RETURNING *`,
    [topupId,checkoutId,checkoutUrl,round2(fee),round2(totalAmount)]
  );
  return rows[0]||null;
}

async function getTopupByCheckoutId(checkoutId){
  const db=database();
  const {rows}=await db.query("SELECT * FROM wallet_topups WHERE checkout_id=$1 LIMIT 1",[checkoutId]);
  return rows[0]||null;
}

async function getTopup(idValue,userId=null){
  const db=database(); const p=[idValue]; let sql="SELECT * FROM wallet_topups WHERE id=$1";
  if(userId){p.push(userId);sql+=" AND user_id=$2";}
  const {rows}=await db.query(sql+" LIMIT 1",p); return rows[0]||null;
}

async function listTopups(userId,limit=50){
  const db=database();
  const {rows}=await db.query(
    "SELECT * FROM wallet_topups WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId,Math.max(1,Math.min(100,Number(limit)||50))]
  ); return rows;
}

async function markTopupPaid(topupId){
  const db=database();
  await db.query("BEGIN");
  try{
    const locked=await db.query("SELECT * FROM wallet_topups WHERE id=$1 FOR UPDATE",[topupId]);
    const topup=locked.rows[0];
    if(!topup) throw new Error("Recarga não encontrada.");
    if(topup.status==="PAID"){
      await db.query("ROLLBACK");
      return topup;
    }
    await db.query("UPDATE wallet_topups SET status='PAID',paid_at=NOW() WHERE id=$1",[topupId]);
    const updated=await db.query(
      "UPDATE customer_accounts SET wallet_balance=wallet_balance+$2,updated_at=NOW() WHERE user_id=$1 RETURNING wallet_balance",
      [topup.user_id,topup.amount]
    );
    await db.query(
      `INSERT INTO wallet_transactions(
       id,user_id,transaction_type,amount,status,description,external_ref,idempotency_key,metadata
      ) VALUES($1,$2,'TOPUP',$3,'POSTED','Recarga de saldo Postal',$4,$5,$6::jsonb)
      ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [id(),topup.user_id,topup.amount,topup.checkout_id,"topup:"+topup.id,JSON.stringify({topupId:topup.id,simulation:topup.is_simulation})]
    );
    await db.query("COMMIT");
    return {...topup,status:"PAID",balance:Number(updated.rows[0]?.wallet_balance||0)};
  }catch(error){await db.query("ROLLBACK");throw error;}
}

async function updateTopupStatus(topupId,status){
  const db=database();
  const {rows}=await db.query(
    "UPDATE wallet_topups SET status=$2 WHERE id=$1 RETURNING *",
    [topupId,status]
  );
  return rows[0]||null;
}

async function insertClientOrder(order){
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO freight_orders(
      id,store_id,client_user_id,referral_store_id,referral_commission,
      partner_email,status,payment_method,payment_status,payment_provider,
      payment_amount,payment_surcharge,cash_remittance_amount,
      sale_price,addons_total,customer_subtotal,
      point_revenue_total,postal_revenue_total,provider_revenue_total,
      partner_commission,postal_margin,provider_cost,
      first_mile_type,first_mile_fee,package_count,
      postal_company_id,carrier,service_name,deadline,quote_token,
      sender,recipient,items,invoice_number,package_data
    ) VALUES(
      $1,NULL,$2,$3,$4,
      $5,$6,'SALDO','PAID','POSTAL_WALLET',
      $7,0,0,
      $8,0,$9,
      0,$10,$11,
      0,$12,$13,
      $14,$15,$16,
      $17,$18,$19,$20,$21,
      $22::jsonb,$23::jsonb,$24::jsonb,$25,$26::jsonb
    ) RETURNING *`,
    [
      order.id,order.clientUserId,order.referralStoreId||null,order.referralCommission||0,
      order.partnerEmail,order.status,order.totalAmount,order.freightPrice,order.customerSubtotal,
      order.postalRevenueTotal,order.providerCost,order.postalMargin,order.firstMileType,order.firstMileFee,order.packageCount,
      order.postalCompanyId||null,order.carrier||"",order.serviceName||"",order.deadline||0,order.quoteToken,
      JSON.stringify(order.sender||{}),JSON.stringify(order.recipient||{}),JSON.stringify(order.items||[]),
      order.invoiceNumber||"",JSON.stringify(order.packageData||{})
    ]
  ); return rows[0];
}

async function createClientOrderAndDebit(order){
  const db=database();
  const total=round2(order.totalAmount);
  await db.query("BEGIN");
  try{
    const wallet=await db.query(
      `UPDATE customer_accounts SET wallet_balance=wallet_balance-$2,updated_at=NOW()
        WHERE user_id=$1 AND wallet_balance >= $2 RETURNING wallet_balance`,
      [order.clientUserId,total]
    );
    if(!wallet.rows[0]) throw new Error("Saldo insuficiente.");

    const {rows}=await db.query(
      `INSERT INTO freight_orders(
        id,store_id,client_user_id,referral_store_id,referral_commission,
        partner_email,status,payment_method,payment_status,payment_provider,
        payment_amount,payment_surcharge,cash_remittance_amount,
        sale_price,addons_total,customer_subtotal,
        point_revenue_total,postal_revenue_total,provider_revenue_total,
        partner_commission,postal_margin,provider_cost,
        first_mile_type,first_mile_fee,package_count,
        postal_company_id,carrier,service_name,deadline,quote_token,
        sender,recipient,items,invoice_number,package_data,paid_at
      ) VALUES(
        $1,NULL,$2,$3,$4,
        $5,$6,'SALDO','PAID','POSTAL_WALLET',
        $7,0,0,
        $8,0,$9,
        0,$10,$11,
        0,$12,$13,
        $14,$15,$16,
        $17,$18,$19,$20,$21,
        $22::jsonb,$23::jsonb,$24::jsonb,$25,$26::jsonb,NOW()
      ) RETURNING *`,
      [
        order.id,order.clientUserId,order.referralStoreId||null,order.referralCommission||0,
        order.partnerEmail,order.status,total,order.freightPrice,order.customerSubtotal,
        order.postalRevenueTotal,order.providerCost,order.postalMargin,
        order.firstMileType,order.firstMileFee,order.packageCount,
        order.postalCompanyId||null,order.carrier||"",order.serviceName||"",order.deadline||0,order.quoteToken,
        JSON.stringify(order.sender||{}),JSON.stringify(order.recipient||{}),JSON.stringify(order.items||[]),
        order.invoiceNumber||"",JSON.stringify(order.packageData||{})
      ]
    );

    await db.query(
      `INSERT INTO wallet_transactions(
        id,user_id,transaction_type,amount,status,description,order_id,idempotency_key,metadata
      ) VALUES($1,$2,'SHIPMENT_DEBIT',$3,'POSTED',$4,$5,$6,$7::jsonb)`,
      [
        id(),order.clientUserId,-total,
        "Pagamento de envio Postal",order.id,"client-order:"+order.id,
        JSON.stringify({freight:round2(order.freightPrice),firstMile:round2(order.firstMileFee)})
      ]
    );
    await db.query("COMMIT");
    return {order:rows[0],balance:Number(wallet.rows[0].wallet_balance)};
  }catch(error){await db.query("ROLLBACK");throw error;}
}

async function listClientOrders(userId,limit=100){
  const db=database();
  const {rows}=await db.query(
    `SELECT f.*,
       COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at) FROM order_events e WHERE e.order_id=f.id),'[]'::jsonb) AS events
       FROM freight_orders f
      WHERE f.client_user_id=$1
      ORDER BY f.created_at DESC LIMIT $2`,
    [userId,Math.max(1,Math.min(250,Number(limit)||100))]
  ); return rows;
}

async function getClientOrder(orderId,userId){
  const db=database();
  const {rows}=await db.query(
    `SELECT f.*,
       COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at) FROM order_events e WHERE e.order_id=f.id),'[]'::jsonb) AS events
       FROM freight_orders f WHERE f.id=$1 AND f.client_user_id=$2 LIMIT 1`,
    [orderId,userId]
  ); return rows[0]||null;
}

function geoDistanceKm(aLat,aLng,bLat,bLng){
  const vals=[aLat,aLng,bLat,bLng].map(Number);
  if(vals.some(v=>!Number.isFinite(v))) return null;
  const [lat1,lon1,lat2,lon2]=vals; const r=6371;
  const dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*r*Math.asin(Math.sqrt(x));
}

async function choosePickupStore({address={},latitude=null,longitude=null}){
  const stores=await listPickupStores();
  if(!stores.length) return null;
  const cep=String(address.cep||"").replace(/\D/g,"");
  const city=String(address.city||"").toLowerCase();
  const state=String(address.state||address.uf||"").toLowerCase();

  const scored=stores.map(store=>{
    const dist=geoDistanceKm(latitude,longitude,store.latitude,store.longitude);
    const a=store.address||{};
    const storeCep=String(a.cep||"").replace(/\D/g,"");
    const storeCity=String(a.city||"").toLowerCase();
    const storeState=String(a.state||a.uf||"").toLowerCase();
    let score=100000;
    if(dist!=null) score=dist;
    else if(cep&&storeCep&&cep.slice(0,5)===storeCep.slice(0,5)) score=1;
    else if(city&&storeCity&&city===storeCity&&(!state||!storeState||state===storeState)) score=10;
    return {store,score,dist};
  }).sort((a,b)=>a.score-b.score);
  const best=scored[0]||null;
  if(!best||best.score>=100000) return null;
  if(best.dist!=null&&best.dist>Number(best.store.pickup_radius_km||10)) return null;
  return best;
}

async function createCollectionRequest(request){
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO collection_requests(
      id,client_user_id,freight_order_id,service_type,status,package_count,
      fee_per_package,total_fee,assigned_store_id,point_rate,point_compensation,postal_compensation,
      address,latitude,longitude,scheduled_for,notes,assigned_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,
      CASE WHEN $9::uuid IS NULL THEN NULL ELSE NOW() END)
    RETURNING *`,
    [
      id(),request.clientUserId,request.freightOrderId||null,request.serviceType,request.status,request.packageCount,
      request.feePerPackage,request.totalFee,request.assignedStoreId||null,request.pointRate||0,
      request.pointCompensation||0,request.postalCompensation||0,JSON.stringify(request.address||{}),
      request.latitude||null,request.longitude||null,request.scheduledFor||null,request.notes||""
    ]
  ); return rows[0];
}

async function listCollections({clientUserId=null,storeId=null,all=false}={},limit=100){
  const db=database(); const where=[],params=[];
  if(!all&&clientUserId){params.push(clientUserId);where.push("c.client_user_id=$"+params.length);}
  if(!all&&storeId){params.push(storeId);where.push("c.assigned_store_id=$"+params.length);}
  params.push(Math.max(1,Math.min(250,Number(limit)||100)));
  const {rows}=await db.query(
    `SELECT c.*,u.name AS client_name,u.email AS client_email,s.name AS store_name,s.code AS store_code
       FROM collection_requests c
       JOIN app_users u ON u.id=c.client_user_id
       LEFT JOIN stores s ON s.id=c.assigned_store_id
       ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY c.requested_at DESC LIMIT $${params.length}`,params
  ); return rows;
}

async function getCollection(collectionId){
  const db=database();
  const {rows}=await db.query(
    `SELECT c.*,u.name AS client_name,u.email AS client_email,s.name AS store_name,s.code AS store_code
       FROM collection_requests c JOIN app_users u ON u.id=c.client_user_id
       LEFT JOIN stores s ON s.id=c.assigned_store_id WHERE c.id=$1 LIMIT 1`,
    [collectionId]
  ); return rows[0]||null;
}

async function updateCollection(collectionId,patch){
  const db=database(); const current=await getCollection(collectionId); if(!current)return null;
  const nextPostal=Number((patch.postalCompensation ?? current.postal_compensation) || 0);
  const previousPostal=Number(current.postal_compensation||0);
  const {rows}=await db.query(
    `UPDATE collection_requests SET
      status=$2,assigned_store_id=$3,point_rate=$4,point_compensation=$5,postal_compensation=$6,
      scheduled_for=$7,notes=$8,assigned_at=CASE WHEN $3::uuid IS NOT NULL AND assigned_at IS NULL THEN NOW() ELSE assigned_at END,
      completed_at=CASE WHEN $2 IN ('COLLECTED','RECEIVED_AT_POINT','COMPLETED') THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
      updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [
      collectionId,patch.status??current.status,patch.assignedStoreId??current.assigned_store_id,
      patch.pointRate??Number(current.point_rate),patch.pointCompensation??Number(current.point_compensation),
      nextPostal,patch.scheduledFor??current.scheduled_for,
      patch.notes??current.notes
    ]
  );
  if(rows[0]?.freight_order_id && Math.abs(nextPostal-previousPostal)>0.0001){
    await db.query(
      `UPDATE freight_orders
          SET postal_revenue_total=postal_revenue_total+$2,updated_at=NOW()
        WHERE id=$1`,
      [rows[0].freight_order_id,round2(nextPostal-previousPostal)]
    );
  }
  return rows[0]||null;
}

async function createPointEarning({storeId,clientUserId=null,earningType,amount,referenceType,referenceId,status="EARNED",metadata={}}){
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO point_earnings(
      id,store_id,client_user_id,earning_type,amount,status,reference_type,reference_id,metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT(store_id,earning_type,reference_type,reference_id) DO UPDATE SET
      amount=EXCLUDED.amount,metadata=EXCLUDED.metadata
    RETURNING *`,
    [id(),storeId,clientUserId,earningType,round2(amount),status,referenceType,String(referenceId),JSON.stringify(metadata||{})]
  ); return rows[0];
}

async function listPointEarnings(storeId,limit=100){
  const db=database();
  const {rows}=await db.query(
    "SELECT * FROM point_earnings WHERE store_id=$1 ORDER BY created_at DESC LIMIT $2",
    [storeId,Math.max(1,Math.min(250,Number(limit)||100))]
  );return rows;
}

async function referralStats(storeId){
  const db=database();
  const {rows}=await db.query(
    `SELECT
      (SELECT COUNT(*) FROM customer_accounts WHERE referral_store_id=$1)::int AS referred_clients,
      (SELECT COUNT(*) FROM freight_orders WHERE referral_store_id=$1 AND client_user_id IS NOT NULL)::int AS referred_shipments,
      COALESCE((SELECT SUM(amount) FROM point_earnings WHERE store_id=$1 AND earning_type='REFERRAL' AND status='EARNED'),0) AS referral_earnings,
      COALESCE((SELECT SUM(amount) FROM point_earnings WHERE store_id=$1 AND earning_type='PICKUP' AND status='EARNED'),0) AS pickup_earnings,
      COALESCE((SELECT SUM(amount) FROM point_earnings WHERE store_id=$1 AND earning_type='DROPOFF' AND status='EARNED'),0) AS dropoff_earnings`,
    [storeId]
  ); return rows[0];
}

async function createConnection({userId,platform,displayName=""}){
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO ecommerce_connections(id,user_id,platform,provider,display_name,status,config)
     VALUES($1,$2,$3,'CONECTENVIOS',$4,'AWAITING_PROVIDER_AUTH',$5::jsonb) RETURNING *`,
    [id(),userId,platform,displayName,JSON.stringify({whiteLabel:"POSTAL_SERVICOS",bridge:"CONECTENVIOS"})]
  ); return rows[0];
}

async function listConnections(userId){
  const db=database();
  const {rows}=await db.query(
    `SELECT c.*,
      (SELECT COUNT(*) FROM ecommerce_orders o WHERE o.connection_id=c.id)::int AS imported_orders
      FROM ecommerce_connections c WHERE c.user_id=$1 ORDER BY c.created_at DESC`,
    [userId]
  );return rows;
}

async function listBridgeConnections(status=null,limit=100){
  const db=database();
  const safe=Math.max(1,Math.min(250,Number(limit)||100));
  const params=[];
  let where="";
  if(status){ params.push(status); where="WHERE c.status=$1"; }
  params.push(safe);
  const limitPos=params.length;
  const {rows}=await db.query(
    `SELECT c.id,c.user_id,c.platform,c.display_name,c.external_store_id,c.status,
            c.authorization_url,c.config,c.last_sync_at,c.created_at,c.updated_at,
            u.email AS client_email,u.name AS client_name
       FROM ecommerce_connections c
       JOIN app_users u ON u.id=c.user_id
       ${where}
       ORDER BY c.updated_at ASC
       LIMIT ${limitPos}`,
    params
  );
  return rows;
}

async function getConnectionById(connectionId){
  const db=database();
  const {rows}=await db.query(
    `SELECT c.*,u.email AS client_email,u.name AS client_name
       FROM ecommerce_connections c JOIN app_users u ON u.id=c.user_id
      WHERE c.id=$1 LIMIT 1`,
    [connectionId]
  );
  return rows[0]||null;
}

async function updateConnection(connectionId,userId,patch){
  const db=database();
  const {rows}=await db.query(
    `UPDATE ecommerce_connections SET
      display_name=COALESCE($3,display_name),external_store_id=COALESCE($4,external_store_id),
      status=COALESCE($5,status),authorization_url=COALESCE($6,authorization_url),
      config=COALESCE($7::jsonb,config),last_sync_at=CASE WHEN $8 THEN NOW() ELSE last_sync_at END,updated_at=NOW()
      WHERE id=$1 AND user_id=$2 RETURNING *`,
    [connectionId,userId,patch.displayName??null,patch.externalStoreId??null,patch.status??null,
     patch.authorizationUrl??null,patch.config?JSON.stringify(patch.config):null,Boolean(patch.markSynced)]
  );return rows[0]||null;
}

async function deleteConnection(connectionId,userId){
  const db=database();
  const {rows}=await db.query(
    "DELETE FROM ecommerce_connections WHERE id=$1 AND user_id=$2 RETURNING *",
    [connectionId,userId]
  );
  return rows[0]||null;
}

async function importEcommerceOrder({connectionId,externalOrderId,customerName="",externalStatus="",payload={}}){
  const db=database();
  const {rows}=await db.query(
    `INSERT INTO ecommerce_orders(id,connection_id,external_order_id,customer_name,external_status,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(connection_id,external_order_id) DO UPDATE SET
       customer_name=EXCLUDED.customer_name,external_status=EXCLUDED.external_status,payload=EXCLUDED.payload,updated_at=NOW()
     RETURNING *`,
    [id(),connectionId,String(externalOrderId),customerName,externalStatus,JSON.stringify(payload||{})]
  );return rows[0];
}

async function listEcommerceOrders(userId,limit=100){
  const db=database();
  const {rows}=await db.query(
    `SELECT o.*,c.platform,c.display_name AS connection_name
       FROM ecommerce_orders o JOIN ecommerce_connections c ON c.id=o.connection_id
      WHERE c.user_id=$1 ORDER BY o.created_at DESC LIMIT $2`,
    [userId,Math.max(1,Math.min(250,Number(limit)||100))]
  );return rows;
}

async function listClientsByStore(storeId,limit=100){
  const db=database();
  const {rows}=await db.query(
    `SELECT u.id,u.email,u.name,c.document,c.phone,c.company_name,c.wallet_balance,c.created_at,
       (SELECT COUNT(*) FROM freight_orders f WHERE f.client_user_id=u.id)::int AS shipments
       FROM customer_accounts c JOIN app_users u ON u.id=c.user_id
      WHERE c.referral_store_id=$1
      ORDER BY c.created_at DESC LIMIT $2`,
    [storeId,Math.max(1,Math.min(250,Number(limit)||100))]
  );return rows;
}

async function getImportedOrder(orderId,userId){
  const db=database();
  const {rows}=await db.query(
    `SELECT o.*,c.platform,c.display_name AS connection_name
       FROM ecommerce_orders o
       JOIN ecommerce_connections c ON c.id=o.connection_id
      WHERE o.id=$1 AND c.user_id=$2 LIMIT 1`,
    [orderId,userId]
  );
  return rows[0]||null;
}

async function linkImportedOrder(orderId,userId,freightOrderId){
  const db=database();
  const {rows}=await db.query(
    `UPDATE ecommerce_orders o SET
       freight_order_id=$3,import_status='PROCESSED',updated_at=NOW()
      FROM ecommerce_connections c
      WHERE o.id=$1 AND o.connection_id=c.id AND c.user_id=$2
      RETURNING o.*`,
    [orderId,userId,freightOrderId]
  );
  return rows[0]||null;
}

async function listClientOperations(userId,limit=250){
  const db=database();
  const safeLimit=Math.max(1,Math.min(500,Number(limit)||250));
  const [imports,shipments]=await Promise.all([
    db.query(
      `SELECT o.*,c.platform,c.display_name AS connection_name
         FROM ecommerce_orders o
         JOIN ecommerce_connections c ON c.id=o.connection_id
        WHERE c.user_id=$1 AND o.freight_order_id IS NULL
        ORDER BY o.created_at DESC LIMIT $2`,
      [userId,safeLimit]
    ),
    db.query(
      `SELECT f.*,
          eo.external_order_id AS source_order_id,
          ec.platform AS source_platform,
          ec.display_name AS source_connection_name,
          col.id AS collection_id,
          col.status AS collection_status,
          col.service_type AS collection_service_type,
          col.assigned_store_id AS collection_store_id,
          col.store_name AS collection_store_name
         FROM freight_orders f
         LEFT JOIN ecommerce_orders eo ON eo.freight_order_id=f.id
         LEFT JOIN ecommerce_connections ec ON ec.id=eo.connection_id
         LEFT JOIN LATERAL (
           SELECT cr.*,s.name AS store_name
             FROM collection_requests cr
             LEFT JOIN stores s ON s.id=cr.assigned_store_id
            WHERE cr.freight_order_id=f.id
            ORDER BY cr.requested_at DESC LIMIT 1
         ) col ON TRUE
        WHERE f.client_user_id=$1
        ORDER BY f.created_at DESC LIMIT $2`,
      [userId,safeLimit]
    )
  ]);
  return {imports:imports.rows,shipments:shipments.rows};
}

async function createBulkCollectionsAndDebit({
  userId,orderIds,address={},latitude=null,longitude=null,scheduledFor=null,notes="",
  feePerPackage=5,pointRate=3,assignedStoreId=null
}){
  const db=database();
  const ids=[...new Set((orderIds||[]).map(String).filter(Boolean))];
  if(!ids.length) throw new Error("Selecione ao menos um envio.");
  const totalFeePerPackage=round2(feePerPackage);
  const pointPerPackage=round2(pointRate);

  await db.query("BEGIN");
  try{
    const ordersRes=await db.query(
      `SELECT f.*
         FROM freight_orders f
        WHERE f.client_user_id=$1 AND f.id=ANY($2::uuid[])
          AND f.payment_status='PAID'
        FOR UPDATE`,
      [userId,ids]
    );
    const orders=ordersRes.rows;
    if(!orders.length) throw new Error("Nenhum envio elegível para coleta.");

    const existingRes=await db.query(
      `SELECT freight_order_id FROM collection_requests
        WHERE client_user_id=$1 AND freight_order_id=ANY($2::uuid[])
          AND status NOT IN ('CANCELED','DECLINED')`,
      [userId,ids]
    );
    const existing=new Set(existingRes.rows.map(x=>String(x.freight_order_id)));
    const eligible=orders.filter(o=>!existing.has(String(o.id)));
    if(!eligible.length) throw new Error("Os envios selecionados já possuem coleta ou postagem vinculada.");

    const totalPackages=eligible.reduce((sum,o)=>sum+Math.max(1,Number(o.package_count||1)),0);
    const totalFee=round2(totalFeePerPackage*totalPackages);

    const walletRes=await db.query(
      `UPDATE customer_accounts
          SET wallet_balance=wallet_balance-$2,updated_at=NOW()
        WHERE user_id=$1 AND wallet_balance >= $2
        RETURNING wallet_balance`,
      [userId,totalFee]
    );
    if(!walletRes.rows[0]) throw new Error("Saldo insuficiente para solicitar as coletas.");

    const created=[];
    for(const order of eligible){
      const count=Math.max(1,Number(order.package_count||1));
      const orderFee=round2(totalFeePerPackage*count);
      const pointComp=assignedStoreId?round2(pointPerPackage*count):0;
      const postalComp=round2(orderFee-pointComp);
      const collectionId=id();

      const {rows}=await db.query(
        `INSERT INTO collection_requests(
          id,client_user_id,freight_order_id,service_type,status,package_count,
          fee_per_package,total_fee,assigned_store_id,point_rate,point_compensation,postal_compensation,
          address,latitude,longitude,scheduled_for,notes,assigned_at
        ) VALUES(
          $1,$2,$3,'PICKUP',$4,$5,$6,$7,$8,$9,$10,$11,
          $12::jsonb,$13,$14,$15,$16,
          CASE WHEN $8::uuid IS NULL THEN NULL ELSE NOW() END
        ) RETURNING *`,
        [
          collectionId,userId,order.id,assignedStoreId?"ASSIGNED":"REQUESTED",count,
          totalFeePerPackage,orderFee,assignedStoreId,assignedStoreId?pointPerPackage:0,
          pointComp,postalComp,JSON.stringify(address||{}),latitude,longitude,
          scheduledFor||null,notes||""
        ]
      );
      created.push(rows[0]);

      await db.query(
        `UPDATE freight_orders SET
           first_mile_type='PICKUP',
           first_mile_fee=$2,
           postal_revenue_total=postal_revenue_total+$3,
           updated_at=NOW()
         WHERE id=$1`,
        [order.id,orderFee,postalComp]
      );
    }

    await db.query(
      `INSERT INTO wallet_transactions(
        id,user_id,transaction_type,amount,status,description,idempotency_key,metadata
      ) VALUES($1,$2,'COLLECTION_DEBIT',$3,'POSTED',$4,$5,$6::jsonb)`,
      [
        id(),userId,-totalFee,
        "Solicitação de coleta em lote",
        "bulk-collection:"+crypto.createHash("sha256").update(userId+"|"+eligible.map(x=>x.id).sort().join("|")+"|"+String(scheduledFor||"")).digest("hex").slice(0,32),
        JSON.stringify({orderIds:eligible.map(x=>x.id),packages:totalPackages})
      ]
    );

    await db.query("COMMIT");
    return {
      collections:created,
      totalPackages,
      totalFee,
      balance:Number(walletRes.rows[0].wallet_balance)
    };
  }catch(error){
    await db.query("ROLLBACK");
    throw error;
  }
}

module.exports={
  initClientDb,createCustomerAccount,getCustomerAccount,findStoreByReferralCode,
  listPublicStores,listPickupStores,updateStorePickupSettings,getWallet,listWalletTransactions,creditWallet,debitWallet,
  createTopup,setTopupCheckout,getTopupByCheckoutId,getTopup,listTopups,markTopupPaid,updateTopupStatus,
  insertClientOrder,createClientOrderAndDebit,listClientOrders,getClientOrder,choosePickupStore,createCollectionRequest,
  listCollections,getCollection,updateCollection,createPointEarning,listPointEarnings,referralStats,
  createConnection,listConnections,listBridgeConnections,getConnectionById,updateConnection,deleteConnection,importEcommerceOrder,listEcommerceOrders,
  getImportedOrder,linkImportedOrder,listClientOperations,createBulkCollectionsAndDebit,
  listClientsByStore
};

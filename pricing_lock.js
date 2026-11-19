"use strict";

// Proteção no banco de dados: não basta ocultar botões na interface.
// A primeira emissão/registro de rastreio é o limite para congelar os valores.
const pricingLockSql = `
CREATE OR REPLACE FUNCTION postal_lock_posted_order_prices()
RETURNS TRIGGER AS $postal_lock$
DECLARE
  field_name TEXT;
BEGIN
  IF OLD.price_locked_at IS NOT NULL OR OLD.shipped_at IS NOT NULL OR NULLIF(OLD.tracking_code,'') IS NOT NULL
     OR OLD.status IN ('LABEL_AVAILABLE','LABEL_AVAILABLE_SIMULATED') THEN
    FOREACH field_name IN ARRAY ARRAY[
      'sale_price','addons_total','customer_subtotal','payment_amount',
      'payment_surcharge','cash_remittance_amount','partner_commission',
      'point_revenue_total','postal_revenue_total','provider_revenue_total',
      'postal_margin','provider_cost','hub_transfer_fee_per_package',
      'hub_transfer_total','first_mile_fee','referral_commission'
    ] LOOP
      IF to_jsonb(NEW)->field_name IS DISTINCT FROM to_jsonb(OLD)->field_name THEN
        RAISE EXCEPTION 'Os valores da postagem estão bloqueados após a emissão da etiqueta (%)', field_name
          USING ERRCODE='23514';
      END IF;
    END LOOP;
    -- Um pedido postado não pode voltar a ser "não postado" para burlar o bloqueio.
    IF OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS NULL OR
       NULLIF(OLD.tracking_code,'') IS NOT NULL AND NULLIF(NEW.tracking_code,'') IS NULL THEN
      RAISE EXCEPTION 'Não é permitido retirar a identificação de um envio postado.'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD.price_locked_at IS NOT NULL THEN
    NEW.price_locked_at := OLD.price_locked_at;
  ELSIF NEW.shipped_at IS NOT NULL OR NULLIF(NEW.tracking_code,'') IS NOT NULL
      OR NEW.status IN ('LABEL_AVAILABLE','LABEL_AVAILABLE_SIMULATED') THEN
    NEW.price_locked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$postal_lock$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postal_lock_posted_order_prices_trigger ON freight_orders;
CREATE TRIGGER postal_lock_posted_order_prices_trigger
BEFORE UPDATE ON freight_orders
FOR EACH ROW EXECUTE FUNCTION postal_lock_posted_order_prices();

CREATE OR REPLACE FUNCTION postal_lock_posted_order_addons()
RETURNS TRIGGER AS $postal_addon_lock$
DECLARE
  target_order_id UUID;
BEGIN
  target_order_id := CASE WHEN TG_OP='INSERT' THEN NEW.order_id ELSE OLD.order_id END;
  IF EXISTS (
    SELECT 1 FROM freight_orders
    WHERE id=target_order_id AND
      (price_locked_at IS NOT NULL OR shipped_at IS NOT NULL OR NULLIF(tracking_code,'') IS NOT NULL
       OR status IN ('LABEL_AVAILABLE','LABEL_AVAILABLE_SIMULATED'))
  ) THEN
    RAISE EXCEPTION 'Não é permitido adicionar, alterar ou excluir cobranças após a postagem.'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    IF EXISTS (
      SELECT 1 FROM freight_orders
      WHERE id=NEW.order_id AND
        (price_locked_at IS NOT NULL OR shipped_at IS NOT NULL OR NULLIF(tracking_code,'') IS NOT NULL
         OR status IN ('LABEL_AVAILABLE','LABEL_AVAILABLE_SIMULATED'))
    ) THEN
      RAISE EXCEPTION 'Não é permitido transferir cobranças para um pedido já postado.'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$postal_addon_lock$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postal_lock_posted_order_addons_trigger ON order_addons;
CREATE TRIGGER postal_lock_posted_order_addons_trigger
BEFORE INSERT OR UPDATE OR DELETE ON order_addons
FOR EACH ROW EXECUTE FUNCTION postal_lock_posted_order_addons();
`;

module.exports = {pricingLockSql};

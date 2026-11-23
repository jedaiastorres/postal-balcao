"use strict";

// Correções de dados cadastrais: nunca altera a cotação, o pagamento ou o pacote.
const EDITABLE_STATUSES = new Set([
  "SHIPMENT_ERROR", "PROVIDER_PAYMENT_PENDING", "PAYMENT_SETUP_PENDING",
  "PARTNER_FINANCIAL_SETUP_REQUIRED"
]);
const RETRY_STATUSES = new Set([
  "SHIPMENT_ERROR", "PROVIDER_PAYMENT_PENDING", "PAID_WAITING_SHIPMENT",
  "PAYMENT_CONFIRMED"
]);
const PARTY_FIELDS = ["name","document","phone","email","address","number","neighborhood","complement","city"];
const digits = value => String(value ?? "").replace(/\D/g, "");

function validDocument(value) {
  const number = digits(value);
  if (![11,14].includes(number.length) || /^(\d)\1+$/.test(number)) return false;
  if (number.length === 11) {
    const check = size => {
      let sum=0;
      for (let i=0;i<size;i++) sum+=Number(number[i])*(size+1-i);
      return ((sum*10)%11)%10;
    };
    return check(9)===Number(number[9]) && check(10)===Number(number[10]);
  }
  const calculate = length => {
    const weights = length===12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum=weights.reduce((acc,w,i)=>acc+w*Number(number[i]),0);
    return sum%11<2?0:11-sum%11;
  };
  return calculate(12)===Number(number[12]) && calculate(13)===Number(number[13]);
}

function canEditOrder(order) {
  return !!order && EDITABLE_STATUSES.has(String(order.status)) &&
    !order.is_simulation && !order.conect_cart_id && !order.conect_package_id &&
    !order.tracking_code && !order.shipped_at &&
    !order.label_a4_url && !order.label_a6_url &&
    String(order.provider_payment_status||"").toUpperCase()!=="PROCESSING";
}

function canRetryShipment(order) {
  if (!order || String(order.payment_status).toUpperCase()!=="PAID" ||
      order.is_simulation || !RETRY_STATUSES.has(String(order.status))) return false;
  if (order.conect_cart_id || order.conect_package_id) return true;
  const providerStatus=String(order.provider_payment_status||"").toUpperCase();
  if(providerStatus==="REJECTED_INPUT" &&
     /servi[cç]o selecionado|servi[cç]o postal|valor da declara[cç][aã]o|documento fiscal/i.test(
       String(order.provider_payment_last_error||"").toLowerCase())) return false;
  return ["AWAITING_FUNDS","REJECTED_INPUT"].includes(providerStatus) ||
    Number(order.provider_payment_attempts||0)===0;
}

function correctedParty(previous, submitted, label) {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw Object.assign(new Error("Informe os dados de "+label+"."),{status:400});
  }
  const value={...(previous||{})};
  for (const field of PARTY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(submitted,field)) {
      value[field]=String(submitted[field]??"").trim().slice(0,field==="address"?200:120);
    }
  }
  value.document=digits(value.document);
  value.phone=digits(value.phone);
  for(const field of ["name","document","phone","address","number","neighborhood","city"]){
    if(!String(value[field]||"").trim()) {
      throw Object.assign(new Error("Preencha "+field+" de "+label+"."),{status:400});
    }
  }
  if (!validDocument(value.document)) {
    throw Object.assign(new Error("CPF/CNPJ de "+label+" é inválido. Confira os dígitos verificadores."),{status:400});
  }
  if (value.phone.length<10 || value.phone.length>11) {
    throw Object.assign(new Error("Telefone de "+label+" deve ter DDD e 10 ou 11 dígitos."),{status:400});
  }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)){
    throw Object.assign(new Error("E-mail de "+label+" é inválido."),{status:400});
  }
  if (digits(value.cep).length!==8) {
    throw Object.assign(new Error("CEP de "+label+" é inválido."),{status:400});
  }
  return value;
}

function providerErrorSummary(input) {
  const raw=String(input||"").toLowerCase();
  const invalidService=/postal_service_name|servi[cç]o postal.*inv[aá]lid|nome do servi[cç]o postal|servi[cç]o selecionado|mapeamento do servi[cç]o/i.test(raw);
  const invalidDeclaration=/declaration|declara[cç][aã]o|valor em r\$|valor declarado/i.test(raw);
  if (invalidService && invalidDeclaration)
    return "A integração recusou o serviço selecionado e o valor da declaração. O cadastro do cliente não resolve isso; é necessária correção da integração ConectEnvios.";
  if (invalidService)
    return "O serviço postal selecionado foi rejeitado pela ConectEnvios. Revise o mapeamento do serviço antes da emissão.";
  if (invalidDeclaration)
    return "O valor da declaração de conteúdo foi rejeitado. Não altere o valor real sem confirmar a regra da transportadora.";
  if (/cpfcnpj|cpf\/cnpj|cpf|cnpj|documento|document/.test(raw))
    return "Documento rejeitado. Confira o CPF/CNPJ do remetente e destinatário.";
  if (/logradouro|endereço|endereco|bairro|neighborhood|street|address/.test(raw))
    return "Endereço rejeitado pela integração. Confira logradouro, número e bairro.";
  if (/cep|postal.?code|zipcode|zip.?code/.test(raw))
    return "CEP rejeitado pela transportadora. Confira a origem e o destino.";
  if (/telefone|phone|celular/.test(raw))
    return "Telefone rejeitado. Confira o DDD e os números informados.";
  if (/saldo|balance|carteira|wallet|insuficient|pagamento|payment/.test(raw))
    return "Saldo ou liberação financeira pendente na ConectEnvios.";
  if (/declara|nota fiscal|nfe|nf-e|receipt|invoice/.test(raw))
    return "Documento fiscal ou declaração de conteúdo rejeitado pela transportadora.";
  if (!raw.trim())return "";
  return "A ConectEnvios não concluiu a emissão. Confira os dados e o histórico; se já houve tentativa, solicite conferência antes de repetir.";
}

module.exports={validDocument,canEditOrder,canRetryShipment,correctedParty,providerErrorSummary};

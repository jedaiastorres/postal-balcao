const test = require("node:test");
const assert = require("node:assert/strict");

// Intercepta as requisições: estes testes nunca acessam a API real do Asaas.
process.env.ASAAS_API_KEY = "$aact_hmlg_teste_local_sem_validade";
const asaas = require("../asaas");

async function checkoutPayload(customerData) {
  const previousFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ id: "checkout_teste", status: "ACTIVE" })
    };
  };
  try {
    await asaas.createCheckout({
      orderId: "TOPUP-TEST", billingType: "PIX", amount: 36.85,
      itemName: "Adicionar saldo Postal", customerData
    });
    return payload;
  } finally {
    global.fetch = previousFetch;
  }
}

test("recarga sem endereço cadastrado abre Checkout sem pré-preenchimento incompleto", async () => {
  const payload = await checkoutPayload({
    name: "Cliente Teste", cpfCnpj: "12345678901", email: "cliente@example.com"
  });
  assert.equal(Object.hasOwn(payload, "customerData"), false);
  assert.equal(payload.items[0].value, 38.84);
});

test("recarga com endereço completo mantém os dados do pagador", async () => {
  const payload = await checkoutPayload({
    name: "Cliente Teste", cpfCnpj: "12.345.678/0001-00",
    address: "Rua das Flores", addressNumber: "10", province: "Centro",
    postalCode: "68515-000", complement: "Sala 2"
  });
  assert.deepEqual(payload.customerData, {
    name: "Cliente Teste", cpfCnpj: "12345678000100",
    address: "Rua das Flores", addressNumber: "10",
    complement: "Sala 2", postalCode: "68515000", province: "Centro"
  });
});

test("recarga com endereço parcialmente cadastrado não envia customerData inválido", async () => {
  const payload = await checkoutPayload({
    name: "Cliente Teste", cpfCnpj: "12345678901",
    address: "Rua das Flores", postalCode: "68515000", province: "Centro"
  });
  assert.equal(Object.hasOwn(payload, "customerData"), false);
});

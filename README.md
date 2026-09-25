# Postal Balcão

Plataforma web da Postal Serviços para pontos parceiros, com cotação via ConectEnvios API V1. Precificação atual: 20% de comissão do ponto e 12% de margem Postal sobre o preço final.

## Integração

- Base: `https://app.conectenvios.com.br/api/v1`
- Cotação: `POST /package/shipping`
- Prazo: `POST /package/deadline`
- Criação de envio: `POST /cart` (bloqueada por padrão até homologação)
- Rastreamento: endpoints `/package/track/...`

## Variáveis

Use `.env.example` como referência. Nunca faça commit do token da ConectEnvios.

## Execução

```bash
npm install
npm start
```

Healthcheck: `/health`.


## Fluxo V1.2

A V1.2 adiciona o fluxo operacional completo de preparação da postagem:

- cotação real pela ConectEnvios;
- escolha do serviço;
- token assinado para impedir alteração do preço/serviço cotado;
- cadastro de remetente e destinatário;
- preenchimento automático de endereço por CEP;
- nota fiscal ou declaração de conteúdo;
- confirmação da forma de pagamento;
- criação preparada via `POST /cart`;
- retorno de código de rastreio;
- etiqueta A6;
- comprovante térmico de postagem em 80 mm (configurável também para 58 mm).

O comprovante do remetente contém data/hora, rastreio, remetente, destinatário, transportadora, serviço, prazo, peso, dimensões, valor declarado, conteúdo, forma de pagamento, total pago e IDs da postagem/pacote.

A emissão real continua protegida por `ENABLE_SHIPMENT_CREATION=false` até a homologação final do fluxo.


## V1.4 — taxas, produtos, estoque e API aberta

A V1.4 protege as margens do frete acrescentando a taxa de pagamento ao valor cobrado do cliente. A taxa é calculada conforme a forma de pagamento antes da criação do pedido:

- PIX: taxa configurável do Asaas somada ao total;
- cartão: gross-up da taxa percentual + fixa para que o líquido preserve as partes do ponto, Postal e custo logístico;
- dinheiro: a taxa de PIX usada no repasse posterior do ponto é somada ao valor cobrado do cliente. O ponto mantém sua receita e repassa apenas o restante + a taxa necessária para liquidar o pagamento.

Os valores de taxa são configuráveis por ambiente e não ficam hardcoded como regra comercial definitiva.

### Produtos e serviços adicionais

Existe um catálogo genérico com dois tipos:

- `PRODUCT`: produto físico, com controle de estoque opcional;
- `SERVICE`: serviço adicional, sem necessidade de estoque físico.

Os produtos físicos podem ser recebidos e ajustados pelo ponto. O ponto pode definir seu preço de venda. O sistema controla quantidade física, quantidade reservada, saldo disponível e estoque mínimo.

O catálogo inicial cria, sem preço e sem estoque, alguns itens de embalagem: caixa pequena, média e grande, envelope plástico e envelope com bolha. O ponto define preço e dá entrada no estoque antes de vendê-los.

Cada item possui divisão financeira configurável entre ponto, Postal e provedor externo. Isso permite, por exemplo, embalagens com 100% da receita para o ponto ou serviços futuros com outra regra de comissão.

### API de integrações v1

A API para integrações externas é versionada e protegida por `x-api-key`:

- `GET /api/integrations/v1/catalog/items`
- `PUT /api/integrations/v1/catalog/items/:code`
- `POST /api/integrations/v1/inventory/receive`

O modelo do catálogo inclui `externalProvider`, `externalRef` e `metadata`, permitindo acrescentar futuramente serviços de terceiros, seguros, assistência, linhas de crédito, conveniências e outros produtos sem redesenhar o núcleo do Postal Balcão.

Nunca exponha `INTEGRATION_API_KEY`, `ASAAS_API_KEY` ou tokens da ConectEnvios no frontend.

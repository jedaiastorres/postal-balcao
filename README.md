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

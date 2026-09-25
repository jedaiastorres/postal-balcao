# Postal Balcão

Plataforma web da Postal Serviços para pontos parceiros, com cotação via ConectEnvios API V1.

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

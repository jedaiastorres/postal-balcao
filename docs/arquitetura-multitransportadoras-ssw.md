# Integração multi-transportadoras e SSW — Fase 1

## Princípio
Uma transportadora (carrier) representa a empresa jurídica que efetua a operação; um provider representa seu software de integração (SSW, ConectEnvios, API própria, EDI). Diversas transportadoras poderão usar o mesmo provider SSW, mas cada uma terá domínio, usuário, autorização e configuração isolados.

```
Cotador/Postagem Postal
  -> Carrier Registry (carrier_id, provider, capabilities, active)
  -> Eligibility (origem/destino/CEP/peso/prazo)
  -> Adapter do provider (SSW / ConectEnvios / Custom / EDI)
  -> Resposta normalizada (cotação, serviço, pedido, rastreio)
```

## Plano de banco (ainda NÃO aplicado)
- `carriers(id, name, legal_name, cnpj, provider, active, capabilities, created_at, updated_at)`
- `carrier_connections(id, carrier_id, provider, credential_ref, config_public, status, last_test_at)`
- `carrier_routes(id, carrier_id, active, origin, destination, cep_start, cep_end, max_weight_kg, price_policy, deadline_policy)`
- `carrier_shipments(id, carrier_id, order_id, external_id, state, tracking_number, created_at)`
- `carrier_events(id, carrier_id, shipment_id, source_event_id, status, occurred_at, payload)`

Cada consulta e alteração de dados deve verificar o `carrier_id`; parâmetros externos não podem conceder acesso cruzado. Credenciais devem ficar em armazenamento de segredos no servidor e nunca em logs, frontend ou JSON público. Evitar duplicatas com idempotência por transportadora e pedido.

## SSW: documentos oficiais
- Índice: https://ssw.inf.br/ajuda/
- Cotação SOAP: https://ssw.inf.br/ws/sswCotacao/help.html
- Cotação + coleta SOAP: https://ssw.inf.br/ws/sswCotacaoColeta/help.html
- Token WebAPI: https://ssw.inf.br/ajuda/generateToken.html
- Recepção NOTFIS: https://ssw.inf.br/ajuda/notfis.html
- Consultas gerais: https://ssw.inf.br/ajuda/consultaGenerica.html
- Etiquetas: https://ssw.inf.br/ajuda/consultaNr.html

**Condições:** token WebAPI válido por seis horas, autorização EDI ssw2173 para gerar token e ssw1864 para NOTFIS, limite publicado de 20 requisições/segundo. Implementar limitação compartilhada, filas, backoff e segregação por tenant; conferir semântica de erros SOAP e requisitos por endpoint.

### Dados necessários por transportadora SSW
- Sigla de domínio SSW da empresa
- Usuário técnico de integração (não solicitar senha via chat)
- CNPJ autorizado para EDI/token
- CNPJ pagador do frete para cotação; tabelas e códigos de mercadoria habilitados
- Fluxo fiscal: NF-e, CT-e, pré-DC-e e regras de documentos específicos
- Unidades, rotas, política comercial e operação de coleta

### Fluxos
1. **Cotação:** selecionar transportadoras elegíveis, consultar preço/prazo de cada uma com credenciais específicas, aplicar margem da plataforma, armazenar snapshot assinado da oferta.
2. **Contratação:** cobrar; apenas após confirmação enviar a operação à transportadora; tratar retentativas e idempotência.
3. **SSW:** na cotação há WebService SOAP; NOTFIS recebe NF e permite geração posterior de CT-e, não equivale a criação instantânea garantida de CT-e. Definir serviço adequado para cada caso documental após homologação.
4. **Rastreio:** normalizar ocorrências e preservar IDs externos, timestamps e comprovantes.
5. **Hub/CEP máscara:** manter endereço real do cliente e endereço operacional do hub em campos distintos; nunca alterar o documento fiscal ou etiqueta da transportadora para simular origem falsa; taxa de transferência R$ 5 por pacote é receita da plataforma, não comissão do ponto.

## Critérios de liberação
- Testes unitários e integração em ambiente seguro
- Segurança de múltiplos tenants e autenticação
- Validação da cobertura, peso, cubagem, preço e prazo
- Retentativa idempotente, falhas externas e rate limit
- Homologação de documentos fiscais, etiqueta e rastreio por transportadora
- Habilitar flag de cotação por transportadora somente depois da homologação

Nenhuma funcionalidade deste documento está automaticamente habilitada em produção.

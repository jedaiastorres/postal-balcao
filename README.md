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


## V1.5 — multi-ponto, master, homologação e crédito

A V1.5 transforma o Postal Balcão em uma plataforma multi-ponto:

- pontos físicos independentes com comissão própria;
- usuários individuais com perfis ADMIN, STORE_OWNER, STORE_CLERK e OPS;
- sessão assinada, proteção CSRF, limitação de tentativas de login e trilha de auditoria;
- Painel Master da Postal para pontos, usuários, catálogo, comissões, wallet Asaas, crédito e auditoria;
- Meus Fretes com pesquisa, filtros, linha do tempo e segunda via;
- modo de homologação de pagamentos enquanto o Asaas não estiver ativo;
- etiqueta A6 simulada claramente marcada como sem validade logística;
- estoque por ponto com entrada, lote, custo médio, preço, margem, estoque mínimo, reservas, movimentações e CSV;
- catálogo central extensível de produtos e serviços;
- módulo Crédito no Balcão com parceiros, produtos, leads e consentimento;
- API versionada para catálogo, estoque e atualizações de propostas financeiras;
- exportação operacional em JSON pelo administrador.

### Segurança do simulador

O simulador só funciona quando `PAYMENT_SIMULATOR_ENABLED=true` e o Asaas ainda não está configurado. Ele nunca chama a ConectEnvios para criar uma postagem real e toda etiqueta gerada nesse modo é marcada como HOMOLOGAÇÃO — NÃO POSTAR.

### Perfis

- `ADMIN`: administração completa da rede;
- `STORE_OWNER`: operação e gestão financeira/estoque do próprio ponto;
- `STORE_CLERK`: cotação, atendimento, pagamentos e crédito do próprio ponto;
- `OPS`: leitura operacional e gestão física de estoque, sem acesso ao crédito ou painel master.

### Exportação e recuperação

O Painel Master possui exportação operacional JSON contendo os dados de negócio do PostgreSQL, sem hashes de senha. Isso complementa o volume persistente do PostgreSQL; snapshots físicos do banco devem ser configurados no provedor de infraestrutura conforme a política de backup adotada.


## V1.6 — portal cliente, saldo, integrações, coletas e indicação

A V1.6 acrescenta uma experiência de autoatendimento para clientes da Postal Serviços, separada da operação de balcão dos pontos parceiros.

### Conta e saldo do cliente

- perfil `CLIENT` com cadastro próprio e sessão individual;
- carteira pré-paga Postal com extrato de créditos e débitos;
- recarga por PIX/cartão preparada para Asaas;
- a taxa financeira da recarga é acrescentada ao pagamento para que o valor creditado permaneça integral;
- enquanto o Asaas não estiver ativo, recargas funcionam somente em homologação e não movimentam dinheiro real;
- cada frete do cliente é debitado do saldo antes da emissão;
- se a emissão real estiver desativada e o Asaas já estiver em produção, o sistema bloqueia o débito para não consumir saldo sem gerar etiqueta.

### Primeira milha

Cada etiqueta do portal cliente representa um pacote e acrescenta **R$ 5,00 por pacote**:

- coleta no endereço: um ponto habilitado pode receber **R$ 3,00** e os **R$ 2,00** restantes ficam com a Postal;
- postagem em ponto Postal: o ponto escolhido recebe **R$ 2,00** e os **R$ 3,00** restantes ficam com a Postal;
- pontos parceiros podem aderir ou sair da rede de coletas, definir raio operacional e informar coordenadas;
- o roteamento usa coordenadas quando disponíveis e, como fallback, CEP/cidade;
- solicitações sem um ponto compatível permanecem no painel da Postal para direcionamento manual;
- pagamentos aos pontos são registrados em ledger próprio e são idempotentes.

### Indicação de clientes

Cada ponto possui código/link rastreável. Clientes cadastrados pelo link ou diretamente pelo ponto ficam vinculados ao indicador. Para cada envio efetivamente emitido desse cliente, o ponto acumula **R$ 0,50**. Envios de homologação geram apenas lançamentos simulados.

### E-commerce em marca Postal

O portal apresenta as integrações sob a marca Postal Serviços. O backend mantém uma camada de ponte para o provedor logístico, sem enviar tokens da ConectEnvios ao navegador.

Plataformas preparadas no catálogo de conexão:
- Nuvemshop;
- WooCommerce;
- Loja Integrada;
- Shopify;
- Tray.

A ConectEnvios publica que possui API REST e integrações com e-commerces/ERPs e cita publicamente Nuvemshop, WooCommerce, Loja Integrada e Shopify. A Tray possui um aplicativo público da ConectEnvios. Entretanto, a documentação pública da API V1 disponível para este projeto não expõe endpoints de provisionamento/OAuth dessas integrações nativas. Por isso, a V1.6 cria a conexão Postal com status `AWAITING_PROVIDER_AUTH` e disponibiliza uma API de ponte para receber a ativação e os pedidos quando a ConectEnvios fornecer os dados privados de autorização.

Endpoints da ponte:
- `PATCH /api/integrations/v1/ecommerce/connections/:id`
- `POST /api/integrations/v1/ecommerce/connections/:id/orders`

### Painéis de coletas

- cliente: acompanha sua coleta/postagem no ponto;
- ponto: recebe e atualiza coletas atribuídas;
- Postal ADMIN: visualiza todas as solicitações e pode direcionar/reencaminhar para um ponto;
- ponto parceiro: acompanha ganhos de coleta, postagem e indicação.

### Segurança e dados

- saldo é mantido em ledger e as baixas de saldo + criação do frete são atômicas no PostgreSQL;
- recargas têm chave de idempotência;
- criação de ganhos do ponto usa restrição única por referência;
- tokens dos provedores continuam somente no servidor;
- exportação operacional ADMIN inclui clientes, carteira, recargas, conexões de e-commerce, coletas e ganhos dos pontos;
- backups diários do volume PostgreSQL devem permanecer ativos na infraestrutura.

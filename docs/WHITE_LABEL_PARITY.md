# White Label — paridade funcional com Postal Balcão

## Princípio obrigatório

O White Label é **a mesma plataforma Postal Balcão**, com a identidade visual e as políticas comerciais da transportadora configuradas por empresa. **Não** é um produto simplificado nem uma operação fora da Postal. A evolução deve convergir para componentes e serviços compartilhados, evitando cópias divergentes.

O tenant (transportadora), a unidade, o cliente e o pedido sempre têm escopo persistido e validado pelo servidor. Um White Label jamais visualiza ou altera recursos de outro, nem acessa recursos administrativos da Postal.

## Situação do primeiro marco (24/11/2026)

| Módulo | Situação no White Label | Origem compartilhada |
|---|---|---|
| Marca, cores, nome | Implementado | CSS padrão Postal + tema |
| MASTER, operador, unidades | Implementado | Banco White Label segregado |
| Cadastro de clientes fixos | Implementado | WL com vinculação ponto/tenant |
| **Acesso do cliente fixo, sessão e troca de senha** | **Implementado neste marco** | Autenticação reutiliza hash seguro |
| **Cotação manual e regional + transportadoras integradas** | **Implementado neste marco (simulação)** | Regras de precificação e consulta do Postal |
| **XML NF-e/DC-e** | **Implementado neste marco** | `public/fiscal_document.js` original |
| **Consulta por chave NF-e/DC-e com autorização e CPF/CNPJ vinculado** | **Implementado neste marco se provedor estiver habilitado** | Serviço fiscal original |
| **Cotações de até cinco volumes** | **Implementado neste marco (simulação)** | Adaptador da mesma API integrada |
| **Endereços salvos do cliente** | **Implementado neste marco** | Interface / banco do tenant |
| **Planilha modelo e validação** | **Implementado neste marco, sem emissão** | `bulk_shipping.js` original |
| Coletas da transportadora | Implementado como ordens internas | Fluxo WL atual |
| Coletas iniciadas pela conta do cliente | Pendente | Deve conectar ordens ao cliente/tenant |
| Pedidos, pagamento, etiquetas A6, reprocessar e comprovantes | Pendente | Não ativar antes da paridade financeira |
| Carteira Asaas para cliente, MASTER e ponto, split de pagamento | Pendente | Homologar 3 destinatários e estornos |
| Rastreamento marca própria e cadeia de eventos | Pendente no cliente WL | Reutilizar rastreio Postal com tenant |
| Importação de planilhas com emissão real | Pendente | Usar a mesma máquina de estados do Postal |
| Integrações WooCommerce/Nuvemshop/Shopify | Pendente no cliente WL | Webhooks/credenciais isolados por tenant |
| Cotação pública sem login | Pendente no WL | Reaproveitar formulário público Postal |
| Catálogo, produtos extras, estoque, QR, scanner, relatórios | Pendente no WL | Módulos compartilhados |
| Dashboards comerciais e financeiros consolidados Postal | Pendente | DRE/ERP com rateio por tenant |

## Política financeira obrigatória — sem dupla comissão

1. **Rotas próprias:** preço da transportadora White Label, menos a **taxa contratual Postal** (percentual + valor fixo), determina a parcela White Label. A parcela White Label é dividida entre ponto e MASTER segundo a taxa do ponto ou override específico do cliente. A taxa Postal não é descontada de novo.
2. **Transportadoras integradas:** preço de venda considera custo do provedor + **margem Postal** + **comissão comercial White Label** definida no MASTER Postal. A comissão White Label é dividida entre ponto e MASTER. A soma não pode superar a receita líquida disponível.
3. **Operação real (futura):** quando ocorrer emissão, congelar por pedido `tenant_id`, `client_id`, `point_id`, `carrier_mode`, `gross_sale`, `provider_cost`, `postal_fee`, `postal_margin`, `white_label_share`, `point_share`, `master_share`, e condições/tabelas usadas no momento. Nunca recalcular pedidos passados com tarifas atuais.
4. **Asaas:** os splits devem ser verificados e conciliados com as carteiras Asaas de Postal, MASTER White Label e ponto; pendências, falhas, cancelamentos, estornos e pagamentos parciais precisam de tratamento e idempotência. Nenhum repasse ou emissão pode ocorrer sem autorização e testes de homologação.
5. **Cliente e operador:** nunca retornam custo do provedor, comissões ou Wallet IDs por endpoints públicos/operacionais; MASTER Postal acompanha a soma e os saldos de todos os White Labels, MASTER do WL só sua empresa, operador só seu ponto, cliente só sua conta.

## Regras de equivalência

- Para toda funcionalidade nova no Postal Balcão, adicionar caso de teste verificando uso no White Label, mesmo componente/serviço quando possível e branding isolado.
- Nenhum novo módulo deve parecer operacional se ainda não puder gravar/consultar dados reais do próprio tenant. Exibir explicitamente **Em homologação** nesses casos.
- O mesmo input deve produzir mesma validação de XML, CEP, NF-e/DC-e, volumes, importação XLSX/CSV, prazos e serviços, sujeito às tarifas e contratos do tenant.
- Conservar o fluxo de etiqueta, pedido, pagamento, rastreio e comprovante que já funciona no Postal Balcão. **Não** desviar uma conta White Label para APIs globais sem `tenant_id` validado.
- A marca Postal pode ser responsável pelo software nos contratos, mas não aparece na frente do cliente do White Label, exceto por requisito legal.

## Critérios para liberar paridade integral

A equivalência só estará concluída quando todos os módulos marcados como **Pendente** estiverem implementados, com testes E2E por papel, dois tenants diferentes, falha de provedor, concorrência, cobrança, split, reprocessamento e estorno. Até lá, o cliente pode cotar e preparar dados, mas **não emitir ou pagar** pelo White Label.


## Rede integrada Postal + White Label — marco 2026-11-25

Modelo comercial aprovado: **a empresa que vende mantém o cliente, a cobrança e a responsabilidade comercial**. A Postal recebe a comissão contratada (uma única vez), mesmo quando outra empresa faz a coleta, transferência ou entrega. Os operadores só participam após adesão e aceitação voluntária.

Implementado neste marco:
- Cadastro de participação na rede por MASTER (opt-in), nunca por operador/cliente; a Postal opta em seu próprio MASTER.
- Serviços e preços ofertados para **COLETA**, **TRANSFERÊNCIA** e **ENTREGA**, com faixas de CEP, pesos, horas e valores; o preço da etapa pertence ao operador escolhido.
- Busca compartilhada de serviços em CEPs comuns, com propostas envolvendo duas ou três etapas e ao menos uma empresa executora diferente da vendedora.
- Confirmação de aceite por cada transportadora, rejeição, cancelamento e acompanhamento das etapas por vendedor, executor e MASTER Postal.
- Identificador de rastreio reservado por pedido, histórico de alterações e congelamento de composição comercial em centavos: venda bruta = comissão Postal + soma das etapas + margem do vendedor.
- Controles para não misturar empresas, impedir alterações de etapas de outras transportadoras, evitar duplicidade da mesma proposta e impedir início de execução sem pagamento efetivamente conciliado.
- Logomarca J&T Express fornecida pelo usuário, mapeada no catálogo compartilhado de imagens de cotações.

**Pagamento real ainda bloqueado:** o Postal Balcão possui credencial Asaas central, mas o modelo comercial adotado requer que **a conta da empresa vendedora emita a cobrança**, com recebedores autorizados. Antes de produzir efeitos financeiros, precisamos de credencial/API da empresa vendedora ou mecanismo aprovado de subconta, wallets verificadas para cada executora, split habilitado, webhook de pagamento e de liquidação, estorno parcial/total, divergências, conciliação e tratamento de falhas. O uso de walletId isolado não autoriza debitar cliente. O código de rede não executa cobranças, repasses ou emissão automática.

Regra Asaas a integrar na próxima etapa: a carteira emissora não deve constar como recebedora do próprio split; cada recebedor recebe valor fixo efetivo somente até o líquido de taxas Asaas, e eventual divergência bloqueia conciliação. O lançamento de receita de etapa executada só poderá ser reconhecido após evento de execução com prova e liquidação validada.

A rede integrada **não deve receber acesso a carteiras ou chaves de API de terceiros**; informações financeiras internas são exibidas apenas à empresa vendedora e ao MASTER Postal. Na próxima etapa, disponibilizar rastreio público apropriado e conciliação por webhooks; até lá a operação interempresas fica em estágio de contratação/aceite.

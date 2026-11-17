# Clientes e coletas do ponto

## Regras aplicadas nesta alteração

| Mudança | Permissão e escopo | Regra financeira |
| --- | --- | --- |
| Clientes do ponto | STORE_OWNER e STORE_CLERK do ponto ativo; lista pelo referral_store_id | Cadastro não credita carteira nem cria ganho de indicação |
| Cadastro de conta cliente | Usuário CLIENT novo, vínculo fixado no servidor; e-mail duplicado retorna 409 | Usuário e conta criados juntos em transação; não sobrescreve conta, senha ou indicação existente |
| Uso do cliente como remetente | Contatos e endereço do próprio ponto, conferidos pelo operador | Invalida cotação anterior; recalcular antes de vender |
| Coleta pela cotação | Dono/atendente; preenche dados e número de volumes; operador confirma endereço e data | Somente cria solicitação; não cria postagem nem debita carteira |
| Coleta avulsa em Coletas | Dono/atendente, ponto ativo; cliente cadastrado deve pertencer ao ponto; também aceita contato manual sem login | Valor previsto pela taxa configurada; sem cobrança, repasse ou ganho automático enquanto não houver pagamento vinculado |
| Conclusão e remuneração | Ponto atribuído; transições válidas; concluída/cancelada não pode voltar ou mudar de ponto | Exige frete vinculado com payment_status PAID e taxa de primeira milha suficiente; homologação gera SIMULATED; registro único por referência |
| Atribuição administrativa | ADMIN/SUPERVISOR; destino ativo e habilitado; bloqueada após conclusão | Recalcula divisão sem saldo negativo e ajusta receita da primeira milha na mesma transação |
| Cancelamento de coleta paga | Bloqueado neste endpoint enquanto faltar o fluxo de estorno correspondente | Impede encerrar uma coleta cobrada sem tratar o dinheiro do cliente |
| Operador OPS | Pode acompanhar/avançar coleta atribuída; não cadastrar clientes nem criar coleta | Não recebe remuneração/repasse da coleta nas respostas |
| Internacional | Removido da interface | Nenhuma oferta externa é apresentada como serviço integrado |

As permissões atuais são novamente consultadas no banco nos endpoints alterados. Sessões de usuários desativados, com perfil ou ponto alterado, e pontos inativos são recusadas. Dono e atendente não acessam carteiras ou senhas dos clientes pela listagem; o atendente continua sem acesso aos ganhos do ponto. Senha inicial gerada é exibida somente no cadastro bem-sucedido e não é persistida no navegador.

## Configuração e consistência

CLIENT_PICKUP_FEE_PER_PACKAGE define o preço previsto por pacote; POINT_PICKUP_EARNING_PER_PACKAGE e POINT_DROPOFF_EARNING_PER_PACKAGE definem divisão operacional. A divisão não pode superar a taxa. Quantidades devem ser inteiras de 1 a 200. Os cálculos da coleta são feitos em centavos; a interface usa a configuração pública, não um preço fixo de R$ 5.

POST /api/store/collections exige requestKey UUID. Repetições do mesmo operador/chave retornam o registro original, sem duplicação. Uma solicitação já redirecionada a outro ponto não é devolvida ao ponto anterior pelo replay. As atualizações usam conexão PostgreSQL reservada, trava de linha e transação para estado, atribuição, receita e ganho. A criação da conta cliente usa INSERT simples (sem upsert de usuário) e transação, preservando contas existentes mesmo em disputa por e-mail.

Criar coleta avulsa é uma operação operacional, não uma confirmação de pagamento. Nenhum registro antigo de ganhos foi apagado ou reclassificado; se já houver ganhos gerados por coletas avulsas no ambiente real, é necessária conciliação antes de qualquer correção contábil. Fluxos existentes do portal cliente com débito de carteira e emissão de frete permanecem separados; a nova tela não pode gastar saldo do cliente em seu nome.

## Verificações

- Regras unitárias: taxas configuráveis, contagem inválida, repasse impossível, estados finais e pagamento insuficiente.
- PostgreSQL embarcado (PGlite, somente dependência de desenvolvimento): migração repetível, isolamento de clientes por ponto, e-mail duplicado sem sobrescrita, rollback sem conta órfã, criação repetida de coleta, tentativa de atualização por outro ponto, conclusão sem pagamento sem ganho ou débito, ganho único real/simulado e bloqueio de cancelamento pago.
- Middleware: usuário desativado, troca de perfil/ponto e ponto inativo.
- Chromium com API simulada: cadastro por atendente, reutilização do cliente, preço configurado de R$ 7,50, criação com CSRF, atalho pela cotação, restrição de OPS e layout em computador/celular.

Os testes embarcados não substituem a homologação no PostgreSQL de produção, em sessões concorrentes independentes, com pagamentos e provedores reais. Nenhuma cobrança, postagem, migração de produção ou implantação foi executada nesta tarefa.

## Para alterações seguintes

Antes de mudar cada fluxo, conferir perfil, escopo do ponto/cliente, estados permitidos, cobrança versus previsão, saldo, composição de taxas/comissões/repasses, homologação versus produção, repetição de requisição e estorno. Reutilizar as regras existentes; se a regra não estiver documentada ou implementada, expor a limitação em vez de simular integração ou movimentação financeira.

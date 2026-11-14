# Postagens em massa — Cliente Postal

## Operação
1. O cliente baixa /api/client/bulk/template na tela Pedidos e etiquetas.
2. Preenche a aba Envios, uma linha por pedido, com pedido_referencia única para sua conta.
3. Importa XLSX ou CSV. O arquivo é lido em sessão autenticada, validado e não fica armazenado nessa etapa.
4. Calcula cotações individualizadas pela ConectEnvios, revisa os preços e escolhe serviço para cada linha.
5. Confirma explicitamente o total e contrata com Saldo Postal. Os pedidos são debitados separadamente e ficam na Central de Pedidos.
6. Etiquetas liberadas podem ser impressas em lote. As pendentes seguem o fluxo de revisão e reprocessamento. Coleta em lote é solicitada separadamente.

## Campos e limites
- Uma linha por pedido. Até 100 pedidos e arquivo até 900 KB.
- Peso e medidas são de cada volume. Quantidade_volumes de 1 a 50; valor_declarado_total é distribuído entre volumes.
- documento_tipo: NFE, DCE ou DECLARACAO. NFE/DCe exigem chave fiscal de 44 dígitos com modelos 55/99.
- A importação não equivale a consulta fiscal autorizada e não autentica XML ou chaves automaticamente.
- pedido_referencia não deve ser reutilizada para um pedido diferente: repetições localizam o pedido anterior sem novo débito.

## CEP máscara para clientes
- Planilha contém CEP real do remetente e destinatário.
- O servidor seleciona hub ativo cadastrado para o CEP real; não utiliza ponto indicador de outro município como origem.
- Quando aplicável, a cotação utiliza a origem operacional e cobra R$ 5 por volume ao hub/MASTER.
- Campos do endereço real permanecem no pedido; a etiqueta externa seguirá as regras da transportadora e a origem operacional.
- Valores de transferência são gravados separadamente nos lançamentos financeiros dos clientes.

## Segurança
- Importação, template e contratação exigem sessão CLIENT.
- Dados do arquivo são validados e fórmulas são rejeitadas.
- Preços só são contratados por seleção assinada do backend.
- Debitar e registrar o pedido usa transação no mesmo cliente PostgreSQL e chave idempotente única por cliente/referência.
- Conferir que a etiqueta realmente está disponível antes de considerar uma postagem pronta para expedição.

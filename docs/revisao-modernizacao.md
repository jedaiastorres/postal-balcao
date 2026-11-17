# Modernização e revisão do Postal Balcão

Interface: refinamento do login, navegação, painel e formulários, preservando a marca Postal. Estados de foco visíveis, movimento reduzido, menu com Escape e identificação acessível.

Correções:
- Cookies malformados são ignorados sem lançar URIError na autenticação.
- Histórico local corrompido, indisponível ou com formato inválido deixa de bloquear a interface.
- Impressão de documentos envia o token CSRF exigido pelo servidor.
- Proxy de documentos valida origem e caminho normalizados e rejeita redirecionamentos.
- Criação inicial do administrador em produção exige senha própria ou hash configurado.
- Override do uuid do ExcelJS para versão corrigida, com teste de escrita/leitura de formatação condicional. Lockfile adicionado.

Validação: npm test, npm audit, node --check e git diff --check. O resultado da auditoria refere-se às dependências instaladas, não certifica ausência de falhas no produto.

Limitações e pontos para próxima revisão:
- Sem DATABASE_URL, o backend não inicializa: initClientDb exige PostgreSQL mesmo após initDb informar modo sem persistência. Nenhuma transação de pagamento, emissão ou migração foi executada neste ambiente.
- db.js configura TLS com rejectUnauthorized:false em produção. Requer alinhar CA e requisitos do provedor antes de mudar para evitar interromper a conexão.
- O proxy ainda aceita identificadores de documento informados pelo usuário autenticado; deve ser vinculado a pedidos autorizados e validado com contratos reais da ConectEnvios para fechar possíveis acessos entre contas.
- Revisão de autorização completa, concorrência financeira e testes integrados com PostgreSQL e provedores continuam pendentes.

## Personalização do menu e comprovantes

Os 16 itens do menu usam SVGs locais com traço uniforme, sem fontes de ícones ou serviços externos. Os textos acessíveis permanecem nos botões.

O comprovante térmico reutiliza o envelope vetorial e o nome Postal Serviços já presentes na interface. Não foi encontrado arquivo oficial adicional nem manual de marca no repositório; a implementação não certifica titularidade ou licença da marca. O símbolo pode ser substituído por uma arte oficial fornecida pelo responsável.

A marca é monocromática e incorporada ao HTML, inclusive na prévia e na impressão em 58/80 mm. O ponto parceiro, pedido, valores, destinatários e múltiplos rastreios são preservados. Simulações recebem aviso explícito; status ausente não presume pagamento. Etiquetas reais, documentos fiscais e códigos das transportadoras não são modificados por esta personalização.

Validação adicional: testes de comprovantes com múltiplos rastreios, escape de conteúdo, prévia, simulação e confirmação de pagamento; renderização em Chromium nos dois tamanhos térmicos sem transbordamento horizontal. A impressão física e os comprovantes de pedidos reais ainda precisam ser homologados no ambiente integrado.

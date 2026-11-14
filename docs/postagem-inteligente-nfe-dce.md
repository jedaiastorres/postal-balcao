# Postagem Inteligente por NF-e / DC-e

## Modos disponíveis
1. **Manual** (padrão): o usuário informa CEP, peso, medidas e volumes, e depois remetente, destinatário e conteúdo.
2. **XML local**: a pessoa escolhe um XML NF-e ou DC-e do próprio dispositivo. O navegador extrai os dados e preenche origem/destino, remetente/destinatário, itens e valor. O XML não é enviado ao servidor por esta função.
3. **Consulta autorizada por chave**: fornece chave de 44 dígitos e declara autorização. O backend usa apenas provedor de consulta fiscal configurado, com controle de acesso. **Não está operacional sem uma integração fiscal oficialmente autorizada.**

O tipo do documento e a chave informados ficam registrados em \`package_data.fiscalDocument\` do pedido. Não se deve tratar uma simples chave digitada ou um XML importado como prova de autenticidade/regularidade fiscal; validação fiscal é separada. O servidor mantém o fluxo de cotação e emissão anterior para as transportadoras existentes.

## Configuração de provedor autorizado (pendente)
Somente no ambiente seguro do Railway:
- \`FISCAL_LOOKUP_ENABLED=true\`
- \`FISCAL_LOOKUP_URL=https://<seu-provedor-autorizado>/consulta\`
- \`FISCAL_LOOKUP_TOKEN\` com credencial específica, nunca no GitHub ou frontend.

Esta integração **não** é o endpoint oficial SEFAZ direto. O provedor contratado ou gateway próprio deverá realizar a consulta fiscal autorizada, gerir certificado/autorização conforme a documentação oficial e responder ao backend com:
\`\`\`json
{
  "authorized": true,
  "document": {
    "type": "NFE",
    "key": "<44 dígitos>",
    "sender": {"name": "...", "document": "...", "cep": "00000000", "address": "...", "number": "...", "neighborhood": "...", "city": "Cidade/UF"},
    "recipient": {"name": "...", "document": "...", "cep": "00000000", "address": "...", "number": "...", "neighborhood": "...", "city": "Cidade/UF"},
    "items": [{"description": "...", "quantity": 1, "value": 99.90}],
    "declaredValue": 99.90,
    "volumeCount": 1,
    "grossWeightKg": 1.2
  }
}
\`\`\`
O provedor precisa garantir autorização para a chave, limitar requisições e bloquear consulta a documentos não autorizados. O backend exige HTTPS, token configurado, declaração de autorização, chave compatível com modelo 55 (NF-e) ou 99 (DC-e) e resposta com \`authorized: true\`. Para perfil CLIENT, valida ainda se o CPF/CNPJ do cadastro participa como remetente ou destinatário. O backend não consulta portais com CAPTCHA nem burla regras de distribuição.

## Compatibilidade documental com transportadoras
- NF-e: o campo \`invoiceNumber\` do fluxo existente continua sendo enviado como recibo/chave, conforme a integração corrente.
- DC-e: a chave é preservada em \`package_data.fiscalDocument\`, **sem se passar por número de NF-e**. O fluxo legado de declaração de conteúdo da transportadora permanece e deve ser homologado com cada parceira quanto à aceitação da DC-e original.
- Medidas e quantidade real de volumes sempre precisam de conferência humana. A importação não autoriza editar valores fiscais no XML.
- Documentos fiscais são usados como fonte de pré-preenchimento e não alteram o endereço do hub/CEP máscara nem os dados reais do remetente.

## Homologação recomendada
- NF-e XML com emitente, destinatário, 1 item / vários itens, vários volumes;
- DC-e XML com remetente e destinatário;
- XML malformado, chave ausente, tamanho acima de 3 MB, DOCTYPE/ENTITY;
- Consulta autorizada com credenciais ausentes, token inválido, documento não autorizado, modelo divergente;
- Usuário CLIENT tentando acessar documento fiscal de terceiro;
- Fluxos point owner, clerk e client;
- Cotação com alteração posterior de CEP/volume e nova confirmação;
- Postagem NF-e (sem duplicar documento) e DC-e com homologação específica da transportadora.

Referências:
- Portal Nacional da DC-e: https://dfe-portal.svrs.rs.gov.br/Dce/Documentos
- NT 2014.002 NF-e Distribuição DF-e: https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=VgPuhtPApQo=

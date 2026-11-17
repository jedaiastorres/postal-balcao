# Identidade oficial, rastreio e integrações

## Postal e transportadoras

A logo Postal foi localizada no cabeçalho de http://postalservicos.com.br/ e obtida do arquivo oficial https://postalservicos.com.br/medias/Postal-Servicos.svg (o download neste ambiente precisou de HTTP, pois HTTPS retornava 403). O vetor foi preservado; foram removidos apenas prólogo XML, DOCTYPE e comentário de geração. Uso local em login, menu, rastreio e comprovante. Na impressão térmica aplica-se escala de cinza por CSS, sem deformar a marca. O comprovante incorpora o SVG em data URI para impressão sem rede e aguarda a decodificação da imagem.

Fontes dos arquivos de transportadoras: site oficial da ConectEnvios, https://conectenvios.com.br/images/transportadoras/:
- correios.svg
- jadlog.svg
- azul-cargo-express.png (salvo como azul-cargo.png)
- loggi.svg
- fedex.svg
- ups.svg
- dhl.svg

As artes são as publicadas pelo integrador oficial, não logotipos redesenhados. Todos os arquivos ficam em public/assets/brands; branding.js contém o mapa de nomes e o logo incorporado do comprovante. Nomes não reconhecidos mantêm identificação textual sem atribuir marca incorreta. Acrescentar novas marcas somente após obter a arte da transportadora ou do integrador. O uso identifica os prestadores e não declara parceria adicional nem altera etiquetas reais/fiscais. Os direitos de marca permanecem com seus titulares.

## Consulta DANFE

Fonte: https://consultadanfe.com/api (documentação renderizada em ApiDocs-BGoRFjym.js no momento da consulta).

A API serve para consultar NF-e modelo 55 por chave via POST https://consultadanfe.com/api/v1/consulta, body {"chave":"<44 caracteres>"}, Accept application/json. Resposta documentada: status, chave, tipo, pdf_base64 e xml_base64. Não retorna nosso contrato normalizado com authorized:true. O adaptador próprio lê o XML no servidor e preserva a validação de vínculo fiscal do perfil CLIENT. Não afirma que o fornecedor verificou autorização do usuário nem substitui validação de autenticidade fiscal.

Limitações publicadas da API gratuita:
- consulta por chave somente NF-e modelo 55, não DC-e;
- mês corrente e, até o dia 14, também o anterior;
- 60 requisições/minuto por IP e cotas de respostas 404 (500 por IP/dia e 500 por CNPJ emitente);
- notas antigas devem usar XML/app do fornecedor.

Ativação opcional no servidor: FISCAL_LOOKUP_ENABLED=true e FISCAL_LOOKUP_PROVIDER=CONSULTADANFE. Não exige URL nem token; endpoint fixo. Não ativado em produção por esta alteração. O contrato anterior continua disponível com FISCAL_LOOKUP_PROVIDER=AUTHORIZED, URL HTTPS e token.

Proteções: consentimento explícito, autenticação, vínculo CPF/CNPJ para cliente, DV e modelo da chave antes da chamada, limite local de 30 chamadas/minuto por processo, timeout, redirecionamentos bloqueados, tamanho de resposta limitado, rejeição de DOCTYPE/ENTITY e conferência da chave no XML. Não se fazem retries automáticos. A aplicação atual suporta somente chaves numéricas; chaves alfanuméricas anunciadas pelo fornecedor continuam fora do fluxo atual. Nenhuma NF-e real foi consultada nesta tarefa. Homologar com chave própria/autorizada, permissões, limites de instâncias e dados reais antes de ativar.

## Internacional

Fonte: https://faq.conectenvios.com.br/internacional-orientacoes/

A ConectEnvios orienta operar FedEx, DHL e UPS em https://enviointernacional.com.br/conectenvios. Foi acrescentado acesso explícito a esse portal externo no menu, sem enviar dados automaticamente. Não foi localizado contrato público de cotação/emissão internacional na API V1 usada pelo Balcão; páginas de documentação testadas redirecionam ao login. Por isso não há emissão internacional nativa nem débitos internacionais na carteira Postal. Para integração completa, obter contrato/API e credenciais específicas, campos de país, moeda, HS Code, finalidade, invoice/AWB e regras de coleta e homologar com o provedor.

## Rastreio e validação

Tela revisada com marca oficial, hierarquia visual, foco visível, adaptação mobile, estados de consulta/erro acessíveis e timeout. Rastreios externos sem detalhes não exibem rota nem bloco de pacote presumidos. Não é inferida entrega concluída a partir de cor; o status retornado permanece visível. As respostas públicas existentes e suas permissões não foram alteradas.

Testes locais incluem adaptação dos comprovantes, XML sintético com chaves verificadas, falhas do provedor, múltiplos volumes, proteção contra entidades e incompatibilidade da chave. Navegador com respostas simuladas para rastreio em 1440 e 390 px, consulta bem-sucedida e erro sem dados antigos. Sem PostgreSQL e credenciais, pagamentos, postagem real e consulta fiscal real não foram exercitados.

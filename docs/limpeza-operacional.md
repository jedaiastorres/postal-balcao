# Limpeza operacional única

O usuário solicitou zerar todos os dados operacionais, clientes e financeiro, mantendo somente o master. O script scripts/operational-reset.js executa uma manutenção pontual, não adiciona um endpoint de exclusão ao sistema.

- Sem argumentos, faz somente inventário em transação READ ONLY.
- --apply exige confirmação explícita de alvo, identificador único, chave de backup AES-256 e os IDs exatos do projeto, ambiente e serviço de produção Postal Balcão.
- Master identificado por APP_USER; precisa existir, estar ativo e ser ADMIN. ID, senha e credenciais são preservados.
- Antes de excluir, guarda snapshot criptografado em schema privado postal_reset_archive. A chave é variável protegida do serviço, nunca no Git nem em logs. A cópia de recuperação não aparece no sistema ou na exportação operacional normal.
- Exclui envios, eventos, pedidos importados, integrações de clientes, carteiras/extratos/recargas, coletas, ganhos, estoque dos pontos, propostas financeiras, pontos, cadastros e contas não master. As definições globais de catálogo e parceiros/produtos de crédito permanecem disponíveis; são configuração de serviços, não histórico ou contas operacionais.
- Travas, transação e verificações finais impedem limpeza parcial. Tabelas públicas desconhecidas abortam a manutenção. O mesmo identificador de execução nunca apaga novamente dados novos.
- Não cancela remessas, estorna, transfere ou apaga registros na ConectEnvios/Asaas. Não muda chaves desses provedores.
- Rotação da chave de sessão encerra sessões antigas; o master entra novamente com suas credenciais existentes. Versão de limpeza na configuração pública descarta cotações locais antigas nos navegadores.
- A tarefa temporária de pré-deploy deve ser removida após o sucesso; nenhuma limpeza roda no fluxo normal de inicialização.

Os testes com PostgreSQL embarcado verificam inventário sem escrita, proteção do master, backup criptografado recuperável, exclusão integral das tabelas alvo, preservação de senha, rejeição de tabelas desconhecidas e proteção contra repetição.

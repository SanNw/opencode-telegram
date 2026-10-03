# Aceitação física — relato de 2026-10-03

Fonte: relato do proprietário durante o teste no Telegram. Versões do sistema e do Telegram não foram informadas; este registro não fecha a matriz completa de plataformas.

## Resultados relatados

- Abertura: OK.
- Resposta longa: OK.
- Segundo plano: OK.
- Reconexão: OK.
- Reabertura: OK.
- Teclado/rotação: falha — composer desaparecia e layout/rolagem ficavam instáveis.
- Desktop/redimensionamento: falha — composer fora da área visível e Settings deslocado na navegação lateral.
- Seletor de agentes: menu nativo fora da identidade visual.
- Fotos: ausência de prévia segura no chat; nomes de arquivos grandes.

## Correções implementadas para reteste

Chat limitado à altura visível nos dois lados do breakpoint, com atualização por `visualViewport.resize`; layout compacto em telas baixas; navegação lateral com Settings na base; seletor de agentes com botões estilizados, seleção explícita e Escape; tipografia compacta dos anexos.

Imagens embutidas pelo OpenCode agora passam pelo Bridge: PNG/JPEG/WebP são validados por assinatura e MIME, até 10 MiB por imagem, com cache de até 64 MiB por proprietário e TTL de 24 horas. A resposta de mensagens expõe apenas ID opaco, nunca a data URL. O endpoint existente exige autenticação e proprietário correto. URLs remotas não são buscadas e SVG não é aceito como imagem inline. A tabela de cache é criada pela migração 11; faça backup antes de atualizar.

## Reteste necessário

Segundo relato: a prévia de imagem funcionou e o composer deixou de desaparecer, mas a conversa ficou espremida em paisagem. O modo paisagem com altura até 500 px agora recolhe a topbar, usa navegação lateral somente com ícones e oculta os metadados da sessão; controles de esforço não quebram em várias linhas. A regressão de navegador exige ao menos 40% da altura para o transcript nesses viewports. A imagem deixa de adiar a busca por lazy loading; a latência percebida ainda não foi medida no dispositivo.

Ferramentas bash com código de saída diferente de zero agora aparecem como falha no histórico e nos eventos, mesmo quando o upstream informa completed. A preferência local de geração de imagens é OpenAI direto, por instrução opt-in ao agente (não por sandbox de rede). A conexão OpenAI verificada usa OAuth, sem API key compatível identificada; geração real permanece não validada e nenhuma chamada paga foi feita.

1. Fechar/reabrir o Mini App e informar versões de Android/Telegram e sistema/Telegram Desktop.
2. Abrir o seletor de agentes e selecionar uma opção.
3. Girar retrato → paisagem → retrato, com e sem teclado.
4. Redimensionar a janela Desktop repetidamente, sem rolar a página para recuperar o composer.
5. Verificar Settings na base da navegação lateral antes e depois de rolar uma página longa.
6. Enviar uma foto PNG/JPEG/WebP, aguardar a resposta e reabrir a conversa: a imagem deve aparecer e o nome não deve dominar o card.

Status: **aguardando reteste físico**. A suíte Chromium valida geometria e integração com fixtures; não equivale a aprovação no Telegram real. A release permanece beta até fechar os critérios de estabilidade e segurança.

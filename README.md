# Pokelike Companion

Extensão de navegador (Chrome, Edge, Brave, Opera) que coloca um painel de apoio
no [Pokelike](https://pokelike.xyz), no estilo dos menus dos jogos de Pokémon.

![Painel na tela de captura](preview.png)

## Instalar

1. Baixe o repositório (botão **Code → Download ZIP**) e descompacte numa pasta que você não vá apagar.
2. Abra `chrome://extensions` (no Edge: `edge://extensions`).
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta que tem o `manifest.json`.
5. Abra ou recarregue o pokelike.xyz. O painel aparece no canto inferior esquerdo.

Para atualizar depois: substitua os arquivos e clique em ↻ no card da extensão.

## O que tem

| Aba | O que faz |
|---|---|
| **Caça** | Reset automático até sair um shiny, uma aurora ou um Pokémon específico. Faz o mesmo que você faz na mão (R → nó de captura da esquerda → confere as 3 opções). Para sozinho, toca um som e destaca o card. Mostra a chance por reset, quantos resets em média e o histórico do que você achou. |
| **Luta** | Próximo chefe (líder de ginásio no Story, treinador no Battle Tower), **chance de vitória** calculada com 300 lutas simuladas pelo próprio motor do jogo, **melhor ordem do time** (testa todas as ordens) e duelo de tipos. |
| **Time** | Seu time com HP e o golpe que cada um usa, as fraquezas que o time compartilha, os buracos de cobertura de ataque e os traits (no Battle Tower). |
| **Tipos** | Tabela de tipos: escolha 1 ou 2 tipos e veja o que bate 2x/4x, o que resiste e quanto cada Pokémon do seu time causa. |
| **Tela de captura** | Embaixo de cada opção: shiny/aurora, tipo de ataque, cobertura nova, se cobre ou piora fraquezas do time, traits que sobem e quanto muda a chance contra o próximo chefe. |

## Coisas do jogo que vale saber

- **Shiny**: 1% por Pokémon (2% com Shiny Charm, ×2 com a passiva de shiny, ×2 no
  desafio Aurora Hunt). O 1º nó tem 3 opções, então dá ~3% por reset.
- **Aurora só existe no Battle Tower / Challenges**: são 10% dos shinies (20% com o
  Aurora Charm). No Story ela nunca aparece, nem caçando.
- **Cada Pokémon ataca com um tipo só**: o primeiro tipo dele que não é Normal.
  Um Pidgey (Normal/Flying), por exemplo, só bate Flying.
- **Traits** (Battle Tower): cada Pokémon dá 1 ponto por tipo (shiny conta 2,
  aurora 3) e cada 2 pontos sobem 1 tier.

## Segurança

- **Fica desligado no modo Ranked e no Soul Link.** O Ranked grava seus inputs
  como anti-cheat, e a extensão não mexe em nada lá.
- As simulações salvam e restauram a seed do jogo, igual às simulações internas do
  próprio Pokelike. Elas **não mudam o resultado** das suas lutas.
- A caça só reseta uma run vazia. Se a run já tiver progresso, ela pergunta antes.
  Qualquer tecla ou clique seu no jogo pausa a caça na hora.
- Tudo roda local. A extensão não manda nada pra lugar nenhum.

## Se parar de funcionar

O Pokelike atualiza com frequência. A extensão usa funções internas do jogo
(`runBattle`, `executeResetRun`, `campaignGymTeam`...). Se alguma for renomeada,
o console mostra `[Pokelike Companion] jogo não carregou as funções esperadas`.

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

O painel tem dois modos (botão ⤢ no cabeçalho):

- **Compacto** (padrão): uma barra com até 3 linhas que mudam conforme a tela:
  caça (▶ / ■ e progresso), chance contra o próximo chefe (e a liga inteira na Elite Four)
  e a rota sugerida quando você está no mapa.
- **Estendido**: todas as ferramentas em abas.

| Aba | O que faz |
|---|---|
| **Caça** | Reset automático até sair um shiny, uma aurora, **um shiny que falta na sua Dex** ou um Pokémon específico. Chance por reset, histórico com estatísticas (média, melhor e pior caça) e a chance atual do **ovo lendário** com o bônus acumulado. |
| **Luta** | Próximo chefe (inclusive cada membro da **Elite Four**), chance de vitória simulada pelo motor do jogo, melhor ordem do time e duelo de tipos. |
| **Time** | HP, golpe de cada um, fraquezas compartilhadas, buracos de cobertura e traits. |
| **Dex** | Progresso da Pokédex, Shiny Dex e Aurora Dex por região, **quais Pokémon do mapa atual ainda faltam**, e busca com onde cada um aparece. |
| **Tipos** | Tabela de tipos com 1 ou 2 tipos e quanto o seu time causa. |

E dentro das telas do próprio jogo:

| Tela | O que aparece |
|---|---|
| **Mapa** | Uma trilha pontilhada dourada com a rota sugerida até o chefe (captura vale mais com espaço no time, centro vale mais com HP baixo). |
| **Captura** | Tipo de ataque, cobertura nova, fraquezas, traits, chance contra o chefe e o selo **NOVO NA DEX / SHINY NOVO** (só quando ajuda a escolher). |
| **Relíquia, item e boost** | Nota **S+ a C** na base do card, com em quem equipar; os motivos completos aparecem ao passar o mouse. |
| **Time cheio** | Selo no canto de cada Pokémon: quanto a troca pelo novo muda a luta contra o chefe. |
| **Move Tutor** | Nota em cada linha: em quem o golpe mais forte faz mais diferença. |
| **Equipar item** | ★ no Pokémon que a nota do item sugeriu. |
| **Preparação do chefe** | Faixa com chance de vitória, **liga inteira** (sem recuperar HP entre as lutas: mostra até onde você costuma chegar) e ordem sugerida. |

**Treinadores comuns** não têm previsão: o jogo sorteia o time deles só na hora em que você
clica no nó, então não dá pra saber antes.

## Coisas do jogo que vale saber

- **Shiny**: 1% por Pokémon (2% com Shiny Charm, ×2 com a passiva de shiny, ×2 no
  desafio Aurora Hunt). O 1º nó tem 3 opções, então dá ~3% por reset.
- **Aurora só existe no Battle Tower / Challenges**: são 10% dos shinies (20% com o
  Aurora Charm). No Story ela nunca aparece, nem caçando.
- **Cada Pokémon ataca com um tipo só**: o primeiro tipo dele que não é Normal.
  Um Pidgey (Normal/Flying), por exemplo, só bate Flying.
- **Traits** (Battle Tower): cada Pokémon dá 1 ponto por tipo (shiny conta 2,
  aurora 3) e cada 2 pontos sobem 1 tier.

## Como as notas são calculadas

A nota soma duas coisas:

1. **Simulação**: o motor de batalha do próprio jogo roda a luta contra o próximo chefe com e
   sem a opção (as mesmas sementes de batalha pra todas as opções, então a diferença vem da
   opção e não da sorte). Se a luta for fácil ou difícil demais pra comparar, a simulação
   aumenta a vida de um dos lados até a chance ficar perto de 50%.
2. **Sinergia**: regras com o motivo escrito. Item de tipo só serve pra quem é daquele tipo
   (e quem segura passa a atacar com ele, +40% de dano); relíquia de kit conta os Pokémon e
   traits do tipo; boost de SPE vê se você passa a atacar antes de alguém do chefe; e assim por diante.

Faixas: **S+** ≥ 14 · **S** ≥ 9 · **A** ≥ 5 · **B** ≥ 1,5 · **C** abaixo. "★ MELHOR" só
aparece quando uma opção ganha com folga. Dá pra desligar na aba **Luta → Dicas na tela do jogo**.

## Desempenho

As simulações rodam em fatias curtas, devolvendo o controle pro navegador entre elas: clicar
num card nunca fica esperando o cálculo, e sair da tela cancela o que estava sendo calculado.
O espaço das dicas é reservado no mesmo instante em que o jogo desenha os cards, então nada
pula de lugar embaixo do mouse.

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

## Ícones

O ícone da extensão (`icons/`) é uma Ultra Ball em pixel art própria, gerada por
`tools/make_icons.py`: edite a grade 16×16 do script e rode `python3 tools/make_icons.py`
(precisa do Pillow). A Ultra Ball do cabeçalho do painel é carregada do próprio site
do jogo enquanto você joga, e não fica guardada aqui.

# Parte D — Correção do cálculo da taxa de entrega e do lucro

Código: `src/delivery-fee.ts` • Testes: `src/delivery-fee.test.ts` • Rodar: `npm test` (dentro de `D/`).

O pipeline é curto e intencional: `resolveTier` (traduz o payload do parceiro para `ouro | prata | bronze | sem_nivel`) → `getDeliveryFee` (consulta a tabela: ouro 11.20, prata 7.50, bronze 4.90; `sem_nivel` = 0) → `computeProfit` (lucro = `total − custo − (total × commissionPct) − taxa`, arredondado a 2 casas; premissa: comissão de 23%, `commissionPct = 0.23`).

## Documentação de Mutantes

Mutante = sabotagem mínima e plausível no código de produção. Suíte que não mata mutantes não protege nada. Abaixo, os três mutantes mais prováveis e o teste que mata cada um (todos verificados rodando `npm test` com a sabotagem aplicada).

### Mutante 1 — `??` trocado por `||` no parser

- **Mudança:** em `extractRawTier`, `const chosen = v1 ?? v2 ?? v3;` vira `v1 || v2 || v3;`.
- **Efeito:** com `{ tier: "", tier_id: "3_gold" }` (v1 chegando vazio junto de v2 válido), o `||` trata string vazia como falsa, pula o campo e lê `3_gold` → devolve `ouro`, taxa 11.20. Payload corrompido viraria nível pleno — a mesma classe de erro que zerava a taxa antes.
- **Quem mata:** o teste "string vazia em v1 NÃO cai para v2", que espera `sem_nivel`. Com o mutante, recebe `ouro` → vermelho.

### Mutante 2 — regra de ouro violada (fallback `"sem_nivel"` → `"ouro"`)

- **Mudança:** em `resolveTier`, `TIER_BY_RAW[normalized] ?? "sem_nivel"` vira `?? "ouro"`.
- **Efeito:** todo tier ausente ou desconhecido vira `ouro` com taxa 11.20 — o vício antigo de "na dúvida, é ouro", agora cobrando taxa cheia de quem não tem nível.
- **Quem mata:** o teste "nulo, ausente, inválido ou desconhecido → 'sem_nivel', NUNCA 'ouro'" e os 341 cenários de `tierInput` mais os 60 pedidos malformados do fuzzing (seed 123): todos exigem `sem_nivel` com taxa 0 e lucro válido — o primeiro lixo já devolve `ouro`/11.20 → vermelho imediato.

### Mutante 3 — mapa de tiers alterado (linha `"2_silver": "prata"` removida)

- **Efeito:** `2_silver` deixa de ser reconhecido, cai em `sem_nivel`, taxa 0 — o lucro do P-2 infla de 16.21 para 23.71 (deixa de descontar os 7.50 de taxa).
- **Quem mata:** o teste v2 (`{ tier_id: "2_silver" }` → `prata`) e o teste da tabela executiva (P-2 exige taxa 7.50 e lucro 16.21) → dois vermelhos na hora.

Resumo: qualquer uma dessas regressões é capturada automaticamente por `npm test` antes de chegar à produção.

## Síntese

**O que estava errado no parser:** o parceiro passou a identificar o nível do restaurante com códigos novos (`3_gold`, `2_silver`, `1_bronze`) que o nosso sistema não entendia. Na dúvida, o código antigo assumia "ouro" — e era isso que gerava o selo na tela — mas procurava o preço usando o código cru, que não existe na nossa tabela. Resultado: o sintoma clássico **taxa R$ 0,00 com selo ouro** e lucro inflado com dinheiro que não existia. O parser agora traduz as três versões de contrato — v1 `{tier}`, v2 `{tier_id}`, v3 `{merchant.tier_id}` — para `ouro | prata | bronze | sem_nivel`, com precedência v1 > v2 > v3, e trata string vazia como payload corrompido (não pula para a próxima versão).

**Restaurantes sem nível:** nada de adivinhar. Nível ausente, nulo, vazio ou desconhecido vira **`sem_nivel`**: taxa de entrega estritamente **R$ 0,00** por princípio (não inventa taxa, nem para mais nem para menos), lucro calculado como `total − custo − (total × commissionPct)` e *drift log* estruturado com o valor cru recebido do parceiro — para o time mapear o novo nível em um ticket, em vez de descobrir pela contabilidade.

**Comissão no lucro:** a fórmula passou a descontar a comissão percentual da plataforma sobre o total do pedido, além do custo e da taxa: `total − custo − (total × commissionPct) − taxa`. `commissionPct` inválido (NaN, infinito, fora de `[0, 1]`) é saneado para 0 — o lucro nunca sai como número inválido.

**Impacto financeiro exato nos 3 pedidos de exemplo** (restaurante Ouro, `3_gold`; comissão de 23% sobre o total já descontada nos dois cenários; fórmula: `total − custo − (total × commissionPct) − taxa`):

| Pedido | Nível do Restaurante | Distância | Taxa de entrega | Lucro antes (Taxa R$ 0,00) | Lucro depois (Correto) | Diferença real |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P-1** | Ouro (`3_gold`) | até 10km | R$ 11,20 | R$ 33,68 | R$ 22,48 | **−R$ 11,20** |
| **P-2** | Ouro (`3_gold`) | até 5km | R$ 7,50 | R$ 23,71 | R$ 16,21 | **−R$ 7,50** |
| **P-3** | Ouro (`3_gold`) | até 2km | R$ 4,90 | R$ 12,36 | R$ 7,46 | **−R$ 4,90** |
| **Total**| **Ouro** | — | **R$ 23,60** | **R$ 69,75** | **R$ 46,15** | **−R$ 23,60** |

Os números "caíram" R$ 23,60 — é a primeira vez que são a verdade: o painel exibia lucro que não existia nesses 3 pedidos.

## Incertezas e Perguntas para o Fundador (Urgente)

Para não deixar o sistema fora do ar, o código entrou em produção com **duas premissas financeiras assumidas por nós** — funcionais hoje, mas que precisam da sua validação imediata, porque cada uma delas move dinheiro de verdade em todos os pedidos:

1. **Fallback da taxa de entrega:** quando o nível do restaurante vem desconhecido ou corrompido pelo parceiro, o sistema cobra **R$ 0,00** de taxa. A decisão a tomar: mantemos **R$ 0,00** (favorece a conversão do restaurante, mas a Prato assume o prejuízo do frete do próprio bolso) ou passamos a cobrar a **taxa mínima (Bronze, R$ 4,90)** para estancar a sangria? Enquanto o parceiro não nos diz o nível, cada pedido nesse estado é frete bancado pela plataforma.
2. **Comissão fixa de 23%:** a fórmula de lucro foi travada em **23% para todos** os restaurantes. Essa é a taxa real vigente em contrato hoje? Existem restaurantes com **taxas negociadas diferentes**? Se houver, o painel está inflando o lucro de quem paga mais que 23% e reduzindo o de quem paga menos — ou seja, decisões de preço e cardápio sendo tomadas sobre números errados.

**O alerta que precisa ficar registrado:** assumir regras financeiras em silêncio sem validação do negócio é o caminho mais rápido para um rombo de caixa silencioso. As duas premissas estão isoladas em constantes de fácil ajuste (`COMMISSION_PCT` e a regra de `sem_nivel`) e reversíveis em minutos — mas só o negócio pode dizer o número certo. Pedimos resposta antes que o volume de pedidos amplifique o erro.

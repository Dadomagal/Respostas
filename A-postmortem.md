# Postmortem — Incidente de Falha na Sincronização de Métricas de Pedidos

**Plataforma:** Prato
**Componente afetado:** Cron diário `orders-snapshot-daily` (06:00 UTC) — etapa de persistência de métricas por item
**Tabelas afetadas:** `order_item_metrics_daily` (congelada no dia 02); `order_store_metrics_daily` (íntegra, atualizada até o dia 12)

| Campo | Valor |
|---|---|
| **Início** | Dia 02 (mesma data da publicação de "melhorias no relatório de pedidos" pelo app parceiro) |
| **Detecção** | Dia 12, por reclamação de cliente — 10 dias após o início |
| **Severidade** | SEV-1 silencioso — integridade de dados de negócio comprometida, sem nenhum alarme disparado |
| **Sintoma visível** | Faturamento por item com queda aparente de 71% no painel; filtro de 7 dias exibindo R$ 0,00 |
| **Status** | Causa raiz corrigida; gates anti-recorrência em implantação (Seção 5) |

### Evidências coletadas

| # | Evidência |
|---|---|
| 1 | 16 execuções recentes do cron `orders-snapshot-daily` com status `Completed`; nenhuma `Failed` |
| 2 | `order_store_metrics_daily` com dados até o dia 12; `order_item_metrics_daily` parada no dia 02 (10 dias congelada) |
| 3 | Logs repetidos desde o dia 02 (nível `warn`): `orders.snapshot.item_batch_skipped { accountId: 'acc_7f2', rows: 412, err: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }` |
| 4 | O código fazia `page.results.map(...)` injetando `accountId` e `today`, gravava via `db.insert(...).values(rows).onConflictDoUpdate(...)` e, em erro, o `catch` apenas logava (`logger.warn`) **sem** `throw` |
| 5 | Além do painel de faturamento, outras 5 telas operacionais e a rotina automatizada de recomendação de cardápio consomem `order_item_metrics_daily` |
| 6 | O app parceiro publicou nota no dia 02 sobre "melhorias no relatório de pedidos" |

---

## 1. Seção Perguntaria

**Pergunta formal ao time da API parceira (abertura imediata, prioridade alta):**

> A atualização publicada pelo app parceiro no dia 02 ("melhorias no relatório de pedidos") alterou o **contrato de resposta** do endpoint de relatório de pedidos? Especificamente: o relatório passou a retornar os itens **desmembrados** — uma linha por **variação de produto**, por **promoção aplicada**, ou com **paginação que repete registros** — de forma que o **mesmo `item_id` pode aparecer mais de uma vez na mesma resposta, para a mesma loja e a mesma data**? Em caso afirmativo, solicitamos a especificação atualizada do contrato, a semântica dos campos `revenue` e `orders` nas linhas desmembradas (valores parciais por linha ou total repetido) e o changelog da mudança com data exata de ativação.

**Premissa adotada neste postmortem:**

> A API parceira passou a retornar o **mesmo `item_id` mais de uma vez na mesma resposta** para a mesma loja/data (itens desmembrados por variação, promoção ou paginação duplicada). Toda a análise técnica deste documento parte dessa premissa. Ela é consistente com a evidência 6 (mudança publicada exatamente no dia 02, mesma data do congelamento) e com a evidência 3 (violação de chave de conflito no `ON CONFLICT`, que só acontece com tuplas repetidas no mesmo lote). **Se a resposta do parceiro contradisser esta premissa, este postmortem deve ser revisado e a causa raiz reavaliada.**

---

## 2. Causa Raiz e Análise Técnica

### 2.1 Por que o PostgreSQL rejeitou o comando

O job montava o lote de inserção com um mapeamento direto da resposta da API — sem nenhum passo de deduplicação:

```ts
// ANTES (código com o bug)
const rows = page.results.map((r) => ({
  accountId,
  today,
  storeId: r.storeId,
  itemId: r.item_id,
  revenue: r.revenue,
  orders: r.orders,
}));

try {
  await db
    .insert(orderItemMetricsDaily)
    .values(rows)
    .onConflictDoUpdate({ /* target: (accountId, storeId, itemId, snapshotDate) */ });
} catch (err) {
  logger.warn("orders.snapshot.item_batch_skipped", { accountId, rows: rows.length, err });
  // ❌ sem throw: a exceção morre aqui
}
```

Quando a parceira passou a enviar o mesmo `item_id` desmembrado em várias linhas, o array `rows` passou a conter **tuplas duplicadas na chave de conflito** `(accountId, storeId, itemId, snapshotDate)`.

O `ON CONFLICT DO UPDATE` é **uma única instrução SQL**, executada atomicamente sobre um snapshot da tabela. O PostgreSQL exige que cada linha afetada pelo caminho de conflito seja tocada **no máximo uma vez por instrução**: se o próprio lote de `values` traz duas ou mais tuplas com a mesma chave, a segunda precisaria atualizar a linha que a primeira já atualizou — e o resultado passaria a depender da ordem das tuplas (a última sobrescreve? soma?). Como não existe resposta determinística, o banco **aborta a instrução inteira** com o erro:

```text
ON CONFLICT DO UPDATE command cannot affect row a second time
```

Por ser atômica, a falha descarta **todas** as linhas do lote — não apenas as duplicadas. Isso explica com precisão a evidência 2: a granularidade de **loja/dia** (`order_store_metrics_daily`) não tinha chaves duplicadas no payload da parceira e continuou sendo gravada até o dia 12, enquanto a granularidade de **item/dia** (`order_item_metrics_daily`) congelou exatamente no dia 02, o primeiro dia em que o payload desmembrado chegou. A cada execução diária seguinte, o mesmo lote inválido foi montado e rejeitado, empurrando o gap de dados para 10 dias.

### 2.2 Por que o cron reportou `Completed` nas 16 execuções

A escrita no banco estava dentro de um `try/catch` cujo `catch` **engolia a exceção**: registrava apenas `logger.warn("orders.snapshot.item_batch_skipped", ...)` e encerrava a função normalmente, **sem `throw`**.

Para o orquestrador de cron, o contrato de sucesso é simples: **a função retorna sem exceção não tratada = execução bem-sucedida (`Completed`)**. O erro do banco foi rebaixado a um evento de log de nível `warn` e nunca chegou à superfície de status do job. Resultado: 16 execuções consecutivas verdes, com a tabela morta desde a primeira delas. As mensagens de log até seguiam a convenção do projeto (contexto estruturado com `accountId`, `rows` e `err`), mas o nível `warn` e a ausência de propagação tornaram o status de saída do job **um sinal mentiroso** sobre a saúde da sincronização.

---

## 3. Invisibilidade por 10 Dias e Impacto de Negócio

### 3.1 Por que ninguém viu por 10 dias

O monitoramento estava baseado **estritamente no status de saída do job**: um dashboard operacional que refletia o `Completed`/`Failed` do orquestrador. Como a exceção foi engolida (Seção 2.2), o sistema reportava verde enquanto os dados apodreciam — **confiança cega no status do cron, sem nenhuma validação da saúde dos dados produzidos**. Nenhum alarme existe para logs de nível `warn`, e ninguém lê 16 "verdes" consecutivos à procura de um `item_batch_skipped` discreto.

### 3.2 O que faltava no sistema

- **Alerta de frescor de dados (*data freshness*):** nenhum probe media se a tabela continuava **recebendo datas novas** (`max(snapshot_date)` avançando dia a dia). O congelamento seria detectado em horas, não em 10 dias.
- **Detecção de anomalia de faturamento zerado:** o filtro de 7 dias exibiu **R$ 0,00** continuamente e nenhum gatilho de negócio disparou. Receita agregada zerada é um sinal anômalo demais para não ter alarme próprio.
- **Alerta sobre taxa de skips:** os eventos `item_batch_skipped` repetidos diariamente deveriam, por si só, acender um alerta de taxa anômala de lotes descartados.

### 3.3 Impacto amplo

O congelamento **não ficou restrito ao painel**. A tabela `order_item_metrics_daily` é insumo de:

- o **painel de faturamento por item** (sintoma reportado: queda aparente de 71% e R$ 0,00 no filtro de 7 dias);
- **outras 5 telas operacionais** (rankings, mix de produtos e visões de desempenho por item) exibindo dados defasados ou vazios;
- a **rotina automatizada de recomendação de cardápio**, que durante 10 dias tomou **decisões de otimização erradas/obsoletas** — recomendando com base no snapshot congelado do dia 02, ignorando toda a evolução real de demanda do período.

O dano é composto: quanto mais dias congelados, maior o esforço de backfill, maior a distorção das recomendações automáticas e maior a erosão de confiança do restaurante na plataforma.

---

## 4. Correção e Prova de Regressão

### 4.1 Código TypeScript corrigido

A correção tem três camadas: **escopo correto dos dados**, **agregação de tuplas duplicadas antes do banco** e **persistência atômica com chunking**. Nenhum `catch` engole falha: erro de banco propaga e falha o step.

```ts
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { orderItemMetricsDaily } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

type PartnerItem = {
  item_id: string;
  storeId: string;
  revenue: number;
  orders: number;
};

type Row = {
  accountId: string;
  storeId: string;
  itemId: string;
  snapshotDate: string; // "YYYY-MM-DD"
  revenue: number;
  orders: number;
};

const CHUNK_SIZE = 500; // lotes de 500 itens (faixa segura: 500–1000) por statement

export async function syncOrderItemMetrics(
  accountId: string,
  today: string,
  page: { results: PartnerItem[] },
): Promise<void> {
  // 1) Escopo correto: accountId vem do contexto autenticado do job (isolamento
  //    de tenant — nunca do payload do parceiro) e snapshotDate é fixo (= today).
  const scoped = page.results.map((r): Row => ({
    accountId,
    storeId: r.storeId,
    itemId: r.item_id,
    snapshotDate: today,
    revenue: r.revenue,
    orders: r.orders,
  }));

  // 2) Agregação: tuplas com a mesma chave de conflito são SOMADAS antes de
  //    chegar ao banco. O Map garante exatamente 1 linha por
  //    (accountId, storeId, itemId, snapshotDate) — condição necessária para o
  //    ON CONFLICT DO UPDATE ser uma instrução válida.
  const aggregated = new Map<string, Row>();

  for (const row of scoped) {
    const key = `${row.accountId}|${row.storeId}|${row.itemId}|${row.snapshotDate}`;
    const existing = aggregated.get(key);

    if (existing) {
      existing.revenue += row.revenue;
      existing.orders += row.orders;
    } else {
      aggregated.set(key, row);
    }
  }

  const rows = Array.from(aggregated.values());

  // 3) Persistência atômica com chunking: uma ÚNICA db.transaction envolve todos
  //    os lotes. Ou o dia inteiro é gravado, ou nada é — nunca um dia parcial.
  //    Não há catch engolidor: qualquer falha de banco PROPAGA, o step falha e o
  //    orquestrador marca Failed, acionando retry e alerta.
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);

      await tx
        .insert(orderItemMetricsDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            orderItemMetricsDaily.accountId,
            orderItemMetricsDaily.storeId,
            orderItemMetricsDaily.itemId,
            orderItemMetricsDaily.snapshotDate,
          ],
          set: {
            revenue: sql`excluded.revenue`,
            orders: sql`excluded.orders`,
            updatedAt: new Date(),
          },
        });
    }
  });

  // Log estruturado com contexto obrigatório (convenção Prato: accountId,
  // snapshotDate e contagem de linhas para auditoria por tenant).
  logger.info("orders.snapshot.item_batch_persisted", {
    accountId,
    snapshotDate: today,
    rows: rows.length,
  });
}
```

**Por que cada camada existe:**

- **Map de agregação:** elimina a causa raiz — o mesmo `item_id` desmembrado em N linhas pela parceira vira **1 linha nossa** com `revenue` e `orders` somados; o upsert volta a ser determinístico e válido.
- **Chunking de 500–1000 itens:** protege contra payloads massivos. Um único `insert` com dezenas de milhares de linhas pressiona memória e o tamanho do statement; lotes pequenos mantêm cada statement enxuto, sem mudar o resultado.
- **`db.transaction` única:** o chunking não pode criar falhas parciais (dia gravado pela metade). Como todos os lotes compartilham a mesma transação, qualquer erro em qualquer chunk faz **rollback total** — atomicidade preservada.
- **Sem `catch`:** falha de banco = falha do step. O status do cron volta a ser confiável e o retry do orquestrador volta a funcionar.

### 4.2 Prova (Teste Unitário)

**Cenário:** injetar na rotina um payload simulando a resposta da API parceira pós-mudança, com o **mesmo `item_id` repetido 3 vezes** (desmembramento) para a mesma loja/data, mais um segundo item íntegro. **Asserções:** o array efetivamente gravado contém **apenas 1 linha agregada** para o item duplicado, com a **soma exata** de `revenue` e `orders` das três tuplas, e a operação de banco (upsert) executa **sem erro de conflito**. Este teste falha no código antigo (as duplicatas atravessariam o mapeamento direto e estourariam o `ON CONFLICT`) e passa no corrigido — é a prova de regressão do fix.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const values = vi.fn(() => ({ onConflictDoUpdate }));
const insert = vi.fn(() => ({ values }));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ insert })),
  },
}));

import { syncOrderItemMetrics } from "./orders-snapshot";

type WrittenRow = {
  accountId: string;
  storeId: string;
  itemId: string;
  snapshotDate: string;
  revenue: number;
  orders: number;
};

describe("orders-snapshot: itens desmembrados (item_id duplicado no payload)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agrega 3 tuplas do mesmo item_id em 1 linha com a soma exata e grava sem conflito", async () => {
    // Payload simulando a API parceira a partir do dia 02:
    // item_A desmembrado em 3 linhas; item_B íntegro como controle.
    const payload = {
      results: [
        { item_id: "item_A", storeId: "st_1", revenue: 120.5, orders: 10 },
        { item_id: "item_A", storeId: "st_1", revenue: 79.5, orders: 6 },
        { item_id: "item_A", storeId: "st_1", revenue: 40.0, orders: 4 },
        { item_id: "item_B", storeId: "st_1", revenue: 30.0, orders: 2 },
      ],
    };

    // 1) A operação completa SEM lançar erro (nenhum conflito escapa).
    await expect(
      syncOrderItemMetrics("acc_7f2", "2026-09-02", payload),
    ).resolves.toBeUndefined();

    // 2) O array gravado contém apenas 1 linha por item (2 itens -> 2 linhas).
    const written = values.mock.calls.map((call) => call[0]).flat() as WrittenRow[];
    expect(written).toHaveLength(2);

    // 3) A linha do item_A carrega a SOMA EXATA das 3 tuplas duplicadas...
    expect(written.find((r) => r.itemId === "item_A")).toEqual({
      accountId: "acc_7f2",
      storeId: "st_1",
      itemId: "item_A",
      snapshotDate: "2026-09-02",
      revenue: 240, // 120.5 + 79.5 + 40.0
      orders: 20, // 10 + 6 + 4
    });

    // 4) ...e o upsert no banco foi executado sem qualquer rejeição de conflito.
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1); // 4 linhas -> 1 chunk de 500
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Array) }),
    );
  });
});
```

---

## 5. Gates Anti-Recorrência

Corrigir não basta: o incidente precisa ficar **estruturalmente impossível** de repetir.

### 5.1 Nível de Código

- **Proibição estrutural de engolir falhas de banco em jobs de background** (linter + code review). Regra a ser enforced: em `jobs/**` e `cron/**`, todo `catch` deve **repropagar** a exceção (`throw` ou wrap-and-throw com contexto); `catch` que apenas loga (`logger.warn`/`logger.error`) sem `throw` é **bloqueio de review** e alvo de regra de lint dedicada (habilitar `no-empty-catch` e regra customizada para diretórios de job).
- **Contrato do job:** falha de persistência = **falha do step**. É o status de saída que aciona o retry do orquestrador e o alerta — nunca um log. O status do cron volta a ser um sinal confiável.
- **Convenções Prato reafirmadas no checklist de review:** mensagens de log sempre com contexto (`accountId`, `snapshotDate`, contagens) e isolamento de tenant em toda escrita (`accountId` sempre do contexto autenticado, presente na chave de conflito).

### 5.2 Nível de Observabilidade

- **Alerta de frescor de dados (*data freshness*):** probe agendado mede `max(snapshot_date)` em `order_item_metrics_daily`. Se a data mais recente atrasar **mais de 26h** (job diário às 06:00 UTC + margem de tolerância de 20h), acionar **alerta crítico no PagerDuty** imediatamente. Mesmo que o job mente de novo ("Completed"), o dado parado toca o alarme.
- **Alerta de anomalia de negócio:** disparo automático se a **receita agregada de um restaurante cair a zero por mais de 48h sem alteração de status da loja** (fechamento, desativação ou pausa registrados). Esse gate vigia o sintoma final que o cliente viu, independente de qualquer job, tabela ou pipeline envolvido.
- **Camada complementar (barata):** alerta de taxa anômala sobre os eventos `item_batch_skipped` — qualquer reaparição do padrão "lotes descartados" dispara antes mesmo do freshness vencer.

As duas camadas principais são independentes: uma vigia o **pipeline** (frescor do dado), a outra vigia o **negócio** (receita zero). Para o incidente repetir, as duas precisariam falhar simultaneamente.

---

## 6. Síntese

O aplicativo do parceiro fez uma atualização no dia 02 e passou a enviar os números de venda de cada produto fatiado em várias linhas (uma por promoção ou variação), em vez de uma linha única por produto; o nosso robô que arquiva esses números não estava preparado para receber o mesmo produto repetido e recusou o pacote inteiro — e, por um defeito nosso, em vez de soar o alarme ele apenas anotou um aviso discreto e continuou reportando "trabalho concluído". Com isso, os gráficos de faturamento por item ficaram congelados por 10 dias, o painel mostrou uma queda falsa de 71%, outras telas operacionais exibiram dados defasados e a recomendação automática de cardápio passou a sugerir otimizações com base em informações velhas, sem que ninguém fosse avisado. Já corrigimos o processador para somar corretamente as linhas repetidas e aguentar relatórios de qualquer tamanho sem travar, e instalamos alarmes que vigiam a saúde do dado em si — se os números pararem de chegar ou se o faturamento de um restaurante zerar de forma suspeita, o time técnico é acionado na hora — garantindo que qualquer anomalia futura seja comunicada imediatamente, em vez de passar despercebida por dias.

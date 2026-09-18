# C-review

**Revisão de Pull Request** — Funcionalidade: reimportação de stock
**Veredicto:** ❌ **Merge bloqueado** — 3 defeitos bloqueiam o merge; 3 exigem correção antes da aprovação final.

| # | Defeito | Severidade |
| --- | --- | --- |
| A | Migração destrutiva (`DROP COLUMN`) sem estratégia de transição | 🔴 Bloqueia merge |
| B | Fuga de isolamento de tenant na action | 🔴 Bloqueia merge |
| C | `catch` vazio / falso positivo ao usuário | 🟠 Deve corrigir |
| D | Auditoria registrada com usuário errado | 🟡 Nit / Deve corrigir |
| E | Efeito colateral externo fora do `step.run` | 🟠 Deve corrigir |
| F | `unscoped` sem filtro de tenant no job | 🔴 Bloqueia merge |

---

## 1. Defeitos Encontrados

### Defeito A — Migração destrutiva (perda de dados) e sem transição segura

1. **Trecho do código:**
   ```sql
   ALTER TABLE item_stock DROP COLUMN qty;
   ```
2. **Cenário (o que acontece em produção):** a migração apaga a coluna `qty` inteira, eliminando o histórico de stock de **todos os clientes** da plataforma. A regra da empresa é clara: **"migração nunca perde dado"**.
3. **Severidade:** 🔴 Bloqueia merge.
4. **Correção — por que `RENAME` também não resolve:** trocar por `ALTER TABLE item_stock RENAME COLUMN qty TO quantity` preserva o dado, mas **quebra o deploy zero-downtime**. Nossa migração roda enquanto instâncias com a **versão antiga do código** ainda atendem tráfego; no instante do rename, toda query antiga que referencia `qty` passa a falhar com `column "qty" does not exist` — erro instantâneo em frota, durante toda a janela de rollout. O padrão correto é **Expand & Contract**:
   - **Fase 1 (esta PR — expand):** adicionar a coluna nova sem remover a antiga, com backfill:
     ```sql
     ALTER TABLE item_stock ADD COLUMN quantity integer NOT NULL DEFAULT 0;
     UPDATE item_stock SET quantity = qty; -- backfill (em lotes, se a tabela for grande)
     ```
   - **Fase 2 (código, pode ser nesta PR):** aplicação passa a **escrever nas duas colunas** (dual write) e a **ler de `quantity`**. Com código novo e velho convivendo, ambos funcionam: o velho lê/escreve `qty`, o novo mantém `quantity` sincronizada.
   - **Fase 3 (PR futura — contract):** após todas as instâncias rodarem o código novo e a coluna `qty` não ter mais leitores, remover a coluna deprecada em migração separada:
     ```sql
     ALTER TABLE item_stock DROP COLUMN qty;
     ```

### Defeito B — Fuga de isolamento de tenant (falta de `scoped` na action)

1. **Trecho do código:** (em `actions.ts`)
   ```ts
   await db.select().from(itemStock).where(eq(itemStock.itemId, itemId));
   ```
2. **Cenário:** a leitura de `itemStock` **não aplica o filtro de tenant (`accountId`)**. Um usuário mal-intencionado pode passar o `itemId` de um restaurante concorrente e ler/acionar atualizações que não lhe pertencem.
3. **Severidade:** 🔴 Bloqueia merge.
4. **Correção:** envolver a query em `scoped`:
   ```ts
   await scoped(accountId, tx => tx.select()...);
   ```

### Defeito C — `catch` vazio e falso positivo

1. **Trecho do código:** (em `actions.ts`)
   ```ts
   .catch(() => {});
   ```
2. **Cenário:** se o provedor de jobs (Redis/fila) estiver fora do ar, o erro é **engolido**. O usuário recebe `{ ok: true }`, fica esperando o stock atualizar na tela — mas o job **nunca foi criado**. **`catch` vazio é proibido**.
3. **Severidade:** 🟠 Deve corrigir.
4. **Correção:** registrar o erro e devolver falha explícita ao cliente:
   ```ts
   logger.error('stock.queue_failed', { accountId, itemId, err });
   return { ok: false, error: 'queue_error' };
   ```

### Defeito D — Auditoria com usuário errado

1. **Trecho do código:** (em `actions.ts`, inserção no `auditLog`)
   ```ts
   userId: accountId
   ```
2. **Cenário:** a ação fica registrada como se tivesse sido feita pelo "Restaurante" (a empresa), quando o objetivo da auditoria é saber **qual pessoa específica** clicou no botão. `accountId` e `userId` respondem perguntas diferentes; um não substitui o outro.
3. **Severidade:** 🟡 Nit / Deve corrigir.
4. **Correção:**
   ```ts
   const userId = await currentUserId();
   ```

### Defeito E — Efeito colateral externo fora do `step.run`

1. **Trecho do código:** (em `stock-reimport.ts`)
   ```ts
   await client.setStock(...);
   ```
2. **Cenário:** a chamada à API externa do parceiro está **solta** no corpo do job. Se o job falhar na linha seguinte ou der timeout e o provedor executar um dos **3 retries** configurados, a chamada externa **repete fora de qualquer controle de step** — sem rastreio nem deduplicação. **Efeito colateral externo sempre dentro de `step.run`**.
3. **Severidade:** 🟠 Deve corrigir.
4. **Correção:** envolver a chamada num step, tornando-a rastreável e não repetida fora do controle do provedor:
   ```ts
   await step.run('set-remote-stock', () => client.setStock(...));
   ```

### Defeito F — `unscoped` sem filtro de tenant explícito no job

1. **Trecho do código:** (em `stock-reimport.ts`)
   ```ts
   unscoped(tx => tx.select().from(menuItems).where(...))
   ```
2. **Cenário:** o `accountId` está disponível no `event.data`, mas **não é usado** nas queries `unscoped`. Isso viola a convenção de **`WHERE` explícito de tenant** em batch jobs e abre brecha para **fuga de dados entre tenants**.
3. **Severidade:** 🔴 Bloqueia merge.
4. **Correção:** adicionar o filtro de tenant em **ambas** as queries do job:
   ```ts
   .and(eq(menuItems.accountId, accountId))
   ```

---

## 2. Qual defeito bloquearia sozinho o merge?

O **Defeito A (migração destrutiva)**.

A perda **irrevogável** do stock de todos os restaurantes causaria incidente gravíssimo de negócio: clientes que usam o sistema como **fonte de verdade para o delivery** teriam o inventário apagado e as vendas bloqueadas. Perda de dados em produção é a falha mais severa que este review pode capturar.

O **Defeito B** (isolamento de tenant) também é crítico — mas o A **destrói a operação dos clientes de uma vez**.

---

## 3. Teste a escrever primeiro (TDD)

Um teste de **Segurança / Isolamento de Tenant**:

- **Cenário:** chamar a `reimportStockAction` com um usuário autenticado no Restaurante A (`acc_A`), passando **propositadamente** o `itemId` de um produto que pertence ao Restaurante B (`acc_B`).
- **Comportamento esperado:** a função retorna `{ ok: false, error: 'not_found' }` e o mock da fila **não é chamado** — garantindo que o `scoped` rejeita o acesso cruzado antes de qualquer efeito colateral.

---

## Síntese

Merge bloqueado por três defeitos: migração destrutiva sem estratégia de transição (A), fuga de isolamento de tenant na action (B) e `unscoped` sem `WHERE accountId` no job (F).

A correção do A é **Expand & Contract**: nesta PR, `ADD COLUMN quantity` + backfill + dual write; a remoção de `qty` vira uma PR futura, depois de todas as instâncias rodarem o código novo. Um `RENAME COLUMN` preserva o dado, mas derruba as instâncias antigas durante o rollout — não aceito rename como solução final.

B e F são correções de duas linhas (`scoped(accountId, tx => ...)` e `eq(menuItems.accountId, accountId)` em ambas as queries do job) e desbloqueiam o grosso do PR rápido. C exige log + retorno `{ ok: false }`; D troca `accountId` por `currentUserId()`; E move `client.setStock` para dentro de `step.run`. Antes de reabrir, rode o teste de isolamento de tenant descrito na §3 — ele deve falhar no código atual e passar com B e F corrigidos.

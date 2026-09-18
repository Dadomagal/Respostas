# G-plano — Refatoração: Investigação de Bug Crítico de Reembolso Parcial (cal.diy)

**Repositório:** Cal.com (cal.diy) • **Commit:** `009f91d1636560fe6c60182c0bcff3d413da2919`
**Sintoma:** em eventos pagos com `seatsPerTimeSlot > 1`, o cancelamento pelo anfitrião (política `ALWAYS` ou `DAYS` dentro da janela) reembolsa apenas o primeiro participante; os demais ficam com o agendamento cancelado e o valor retido, sem erros nos logs.

---

## 1. Onde mora o bug e Jornada de Investigação

### 1.1 Localização Exata

- **Arquivo:** `packages/features/bookings/lib/payment/processPaymentRefund.ts`
- **Função:** `processPaymentRefund({ booking, teamId })` (linhas 9–84)
- **Linha 29:** `const successPayment = payment.find((p) => p.success);` — `Array.prototype.find` retorna apenas o **primeiro** pagamento com `success: true`, descartando os N−1 pagamentos restantes do array `booking.payment`.
- **Linha 83:** `await handlePaymentRefund(successPayment.id, paymentAppCredential);` — executa o estorno **uma única vez**, sem laço, para um único `paymentId` (`handlePaymentRefund`, em `packages/features/bookings/lib/payment/handlePaymentRefund.ts:5–32`, chama `paymentInstance.refund(paymentId)` do provedor).
- **Agravante:** a política de reembolso (`ALWAYS`/`DAYS`) é avaliada uma única vez usando moeda/valor do primeiro pagamento (`getPaymentAppData` nas linhas 32–39; janela `DAYS` nas linhas 73–82) e depois aplicada a um só estorno.

### 1.2 Jornada de Busca (ordem dos passos)

1. **Busca pela função de estorno:** varredura do monorepo por `processPaymentRefund` / `handlePaymentRefund` / `deleteBooking` / `cancelBooking`, que revelou imediatamente `processPaymentRefund.ts` e seu único laço ausente — o `.find()` da linha 29 já era o principal suspeito.
2. **Navegação da rota de entrada:** da rota Next.js `apps/web/app/api/cancel/route.ts:52` (POST/DELETE `/api/cancel`, usada pela UI de cancelamento) até o núcleo `packages/features/bookings/lib/handleCancelBooking.ts`, confirmando em `handleCancelBooking.ts:409–416` que o cancelamento do anfitrião dispara `processPaymentRefund({ booking: bookingToDelete })` uma única vez — ou seja, o erro não está no disparo, mas dentro da função de estorno.
3. **Confirmação no schema:** leitura de `packages/prisma/schema.prisma` (modelo `Payment`: `bookingId Int` FK simples + `@@index([bookingId])`; `Booking.payment Payment[]`), confirmando a cardinalidade **Booking 1 : N Payment**. O elo que faltava veio de `packages/features/bookings/lib/handleSeats/create/createNewSeat.ts:262`, onde cada assento adicional chama `handlePayment` com o **mesmo** `bookingId` (`booking: seatedBooking`) — um `Payment` por participante, todos no mesmo booking. A premissa de "1 pagamento por booking" embutida no `.find()` é, portanto, falsa por construção da feature de assentos.

### 1.3 Caminhos Descartados

- **Webhooks do Stripe** (`packages/app-store/stripepayment/api/paymentCallback.ts` e fluxo `refunded` do provedor): descartados como origem, pois a falha ocorre no **disparo inicial síncrono do cancelamento pela aplicação** — o estorno dos demais participantes nunca é solicitado ao provedor. O processamento assíncrono do Stripe está íntegro: ele apenas confirma/dá baixa no que a aplicação pede (e o `PaymentService.refund` do Stripe funciona corretamente para o pagamento que é enviado).
- **`processNoShowFeeOnCancellation`** (caminho `HOLD`, `handleCancelBooking.ts:417–427`): descartado, pois este caminho recebe o array completo (`payments: bookingToDelete.payment`) e não sofre do defeito.
- **Branch de recorrência** (`handleCancelBooking.ts:359–388`): observado que não processa reembolso algum, mas está fora do escopo deste sintoma (o caso reprodutível é seated, não recurring).

## 2. Raio de Impacto e Riscos de Regressão

### 2.1 Chamadores

**Diretos de `processPaymentRefund` (2):**

| # | Local | Contexto |
|---|-------|----------|
| 1 | `packages/features/bookings/lib/handleCancelBooking.ts:411` | Cancelamento de booking (host ou booker sem `seatReferenceUid`), gate `payment.some(p => p.paymentOption === "ON_BOOKING")` na linha 409 |
| 2 | `packages/trpc/server/routers/viewer/bookings/confirm.handler.ts:415` | **Rejeição** de booking (procedure tRPC `viewer.bookings.confirm`), gate `if (booking.payment.length)` na linha 414 — mesmo defeito ao rejeitar booking pago com assentos |

**Indiretos (chegam via `handleCancelBooking`):**

| # | Local | Contexto |
|---|-------|----------|
| 1 | `apps/web/app/api/cancel/route.ts:52` | UI Next.js — `POST/DELETE /api/cancel` (caminho principal do bug) |
| 2 | `packages/features/calendar-subscription/lib/sync/CalendarSyncService.ts:127` | Host deletou o evento no Google/Outlook → cancelamento via sync de calendário |
| 3 | `packages/trpc/server/routers/viewer/bookings/reportBooking.handler.ts:85` | Cancelamento automático de booking reportado como spam |
| 4 | API Platform v2 (re-exports em `packages/platform/libraries/index.ts:55` e `packages/platform/libraries/bookings.ts:6`) → `apps/api/v2/.../2024-04-15/controllers/bookings.controller.ts:262`, `apps/api/v2/.../2024-08-13/services/bookings.service.ts:915`, `apps/api/v2/src/lib/services/booking-cancel.service.ts:11` | REST pública da plataforma |

### 2.2 O que pode quebrar

- **Duplo reembolso:** se a nova iteração não filtrar pagamentos já estornados (`refunded: true`) antes de chamar o provedor, um cancelamento repetido (ou reentrância entre rotas) pode emitir `refund` duas vezes para o mesmo `paymentId`. A trava obrigatória é o filtro estrito `p.refunded !== true` lido do banco, somado ao bail-out idempotente nativo do serviço Stripe (`PaymentService.refund` retorna o pagamento sem relançar quando `payment.refunded` já é `true`).
- **Quebra da rejeição de reservas:** alterar a assinatura de `processPaymentRefund` (ex.: trocar `{ booking }` por `{ paymentIds }` ou mover a iteração para os chamadores) quebraria `confirm.handler.ts:415` e qualquer chamador futuro; qualquer mudança de contrato exigiria ajuste em todas as rotas listadas.

### 2.3 Localização da Correção

**A correção deve permanecer dentro de `processPaymentRefund.ts`.** É o ponto central de domínio reutilizado por todas as rotas (cancelamento web, sync de calendário, rejeição tRPC, API v2): corrigir lá dentro corrige todos os chamadores de uma vez, sem alterar nenhuma assinatura pública e sem duplicar a lógica de iteração/credenciais em cada rota.

## 3. Plano de Correção (prosa)

A mudança concentra-se em `packages/features/bookings/lib/payment/processPaymentRefund.ts`: a linha 29, que hoje faz `payment.find((p) => p.success)` e elege um único pagamento, passa a derivar `const paymentsToRefund = payment.filter((p) => p.success && p.refunded !== true)`, e a linha 83 passa a executar `handlePaymentRefund` dentro dessa iteração — uma chamada por participante — com o laço precedido da resolução única de credenciais (`prisma.credential.findMany` por `appId`) e de `appData`/política, que sobem para antes do loop para evitar consultas repetidas ao Prisma a cada participante; o que **não muda** é a avaliação da política de cancelamento — `NEVER` continua abortando, e a janela `DAYS`/`refundDaysCount` continua sendo checada uma única vez a partir do primeiro pagamento bem-sucedido, exatamente como hoje — e o fluxo de agendamentos individuais, pois um booking de assento único tem array de 1 elemento e o filtro retorna o mesmo comportamento atual (regressão zero para 1 assento); a trava de duplo reembolso fica em duas camadas: o filtro estrito `p.refunded !== true` lido do banco **antes** de qualquer chamada ao provedor, e a checagem idempotente nativa do serviço Stripe, que faz bail-out seguro retornando o pagamento quando ele já foi estornado — garantindo que retradas, reentrâncias de sync de calendário ou cancelamentos repetidos pela API nunca emitam um segundo `refund` para o mesmo `paymentId`.

## 4. Estratégia de Testes

**Arquivos existentes (base atual):**

| Arquivo | Estado |
|---------|--------|
| `packages/features/bookings/lib/payment/processPaymentRefund.test.ts` | 9 casos, todos com array de **1 pagamento** (`mockPayment`, linhas 24–39); mockam `getPaymentAppData` e `handlePaymentRefund` via `vi.mock` |
| `packages/features/bookings/lib/handleCancelBooking/test/handleCancelBooking.test.ts` | Teste "Should call processPaymentRefund" (linha 162) verifica apenas que a função foi chamada; cenário com **1 único pagamento** (linhas 230–242); `processPaymentRefund` mockado (linhas 24–26) |

**Cenário novo a escrever primeiro (TDD — deve falhar antes da correção):**

- **Caso:** *"Deve reembolsar individualmente todos os pagamentos com sucesso de uma reserva com múltiplos assentos"* — em `processPaymentRefund.test.ts`, reaproveitando os mocks existentes.
- **Setup:** booking com `payment: [P1(success: true, refunded: false), P2(success: true, refunded: false), P3(success: false)]`, `eventType.owner` presente, política `ALWAYS` (ou `DAYS` dentro da janela via `vi.setSystemTime`).
- **Expectativa:**
  1. `handlePaymentRefund` invocado **exatamente 2 vezes** — para `P1.id` e `P2.id`;
  2. `P3` (`success: false`) **ignorado**, sem chamada;
  3. **0 chamadas repetidas** para pagamentos já estornados (caso de variação: `P2` com `refunded: true` no setup ⇒ apenas 1 chamada, para `P1`);
  4. Credenciais resolvidas uma única vez (`prisma.credential.findMany` chamado 1 vez, não 2).
- **Teste de regressão complementar:** em `handleCancelBooking.test.ts`, cenário seated com 2 participantes pagantes cancelado pelo host ⇒ `processPaymentRefund` chamado 1 vez e, com o mock real removido, `handlePaymentRefund` chamado 2 vezes; e em `confirm.handler` (rejeição), mesma expectativa de iteração.

## 5. Tempo Gasto e Retrospectiva

**Tempo honesto:** ~45 minutos, do checkout do commit (`009f91d163`) ao diagnóstico completo com raio de impacto e mapa de testes.

**O que faria diferente:** consultar a **cardinalidade das tabelas no `schema.prisma`** (`Booking` 1 : N `Payment`) logo após entender o sintoma — "múltiplos assentos pagos, um só reembolso" grita relação 1:N. Com o modelo em mãos, a investigação iria direto para buscas por **acessos indexados incorretos** ao array de pagamentos (`payment[0]` ou `payment.find(...)`) no caminho de refund, encurtando a navegação manual rota-por-rota (`/api/cancel` → `handleCancelBooking.ts` → `processPaymentRefund.ts`). A jornada real funcionou, mas gastou passos intermediários que um olhar pelo modelo de dados teria pulado; o mesmo exercício adiantaria a checagem do segundo chamador (`confirm.handler.ts:415`), que hoje só apareceu no fim do raio de impacto.

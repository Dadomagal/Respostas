import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { orderItemMetricsDaily } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

export type PartnerItem = {
  item_id: string;
  storeId: string;
  revenue: number;
  orders: number;
};

export type Row = {
  accountId: string;
  storeId: string;
  itemId: string;
  snapshotDate: string; // "YYYY-MM-DD"
  revenue: number;
  orders: number;
};

export const CHUNK_SIZE = 500;

/**
 * Agrega as linhas do parceiro ANTES de tocar o banco.
 * O payload desmembrado (a partir do dia 02) traz o mesmo item_id várias
 * vezes; somar aqui garante chaves únicas (accountId, storeId, itemId,
 * snapshotDate) por lote — condição para o ON CONFLICT DO UPDATE ser válido.
 */
export function aggregateRows(rows: Row[]): Row[] {
  const aggregated = new Map<string, Row>();

  for (const row of rows) {
    const key = `${row.accountId}|${row.storeId}|${row.itemId}|${row.snapshotDate}`;
    const existing = aggregated.get(key);

    if (existing) {
      existing.revenue += row.revenue;
      existing.orders += row.orders;
    } else {
      aggregated.set(key, row);
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Sincronização de métricas por item (cron orders-snapshot-daily).
 *
 * Garantias:
 * - Escopo de tenant: accountId vem do contexto do job, nunca do payload.
 * - Atomicidade: os lotes de 500 itens compartilham UMA transação — ou grava
 *   o dia inteiro, ou não grava nada.
 * - Sem catch: falha de banco PROPAGA e falha o step do cron (Failed + retry);
 *   nunca é rebaixada a log.
 */
export async function syncOrderItemMetrics(
  accountId: string,
  today: string,
  page: { results: PartnerItem[] },
): Promise<void> {
  const scoped: Row[] = page.results.map((item) => ({
    accountId,
    storeId: item.storeId,
    itemId: item.item_id,
    snapshotDate: today,
    revenue: item.revenue,
    orders: item.orders,
  }));

  const rows = aggregateRows(scoped);

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

  logger.info("orders.snapshot.item_batch_persisted", {
    accountId,
    snapshotDate: today,
    rows: rows.length,
  });
}

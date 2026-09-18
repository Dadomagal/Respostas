# RFC — Gestão de Rate Limits das APIs Parceiras

**Status:** Aguardando decisão do fundador • **Escala:** 4 restaurantes hoje, milhares na meta

**Problema em uma frase:** a cota de chamadas do parceiro é um cano fino compartilhado; hoje, cada abertura da tela de cardápio o bombardeia com 9 pedidos simultâneos e, no App de Delivery A, o cano é único para todos os restaurantes — um cliente derruba os demais.

---

## 1. Regra de Ouro: a tela nunca fala com o parceiro

**Decisão primária:** a tela de cardápio **nunca mais fará chamadas diretas** (*live fetches*) à API do parceiro ao ser aberta. Ela lê **100% do banco de dados local da Prato** — resposta em milissegundos e **zero consumo da cota**. A conversa com o parceiro passa a ocorrer exclusivamente por sincronizações assíncronas em segundo plano.

**Impacto de negócio:** cardápio instantâneo e imune às instabilidades do parceiro; a cota fica reservada para o que só ele pode responder.

## 2. Onde mora o limitador — sem criar engarrafamento próprio

Um **único portão de saída** (*Outbound API Gateway*) por onde toda chamada ao parceiro passa; o controle de vazão fica centralizado no **Redis**: uma "torneira" por aplicativo, chaveada por `app_id` (App A), e uma por restaurante, por `tenant_id` (App B).

**Token Leasing (anti-gargalo):** em vez de milhares de instâncias consultarem o Redis a cada chamada individual — transformando nosso próprio controle no gargalo nos horários de pico — cada instância **reserva lotes de autorizações** periodicamente, como um caixa que busca troco para a banca em vez de voltar a cada venda. A contenção de rede desaparece.

## 3. O que estoura primeiro: a tela (no modelo antigo)

O cron roda **sequencial e cadenciado**, um restaurante por vez — consumo espalhado no tempo. A tela gerava um **surto** (*burst*): dezenas de chamadas simultâneas em milissegundos a cada operador que abria o cardápio. Vários operadores juntos estouravam a cota em segundos — e o cron e os demais restaurantes pagavam a conta. Com a Regra de Ouro, o risco desaparece na origem.

## 4. Se o Redis cair: degradação graciosa, sem caos de estoque

**Proibido o *fail-closed* cego:** bloquear as sincronizações de estoque numa queda do Redis na sexta à noite faz o restaurante **vender prato esgotado** — cancelamentos em massa e penalidades contratuais.

- **Leituras (UI):** seguem 100% operacionais pelo banco local da Prato (*fail-open*).
- **Escritas / estoque (jobs):** as instâncias alternam automaticamente para um **limitador local de emergência em memória** (*Local Fallback Limiter*), ultra-conservador — **máximo 1 chamada a cada 2 segundos por instância**. O estoque segue sendo atualizado, devagar, e a conta da Prato não é banida pelo parceiro.

## 5. Termostato Automático de Tráfego

Como o parceiro não publica o teto, o sistema se **auto-calibra**. **Medimos primeiro:** erros 429 (`partner_rate_limit_exceeded`, o "aviso de limite excedido"), o cabeçalho `Retry-After` ("volte daqui a X segundos") e o tempo de resposta como sinal precoce de aperto. **Ajuste:** o sistema inicia num ritmo seguro (ex.: 5 chamadas/segundo), **acelera gradualmente** enquanto o parceiro responde bem e, ao receber o **primeiro 429**, **desacelera imediatamente** — fixando o teto operacional seguro do aplicativo, sem teste destrutivo.

## 6. O que NÃO fazer (anti-patterns)

1. **Chamadas síncronas a API externa no carregamento de telas** — é a volta do problema original.
2. **Cota fixa por restaurante no App A** — quebraria o isolamento e esgotaria o limite global **100× mais rápido** na escala.
3. **Retentativa imediata (*busy-wait*) ao receber 429** — martelar a porta fechada converge para o banimento da conta.

---

**Recomendação:** aprovar a Regra de Ouro (UI 100% banco local), o portão único de saída com Redis + Token Leasing, a degradação graciosa e o termostato de descoberta do teto.

// ==UserScript==
// @name         Ahgora — Painel Inteligente Local
// @namespace    https://github.com/jonathanfiss
// @version      2.3.0
// @description  Painel inteligente local para Ahgora
// @author       Jonathan Fiss

// @match https://mirror.app.ahgora.com.br/*
// @match https://app.ahgora.com.br/*

// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @run-at       document-idle

// @downloadURL  https://github.com/jonathanfiss/js.controle-ponto-Ahgora/raw/refs/heads/master/ahgora-panel.user.js
// @updateURL    https://github.com/jonathanfiss/js.controle-ponto-Ahgora/raw/refs/heads/master/ahgora-panel.user.js

// ==/UserScript==

(function () {
  "use strict";

  /* =========================================================
       CONFIG — todas as constantes, sem magic numbers
    ========================================================= */

  const CONFIG = {
    // Jornada
    CARGA_DIARIA: 8 * 60, // minutos
    MAX_HORAS_DIA: 10 * 60,
    MAX_HORAS_TURNO: 6 * 60,
    AVISO_TURNO: 30,
    AVISO_DIA: 30,
    INTERVALO_MINIMO: 30,
    INTERVALO_MAXIMO: 3 * 60 + 30, // CLT: máximo 3h30
    DESCANSO_MINIMO: 11 * 60, // interjornada mínima
    TOLERANCIA: 10, // minutos — saldo dentro desse intervalo é zerado
    // Sistema
    AUTO_REFRESH_MIN: 15,
    VERSAO: "2.3.0",
    SCHEMA_VERSION: 1,
    DEBUG_NOTIF: false, // true → mostra painel de testes de notificação no UI
    // URLs
    URL_REFRESH: "https://app.ahgora.com.br/externo/mirror",
    BATIDA_URL: "https://app.ahgora.com.br/novabatidaonline/",
    NOTIFICACOES: {
      h6: [10, 5, 4, 3, 2, 1],
      h8: [10, 5, 4, 3, 2, 1],
      h10: [10, 5, 4, 3, 2, 1],
      ideal: [5, 1],
      // Lembretes de entrada: dispara N minutos antes do horário padrão de entrada
      // Ajuste HORARIO_ENTRADA_PADRAO para o seu horário de trabalho
      HORARIO_ENTRADA_PADRAO: "09:00", // "HH:MM" — usado como ancoragem do lembrete de entrada
      entrada: [15, 10, 5, 0], // avisar 15 e 5 minutos antes da entrada
      // Lembrete de almoço — OPCIONAL
      // Preencha "HH:MM" para ativar; deixe '' (vazio) para desativar
      HORARIO_ALMOCO: "12:00", // ex.: '12:00'
      almoco: [5, 0], // minutos antes do horário (0 = na hora)
      // Lembrete de retorno do almoço — OPCIONAL
      // Minutos após a SAÍDA para o almoço em que avisa para lançar o retorno.
      // 0 (ou vazio) desativa.
      RETORNO_ALMOCO_APOS_MIN: 70,
    },
    // Janela de recuperação de notificações perdidas (ms)
    // Aumentada para cobrir casos de "abri o browser agora"
    NOTIF_RECOVERY_WINDOW_MS: 4 * 60 * 60 * 1000, // 4 horas
    // Recarga do espelho logo após registrar a batida em /novabatidaonline/
    RECARGA_POS_BATIDA: {
      ATIVO: true,
      ATRASO_INICIAL_S: 3, // espera após o clique antes de recarregar
      ESPERA_APOS_CARGA_S: 6, // tempo para o espelho renderizar antes de conferir
      RETENTATIVAS_S: [10, 20, 30, 45], // se a batida ainda não apareceu, recarrega de novo
      TEMPO_MAX_S: 180, // desiste após esse tempo
      // Pergunta se quer abrir o espelho quando ele está fechado
      PERGUNTAR_ABRIR_ESPELHO: true,
      ESPELHO_TOLERANCIA_S: 25, // sem sinal de vida por mais que isso = espelho fechado
      ATRASO_AVISO_S: 2, // espera antes de mostrar a pergunta
      AVISO_TIMEOUT_S: 20, // some sozinha após esse tempo (0 = fica até fechar)
    },
    // Sessão expirada / motor reserva
    SESSAO: {
      ATIVO: true,
      ESPERA_S: 60, // espelho sem sinal de vida por esse tempo = alerta
      REPETIR_MIN: 30, // repete o alerta a cada N min enquanto continuar deslogado
    },
    // Resumo do dia na página de registro de ponto
    RESUMO_BATIDA: {
      ATIVO: true,
      DADOS_ANTIGOS_MIN: 20, // sem atualização do espelho há mais que isso = avisa
    },
  };

  // REGRAS aponta para as mesmas constantes de CONFIG — fonte única de verdade
  CONFIG.REGRAS = {
    CARGA_DIARIA: CONFIG.CARGA_DIARIA,
    MAX_DIA: CONFIG.MAX_HORAS_DIA,
    MAX_TURNO: CONFIG.MAX_HORAS_TURNO,
    INTERVALO_MIN: CONFIG.INTERVALO_MINIMO,
    INTERVALO_MAX: CONFIG.INTERVALO_MAXIMO,
    DESCANSO_INTERJORNADA: CONFIG.DESCANSO_MINIMO,
    MAX_DIAS_CONSECUTIVOS: 6,
    ON_CALL_MAX: 24 * 60,
    ON_CALL_DESCANSO: CONFIG.DESCANSO_MINIMO,
  };

  /* =========================================================
   MirrorBeat — sinal de vida do espelho. O iframe do espelho
   grava o horário a cada 5s; a página de batida lê para saber
   se o espelho está aberto.
========================================================= */

  const MirrorBeat = {
    KEY: "ahg_mirror_alive",

    beat() {
      try {
        GM_setValue(this.KEY, Date.now());
      } catch {
        /* silent */
      }
    },

    isOpen() {
      try {
        const ts = Number(GM_getValue(this.KEY, 0)) || 0;
        const tolMs =
          (CONFIG.RECARGA_POS_BATIDA?.ESPELHO_TOLERANCIA_S || 25) * 1000;
        return Date.now() - ts < tolMs;
      } catch {
        return true; // na dúvida, não incomoda
      }
    },
  };

  /* =========================================================
   PunchSignal — roda na página de batida (/novabatidaonline/).
   Detecta a confirmação do ponto e avisa o espelho (outra aba).
  ========================================================= */

  const PunchSignal = {
    KEY: "ahg_punch_signal",

    attach() {
      // Captura (3º argumento true) para não depender de stopPropagation do React
      document.addEventListener(
        "click",
        (e) => {
          const btn = e.target.closest?.("button");
          if (!btn) return;
          if (btn.textContent.trim().toLowerCase() !== "registrar ponto")
            return;

          // Só o botão do modal de confirmação
          const modal = btn.closest('[role="presentation"]');
          if (
            !modal ||
            !/confirme seu registro de ponto/i.test(modal.textContent)
          )
            return;

          this.send();
        },
        true,
      );
      console.log("[AHGORA PANEL] monitorando registro de ponto nesta página");
    },

    send() {
      try {
        GM_setValue(this.KEY, {
          ts: Date.now(),
          nonce: Math.random().toString(36).slice(2),
        });
        console.log(
          "[AHGORA PANEL] ponto registrado → sinal enviado ao espelho",
        );
      } catch (e) {
        console.warn("[AHGORA PANEL] falha ao enviar sinal:", e);
      }
      this.verificarEspelho();
    },

    // Se o espelho não está aberto, pergunta se quer abri-lo
    verificarEspelho() {
      const cfg = CONFIG.RECARGA_POS_BATIDA;
      if (!cfg?.PERGUNTAR_ABRIR_ESPELHO) return;
      if (MirrorBeat.isOpen()) return;
      setTimeout(() => this.perguntarAbrir(), (cfg.ATRASO_AVISO_S ?? 2) * 1000);
    },

    abrirEspelho() {
      try {
        if (typeof GM_openInTab === "function") {
          GM_openInTab(CONFIG.URL_REFRESH, { active: true, insert: true });
          return;
        }
      } catch {
        /* cai no window.open */
      }
      window.open(CONFIG.URL_REFRESH, "_blank");
    },

    perguntarAbrir() {
      if (typeof GM_notification !== "function") return;
      const cfg = CONFIG.RECARGA_POS_BATIDA;
      GM_notification({
        title: "✅ Ponto enviado — abrir o espelho?",
        text: "O espelho não está aberto. Clique aqui para abri-lo e conferir sua batida.",
        timeout: (cfg.AVISO_TIMEOUT_S ?? 20) * 1000,
        onclick: () => this.abrirEspelho(),
      });
    },
  };

  /* =========================================================
   PunchSummary — cartão "Resumo do dia" na página de registro
   de ponto. Lê o estado publicado pelo espelho (SharedStore).
========================================================= */

  const PunchSummary = {
    STATE_KEY: "ahg_shared_state",
    LS_COLLAPSED: "ahg_summary_collapsed",
    _el: null,

    init() {
      if (!CONFIG.RESUMO_BATIDA?.ATIVO) return;
      if (document.getElementById("ahg-summary")) return;

      this.injectCSS();
      const el = document.createElement("div");
      el.id = "ahg-summary";
      document.body.appendChild(el);
      this._el = el;
      this.render();

      Ticker.on(30000, () => this.render()); // atualiza o tempo trabalhado ao vivo
      try {
        // atualiza assim que o espelho publicar dados novos
        GM_addValueChangeListener(this.STATE_KEY, () => this.render());
        // e logo após você confirmar a batida (mostra "aguardando o espelho")
        GM_addValueChangeListener(PunchSignal.KEY, () =>
          setTimeout(() => this.render(), 300),
        );
      } catch {
        /* sem listener: o Ticker cobre */
      }
    },

    _esc(s) {
      return String(s).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      );
    },

    _isCollapsed() {
      try {
        const v = localStorage.getItem(this.LS_COLLAPSED);
        if (v === null) return window.innerWidth < 600;
        return v === "1";
      } catch {
        return false;
      }
    },

    _abrirEspelho() {
      try {
        PunchSignal.abrirEspelho();
      } catch {
        window.open(CONFIG.URL_REFRESH, "_blank");
      }
    },

    render() {
      const el = this._el;
      if (!el) return;

      const collapsed = this._isCollapsed();
      const hoje = new Date();
      const dataTxt = `${DataHelper.DIAS_SEMANA_CURTO[hoje.getDay()]} ${String(hoje.getDate()).padStart(2, "0")}/${String(hoje.getMonth() + 1).padStart(2, "0")}`;

      el.innerHTML = `
        <div class="ahg-sum-tit" id="ahg-sum-toggle">📋 Resumo do dia<small>${dataTxt} ${collapsed ? "▸" : "▾"}</small></div>
        ${collapsed ? "" : `<div class="ahg-sum-body">${this._corpo()}</div>`}
      `;

      el.querySelector("#ahg-sum-toggle").onclick = () => {
        try {
          localStorage.setItem(this.LS_COLLAPSED, collapsed ? "0" : "1");
        } catch {
          /* silent */
        }
        this.render();
      };
      el.querySelector("#ahg-sum-open")?.addEventListener("click", () =>
        this._abrirEspelho(),
      );
    },

    _corpo() {
      const cfg = CONFIG.RESUMO_BATIDA;
      const st = SharedStore.get(this.STATE_KEY, null);
      const espelhoAberto = MirrorBeat.isOpen();
      const btnEspelho = `<button class="ahg-sum-btn" id="ahg-sum-open">Abrir espelho</button>`;

      // Sem dados de hoje
      if (!st || st.date !== todayDateStr() || !Array.isArray(st.batidas)) {
        return espelhoAberto
          ? `<div class="ahg-sum-aviso">Aguardando o espelho carregar os dados de hoje…</div>`
          : `<div class="ahg-sum-aviso">Ainda sem dados de hoje.<br>Abra o espelho para sincronizar.</div>${btnEspelho}`;
      }

      const batidas = st.batidas;
      const frozen = !!st.frozen;
      const manMin = (st.manuais || []).map((t) => Hora.toMin(t));
      const NOMES = ["Entrada", "Saída almoço", "Retorno almoço", "Saída"];
      const R = (l, v, c = "", vc = "") =>
        `<div class="ahg-sum-row ${c}"><span class="ahg-sum-lbl">${l}</span><span class="ahg-sum-val ${vc}">${v}</span></div>`;

      let html = "";

      // ── Status de sincronização ─────────────────────────────────────
      const upd = st.updatedAt || 0;
      const hhmm = new Date(upd).toTimeString().slice(0, 5);
      let sig = null;
      try {
        sig = GM_getValue(PunchSignal.KEY, null);
      } catch {
        /* silent */
      }
      const pendente = sig && sig.ts > upd && Date.now() - sig.ts < 180000;
      const idadeMin = (Date.now() - upd) / 60000;

      let aviso = "";
      if (pendente) {
        aviso = espelhoAberto
          ? "⏳ Aguardando o espelho registrar a batida…"
          : "⏳ Batida enviada — abra o espelho para atualizar o resumo.";
      } else if (!espelhoAberto && idadeMin > cfg.DADOS_ANTIGOS_MIN) {
        aviso = `Dados das ${hhmm} — abra o espelho para atualizar.`;
      }
      if (aviso) {
        html += `<div class="ahg-sum-aviso">${aviso}</div>`;
        if (!espelhoAberto) html += btnEspelho;
      }

      // ── Situação e batidas ──────────────────────────────────────────
      const estado = frozen
        ? "🛫 Encerrado"
        : Jornada.resolverEstado(batidas).label;
      html += R("Situação", estado);

      html += `<div class="ahg-sum-sec">Batidas</div>`;
      if (!batidas.length) {
        html += `<div class="ahg-sum-aviso">Nenhuma batida registrada hoje.</div>`;
      }
      batidas.forEach((t, i) => {
        const man = manMin.includes(Hora.toMin(t))
          ? '<span class="ahg-sum-man" title="Batida manual (local)">✎</span>'
          : "";
        html += R(NOMES[i] || `Batida ${i + 1}`, `${this._esc(t)}${man}`);
      });
      if (!frozen && batidas.length < NOMES.length) {
        html += `<div class="ahg-sum-prox">Próxima: ${NOMES[batidas.length]}</div>`;
      }

      // ── Totais do dia ───────────────────────────────────────────────
      if (batidas.length) {
        const trabalhado = Jornada.calcularTrabalhado(batidas);
        const saldoDia = trabalhado - CONFIG.CARGA_DIARIA;
        html += `<div class="ahg-sum-sec">Hoje</div>`;
        html += R(
          "Trabalhado",
          Hora.fmtMin(trabalhado),
          "",
          trabalhado >= CONFIG.CARGA_DIARIA ? "pos" : "warn",
        );
        html += R(
          "Saldo do dia",
          Hora.fmtMin(saldoDia),
          "",
          saldoDia >= 0 ? "pos" : "neg",
        );
      }

      // ── Saídas previstas (dia em andamento) ─────────────────────────
      if (!frozen && batidas.length) {
        const s = Jornada.calcularSaidas(batidas, Number(st.saldoSemana) || 0);
        const linhas = [
          s.h6 !== null &&
            R("⚠️ 6h (limite turno)", Hora.fmtHour(s.h6), "warn", "warn"),
          s.h8 !== null && R("✅ 8h (meta)", Hora.fmtHour(s.h8), "ok", "pos"),
          s.saidaIdeal !== null &&
            R("🏆 Saída ideal", Hora.fmtHour(s.saidaIdeal)),
          s.h10 !== null &&
            R("⛔ 10h (limite dia)", Hora.fmtHour(s.h10), "danger", "neg"),
        ]
          .filter(Boolean)
          .join("");
        if (linhas)
          html += `<div class="ahg-sum-sec">Saídas previstas</div>${linhas}`;
      }

      // ── Intervalo e descanso ────────────────────────────────────────
      const iv = Jornada.calcularIntervalo(batidas);
      if (iv.retornoMinimo) {
        html += `<div class="ahg-sum-sec">Intervalo</div>`;
        html += R("⏳ Retorno mínimo", Hora.fmtHour(iv.retornoMinimo));
        html += R(
          "⚠️ Retorno máximo",
          Hora.fmtHour(iv.retornoMaximo),
          "warn",
          "warn",
        );
      }
      const d11 = Jornada.calcularDescanso(batidas);
      if (d11) html += R("🛌 Retorne após (11h)", Hora.fmtHour(d11));

      // ── Saldos ──────────────────────────────────────────────────────
      if (typeof st.saldoSemanaComHoje === "number") {
        html += `<div class="ahg-sum-sec">Saldos</div>`;
        html += R(
          "Semanal",
          Hora.fmtMin(st.saldoSemanaComHoje),
          "",
          st.saldoSemanaComHoje >= 0 ? "pos" : "neg",
        );
        if (typeof st.saldoMes === "number") {
          html += R(
            "Mensal",
            Hora.fmtMin(st.saldoMes),
            "",
            st.saldoMes >= 0 ? "pos" : "neg",
          );
        }
      }

      html += `<div class="ahg-sum-foot">Atualizado ${hhmm}</div>`;
      return html;
    },

    injectCSS() {
      if (document.getElementById("ahg-summary-css")) return;
      const style = document.createElement("style");
      style.id = "ahg-summary-css";
      style.textContent = `
        #ahg-summary{
            position:fixed;bottom:16px;right:16px;z-index:1000;width:270px;
            background:#0f0f1e;border:1px solid #252545;border-radius:14px;
            color:#dde;font-family:'Segoe UI',sans-serif;font-size:12px;
            box-shadow:0 8px 40px rgba(0,0,0,.45);overflow:hidden;
        }
        .ahg-sum-tit{
            display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;
            background:linear-gradient(135deg,#3b2d82,#1e1b4b);color:#b9a9ff;
            font-weight:700;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;
            padding:9px 12px;
        }
        .ahg-sum-tit small{margin-left:auto;opacity:.75;font-weight:600;letter-spacing:0;text-transform:none;}
        .ahg-sum-body{
            padding:8px 10px 10px;display:flex;flex-direction:column;gap:4px;
            max-height:60vh;overflow-y:auto;
        }
        .ahg-sum-row{
            display:flex;justify-content:space-between;align-items:center;
            padding:4px 8px;border-radius:7px;
            background:rgba(100,100,255,.1);border-left:3px solid #7878ff;
        }
        .ahg-sum-row.ok{background:rgba(61,220,132,.1);border-color:#3ddc84;}
        .ahg-sum-row.warn{background:rgba(255,165,0,.12);border-color:orange;}
        .ahg-sum-row.danger{background:rgba(255,60,60,.14);border-color:#ff4444;}
        .ahg-sum-lbl{color:#9a9ac0;font-size:11.5px;}
        .ahg-sum-val{font-weight:700;font-size:13px;color:#b9a9ff;text-align:right;}
        .ahg-sum-val.pos{color:#3ddc84;}
        .ahg-sum-val.neg{color:#ff6b6b;}
        .ahg-sum-val.warn{color:orange;}
        .ahg-sum-sec{
            font-size:10px;letter-spacing:1px;text-transform:uppercase;
            color:#6a6a90;padding:5px 0 1px;font-weight:700;
        }
        .ahg-sum-aviso{
            font-size:11.5px;color:#ffb347;padding:5px 8px;border-radius:7px;
            background:rgba(255,165,0,.1);
        }
        .ahg-sum-prox{font-size:11px;color:#7880aa;padding:0 8px;font-style:italic;}
        .ahg-sum-man{color:#ffb347;margin-left:4px;}
        .ahg-sum-foot{font-size:10px;font-weight:700;color:#555880;text-align:right;padding-top:4px;}
        .ahg-sum-btn{
            background:#3b2d82;color:#fff;border:none;border-radius:6px;
            padding:6px 10px;cursor:pointer;font-size:12px;
        }
        .ahg-sum-btn:hover{background:#4a3faf;}
        .ahg-sum-body::-webkit-scrollbar{width:8px;}
        .ahg-sum-body::-webkit-scrollbar-thumb{background:#444466;border-radius:10px;}
        @media (max-width:600px){
            #ahg-summary{width:calc(100% - 24px);right:12px;bottom:12px;}
        }
      `;
      document.head.appendChild(style);
    },
  };

  /* =========================================================
   SessionGuard — avisa quando a sessão do Ahgora expirou
   (página de login ou espelho que não está carregando).
========================================================= */

  const SessionGuard = {
    KEY: "ahg_session_alert_ts",
    _loadedAt: Date.now(),

    isLoginPage() {
      return !!document.querySelector('input[type="password"]');
    },

    naPaginaEspelho() {
      return location.pathname.includes("/externo/mirror");
    },

    check() {
      const cfg = CONFIG.SESSAO;
      if (!cfg?.ATIVO) return;
      if (location.pathname.includes("/novabatidaonline")) return; // espelho fechado ali é normal
      if (MirrorBeat.isOpen()) return; // espelho ativo = sessão ok

      const login = this.isLoginPage();
      if (!login && !this.naPaginaEspelho()) return; // outras páginas: não alerta

      const upS = (Date.now() - this._loadedAt) / 1000;
      if (upS < (login ? 8 : cfg.ESPERA_S)) return; // dá tempo da página carregar

      const last = Number(GM_getValue(this.KEY, 0)) || 0;
      if (Date.now() - last < cfg.REPETIR_MIN * 60000) return;
      try {
        GM_setValue(this.KEY, Date.now());
      } catch {
        /* silent */
      }

      this.alertar();
    },

    alertar() {
      if (!document.title.startsWith("🔒"))
        document.title = `🔒 ${document.title}`;
      if (typeof GM_notification !== "function") return;
      GM_notification({
        title: "🔒 Ahgora: sessão expirada",
        text: "O painel parou de monitorar seu ponto. Faça login novamente para voltar a receber as notificações.",
        timeout: 0, // fica na tela até você fechar
        onclick: () => {
          try {
            window.focus();
          } catch {
            /* silent */
          }
        },
      });
    },
  };

  /* =========================================================
   PunchSync — roda no iframe do espelho. Recebe o sinal,
   recarrega e confere se a batida apareceu (com retentativas).
   Key: "ahg_punch_watch" { date, baseCount, startedAt, attempts, phase, nextAt }
========================================================= */

  const PunchSync = {
    SIGNAL_KEY: "ahg_punch_signal",
    WATCH_KEY: "ahg_punch_watch",
    _since: Date.now(),
    _seen: null,

    // Batidas reais de hoje no espelho (sem as manuais locais)
    contarHoje() {
      const el = document.querySelector(".v-calendar-weekly__day.v-present");
      if (!el) return null;
      return [...el.querySelectorAll(".batida")].filter(
        (x) => !x.classList.contains("prevista"),
      ).length;
    },

    _readSignal() {
      try {
        return GM_getValue(this.SIGNAL_KEY, null);
      } catch {
        return null;
      }
    },

    _loadWatch() {
      try {
        const o = JSON.parse(localStorage.getItem(this.WATCH_KEY) || "null");
        return o && o.date === todayDateStr() ? o : null;
      } catch {
        return null;
      }
    },

    _saveWatch(o) {
      try {
        if (o) localStorage.setItem(this.WATCH_KEY, JSON.stringify(o));
        else localStorage.removeItem(this.WATCH_KEY);
      } catch {
        /* silent */
      }
    },

    init() {
      this._since = Date.now();
      this._seen = this._readSignal()?.nonce ?? null; // ignora sinais antigos

      const handle = (v) => {
        if (!v || v.nonce === this._seen) return;
        if (Date.now() - (v.ts || 0) > 60000) return; // sinal velho demais
        this._seen = v.nonce;
        this.onSignal();
      };

      if (typeof GM_addValueChangeListener === "function") {
        try {
          GM_addValueChangeListener(
            this.SIGNAL_KEY,
            (name, oldV, newV, remote) => {
              if (remote === false) return;
              handle(newV);
            },
          );
          return;
        } catch {
          /* cai no polling */
        }
      }
      Ticker.on(1000, () => handle(this._readSignal())); // fallback por polling
    },

    onSignal() {
      const cfg = CONFIG.RECARGA_POS_BATIDA;
      if (!cfg?.ATIVO) return;
      const now = Date.now();
      console.log("[AHGORA PANEL] sinal de ponto recebido — recarga agendada");
      this._saveWatch({
        date: todayDateStr(),
        baseCount: this.contarHoje(), // null se o mês de hoje não está visível
        startedAt: now,
        attempts: 0,
        phase: "reload",
        nextAt: now + cfg.ATRASO_INICIAL_S * 1000,
      });
    },

    _reload() {
      STATE.nextRefresh = Date.now() + CONFIG.AUTO_REFRESH_MIN * 60 * 1000;
      window.top.location = CONFIG.URL_REFRESH;
    },

    // Chamado a cada 2s pelo Ticker (roda também em aba oculta)
    tick() {
      const cfg = CONFIG.RECARGA_POS_BATIDA;
      if (!cfg?.ATIVO) return;

      const w = this._loadWatch();
      if (!w) return;

      const now = Date.now();
      if (now - w.startedAt > cfg.TEMPO_MAX_S * 1000) {
        this._saveWatch(null);
        return;
      }
      if (now < w.nextAt) return;

      // Fase 1: recarrega o espelho
      if (w.phase === "reload") {
        w.phase = "verify";
        w.nextAt = 0;
        this._saveWatch(w);
        this._reload();
        return;
      }

      // Fase 2 (após a recarga): confere se a batida apareceu
      if (now - this._since < cfg.ESPERA_APOS_CARGA_S * 1000) return; // deixa renderizar

      const atual = this.contarHoje();
      const apareceu =
        w.baseCount === null || (atual !== null && atual > w.baseCount);

      if (apareceu) {
        console.log("[AHGORA PANEL] batida apareceu no espelho");
        this._saveWatch(null);
        render();
        return;
      }

      w.attempts++;
      const delays = cfg.RETENTATIVAS_S || [];
      if (w.attempts > delays.length) {
        console.log("[AHGORA PANEL] batida não apareceu — desistindo");
        this._saveWatch(null);
        return;
      }

      console.log(
        `[AHGORA PANEL] batida ainda não apareceu — nova tentativa em ${delays[w.attempts - 1]}s`,
      );
      w.phase = "reload";
      w.nextAt = now + delays[w.attempts - 1] * 1000;
      this._saveWatch(w);
    },
  };

  /* =========================================================
       STATE — estado de runtime centralizado
    ========================================================= */

  const STATE = {
    menuRelatorios: false,
    menuDebug: false,
    statusExpandido: false,
    nextRefresh: Date.now() + CONFIG.AUTO_REFRESH_MIN * 60 * 1000,
    dragging: false,
    dragOX: 0,
    dragOY: 0,
    panelMinimized: false,
    notificationsFired: new Map(),
    // Período visível no calendário (pode diferir do mês atual)
    periodoSelecionado: { ano: null, mes: null },
  };

  /* =========================================================
       Utilitários internos
    ========================================================= */

  // Data de hoje como "YYYY-MM-DD" — usada em WorkdayStore, NotifScheduler, checarNotifs
  function todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Converte "HH:MM" → minutos desde meia-noite
  function hmToMin(s) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }

  /* =========================================================
   SharedStore — armazenamento do Tampermonkey, compartilhado
   entre todas as páginas/origens do script (JSON).
========================================================= */

  const SharedStore = {
    get(key, fallback = null) {
      try {
        const raw = GM_getValue(key, null);
        if (raw === null || raw === undefined) return fallback;
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        GM_setValue(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };

  /* =========================================================
   Leader — evita que duas abas (ex.: login + batida) disparem
   a mesma notificação no modo reserva.
========================================================= */

  const Leader = {
    KEY: "ahg_fallback_leader",
    _id: Math.random().toString(36).slice(2),

    isLeader() {
      const cur = SharedStore.get(this.KEY, null);
      const now = Date.now();
      if (!cur || cur.id === this._id || now - cur.ts > 5000) {
        SharedStore.set(this.KEY, { id: this._id, ts: now });
        return true;
      }
      return false;
    },
  };

  /* =========================================================
   ManualPunches — batidas manuais locais (solicitações que
   não aparecem no espelho). Key: "ahg_manual_punches"
   { "YYYY-MM-DD": [ { time: "HH:MM", createdAt } ] }
========================================================= */

  const ManualPunches = {
    _KEY: "ahg_manual_punches",

    _loadAll() {
      try {
        const o = JSON.parse(localStorage.getItem(this._KEY) || "{}");
        return o && typeof o === "object" ? o : {};
      } catch {
        return {};
      }
    },

    _saveAll(o) {
      try {
        localStorage.setItem(this._KEY, JSON.stringify(o));
      } catch (e) {
        console.warn("[ManualPunches] save failed:", e);
      }
    },

    dateStr(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    },

    timesFor(dateStr) {
      return (this._loadAll()[dateStr] || []).map((x) => x.time);
    },

    add(dateStr, time) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || ""))
        return { ok: false, erro: "Data inválida." };
      const m = /^(\d{2}):(\d{2})$/.exec(time || "");
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
        return { ok: false, erro: "Horário inválido." };

      const hoje = todayDateStr();
      if (dateStr > hoje)
        return {
          ok: false,
          erro: "Não é possível inserir batida em data futura.",
        };
      if (dateStr === hoje && hmToMin(time) > Hora.nowMin())
        return { ok: false, erro: "Esse horário ainda não chegou." };

      const all = this._loadAll();
      const list = all[dateStr] || [];
      if (list.some((x) => x.time === time))
        return { ok: false, erro: "Essa batida manual já existe." };

      list.push({ time, createdAt: new Date().toISOString() });
      list.sort((a, b) => hmToMin(a.time) - hmToMin(b.time));
      all[dateStr] = list;
      this._saveAll(all);
      return { ok: true };
    },

    remove(dateStr, time) {
      const all = this._loadAll();
      if (!all[dateStr]) return false;
      const antes = all[dateStr].length;
      all[dateStr] = all[dateStr].filter((x) => x.time !== time);
      if (!all[dateStr].length) delete all[dateStr];
      this._saveAll(all);
      return true;
    },

    listAll() {
      const all = this._loadAll();
      const out = [];
      Object.keys(all).forEach((date) =>
        all[date].forEach((x) => out.push({ date, time: x.time })),
      );
      return out.sort(
        (a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time),
      );
    },

    prune(days = 400) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const lim = this.dateStr(cutoff);
      const all = this._loadAll();
      let dirty = false;
      Object.keys(all).forEach((k) => {
        if (k < lim) {
          delete all[k];
          dirty = true;
        }
      });
      if (dirty) this._saveAll(all);
    },

    // Mescla batidas do espelho + manuais (ordenadas). Se o espelho já
    // tiver o mesmo horário, a manual é ignorada (sem duplicar).
    merge(dateStr, domBatidas) {
      const domMin = domBatidas.map((t) => Hora.toMin(t));
      const manuais = this.timesFor(dateStr).filter(
        (t) => !domMin.includes(hmToMin(t)),
      );
      if (!manuais.length) return { batidas: domBatidas, manuais: [] };
      const batidas = [...domBatidas, ...manuais].sort(
        (a, b) => Hora.toMin(a) - Hora.toMin(b),
      );
      return { batidas, manuais };
    },
  };

  /* =========================================================
       WorkdayStore — persistent workday state (localStorage)
    =========================================================
       Key: "ahg_workday_<YYYY-MM-DD>"
       Schema v1:
       {
           schemaVersion: 1,
           date: "YYYY-MM-DD",
           entries: [
               { type, time, source, createdAt }
           ],
           status: "OPEN" | "COMPLETED"
       }
       Event types (ACTUAL):
           WORK_START, BREAK_START, BREAK_END, WORK_END
       Source:
           DOM   — read from calendar DOM (.batida elements)
           MANUAL — explicitly registered by user
    ========================================================= */

  /* =========================================================
   Ticker — relógio em Web Worker (sem throttling em aba oculta)
========================================================= */
  const Ticker = {
    _handlers: [],
    _worker: null,
    _fallbackId: null,
    _started: false,

    on(everyMs, fn) {
      this._handlers.push({ everyMs, fn, last: 0 });
    },

    _loop() {
      const now = Date.now();
      Ticker._handlers.forEach((h) => {
        if (now - h.last >= h.everyMs) {
          h.last = now;
          try {
            h.fn(now);
          } catch (e) {
            console.error("[AHGORA PANEL] ticker:", e);
          }
        }
      });
    },

    _useFallback() {
      if (this._fallbackId) return;
      if (this._worker) {
        try {
          this._worker.terminate();
        } catch {
          /* silent */
        }
        this._worker = null;
      }
      console.warn("[AHGORA PANEL] Worker indisponível, usando setInterval");
      this._fallbackId = setInterval(() => this._loop(), 1000);
    },

    start() {
      if (this._started) return;
      this._started = true;

      try {
        const blob = new Blob(["setInterval(()=>postMessage(1),1000);"], {
          type: "application/javascript",
        });
        this._worker = new Worker(URL.createObjectURL(blob));
        this._worker.onmessage = () => this._loop();
        this._worker.onerror = () => this._useFallback(); // CSP bloqueando blob:
      } catch {
        this._useFallback();
      }

      // Web Lock: o Chrome não congela abas que seguram um lock ativo
      try {
        navigator.locks?.request("ahg-keepalive", () => new Promise(() => {}));
      } catch {
        /* silent */
      }
    },
  };

  const WorkdayStore = {
    _keyFor(dateStr) {
      return `ahg_workday_${dateStr}`;
    },

    // Delegação para o helper central
    _todayStr() {
      return todayDateStr();
    },

    load(dateStr) {
      try {
        const raw = localStorage.getItem(this._keyFor(dateStr));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || obj.schemaVersion !== CONFIG.SCHEMA_VERSION) return null;
        return obj;
      } catch {
        return null;
      }
    },

    save(workday) {
      try {
        localStorage.setItem(
          this._keyFor(workday.date),
          JSON.stringify(workday),
        );
      } catch (e) {
        console.warn("[WorkdayStore] save failed:", e);
      }
    },

    loadToday() {
      const dateStr = this._todayStr();
      return (
        this.load(dateStr) || {
          schemaVersion: CONFIG.SCHEMA_VERSION,
          date: dateStr,
          entries: [],
          status: "OPEN",
        }
      );
    },

    syncFromDom(batidas) {
      const wd = this.loadToday();
      const TYPES = ["WORK_START", "BREAK_START", "BREAK_END", "WORK_END"];
      let dirty = false;

      const idxOf = (type) => {
        const i = TYPES.indexOf(type);
        if (i >= 0) return i;
        const m = /^PUNCH_(\d+)$/.exec(type);
        return m ? Number(m[1]) - 1 : -1;
      };

      // Remove entradas DOM que não existem mais (ex.: batida manual apagada)
      const antes = wd.entries.length;
      wd.entries = wd.entries.filter((e) => {
        if (e.source !== "DOM") return true;
        const idx = idxOf(e.type);
        return idx === -1 ? true : !!batidas[idx];
      });
      if (wd.entries.length !== antes) dirty = true;

      batidas.forEach((time, idx) => {
        if (!time) return;
        const type = TYPES[idx] || `PUNCH_${idx + 1}`;
        const existing = wd.entries.find((e) => e.type === type);

        if (!existing) {
          wd.entries.push({
            type,
            time,
            source: "DOM",
            createdAt: new Date().toISOString(),
          });
          dirty = true;
        } else if (existing.source === "DOM" && existing.time !== time) {
          existing.time = time;
          existing.createdAt = new Date().toISOString();
          dirty = true;
        }
        // MANUAL entries are never overwritten by DOM sync
      });

      if (wd.entries.length >= 4 && wd.status === "OPEN") {
        wd.status = "COMPLETED";
        dirty = true;
      } else if (
        wd.status === "COMPLETED" &&
        wd.entries.length < 4 &&
        !wd.entries.some((e) => e.type === "WORK_END")
      ) {
        wd.status = "OPEN"; // reabre o dia se a última batida foi removida
        dirty = true;
      }

      if (dirty) this.save(wd);
      return wd;
    },

    registerManual(type, time) {
      const wd = this.loadToday();
      const existing = wd.entries.find((e) => e.type === type);
      if (existing) {
        existing.time = time;
        existing.source = "MANUAL";
        existing.createdAt = new Date().toISOString();
      } else {
        wd.entries.push({
          type,
          time,
          source: "MANUAL",
          createdAt: new Date().toISOString(),
        });
      }
      if (type === "WORK_END") wd.status = "COMPLETED";
      this.save(wd);
      return wd;
    },

    pruneOld(days = 35) {
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        Object.keys(localStorage)
          .filter((k) => k.startsWith("ahg_workday_"))
          .forEach((k) => {
            const dateStr = k.replace("ahg_workday_", "");
            if (new Date(dateStr) < cutoff) localStorage.removeItem(k);
          });
      } catch {
        /* silent */
      }
    },
  };

  /* =========================================================
       EventEngine — actual events vs predictions
    =========================================================
       Consumes a WorkdayStore record + DOM batidas and produces:
       {
           actual:   { WORK_START, BREAK_START, BREAK_END, WORK_END }
           predicted: { WORK_END, BREAK_RETURN_MIN, BREAK_RETURN_MAX }
           effectiveBatidas: string[]   ← used by Jornada.*
           status: "OPEN" | "COMPLETED"
           frozen: boolean              ← true when WORK_END is an actual event
       }

       Rule: actual events take precedence over predictions.
             Once frozen=true, Jornada.calcularTrabalhado uses the
             actual WORK_END instead of Hora.nowMin().
    ========================================================= */

  const EventEngine = {
    TYPE_ORDER: ["WORK_START", "BREAK_START", "BREAK_END", "WORK_END"],

    // Build effective batidas array using actual entries when available,
    // falling back to DOM-sourced batidas otherwise.
    // Returns { effectiveBatidas, actual, frozen }
    resolve(workday, domBatidas) {
      // Index entries by type in one pass
      const actual = (workday.entries || []).reduce((acc, e) => {
        acc[e.type] = e;
        return acc;
      }, {});

      // Prefer MANUAL/actual entries; fall back to DOM
      const effectiveBatidas = this.TYPE_ORDER.map(
        (type, idx) => actual[type]?.time ?? domBatidas[idx] ?? null,
      ).filter(Boolean);

      // Append extra punches beyond the 4 known types
      domBatidas.slice(this.TYPE_ORDER.length).forEach((t) => {
        if (t) effectiveBatidas.push(t);
      });

      const frozen = !!actual["WORK_END"];
      return { effectiveBatidas, actual, frozen };
    },

    status(workday) {
      return workday.status || "OPEN";
    },
  };

  /* =========================================================
       RuleEngine — configurable business-rule validation
    =========================================================
       Each rule returns:
       {
           rule: string,
           status: "OK" | "WARNING" | "VIOLATION" | "INFO",
           severity: "INFO" | "WARNING" | "ERROR",
           details: {}
       }
    ========================================================= */

  const RuleEngine = {
    evaluate(batidas, trabalhado) {
      return [
        this.dailyLimitRule(trabalhado),
        this.shiftLimitRule(batidas),
        this.breakRule(batidas),
        this.interjourneyRestRule(batidas),
      ].filter(Boolean);
    },

    dailyLimitRule(trabalhado) {
      const max = CONFIG.MAX_HORAS_DIA;
      if (trabalhado > max) {
        return {
          rule: "DAILY_LIMIT",
          status: "VIOLATION",
          severity: "ERROR",
          details: {
            maxMinutes: max,
            actualMinutes: trabalhado,
            excessMinutes: trabalhado - max,
          },
        };
      }
      if (trabalhado > CONFIG.CARGA_DIARIA) {
        return {
          rule: "DAILY_LIMIT",
          status: "WARNING",
          severity: "WARNING",
          details: {
            maxMinutes: max,
            actualMinutes: trabalhado,
            overtimeMinutes: trabalhado - CONFIG.CARGA_DIARIA,
          },
        };
      }
      return {
        rule: "DAILY_LIMIT",
        status: "OK",
        severity: "INFO",
        details: { actualMinutes: trabalhado },
      };
    },

    shiftLimitRule(batidas) {
      if (batidas.length < 1) return null;
      let maxShift = 0;
      for (let i = 0; i < batidas.length; i += 2) {
        const start = hmToMin(batidas[i]);
        const end = batidas[i + 1] ? hmToMin(batidas[i + 1]) : Hora.nowMin();
        maxShift = Math.max(maxShift, end - start);
      }
      const max = CONFIG.MAX_HORAS_TURNO;
      if (maxShift > max) {
        return {
          rule: "SHIFT_LIMIT",
          status: "VIOLATION",
          severity: "ERROR",
          details: { maxMinutes: max, actualMinutes: maxShift },
        };
      }
      return {
        rule: "SHIFT_LIMIT",
        status: "OK",
        severity: "INFO",
        details: { actualMinutes: maxShift },
      };
    },

    breakRule(batidas) {
      if (batidas.length < 3) return null;
      const breakMin = hmToMin(batidas[2]) - hmToMin(batidas[1]);
      const min = CONFIG.INTERVALO_MINIMO;
      const max = CONFIG.INTERVALO_MAXIMO;
      if (breakMin < min) {
        return {
          rule: "BREAK",
          status: "VIOLATION",
          severity: "ERROR",
          details: { requiredMinutes: min, actualMinutes: breakMin },
        };
      }
      if (breakMin > max) {
        return {
          rule: "BREAK",
          status: "WARNING",
          severity: "WARNING",
          details: { maxMinutes: max, actualMinutes: breakMin },
        };
      }
      return {
        rule: "BREAK",
        status: "OK",
        severity: "INFO",
        details: { actualMinutes: breakMin },
      };
    },

    interjourneyRestRule(batidas) {
      if (batidas.length < 1) return null;
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const ydWd = WorkdayStore.load(yesterday);
      if (!ydWd) return null;

      const ydEnd = ydWd.entries.find((e) => e.type === "WORK_END");
      if (!ydEnd) return null;

      const restMins = 24 * 60 - hmToMin(ydEnd.time) + hmToMin(batidas[0]);
      const required = CONFIG.DESCANSO_MINIMO;

      if (restMins < required) {
        return {
          rule: "INTERJOURNEY_REST",
          status: "VIOLATION",
          severity: "WARNING",
          details: { requiredMinutes: required, actualMinutes: restMins },
        };
      }
      return {
        rule: "INTERJOURNEY_REST",
        status: "OK",
        severity: "INFO",
        details: { actualMinutes: restMins },
      };
    },
  };

  /* =========================================================
       NotifScheduler — persistent notification schedule/recovery
    =========================================================
       Key: "ahg_notif_schedule"
       Schema:
       {
           schedules: [
               { id, type, scheduledFor (ISO), workdayDate, calcVersion, fired }
           ]
       }

       On page/iframe load:
       1. Load schedules
       2. Remove outdated (different workdayDate or already obsoleted by actual event)
       3. For scheduled events still in the future: set up setTimeout
       4. For scheduled events in the past (missed): fire immediately if < 60 min ago

       Deduplication: each id is unique; a new calcVersion obsoletes older schedules
       for the same type+workdayDate.
    ========================================================= */

  const NotifScheduler = {
    _KEY: "ahg_notif_schedule",
    _calcVersion: 0,
    _timers: new Map(),

    load() {
      const shared = SharedStore.get(this._KEY, null);
      if (shared && Array.isArray(shared.schedules)) return shared;
      // migração: lê do localStorage legado (origem do espelho)
      try {
        const raw = localStorage.getItem(this._KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && Array.isArray(o.schedules)) return o;
        }
      } catch {
        /* silent */
      }
      return { schedules: [] };
    },

    save(data) {
      if (!SharedStore.set(this._KEY, data)) {
        try {
          localStorage.setItem(this._KEY, JSON.stringify(data));
        } catch {
          /* silent */
        }
      }
    },

    // Schedule a future notification.
    // scheduledFor: ISO string  e.g. "2026-10-02T18:00:00"
    schedule(id, type, scheduledFor, workdayDate) {
      const data = this.load();
      this._calcVersion++;

      // Remove older schedules of same type+workdayDate
      data.schedules = data.schedules.filter(
        (s) => !(s.type === type && s.workdayDate === workdayDate),
      );

      data.schedules.push({
        id,
        type,
        scheduledFor,
        workdayDate,
        calcVersion: this._calcVersion,
        fired: false,
      });
      this.save(data);
      this._arm(id, type, scheduledFor, workdayDate);
    },

    // Cancel all schedules for a given type+workdayDate (e.g. after actual exit)
    cancel(type, workdayDate) {
      const data = this.load();
      const removed = data.schedules.filter(
        (s) => s.type === type && s.workdayDate === workdayDate,
      );
      removed.forEach((s) => {
        const t = this._timers.get(s.id);
        if (t) {
          clearTimeout(t);
          this._timers.delete(s.id);
        }
      });
      data.schedules = data.schedules.filter(
        (s) => !(s.type === type && s.workdayDate === workdayDate),
      );
      this.save(data);
    },

    // Recover and replay on page load
    recover(workdayDate) {
      const data = this.load();
      const now = Date.now();
      const MISSED_WINDOW_MS = CONFIG.NOTIF_RECOVERY_WINDOW_MS;

      data.schedules
        .filter((s) => s.workdayDate === workdayDate && !s.fired)
        .forEach((s) => {
          const t = new Date(s.scheduledFor).getTime();
          const diff = t - now;

          if (diff > 0) {
            // Ainda no futuro — armar timer
            this._arm(s.id, s.type, s.scheduledFor, s.workdayDate);
          } else if (diff > -MISSED_WINDOW_MS) {
            // Perdida mas recente — disparar agora com contexto de "atrasado"
            this._fireMissed(s.id, s.type, new Date(s.scheduledFor));
          }
          // Mais antiga que a janela: descartar silenciosamente
        });
    },

    // Chamado a cada 1s pelo Ticker: dispara o que venceu, sem depender de setTimeout
    tick() {
      const data = this.load();
      const now = Date.now();
      const today = todayDateStr();

      data.schedules
        .filter((s) => !s.fired && s.workdayDate === today)
        .forEach((s) => {
          const diff = new Date(s.scheduledFor).getTime() - now;
          if (diff > 0) return; // ainda no futuro
          if (diff > -2 * 60 * 1000)
            this._fire(s.id, s.type); // no horário (até 2 min de atraso)
          else if (diff > -CONFIG.NOTIF_RECOVERY_WINDOW_MS)
            this._fireMissed(s.id, s.type, new Date(s.scheduledFor)); // perdida recente
          else this._expire(s.id); // velha demais
        });
    },

    _expire(id) {
      const data = this.load();
      const s = data.schedules.find((x) => x.id === id);
      if (s && !s.fired) {
        s.fired = true;
        this.save(data);
      }
    },

    // Agenda lembretes por horário SEM contexto de calendário (sessão expirada)
    ensureStatic() {
      const today = todayDateStr();
      const st = SharedStore.get("ahg_shared_state", null);
      const known =
        st && st.date === today ? st : { entries: [], frozen: false };
      this.updateFromContext(
        {
          jornadaHoje: {
            saidas: { h6: null, h8: null, h10: null, saidaIdeal: null },
          },
          frozen: !!known.frozen,
          workday: { entries: known.entries || [] },
        },
        today,
      );
    },

    _arm(id, type, scheduledFor, workdayDate) {
      const ms = new Date(scheduledFor).getTime() - Date.now();
      if (ms <= 0) return;

      const existing = this._timers.get(id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this._fire(id, type);
      }, ms);

      this._timers.set(id, timer);
    },

    _fire(id, type) {
      const data = this.load();
      const sched = data.schedules.find((s) => s.id === id);
      if (!sched || sched.fired) return;

      sched.fired = true;
      this.save(data);

      const LABELS = {
        EXPECTED_EXIT_H8: {
          title: "✅ Meta diária",
          body: "Você completou as 8h.",
        },
        EXPECTED_EXIT_H6: {
          title: "⚠️ Limite de turno",
          body: "Você atingiu 6h de turno.",
        },
        EXPECTED_EXIT_H10: {
          title: "⛔ Limite diário",
          body: "Atenção: 10h atingidas.",
        },
        EXPECTED_EXIT_IDEAL: {
          title: "🏆 Saída ideal",
          body: "Saldo semanal compensado.",
        },
        ENTRY_REMINDER: {
          title: "⏰ Hora de bater ponto!",
          body: "Lembre de registrar sua entrada.",
        },
      };
      let lbl = LABELS[type] || { title: `⏰ ${type}`, body: "" };
      let urgente = type.includes("H10") || type === "ENTRY_REMINDER";
      let opts = {};

      if (type === "LUNCH_REMINDER") {
        const antecip = Number(
          (/^LUNCH_REMINDER-(\d+)-/.exec(id) || [])[1] || 0,
        );
        const janela = LunchLive.corpo();
        lbl =
          antecip > 0
            ? {
                title: "🍽️ Almoço chegando",
                body: `Faltam ${antecip} minuto${antecip > 1 ? "s" : ""} para o horário de almoço (${CONFIG.NOTIFICACOES.HORARIO_ALMOCO}).\n${janela}`,
              }
            : {
                title: "🍽️ Hora do almoço!",
                body: `Não esqueça de bater o ponto de saída para o almoço.\n${janela}`,
              };
        urgente = antecip === 0; // só o aviso na hora exige confirmação
        opts = { tag: LunchLive.TAG }; // as atualizações vão substituir esta notificação
        LunchLive.start(); // começa a atualizar a janela de retorno
      }

      if (type === "LUNCH_RETURN_REMINDER") {
        const m = Number(CONFIG.NOTIFICACOES.RETORNO_ALMOCO_APOS_MIN) || 60;
        const txt = m % 60 === 0 ? `${m / 60}h` : `${m} min`;
        lbl = {
          title: "🍽️ Volta do almoço",
          body: `Já se passaram ${txt} da saída para o almoço. Registre o retorno.`,
        };
        urgente = true; // fica na tela até você fechar
      }

      notif(`sched-${id}`, lbl.title, lbl.body, urgente, 0, opts);
      this._timers.delete(id);
    },

    // Disparada quando uma notificação foi perdida (página estava fechada).
    // Inclui o horário original programado na mensagem para dar contexto.
    _fireMissed(id, type, scheduledDate) {
      const data = this.load();
      const sched = data.schedules.find((s) => s.id === id);
      if (!sched || sched.fired) return;

      sched.fired = true;
      if (type === "LUNCH_REMINDER") {
        const agora = Date.now();
        data.schedules.forEach((s) => {
          if (
            s.type === type &&
            s.workdayDate === sched.workdayDate &&
            !s.fired &&
            new Date(s.scheduledFor).getTime() <= agora
          )
            s.fired = true;
        });
      }
      this.save(data);

      const hora = scheduledDate
        ? `${String(scheduledDate.getHours()).padStart(2, "0")}:${String(scheduledDate.getMinutes()).padStart(2, "0")}`
        : "";

      const LABELS_MISSED = {
        EXPECTED_EXIT_H8: {
          title: "⚠️ Você já deveria ter saído",
          body: `Meta de 8h era às ${hora}. Bata o ponto agora se ainda está trabalhando.`,
        },
        EXPECTED_EXIT_H6: {
          title: "⚠️ Turno excedeu 6h",
          body: `Limite de turno era às ${hora}.`,
        },
        EXPECTED_EXIT_H10: {
          title: "🚨 Limite diário ultrapassado",
          body: `10h foram atingidas às ${hora}. Bata o ponto de saída.`,
        },
        EXPECTED_EXIT_IDEAL: {
          title: "⏰ Saída ideal foi às " + hora,
          body: "Saldo semanal já foi compensado.",
        },
        ENTRY_REMINDER: {
          title: "⏰ Não esqueça de bater o ponto",
          body: `Seu horário de entrada era às ${hora}.`,
        },
        LUNCH_REMINDER: {
          title: "🍽️ Lembrete de almoço",
          body: `Horário de almoço: ${CONFIG.NOTIFICACOES.HORARIO_ALMOCO}. Registre a saída se ainda não bateu.\n${LunchLive.corpo()}`,
        },
        LUNCH_RETURN_REMINDER: {
          title: "🍽️ Retorno do almoço",
          body: `O retorno estava previsto para ${hora}. Registre o ponto de volta se já voltou.`,
        },
      };
      const lbl = LABELS_MISSED[type] || {
        title: `⏰ Perdida: ${type}`,
        body: `Programada para ${hora}.`,
      };
      notif(`missed-${id}`, lbl.title, lbl.body, true, 0);
      this._timers.delete(id);
    },

    // Called from checarNotifs to update the persistent schedule.
    // Single load + single save per render tick.
    updateFromContext(ctx, todayStr) {
      const { jornadaHoje } = ctx;
      const frozen = ctx.frozen || false;

      // ── Helpers ──────────────────────────────────────────────────────
      const now = new Date();
      const datePfx = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const minToIso = (min) => {
        const n = ((Math.round(min) % 1440) + 1440) % 1440;
        return `${datePfx}T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00`;
      };
      const isFuture = (iso) => new Date(iso).getTime() > Date.now();
      const horarioValido = (h) =>
        typeof h === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(h.trim());

      // upsert por ID: permite vários lembretes do mesmo tipo (ex.: 15 e 5 min antes)
      const upsert = (data, id, type, iso) => {
        data.schedules = data.schedules.filter((s) => s.id !== id);
        data.schedules.push({
          id,
          type,
          scheduledFor: iso,
          workdayDate: todayStr,
          calcVersion: this._calcVersion,
          fired: false,
        });
        this._arm(id, type, iso, todayStr);
      };

      // Cancela os pendentes (não disparados) de um tipo no dia
      const cancelPending = (data, type) => {
        const antes = data.schedules.length;
        data.schedules = data.schedules.filter(
          (s) => !(s.type === type && s.workdayDate === todayStr && !s.fired),
        );
        [...this._timers.keys()]
          .filter((id) => id.startsWith(type) && id.endsWith(todayStr))
          .forEach((id) => {
            clearTimeout(this._timers.get(id));
            this._timers.delete(id);
          });
        return data.schedules.length !== antes;
      };

      // ── Workday frozen: cancelar TODAS as notificações do dia ────────
      if (frozen) {
        const data = this.load();
        const EXIT_TYPES = [
          "EXPECTED_EXIT_H6",
          "EXPECTED_EXIT_H8",
          "EXPECTED_EXIT_H10",
          "EXPECTED_EXIT_IDEAL",
          "ENTRY_REMINDER",
          "LUNCH_REMINDER",
          "LUNCH_RETURN_REMINDER",
        ];
        let changed = false;
        EXIT_TYPES.forEach((type) => {
          const before = data.schedules.length;
          data.schedules = data.schedules.filter(
            (s) => !(s.type === type && s.workdayDate === todayStr),
          );
          if (data.schedules.length !== before) {
            [...this._timers.keys()]
              .filter((id) => id.startsWith(type))
              .forEach((id) => {
                clearTimeout(this._timers.get(id));
                this._timers.delete(id);
              });
            changed = true;
          }
        });
        if (changed) this.save(data);
        return;
      }

      // ── Batch único: load → modificar → save ────────────────────────
      const data = this.load();
      this._calcVersion++;
      let changed = false;

      const entries = ctx.workday?.entries || [];
      const temEntrada = entries.some((e) => e.type === "WORK_START");
      const temAlmoco = entries.some((e) => e.type === "BREAK_START");

      // Lembrete genérico: agenda `antecips` minutos antes de `horario`.
      // Se não estiver ativo (ou horário vazio/inválido), cancela os pendentes.
      const lembrete = (type, horario, antecips, ativo) => {
        if (!ativo || !horarioValido(horario)) {
          if (cancelPending(data, type)) changed = true;
          return;
        }
        const baseMin = hmToMin(horario.trim());
        (Array.isArray(antecips) ? antecips : []).forEach((antecipMin) => {
          const iso = minToIso(baseMin - antecipMin);
          if (!isFuture(iso)) return;
          upsert(data, `${type}-${antecipMin}-${todayStr}`, type, iso);
          changed = true;
        });
      };

      // 1. Entrada: só enquanto a entrada não foi batida
      lembrete(
        "ENTRY_REMINDER",
        CONFIG.NOTIFICACOES.HORARIO_ENTRADA_PADRAO,
        CONFIG.NOTIFICACOES.entrada,
        !temEntrada,
      );

      // 2. Almoço (opcional): só se HORARIO_ALMOCO estiver preenchido,
      //    a entrada já foi batida e a saída para o almoço ainda não
      lembrete(
        "LUNCH_REMINDER",
        CONFIG.NOTIFICACOES.HORARIO_ALMOCO,
        CONFIG.NOTIFICACOES.almoco,
        temEntrada && !temAlmoco,
      );

      // 3. Retorno do almoço (opcional): N min após a saída para o almoço REAL.
      //    Cancela se o retorno já foi batido ou se o parâmetro estiver desativado.
      const saidaAlmoco = entries.find((e) => e.type === "BREAK_START");
      const temRetorno = entries.some((e) => e.type === "BREAK_END");
      const aposMin = Number(CONFIG.NOTIFICACOES.RETORNO_ALMOCO_APOS_MIN);

      if (saidaAlmoco && !temRetorno && aposMin > 0) {
        const iso = minToIso(hmToMin(saidaAlmoco.time) + aposMin);
        if (isFuture(iso)) {
          upsert(
            data,
            `LUNCH_RETURN_REMINDER-${todayStr}`,
            "LUNCH_RETURN_REMINDER",
            iso,
          );
          changed = true;
        }
      } else if (cancelPending(data, "LUNCH_RETURN_REMINDER")) {
        changed = true;
      }

      // 4. Saídas previstas
      const saidas = jornadaHoje.saidas;
      [
        { type: "EXPECTED_EXIT_H6", min: saidas.h6 },
        { type: "EXPECTED_EXIT_H8", min: saidas.h8 },
        { type: "EXPECTED_EXIT_H10", min: saidas.h10 },
        { type: "EXPECTED_EXIT_IDEAL", min: saidas.saidaIdeal },
      ].forEach(({ type, min }) => {
        if (min === null || min === undefined) return;
        const iso = minToIso(min);
        if (!isFuture(iso)) return;
        upsert(data, `${type}-${todayStr}`, type, iso);
        changed = true;
      });

      if (changed) this.save(data);
    },
  };

  /* =========================================================
   LunchLive — atualiza a notificação de almoço com a janela
   de retorno (mínimo/máximo) até a saída ser registrada.
   Usa CONFIG.INTERVALO_MINIMO / INTERVALO_MAXIMO.
   Key: "ahg_lunch_live"  { date, active, startedAt, lastAt }
========================================================= */

  const LunchLive = {
    _KEY: "ahg_lunch_live",
    TAG: "ahg-lunch-live", // mesma tag = a notificação é substituída

    _load() {
      try {
        const o = JSON.parse(localStorage.getItem(this._KEY) || "null");
        return o && o.date === todayDateStr() ? o : null;
      } catch {
        return null;
      }
    },

    _save(o) {
      try {
        if (o) localStorage.setItem(this._KEY, JSON.stringify(o));
        else localStorage.removeItem(this._KEY);
      } catch {
        /* silent */
      }
    },

    // Janela de retorno considerando que a saída seria AGORA
    corpo() {
      const base = Hora.nowMin();
      const min = base + CONFIG.INTERVALO_MINIMO;
      const max = base + CONFIG.INTERVALO_MAXIMO;
      return `Se sair agora:\n⏳ Retorno mínimo: ${Hora.fmtHour(min)}\n⚠️ Retorno máximo: ${Hora.fmtHour(max)}`;
    },

    // Chamado quando o lembrete de almoço dispara
    start() {
      if (!(Number(CONFIG.NOTIFICACOES.ALMOCO_ATUALIZAR_MIN) > 0)) return;
      const cur = this._load();
      if (cur && cur.active) return;
      this._save({
        date: todayDateStr(),
        active: true,
        startedAt: Date.now(),
        lastAt: Date.now(),
      });
    },

    stop() {
      this._save(null);
    },

    // Chamado a cada 1s pelo Ticker (roda também em aba oculta)
    tick() {
      const st = this._load();
      if (!st || !st.active) return;

      const wd = WorkdayStore.loadToday();
      const jaSaiu = wd.entries.some((e) => e.type === "BREAK_START");
      const encerrado =
        wd.status === "COMPLETED" ||
        wd.entries.some((e) => e.type === "WORK_END");
      const maxMs =
        (Number(CONFIG.NOTIFICACOES.ALMOCO_ATUALIZAR_MAX_MIN) || 120) * 60000;
      const expirou = Date.now() - st.startedAt > maxMs;

      if (jaSaiu || encerrado || expirou) {
        this.stop();
        return;
      }

      // Enquanto ativo, recarrega o espelho com mais frequência para enxergar a batida
      const refMin = Number(CONFIG.NOTIFICACOES.ALMOCO_REFRESH_MIN);
      if (refMin > 0) {
        const alvo = Date.now() + refMin * 60000;
        if (STATE.nextRefresh > alvo) STATE.nextRefresh = alvo;
      }

      const everyMs = Number(CONFIG.NOTIFICACOES.ALMOCO_ATUALIZAR_MIN) * 60000;
      if (Date.now() - st.lastAt < everyMs) return;

      st.lastAt = Date.now();
      this._save(st);

      notif(
        `lunchlive-${st.lastAt}`,
        "🍽️ Saída para o almoço",
        this.corpo(),
        true,
        0,
        {
          tag: this.TAG,
          silent: true, // atualizações sem som
          timeout: everyMs + 15000, // some sozinha logo após a batida
          // fechou a notificação → para. O guard de 3s ignora o "fechamento"
          // da notificação antiga quando ela é substituída pela nova.
          onDone: (user) => {
            if (user && Date.now() - st.lastAt > 3000) LunchLive.stop();
          },
        },
      );
    },
  };

  /* =========================================================
       Hora — formatação e conversão de tempo
    ========================================================= */

  const Hora = {
    toMin(s) {
      if (!s) return null;
      s = String(s).trim();
      const neg = s.startsWith("-");
      const clean = s.replace(/[^0-9:]/g, "");
      const [h, m] = clean.split(":").map(Number);
      if (isNaN(h)) return null;
      return neg ? -(h * 60 + (m || 0)) : h * 60 + (m || 0);
    },

    fmtMin(m) {
      if (m === null || m === undefined) return "--:--";
      const neg = m < 0;
      const abs = Math.abs(Math.round(m));
      return `${neg ? "-" : ""}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    },

    fmtHour(m) {
      if (m === null || m === undefined) return "--:--";
      const n = ((Math.round(m) % 1440) + 1440) % 1440;
      return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    },

    fmtCountdown(ms) {
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return `${min}m ${String(sec).padStart(2, "0")}s`;
    },

    nowMin() {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    },
  };

  /* =========================================================
       DataHelper — semana, feriados, dias úteis, período
    ========================================================= */

  const DataHelper = {
    DIAS_SEMANA: [
      "Domingo",
      "Segunda",
      "Terça",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sábado",
    ],
    DIAS_SEMANA_CURTO: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"],
    MESES: [
      "Janeiro",
      "Fevereiro",
      "Março",
      "Abril",
      "Maio",
      "Junho",
      "Julho",
      "Agosto",
      "Setembro",
      "Outubro",
      "Novembro",
      "Dezembro",
    ],

    getWeekNumber(date) {
      const d = new Date(
        Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
      );
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    },

    sameWeek(a, b) {
      const startOfWeek = (d) => {
        const date = new Date(d);
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(date.setDate(diff));
      };
      const wa = startOfWeek(a);
      const wb = startOfWeek(b);
      return (
        wa.getFullYear() === wb.getFullYear() &&
        wa.getMonth() === wb.getMonth() &&
        wa.getDate() === wb.getDate()
      );
    },

    isWeekend(date) {
      const d = date.getDay();
      return d === 0 || d === 6;
    },

    getPeriodo() {
      const hoje = new Date();
      const ano = hoje.getFullYear();
      const mes = hoje.getMonth();
      const mesStr = String(mes + 1).padStart(2, "0");
      return {
        ano,
        mes,
        descricao: `${this.MESES[mes]} ${ano}`,
        arquivo: `Ahgora_${ano}-${mesStr}`,
        inicio: new Date(ano, mes, 1),
        fim: new Date(ano, mes + 1, 0),
      };
    },

    // Constrói objeto período a partir de ano/mês explícitos (0-based)
    getPeriodoObj(ano, mes) {
      const mesStr = String(mes + 1).padStart(2, "0");
      return {
        ano,
        mes,
        descricao: `${this.MESES[mes]} ${ano}`,
        arquivo: `Ahgora_${ano}-${mesStr}`,
        inicio: new Date(ano, mes, 1),
        fim: new Date(ano, mes + 1, 0),
      };
    },

    // Lê o mês/ano visível no cabeçalho do calendário da Ahgora
    getPeriodoVisivel() {
      // Seletor preciso: botão "Abril/2026" na toolbar do espelho.
      // Exclui .v-menu.escala (menu de escala no painel lateral) e
      // .v-menu__content (dropdown aberto) usando :not().
      // O botão correto fica em: .layout.espelho > .card > .layout.row > .v-menu.v-menu--inline
      const elBotao = document.querySelector(
        ".layout.espelho > .card .v-menu.v-menu--inline:not(.escala) .v-menu__activator .v-btn__content",
      );
      if (elBotao) {
        // firstChild = nó de texto "Abril/2026", ignora o <i>keyboard_arrow_down</i>
        const texto =
          elBotao.firstChild?.nodeType === Node.TEXT_NODE
            ? elBotao.firstChild.textContent.trim()
            : elBotao.textContent.replace(/keyboard_arrow_down/gi, "").trim();
        const resultado = this._parsePeriodoTexto(texto);
        if (resultado) return resultado;
      }

      // Fallback: painel lateral .espelho-resumo-dia contém "ABRIL 2026" como texto puro
      const elResumo = document.querySelector(
        ".espelho-resumo-dia .layout.ma-2.align-center.justify-center.column",
      );
      if (elResumo) {
        const resultado = this._parsePeriodoTexto(elResumo.textContent.trim());
        if (resultado) return resultado;
      }

      // Último fallback: mês atual
      const hoje = new Date();
      return { ano: hoje.getFullYear(), mes: hoje.getMonth() };
    },

    // Nomes de meses normalizados (sem acentos, minúsculos) — gerado uma vez
    _MESES_NORM: null,

    _getMesesNorm() {
      if (!this._MESES_NORM) {
        this._MESES_NORM = this.MESES.map((m) =>
          m
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, ""),
        );
      }
      return this._MESES_NORM;
    },

    // Extrai { ano, mes } de textos como "Junho/2026" ou "junho de 2026"
    _parsePeriodoTexto(texto) {
      if (!texto) return null;
      const anoMatch = texto.match(/\d{4}/);
      if (!anoMatch) return null;
      const ano = parseInt(anoMatch[0], 10);
      const lower = texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      const nomes = this._getMesesNorm();
      for (let i = 0; i < nomes.length; i++) {
        if (lower.includes(nomes[i].slice(0, 3))) return { ano, mes: i };
      }
      return null;
    },

    fmtData(date) {
      return date.toLocaleDateString("pt-BR");
    },
  };

  /* =========================================================
       Jornada — regras de negócio, sem HTML
    ========================================================= */

  const Jornada = {
    calcularTurno(entrada, saida, trabalhadoTotal) {
      const e = Hora.toMin(entrada);
      const s = saida ? Hora.toMin(saida) : Hora.nowMin();
      const total = s - e;
      const aberto = !saida;
      const excedeTurno = total >= CONFIG.MAX_HORAS_TURNO;
      const proximoTurno = total >= CONFIG.MAX_HORAS_TURNO - CONFIG.AVISO_TURNO;
      const excedeDia = trabalhadoTotal >= CONFIG.MAX_HORAS_DIA;
      const proximoDia =
        trabalhadoTotal >= CONFIG.MAX_HORAS_DIA - CONFIG.AVISO_DIA;
      const classe =
        excedeTurno || excedeDia
          ? "danger"
          : proximoTurno || proximoDia
            ? "warn"
            : "infos";
      return { entrada, saida: saida || null, aberto, total, classe };
    },

    calcularTrabalhado(batidas) {
      let total = 0;
      for (let i = 0; i < batidas.length; i += 2) {
        const e = Hora.toMin(batidas[i]);
        const s = batidas[i + 1] ? Hora.toMin(batidas[i + 1]) : Hora.nowMin();
        total += s - e;
      }
      return total;
    },

    calcularSaidas(batidas, saldoSemana) {
      let h6 = null,
        h8 = null,
        h10 = null;

      if (batidas.length >= 3) {
        h6 = Hora.toMin(batidas[2]) + CONFIG.MAX_HORAS_TURNO;
      } else if (batidas.length >= 1) {
        h6 = Hora.toMin(batidas[0]) + CONFIG.MAX_HORAS_TURNO;
      }

      if (batidas.length >= 2) {
        // Duas ou mais batidas: pode calcular h8/h10 a partir do 2º turno
        const e1 = Hora.toMin(batidas[0]);
        const s1 = Hora.toMin(batidas[1]);
        const t1 = s1 - e1;
        const e2 = batidas[2] ? Hora.toMin(batidas[2]) : Hora.nowMin();
        h8 = e2 + (CONFIG.CARGA_DIARIA - t1);
        h10 = e2 + (CONFIG.MAX_HORAS_DIA - t1);
      }
      // Com apenas 1 batida o turno máximo é 6h, por isso h8/h10 não se aplicam:
      // o usuário precisa primeiro registrar o intervalo antes de poder completar 8h.

      const saidaIdeal = h8 !== null ? h8 - saldoSemana : null;
      return { h6, h8, h10, saidaIdeal };
    },

    calcularIntervalo(batidas) {
      if (batidas.length !== 2)
        return { retornoMinimo: null, retornoMaximo: null };
      const s1 = Hora.toMin(batidas[1]);
      return {
        retornoMinimo: s1 + CONFIG.INTERVALO_MINIMO,
        retornoMaximo: s1 + CONFIG.INTERVALO_MAXIMO,
      };
    },

    calcularDescanso(batidas) {
      if (batidas.length < 4) return null;
      return Hora.toMin(batidas[3]) + CONFIG.DESCANSO_MINIMO;
    },

    resolverEstado(batidas) {
      const qtd = batidas.length;
      if (qtd === 0) return { codigo: "SEM_BATIDA", label: "🛬 Não iniciado" };
      if (qtd === 1) return { codigo: "TURNO_1", label: "🥇 Primeiro turno" };
      if (qtd === 2) return { codigo: "INTERVALO", label: "⏸ Intervalo" };
      if (qtd === 3) return { codigo: "TURNO_2", label: "🥈 Segundo turno" };
      return { codigo: "ENCERRADO", label: "🛫 Encerrado" };
    },

    resolverAlerta(batidas, trabalhado) {
      if (trabalhado > CONFIG.MAX_HORAS_DIA) return "⚠️ Limite diário excedido";
      if (batidas.length >= 2) {
        const t1 = Hora.toMin(batidas[1]) - Hora.toMin(batidas[0]);
        if (t1 > CONFIG.MAX_HORAS_TURNO) return "⚠️ Primeiro turno excedeu 6h";
      }
      return null;
    },

    calcularDia(diaData, saldoSemana) {
      const { batidas, trabalhado, isBusinessDay } = diaData;
      const estado = this.resolverEstado(batidas);
      const alerta = this.resolverAlerta(batidas, trabalhado);
      const saidas = this.calcularSaidas(batidas, saldoSemana);
      const intervalo = this.calcularIntervalo(batidas);
      const retorno11h = this.calcularDescanso(batidas);

      const turno1 =
        batidas.length >= 1
          ? this.calcularTurno(batidas[0], batidas[1] || null, trabalhado)
          : null;
      const turno2 =
        batidas.length >= 3
          ? this.calcularTurno(batidas[2], batidas[3] || null, trabalhado)
          : null;

      return { estado, alerta, saidas, intervalo, retorno11h, turno1, turno2 };
    },
  };

  /* =========================================================
       DOM — extração de dados do calendário
    ========================================================= */

  const DOM = {
    extrairDias(periodo) {
      // periodo = { ano, mes } — mês 0-based
      const ano = periodo ? periodo.ano : new Date().getFullYear();
      const mes = periodo ? periodo.mes : new Date().getMonth();
      const resultado = [];

      const hoje = new Date();
      const hojeAno = hoje.getFullYear();
      const hojeMes = hoje.getMonth();
      const hojeDia = hoje.getDate();

      document.querySelectorAll(".v-calendar-weekly__day").forEach((day) => {
        if (day.classList.contains("v-outside")) return;

        const label = day.querySelector(".v-calendar-weekly__day-label");
        if (!label) return;

        const numeroDia = Number(label.textContent.trim());
        if (!numeroDia) return;

        const isPresentClass = day.classList.contains("v-present");
        const isFuture = day.classList.contains("v-future");
        const isHoliday = [...day.querySelectorAll(".material-icons")].some(
          (x) => x.textContent.trim() === "star",
        );

        const data = new Date(ano, mes, numeroDia);
        const weekDay = data.getDay();

        const isToday =
          isPresentClass ||
          (ano === hojeAno && mes === hojeMes && numeroDia === hojeDia);

        // Batidas do espelho + batidas manuais locais (mescladas e ordenadas)
        const domBatidas = [...day.querySelectorAll(".batida")]
          .filter((x) => !x.classList.contains("prevista"))
          .map((x) => x.textContent.trim());
        const { batidas, manuais } = ManualPunches.merge(
          ManualPunches.dateStr(data),
          domBatidas,
        );

        const possuiBatidas = batidas.length > 0;
        const isBusinessDay =
          (weekDay !== 0 && weekDay !== 6 && !isHoliday) || possuiBatidas;
        const trabalhado = possuiBatidas
          ? Jornada.calcularTrabalhado(batidas)
          : 0;
        const saldo = isBusinessDay ? trabalhado - CONFIG.CARGA_DIARIA : 0;

        resultado.push({
          elemento: day,
          data,
          isToday,
          isFuture,
          isHoliday,
          isBusinessDay,
          isWeekend: DataHelper.isWeekend(data),
          semana: DataHelper.getWeekNumber(data),
          diaSemana: DataHelper.DIAS_SEMANA[data.getDay()],
          batidas,
          domBatidas,
          manuais,
          trabalhado,
          saldo,
        });
      });

      return resultado;
    },

    getCompanyCode() {
      const local = localStorage
        .getItem("@batidaOnline/companyCodeDefault")
        ?.trim();
      if (local) return local;
      try {
        return GM_getValue("ahg_company_code", null) || null;
      } catch {
        return null;
      }
    },

    getBatidaUrl() {
      const code = this.getCompanyCode();
      if (!code) return null;
      return `${CONFIG.BATIDA_URL}?defaultDevice=${encodeURIComponent(code)}`;
    },
  };

  /* =========================================================
       Relatorio — organiza dados, sem HTML nem Blob
    ========================================================= */

  const Relatorio = {
    gerarMensal(dias, periodo) {
      const hoje = new Date();
      const p =
        periodo ||
        DataHelper.getPeriodoObj(hoje.getFullYear(), hoje.getMonth());

      const diasFuturos = dias.filter((x) => x.isFuture && x.isBusinessDay);

      // Saldo semanal — reutiliza helper para evitar duplicação
      const _saldoEfetivo = (d) => {
        const bruto = d.saldo;
        return d.batidas.length > 0 && Math.abs(bruto) <= CONFIG.TOLERANCIA
          ? 0
          : bruto;
      };

      const diasDaSemana = dias.filter(
        (x) =>
          DataHelper.sameWeek(x.data, hoje) && !x.isFuture && x.isBusinessDay,
      );
      const saldoSemana = diasDaSemana
        .filter((x) => !x.isToday)
        .reduce((a, d) => a + _saldoEfetivo(d), 0);
      const saldoSemanaComHoje = diasDaSemana.reduce(
        (a, d) => a + _saldoEfetivo(d),
        0,
      );

      const diasDoPeriodo = dias.filter(
        (x) => x.data.getFullYear() === p.ano && x.data.getMonth() === p.mes,
      );

      const registros = this.gerarRegistros(diasDoPeriodo);
      const semanas = this.montarSemanas(registros);
      const resumo = this.montarResumo(
        registros,
        diasFuturos.length,
        saldoSemanaComHoje,
        p,
      );

      const diaHoje = dias.find((x) => x.isToday) || null;
      return {
        registros,
        semanas,
        resumo,
        periodo: p,
        saldoSemana,
        saldoSemanaComHoje,
        diaHoje,
      };
    },

    gerarRegistros(dias) {
      let saldoMesAcum = 0;
      let saldoSemAcum = 0;
      let semanaAnterior = null;

      return dias
        .filter((x) => !x.isFuture)
        .sort((a, b) => a.data - b.data)
        .map((d) => {
          const semana = d.semana;
          if (semana !== semanaAnterior) {
            saldoSemAcum = 0;
            semanaAnterior = semana;
          }

          const b = d.batidas;
          const turno1Min =
            b[0] && b[1] ? Hora.toMin(b[1]) - Hora.toMin(b[0]) : null;
          const turno2Min =
            b[2] && b[3] ? Hora.toMin(b[3]) - Hora.toMin(b[2]) : null;
          const intervMin =
            b[1] && b[2] ? Hora.toMin(b[2]) - Hora.toMin(b[1]) : null;

          // Tolerância: saldo dentro do intervalo [-TOLERANCIA, +TOLERANCIA] é zerado
          const saldoBruto = d.isBusinessDay ? d.saldo : 0;
          const emTolerancia =
            d.isBusinessDay &&
            d.batidas.length > 0 &&
            Math.abs(saldoBruto) <= CONFIG.TOLERANCIA;
          const saldoEfetivo = emTolerancia ? 0 : saldoBruto;

          if (d.isBusinessDay) {
            saldoMesAcum += saldoEfetivo;
            saldoSemAcum += saldoEfetivo;
          }

          return {
            data: d.data,
            diaSemana: d.diaSemana,
            semana,
            isBusinessDay: d.isBusinessDay,
            isHoliday: d.isHoliday,
            isWeekend: d.isWeekend,
            isToday: d.isToday,
            estado: Jornada.resolverEstado(b).codigo,
            batidas: [...b],
            turno1: turno1Min,
            turno2: turno2Min,
            intervalo: intervMin,
            trabalhado: d.trabalhado,
            saldoDia: saldoBruto, // saldo real sem tolerância (para exibição)
            saldoEfetivo, // saldo com tolerância aplicada (para totais)
            emTolerancia, // flag para highlight no modal
            saldoSemana: saldoSemAcum,
            saldoMes: saldoMesAcum,
          };
        });
    },

    montarSemanas(registros) {
      const mapa = new Map();
      registros.forEach((r) => {
        if (!mapa.has(r.semana)) mapa.set(r.semana, []);
        mapa.get(r.semana).push(r);
      });
      return [...mapa.entries()].map(([semana, itens]) => ({
        semana,
        itens,
        totalTrabalhado: itens.reduce((a, b) => a + b.trabalhado, 0),
        // totais usam saldoEfetivo — tolerância já aplicada
        totalSaldo: itens
          .filter((x) => x.isBusinessDay)
          .reduce((a, b) => a + b.saldoEfetivo, 0),
      }));
    },

    montarResumo(registros, diasFuturos, saldoSemana, periodo) {
      const comBatidas = registros.filter((x) => x.batidas.length > 0);
      const uteis = registros.filter((x) => x.isBusinessDay);
      const fds = registros.filter((x) => x.isWeekend && x.batidas.length > 0);
      const totalMes = uteis.reduce((a, b) => a + b.trabalhado, 0);
      const saldoMes = uteis.reduce((a, b) => a + b.saldoEfetivo, 0);
      const media = comBatidas.length > 0 ? totalMes / comBatidas.length : 0;
      const trabalhos = comBatidas.map((x) => x.trabalhado);
      const maior = trabalhos.length ? Math.max(...trabalhos) : 0;
      const menor = trabalhos.length ? Math.min(...trabalhos) : 0;
      const p = periodo || DataHelper.getPeriodo();

      return {
        periodo: p,
        totalMes,
        saldoMes,
        saldoSemana,
        diasRegistrados: comBatidas.length,
        diasUteis: uteis.length,
        diasFds: fds.length,
        diasFuturos,
        media,
        maior,
        menor,
      };
    },

    gerarLinhasCSV(registros) {
      return registros.map((r) => {
        const b = r.batidas;
        return [
          DataHelper.fmtData(r.data),
          r.diaSemana,
          r.semana,
          r.isBusinessDay ? "Sim" : "Não",
          r.isHoliday ? "Sim" : "Não",
          r.estado,
          b[0] || "",
          b[1] || "",
          b[2] || "",
          b[3] || "",
          r.turno1 !== null ? Hora.fmtMin(r.turno1) : "",
          r.turno2 !== null ? Hora.fmtMin(r.turno2) : "",
          r.intervalo !== null ? Hora.fmtMin(r.intervalo) : "",
          r.batidas.length > 0 ? Hora.fmtMin(r.trabalhado) : "",
          r.isBusinessDay ? Hora.fmtMin(r.saldoDia) : "",
          Hora.fmtMin(r.saldoSemana),
          Hora.fmtMin(r.saldoMes),
        ];
      });
    },
  };

  /* =========================================================
       Exportador — apenas exporta, não calcula
    ========================================================= */

  const Exportador = {
    download(conteudo, nomeArquivo, tipo) {
      const bom = tipo.includes("csv") ? "\uFEFF" : "";
      const blob = new Blob([bom + conteudo], { type: tipo });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = nomeArquivo;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    csv(relatorio) {
      const { resumo, periodo } = relatorio;
      const sep = ";";

      const cabecalhoResumo = [
        ["Período", periodo.descricao],
        ["Gerado em", new Date().toLocaleString("pt-BR")],
        ["Carga diária", Hora.fmtMin(CONFIG.CARGA_DIARIA)],
        ["Máx. turno", Hora.fmtMin(CONFIG.MAX_HORAS_TURNO)],
        ["Máx. dia", Hora.fmtMin(CONFIG.MAX_HORAS_DIA)],
        ["Horas realizadas", Hora.fmtMin(resumo.totalMes)],
        ["Saldo mensal", Hora.fmtMin(resumo.saldoMes)],
        ["Dias registrados", resumo.diasRegistrados],
        ["Dias úteis", resumo.diasUteis],
        ["Média diária", Hora.fmtMin(resumo.media)],
        ["Maior jornada", Hora.fmtMin(resumo.maior)],
        ["Menor jornada", Hora.fmtMin(resumo.menor)],
      ].map(([k, v]) => `"${k}"${sep}"${v}"`);

      const cabecalhoDados = [
        "Data",
        "Dia",
        "Semana",
        "Útil",
        "Feriado",
        "Estado",
        "Batida 1",
        "Batida 2",
        "Batida 3",
        "Batida 4",
        "1º Turno",
        "2º Turno",
        "Intervalo",
        "Trabalhado",
        "Saldo dia",
        "Saldo semana",
        "Saldo mês",
      ]
        .map((v) => `"${v}"`)
        .join(sep);

      const linhas = Relatorio.gerarLinhasCSV(relatorio.registros).map((cols) =>
        cols.map((v) => `"${v}"`).join(sep),
      );

      const conteudo = [...cabecalhoResumo, "", cabecalhoDados, ...linhas].join(
        "\r\n",
      );

      this.download(
        conteudo,
        `${periodo.arquivo}.csv`,
        "text/csv;charset=utf-8;",
      );
    },
  };

  /* =========================================================
       Template — apenas HTML reutilizável, sem lógica
    ========================================================= */

  const Template = {
    linha(lbl, val, classe = "infos", extra = "") {
      return `<div class="a-row ${classe} ${extra}"><span class="a-lbl">${lbl}</span><span class="a-val">${val}</span></div>`;
    },

    label(txt) {
      return `<span class="a-lbl">${txt}</span>`;
    },

    valor(txt, cor = "neu") {
      return `<span class="a-val ${cor}">${txt}</span>`;
    },

    secao(txt) {
      return `<div class="a-sec">${txt}</div>`;
    },

    divisor() {
      return `<hr class="a-div">`;
    },

    badge(txt, cor) {
      return `<span class="a-badge a-badge--${cor}">${txt}</span>`;
    },

    botao(id, lbl, icone = "") {
      return `<div class="a-row infos clickable" id="${id}">${this.label(`${icone} ${lbl}`)}</div>`;
    },

    turno(numero, turno) {
      if (!turno) return "";
      const saidaLabel = turno.aberto ? "<em>Agora</em>" : turno.saida;
      const statusLabel = turno.aberto ? "· em andamento" : "";
      return `
            <div class="a-row ${turno.classe}">
                <span class="a-lbl">
                    ${numero}º turno
                    <small style="display:block;margin-top:2px;">${turno.entrada} → ${saidaLabel} ${statusLabel}</small>
                </span>
                <span class="a-val neu">${Hora.fmtMin(turno.total)}</span>
            </div>`;
    },

    titulo(icone, txt) {
      return `<div class="a-tit">${icone} ${txt}<span class="a-x" id="ahg-min">–</span></div>`;
    },

    rodape(atualizado, nextRefresh, versao) {
      return `<div class="a-foot">Atualizado ${atualizado} · Reload em ${Hora.fmtCountdown(nextRefresh - Date.now())} · v${versao}</div>`;
    },

    menu(id, lbl, icone, aberto, conteudo) {
      const seta = aberto ? "▼" : "▶";
      return `
            <div class="a-menu">
                <div class="a-row infos clickable a-menu-toggle" id="${id}-toggle">
                    ${this.label(`${seta} ${icone} ${lbl}`)}
                </div>
                <div class="a-menu-body" id="${id}-body" style="display:${aberto ? "flex" : "none"};flex-direction:column;gap:4px;padding-top:4px;">
                    ${conteudo}
                </div>
            </div>`;
    },
  };

  /* =========================================================
       UI — apenas renderização, sem cálculos
    ========================================================= */

  const UI = {
    render(ctx) {
      const p = document.getElementById("ahg-panel");
      if (!p) return;
      p.innerHTML = this.buildPanel(ctx);
      this.registrarEventos(ctx);
    },

    buildPanel(ctx) {
      const { resumo, relatorio, periodo } = ctx;

      const hoje = new Date();
      const ehMesAtual =
        periodo.ano === hoje.getFullYear() && periodo.mes === hoje.getMonth();

      const secaoOperacional = ehMesAtual
        ? `
                    ${this.renderStatus(ctx)}
                    ${Template.divisor()}
                    ${this.renderHoje(ctx)}
                    ${Template.divisor()}
                    ${this.renderSaidas(ctx)}
                    ${this.renderIntervalo(ctx)}
                    ${Template.divisor()}
                    ${this.renderSemanal(ctx)}
                    ${Template.divisor()}
            `
        : `
                    <div class="a-row infos" style="opacity:0.5;">
                        ${Template.label(`📅 Visualizando ${periodo.descricao}`)}
                    </div>
                    ${Template.divisor()}
            `;

      return `
                ${Template.titulo("⏱", "Painel Inteligente")}
                <div class="a-body">
                    ${secaoOperacional}
                    ${this.renderMensal(ctx)}
                    ${Template.divisor()}
                    ${Template.botao("ahg-open-manuais", "Batidas manuais", "✍️")}
                    ${Template.divisor()}
                    ${this.renderRelatorios(ctx)}
                    ${CONFIG.DEBUG_NOTIF ? `${Template.divisor()}${this.renderDebugNotif(ctx)}` : ""}
                </div>
                ${Template.rodape(Hora.fmtHour(Hora.nowMin()), STATE.nextRefresh, CONFIG.VERSAO)}
            `;
    },

    renderStatus(ctx) {
      const { jornadaHoje } = ctx;
      const codigo = jornadaHoje.estado.codigo;
      const temDetalhe = codigo !== "SEM_BATIDA"; // há batidas para detalhar
      const expandido = temDetalhe && STATE.statusExpandido;

      const alertaHtml = jornadaHoje.alerta
        ? Template.linha(
            "Alerta",
            `<span class="a-val neg">${jornadaHoje.alerta}</span>`,
            "danger",
          )
        : "";

      // Linha de situação: clicável sempre que houver batidas
      const seta = expandido ? "▾" : "▸";
      const situacaoHtml = temDetalhe
        ? `<div class="a-row infos clickable" id="ahg-status-toggle" style="user-select:none;">
                       <span class="a-lbl">Situação</span>
                       <span class="a-val neu" style="display:flex;align-items:center;gap:5px;">
                           ${jornadaHoje.estado.label}
                           <span style="font-size:16px;line-height:1;">${seta}</span>
                       </span>
                   </div>`
        : Template.linha(
            "Situação",
            `<span class="a-val neu">${jornadaHoje.estado.label}</span>`,
            "infos",
          );

      // Detalhe expandido: turnos, intervalo e o que está em andamento
      let detalheHtml = "";
      if (expandido) {
        const { turno1, turno2 } = jornadaHoje;
        const actualExit = jornadaHoje.saidas?.actualExit;

        const linhaTurno = (n, t, saidaFinal) => {
          if (!t) return "";
          const fim = t.aberto ? "agora" : (saidaFinal ?? t.saida ?? "--:--");
          return `<div class="a-status-detalhe-linha${t.aberto ? " a-status-detalhe-linha--aberto" : ""}">
                           <span>${n}º turno${t.aberto ? '<small class="a-status-tag">em andamento</small>' : ""}</span>
                           <span>${t.entrada} → ${fim}</span>
                           <span class="a-val neu" style="font-size:13px;">${Hora.fmtMin(t.total)}</span>
                       </div>`;
        };

        // Intervalo: concluído (entre os dois turnos) ou em andamento
        let linhaIntervalo = "";
        if (turno1?.saida && turno2?.entrada) {
          const intervMin =
            Hora.toMin(turno2.entrada) - Hora.toMin(turno1.saida);
          linhaIntervalo = `<div class="a-status-detalhe-linha a-status-detalhe-linha--intervalo">
                                    <span>Intervalo</span>
                                    <span>${turno1.saida} → ${turno2.entrada}</span>
                                    <span style="font-size:13px;color:#555880;">${Hora.fmtMin(intervMin)}</span>
                                </div>`;
        } else if (codigo === "INTERVALO" && turno1?.saida) {
          const decorrido = Hora.nowMin() - Hora.toMin(turno1.saida);
          linhaIntervalo = `<div class="a-status-detalhe-linha a-status-detalhe-linha--intervalo a-status-detalhe-linha--aberto">
                                    <span>Intervalo<small class="a-status-tag">em andamento</small></span>
                                    <span>${turno1.saida} → agora</span>
                                    <span class="a-val neu" style="font-size:13px;">${Hora.fmtMin(decorrido)}</span>
                                </div>`;
        }

        detalheHtml = `
                    <div class="a-status-detalhe" id="ahg-status-detalhe">
                        ${linhaTurno(1, turno1)}
                        ${linhaIntervalo}
                        ${linhaTurno(2, turno2, actualExit)}
                    </div>`;
      }

      return `
                ${Template.secao("Status atual")}
                ${situacaoHtml}
                ${detalheHtml}
                ${alertaHtml}
            `;
    },

    renderHoje(ctx) {
      const { jornadaHoje, resumo } = ctx;
      const hoje = resumo.diaHoje;
      if (!hoje) return "";

      const corSaldo = hoje.trabalhado >= CONFIG.CARGA_DIARIA ? "pos" : "warn";
      const corSaldoDia = hoje.saldo >= 0 ? "pos" : "neg";

      return `
                ${Template.secao("Hoje")}
                ${Template.turno(1, jornadaHoje.turno1)}
                ${Template.turno(2, jornadaHoje.turno2)}
                ${Template.linha("Trabalhado", `<span class="a-val ${corSaldo}">${Hora.fmtMin(hoje.trabalhado)}</span>`, "infos")}
                ${Template.linha("Saldo do dia", `<span class="a-val ${corSaldoDia}">${Hora.fmtMin(hoje.saldo)}</span>`, "infos")}
            `;
    },

    renderSaidas(ctx) {
      const { jornadaHoje } = ctx;
      const s = jornadaHoje.saidas;

      // Cada linha só aparece quando o valor existe
      const linha6 =
        s.h6 !== null
          ? Template.linha(
              "⚠️ 6h (limite turno)",
              `<span class="a-val warn">${Hora.fmtHour(s.h6)}</span>`,
              "warn",
            )
          : "";
      const linha8 =
        s.h8 !== null
          ? Template.linha(
              "✅ 8h (meta diária)",
              `<span class="a-val pos">${Hora.fmtHour(s.h8)}</span>`,
              "ok",
            )
          : "";
      const linha10 =
        s.h10 !== null
          ? Template.linha(
              "⛔️ 10h (limite dia)",
              `<span class="a-val neg">${Hora.fmtHour(s.h10)}</span>`,
              "danger",
            )
          : "";
      const linhaIdeal =
        s.saidaIdeal !== null
          ? Template.linha(
              "🏆 Saída ideal",
              `<span class="a-val neu">${Hora.fmtHour(s.saidaIdeal)}</span>`,
              "infos",
            )
          : "";

      // Nada a mostrar (ex: workday encerrado)
      if (!linha6 && !linha8 && !linha10 && !linhaIdeal) return "";

      return `
                ${Template.secao("Saídas previstas")}
                ${linha6}
                ${linha8}
                ${linha10}
                ${linhaIdeal}
            `;
    },

    renderIntervalo(ctx) {
      const { jornadaHoje } = ctx;
      const { retornoMinimo, retornoMaximo } = jornadaHoje.intervalo;
      const retorno11h = jornadaHoje.retorno11h;

      if (!retornoMinimo && !retorno11h) return "";

      const blocoIntervalo = retornoMinimo
        ? `
                ${Template.divisor()}
                ${Template.secao("Intervalo")}
                ${Template.linha("⏳ Retorno mínimo", `<span class="a-val neu">${Hora.fmtHour(retornoMinimo)}</span>`, "infos")}
                ${Template.linha("⚠️ Retorno máximo", `<span class="a-val warn">${Hora.fmtHour(retornoMaximo)}</span>`, "warn")}
            `
        : "";

      const blocoDescanso = retorno11h
        ? `
                ${Template.linha("🛌 Retorne após (11h)", `<span class="a-val neu">${Hora.fmtHour(retorno11h)}</span>`, "infos")}
            `
        : "";

      return blocoIntervalo + blocoDescanso;
    },

    renderSemanal(ctx) {
      const { resumo } = ctx;
      const cor = resumo.saldoSemanaComHoje >= 0 ? "ok" : "warn";
      const corVal = resumo.saldoSemanaComHoje >= 0 ? "pos" : "neg";
      const semana = DataHelper.getWeekNumber(new Date());
      return `
                ${Template.secao(`Semanal — sem. ${semana}`)}
                <div class="a-row ${cor}">
                    ${Template.label("Saldo semanal")}
                    <span class="a-val ${corVal}">
                        ${Hora.fmtMin(resumo.saldoSemanaComHoje)}
                        <small>${resumo.diasRegistrados} dias registrados</small>
                    </span>
                </div>
            `;
    },

    renderMensal(ctx) {
      const { resumo, periodo } = ctx;
      const cor = resumo.saldoMes >= 0 ? "ok" : "warn";
      const corVal = resumo.saldoMes >= 0 ? "pos" : "neg";
      // Indica quando o calendário exibe mês diferente do atual
      const hoje = new Date();
      const ehMesAtual =
        periodo.ano === hoje.getFullYear() && periodo.mes === hoje.getMonth();
      const labelPeriodo = ehMesAtual
        ? "Mensal"
        : `Mensal — ${periodo.descricao}`;
      return `
                ${Template.secao(labelPeriodo)}
                <div class="a-row ${cor}">
                    ${Template.label("Saldo mensal")}
                    <span class="a-val ${corVal}">
                        ${Hora.fmtMin(resumo.saldoMes)}
                        <small>${resumo.diasFuturos} úteis restantes</small>
                    </span>
                </div>
                <div class="a-row infos">
                    ${Template.label("📊 Horas realizadas")}
                    <span class="a-val neu">${Hora.fmtMin(resumo.totalMes)}</span>
                </div>
            `;
    },

    renderRelatorios(ctx) {
      const { periodo } = ctx;
      const seta = STATE.menuRelatorios ? "▼" : "▶";
      const itens = `
                ${Template.botao("ahg-open-details-menu", "Detalhamento mensal", "📋")}
                ${Template.botao("ahg-export-csv", "Exportar CSV", "📥")}
            `;
      return `
            <div class="a-menu">
                <div class="a-row infos clickable a-menu-toggle" id="ahg-relatorios-toggle">
                    ${Template.label(`${seta} 📁 Relatórios`)}
                    <span class="a-val neu" style="font-size:11px;opacity:0.7;">${periodo.descricao}</span>
                </div>
                <div class="a-menu-body" id="ahg-relatorios-body" style="display:${STATE.menuRelatorios ? "flex" : "none"};flex-direction:column;gap:4px;padding-top:4px;">
                    ${itens}
                </div>
            </div>`;
    },

    renderDebugNotif(ctx) {
      const seta = STATE.menuDebug ? "▼" : "▶";
      return `
            <div class="a-menu">
                <div class="a-row warn clickable a-menu-toggle" id="ahg-debug-toggle" style="border-color:#886600;">
                    ${Template.label(`${seta} 🧪 Testes de notificação`)}
                </div>
                <div class="a-menu-body" id="ahg-debug-body" style="display:${STATE.menuDebug ? "flex" : "none"};flex-direction:column;gap:4px;padding-top:4px;">
                    ${Template.botao("ahg-dbg-entrada", "Lembrete entrada", "⏰")}
                    ${Template.botao("ahg-dbg-almoco", "Lembrete almoço", "🍽️")}
                    ${Template.botao("ahg-dbg-retorno", "Retorno almoço", "🍽️")}
                    ${Template.botao("ahg-dbg-6h", "Limite turno (6h)", "⚠️")}
                    ${Template.botao("ahg-dbg-8h", "Meta diária (8h)", "✅")}
                    ${Template.botao("ahg-dbg-10h", "Limite dia (10h)", "⛔")}
                    ${Template.botao("ahg-dbg-ideal", "Saída ideal", "🏆")}
                    ${Template.botao("ahg-dbg-missed-8h", "Perdida — meta 8h", "📬")}
                    ${Template.botao("ahg-dbg-urgente", "Urgente (requer OK)", "🚨")}
                </div>
            </div>`;
    },

    registrarEventos(ctx) {
      document.getElementById("ahg-min")?.addEventListener("click", () => {
        document.getElementById("ahg-panel").style.display = "none";
        document.getElementById("ahg-fab").style.display = "flex";
        STATE.panelMinimized = true;
      });

      document
        .getElementById("ahg-status-toggle")
        ?.addEventListener("click", () => {
          STATE.statusExpandido = !STATE.statusExpandido;
          render();
        });

      document
        .getElementById("ahg-relatorios-toggle")
        ?.addEventListener("click", () => {
          const abrindo = !STATE.menuRelatorios;
          STATE.menuRelatorios = abrindo;

          // Lê o período do DOM neste instante
          const periodoAtual = DataHelper.getPeriodoVisivel();
          const periodoObj = DataHelper.getPeriodoObj(
            periodoAtual.ano,
            periodoAtual.mes,
          );

          const body = document.getElementById("ahg-relatorios-body");
          const toggle = document.getElementById("ahg-relatorios-toggle");

          if (body) body.style.display = abrindo ? "flex" : "none";
          if (toggle) {
            const lbl = toggle.querySelector(".a-lbl");
            const valEl = toggle.querySelector(".a-val");
            const seta = abrindo ? "▼" : "▶";
            if (lbl) lbl.textContent = `${seta} 📁 Relatórios`;
            if (valEl) valEl.textContent = periodoObj.descricao;
          }

          if (!abrindo) STATE.menuRelatorios = false;
        });

      document
        .getElementById("ahg-open-details-menu")
        ?.addEventListener("click", () => {
          // Lê o período do DOM no momento do clique
          const pv = DataHelper.getPeriodoVisivel();
          const po = DataHelper.getPeriodoObj(pv.ano, pv.mes);
          const dias = DOM.extrairDias(pv);
          const rel = Relatorio.gerarMensal(dias, po);
          Modal.abrir(rel);
        });

      document
        .getElementById("ahg-export-csv")
        ?.addEventListener("click", () => {
          // Lê o período do DOM no momento do clique
          const pv = DataHelper.getPeriodoVisivel();
          const po = DataHelper.getPeriodoObj(pv.ano, pv.mes);
          const dias = DOM.extrairDias(pv);
          const rel = Relatorio.gerarMensal(dias, po);
          Exportador.csv(rel);
        });

      document
        .getElementById("ahg-test-notif")
        ?.addEventListener("click", () => {
          notif(
            `teste-manual-${Date.now()}`,
            "🧪 Teste de Notificação",
            "Notificação disparada pelo painel Ahgora.",
            false,
            0,
          );
        });
      document
        .getElementById("ahg-open-manuais")
        ?.addEventListener("click", () => ManualModal.abrir());

      // ── Painel de debug (só registra se DEBUG_NOTIF estiver ativo) ──
      if (CONFIG.DEBUG_NOTIF) {
        document
          .getElementById("ahg-debug-toggle")
          ?.addEventListener("click", () => {
            STATE.menuDebug = !STATE.menuDebug;
            const body = document.getElementById("ahg-debug-body");
            const toggle = document.getElementById("ahg-debug-toggle");
            if (body) body.style.display = STATE.menuDebug ? "flex" : "none";
            if (toggle) {
              const lbl = toggle.querySelector(".a-lbl");
              if (lbl)
                lbl.textContent = `${STATE.menuDebug ? "▼" : "▶"} 🧪 Testes de notificação`;
            }
          });

        const dbgNotif = (id, title, body, urgente = false) =>
          notif(`dbg-${id}-${Date.now()}`, title, body, urgente, 0);

        document
          .getElementById("ahg-dbg-entrada")
          ?.addEventListener("click", () =>
            dbgNotif(
              "entrada",
              "⏰ Hora de bater ponto!",
              "Lembre de registrar sua entrada.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-almoco")
          ?.addEventListener("click", () =>
            dbgNotif(
              "almoco",
              "🍽️ Hora do almoço!",
              "Não esqueça de bater o ponto de saída para o almoço.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-retorno")
          ?.addEventListener("click", () =>
            dbgNotif(
              "retorno",
              "🍽️ Volta do almoço",
              "Já se passou 1h da saída para o almoço. Registre o retorno.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-6h")
          ?.addEventListener("click", () =>
            dbgNotif(
              "6h",
              "⚠️ Limite de turno",
              "Você atingiu 6h de turno.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-8h")
          ?.addEventListener("click", () =>
            dbgNotif("8h", "✅ Meta diária", "Você completou as 8h.", false),
          );

        document
          .getElementById("ahg-dbg-10h")
          ?.addEventListener("click", () =>
            dbgNotif(
              "10h",
              "⛔ Limite diário",
              "Atenção: 10h atingidas.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-ideal")
          ?.addEventListener("click", () =>
            dbgNotif(
              "ideal",
              "🏆 Saída ideal",
              "Saldo semanal compensado.",
              false,
            ),
          );

        document
          .getElementById("ahg-dbg-missed-8h")
          ?.addEventListener("click", () =>
            dbgNotif(
              "missed-8h",
              "⚠️ Você já deveria ter saído",
              "Meta de 8h era às 18:00. Bata o ponto agora se ainda está trabalhando.",
              true,
            ),
          );

        document
          .getElementById("ahg-dbg-urgente")
          ?.addEventListener("click", () =>
            dbgNotif(
              "urgente",
              "🚨 Notificação urgente",
              "Esta notificação requer confirmação do usuário.",
              true,
            ),
          );
      }
    },
  };

  /* =========================================================
       Calendario — renderização no calendário, sem cálculos
    ========================================================= */

  const Calendario = {
    render(dias) {
      this.renderTotais(dias);
    },

    renderTotais(dias) {
      dias.forEach((d) => {
        d.elemento?.querySelector(".ahg-total-dia")?.remove();
        d.elemento?.querySelector(".ahg-manual-badge")?.remove();

        // Marca de batidas manuais
        if (d.manuais && d.manuais.length && d.elemento) {
          const b = document.createElement("div");
          b.className = "ahg-manual-badge";
          b.textContent = `✎ ${d.manuais.join(" · ")}`;
          b.title = `Batidas manuais (locais): ${d.manuais.join(", ")}`;
          d.elemento.appendChild(b);
        }

        const temBatidas = d.batidas.length > 0;
        if (!temBatidas || d.isFuture) return;

        const fechado = d.batidas.length % 2 === 0;
        const aberto = !fechado;

        let minutosExibir;
        if (aberto && !d.isToday) {
          let somaFechados = 0;
          for (let i = 0; i + 1 < d.batidas.length; i += 2) {
            const e = Hora.toMin(d.batidas[i]);
            const s = Hora.toMin(d.batidas[i + 1]);
            if (e !== null && s !== null) somaFechados += s - e;
          }
          minutosExibir = somaFechados;
        } else {
          minutosExibir = d.trabalhado;
        }

        const el = document.createElement("div");
        el.className = aberto
          ? "ahg-total-dia ahg-total-dia--aberto"
          : "ahg-total-dia";
        el.textContent = Hora.fmtMin(minutosExibir);
        if (aberto) el.title = "Turno em aberto — total parcial";
        d.elemento.appendChild(el);
      });
    },
  };

  /* =========================================================
       Modal — detalhamento mensal com scroll e semanas
    ========================================================= */

  const Modal = {
    abrir(relatorio) {
      document.getElementById("ahg-details")?.remove();

      const modal = document.createElement("div");
      modal.id = "ahg-details";
      modal.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999999;display:flex;align-items:center;justify-content:center;";

      const box = document.createElement("div");
      box.style.cssText =
        "width:min(900px,95vw);max-height:90vh;overflow-y:auto;overflow-x:auto;background:#111827;border-radius:14px;padding:20px;color:#dde;font-family:Segoe UI,sans-serif;";
      box.innerHTML = this.buildConteudo(relatorio);

      modal.appendChild(box);
      document.body.appendChild(modal);

      document.getElementById("ahg-close-details").onclick = () =>
        modal.remove();
      modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
      };
    },

    buildConteudo(relatorio) {
      const { semanas, resumo } = relatorio;
      let html = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <h2 style="margin:0;">📊 Detalhamento — ${resumo.periodo.descricao}</h2>
                    <button id="ahg-close-details">Fechar</button>
                </div>
                <p style="color:#7880aa;font-size:12px;margin:0 0 8px;">
                    Realizado: <strong>${Hora.fmtMin(resumo.totalMes)}</strong> &nbsp;|&nbsp;
                    Saldo: <strong>${Hora.fmtMin(resumo.saldoMes)}</strong> &nbsp;|&nbsp;
                    Dias: <strong>${resumo.diasRegistrados}</strong>
                </p>
                <p style="color:#555880;font-size:11px;margin:0 0 16px;">
                    ⚪ Tolerância de ±${CONFIG.TOLERANCIA}min — saldo dentro desse intervalo não é contabilizado
                </p>
            `;

      semanas.forEach((sem) => {
        html += `
                    <h3 style="color:#b9a9ff;margin:12px 0 6px;">Semana ${sem.semana}</h3>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:4px;">
                        <thead>
                            <tr style="color:#7880aa;font-size:11px;">
                                <th style="text-align:left;padding:5px 4px;">Dia</th>
                                <th style="text-align:left;padding:5px 4px;">Data</th>
                                <th style="text-align:right;padding:5px 4px;">Trabalhado</th>
                                <th style="text-align:right;padding:5px 4px;">Saldo dia</th>
                            </tr>
                        </thead>
                        <tbody>
                `;

        sem.itens.forEach((r) => {
          if (r.emTolerancia) {
            // Linha com tolerância: cor neutra, tooltip explicativo
            const minutos = Math.abs(r.saldoDia);
            const sentido =
              r.saldoDia >= 0
                ? `+${Hora.fmtMin(r.saldoDia)}`
                : Hora.fmtMin(r.saldoDia);
            html += `
                            <tr title="Tolerância: ${sentido} (${minutos}min dentro do limite de ${CONFIG.TOLERANCIA}min — não contabilizado)"
                                style="opacity:0.6;cursor:help;">
                                <td style="padding:4px;">${DataHelper.DIAS_SEMANA_CURTO[r.data.getDay()]}</td>
                                <td style="padding:4px;">${DataHelper.fmtData(r.data)}</td>
                                <td style="text-align:right;padding:4px;">${Hora.fmtMin(r.trabalhado)}</td>
                                <td style="text-align:right;padding:4px;color:#555880;">
                                    ${sentido} <span style="font-size:10px;">⚪</span>
                                </td>
                            </tr>
                        `;
          } else {
            const corSaldo = r.saldoDia >= 0 ? "#3ddc84" : "#ff6b6b";
            html += `
                            <tr>
                                <td style="padding:4px;">${DataHelper.DIAS_SEMANA_CURTO[r.data.getDay()]}</td>
                                <td style="padding:4px;">${DataHelper.fmtData(r.data)}</td>
                                <td style="text-align:right;padding:4px;">${r.batidas.length > 0 ? Hora.fmtMin(r.trabalhado) : "—"}</td>
                                <td style="text-align:right;padding:4px;color:${corSaldo};">${r.isBusinessDay && r.batidas.length > 0 ? Hora.fmtMin(r.saldoDia) : "—"}</td>
                            </tr>
                        `;
          }
        });

        html += `
                        <tr style="background:#1f2937;font-weight:bold;">
                            <td colspan="2" style="padding:5px 4px;">Total semana ${sem.semana}</td>
                            <td style="text-align:right;padding:5px 4px;">${Hora.fmtMin(sem.totalTrabalhado)}</td>
                            <td style="text-align:right;padding:5px 4px;color:${sem.totalSaldo >= 0 ? "#3ddc84" : "#ff6b6b"};">${Hora.fmtMin(sem.totalSaldo)}</td>
                        </tr>
                        </tbody>
                    </table>
                    <div style="height:14px;"></div>
                `;
      });

      return html;
    },
  };

  /* =========================================================
   ManualModal — inserir / apagar batidas manuais
========================================================= */

  const ManualModal = {
    _data: null,
    _msg: null,
    _confirmando: null,

    abrir() {
      document.getElementById("ahg-manual-modal")?.remove();
      this._msg = null;
      this._confirmando = null;
      this._data = todayDateStr();

      const overlay = document.createElement("div");
      overlay.id = "ahg-manual-modal";
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999999;display:flex;align-items:center;justify-content:center;";

      const box = document.createElement("div");
      box.style.cssText =
        "width:min(460px,95vw);max-height:90vh;overflow-y:auto;background:#111827;border-radius:14px;padding:20px;color:#dde;font-family:Segoe UI,sans-serif;";

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
      };

      this._desenhar(box, overlay);
    },

    _fmtData(d) {
      return d.split("-").reverse().join("/");
    },

    _desenhar(box, overlay) {
      const hoje = todayDateStr();

      // Horários que já aparecem no espelho (mês visível) — para sinalizar duplicidade
      const noEspelho = new Set();
      try {
        DOM.extrairDias(DataHelper.getPeriodoVisivel()).forEach((d) => {
          const ds = ManualPunches.dateStr(d.data);
          d.domBatidas.forEach((t) => noEspelho.add(`${ds}|${Hora.toMin(t)}`));
        });
      } catch {
        /* silent */
      }

      const inputCss =
        "background:#0f0f1e;color:#dde;border:1px solid #252545;border-radius:6px;padding:6px 8px;font-size:13px;color-scheme:dark;";
      const btnCss =
        "background:#3b2d82;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px;";

      const lista = ManualPunches.listAll();
      const linhas = lista.length
        ? lista
            .map((p) => {
              const key = `${p.date}|${p.time}`;
              const duplicada = noEspelho.has(
                `${p.date}|${Hora.toMin(p.time)}`,
              );
              const confirmando = this._confirmando === key;
              return `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;background:rgba(255,255,255,.04);margin-bottom:4px;">
                    <span>${this._fmtData(p.date)} &nbsp;<strong style="color:#b9a9ff;">${p.time}</strong>
                        ${duplicada ? '<small style="color:#ffb347;"> · já consta no espelho</small>' : ""}</span>
                    <button data-del="${key}" style="background:${confirmando ? "#b91c1c" : "#2a2a45"};color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;">
                        ${confirmando ? "Confirmar?" : "🗑 Apagar"}
                    </button>
                </div>`;
            })
            .join("")
        : '<p style="color:#555880;font-size:12px;margin:6px 0;">Nenhuma batida manual registrada.</p>';

      const msgHtml = this._msg
        ? `<div style="font-size:12px;margin:6px 0 10px;color:${this._msg.ok ? "#3ddc84" : "#ff6b6b"};">${this._msg.txt}</div>`
        : '<div style="height:10px;"></div>';
      this._msg = null;

      box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h2 style="margin:0;font-size:17px;">✍️ Batidas manuais</h2>
                <button id="ahg-man-close" style="${btnCss}background:#2a2a45;">Fechar</button>
            </div>
            <p style="color:#7880aa;font-size:11.5px;margin:0 0 12px;">
                Use para batidas feitas por solicitação, que não aparecem no espelho.
                Ficam salvas apenas neste navegador e entram nos cálculos do dia.
            </p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
                <label style="font-size:11px;color:#7880aa;display:flex;flex-direction:column;gap:3px;">Data
                    <input id="ahg-man-data" type="date" value="${this._data || hoje}" max="${hoje}" style="${inputCss}">
                </label>
                <label style="font-size:11px;color:#7880aa;display:flex;flex-direction:column;gap:3px;">Horário
                    <input id="ahg-man-hora" type="time" style="${inputCss}">
                </label>
                <button id="ahg-man-add" style="${btnCss}">＋ Adicionar</button>
            </div>
            ${msgHtml}
            <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#444466;margin:4px 0 6px;font-weight:700;">Inseridas manualmente</div>
            ${linhas}
        `;

      box.querySelector("#ahg-man-close").onclick = () => overlay.remove();

      box.querySelector("#ahg-man-add").onclick = () => {
        const data = box.querySelector("#ahg-man-data").value;
        const hora = box.querySelector("#ahg-man-hora").value;
        this._data = data || hoje;
        this._confirmando = null;

        const r = ManualPunches.add(data, hora);
        this._msg = r.ok
          ? {
              ok: true,
              txt: `Batida ${hora} de ${this._fmtData(data)} adicionada.`,
            }
          : { ok: false, txt: r.erro };
        if (r.ok) render();
        this._desenhar(box, overlay);
      };

      // Apagar em duas etapas (sem confirm(), que pode ser bloqueado em iframe)
      box.querySelectorAll("[data-del]").forEach((btn) => {
        btn.onclick = () => {
          const key = btn.dataset.del;
          if (this._confirmando !== key) {
            this._confirmando = key;
            this._desenhar(box, overlay);
            return;
          }
          const [date, time] = key.split("|");
          ManualPunches.remove(date, time);
          this._confirmando = null;
          this._msg = {
            ok: true,
            txt: `Batida ${time} de ${this._fmtData(date)} removida.`,
          };
          render();
          this._desenhar(box, overlay);
        };
      });
    },
  };

  /* =========================================================
       Notificações
       Usa GM_notification (via extensão Tampermonkey) quando disponível —
       funciona mesmo com a aba em segundo plano ou minimizada.
       Fallback para Notification API nativa do browser.
       Nenhuma das duas funciona com o browser completamente fechado.
    ========================================================= */

  async function pedirNotif() {
    // GM_notification não precisa de permissão explícita do usuário,
    // mas a Notification API precisa. Pedimos para cobrir o fallback.
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission().catch(() => {});
    }
  }

  function notif(
    id,
    title,
    body,
    urgente = false,
    ttlMs = 60 * 1000,
    opts = {},
  ) {
    const agora = Date.now();
    const ultima = STATE.notificationsFired.get(id);
    if (ultima && agora - ultima < ttlMs) return;
    STATE.notificationsFired.set(id, agora);

    const url = DOM.getBatidaUrl();
    const bodyFull = url ? `${body}\nClique para registrar o ponto.` : body;

    // 1- GM_notification direto (funciona em qualquer frame e com a aba em segundo plano)
    if (typeof GM_notification === "function") {
      const det = {
        title,
        text: bodyFull,
        timeout: opts.timeout ?? (urgente ? 0 : 8000),
        onclick: url ? () => window.open(url, "_blank", "noopener") : undefined,
      };
      if (opts.tag) det.tag = opts.tag; // mesma tag substitui a anterior
      if (opts.silent) det.silent = true;
      if (opts.onDone) det.ondone = opts.onDone;
      GM_notification(det);
      return;
    }

    // 2- Sem GM_notification dentro do iframe: delega para a janela do topo
    if (window.top !== window) {
      try {
        window.top.postMessage(
          { type: "AHG_NOTIF", id, title, body, urgente, ttlMs },
          "*",
        );
      } catch (e) {
        console.warn("[AHGORA PANEL] postMessage falhou:", e);
      }
      return;
    }

    // 3- Fallback: Notification API nativa
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    try {
      const n = new Notification(title, {
        body: bodyFull,
        requireInteraction: urgente,
        silent: !!opts.silent,
        tag: opts.tag || `${id}-${agora}`,
      });
      if (url)
        n.onclick = () => {
          window.open(url, "_blank", "noopener");
          n.close();
        };
    } catch (e) {
      console.error("[AHGORA PANEL] Notification falhou:", e);
    }
  }

  // Registro persistente dos avisos "faltam X min" já emitidos hoje
  const PREWARN_KEY = "ahg_prewarn_fired";
  function prewarnLoad() {
    const hoje = todayDateStr();
    try {
      const o = JSON.parse(localStorage.getItem(PREWARN_KEY) || "null");
      if (o && o.date === hoje && Array.isArray(o.keys)) return o;
    } catch {
      /* silent */
    }
    return { date: hoje, keys: [] };
  }

  function checarNotifs(ctx) {
    const { jornadaHoje } = ctx;
    const saidas = jornadaHoje.saidas;
    const now = Hora.nowMin();
    const frozen = ctx.frozen || false;
    const todayStr = todayDateStr();

    // Agendamento persistente (cancela tudo se frozen). Os avisos de "atingido"
    // (6h/8h/10h/ideal) são disparados pelo NotifScheduler.tick().
    NotifScheduler.updateFromContext(ctx, todayStr);
    if (frozen) return;

    const reg = prewarnLoad();
    let dirty = false;

    const chk = (h, id, tit, msg, urgente) => {
      if (h === null || h === undefined) return;
      const faltam = h - now;
      if (faltam <= 0) return;

      // Offsets já ultrapassados (ex.: faltam 3 → 10, 5 e 4 já "passaram")
      const cruzados = (CONFIG.NOTIFICACOES[id] ?? []).filter(
        (min) => faltam <= min,
      );
      const keyOf = (min) => `${id}-${min}-${h}`;
      const pendentes = cruzados.filter(
        (min) => !reg.keys.includes(keyOf(min)),
      );
      if (!pendentes.length) return;

      // Marca todos como emitidos e dispara UMA notificação com o tempo real restante
      cruzados.forEach((min) => {
        if (!reg.keys.includes(keyOf(min))) reg.keys.push(keyOf(min));
      });
      dirty = true;

      notif(
        `prewarn-${id}-${h}-${Math.min(...pendentes)}`,
        `⏰ ${tit}`,
        `${msg}\nFaltam ${faltam} minuto${faltam > 1 ? "s" : ""}.`,
        urgente,
        0,
      );
    };

    chk(
      saidas.h6,
      "h6",
      "6h atingidas",
      "Você completou o mínimo de 6h.",
      true,
    );
    chk(saidas.h8, "h8", "Meta diária", "Você completou as 8h.", false);
    chk(saidas.h10, "h10", "Limite diário", "⚠ Limite diário atingido.", true);
    if (saidas.saidaIdeal !== null && saidas.saidaIdeal !== saidas.h8) {
      chk(
        saidas.saidaIdeal,
        "ideal",
        "Saída ideal",
        "Saldo semanal compensado.",
        false,
      );
    }

    if (dirty) {
      try {
        localStorage.setItem(PREWARN_KEY, JSON.stringify(reg));
      } catch {
        /* silent */
      }
    }
  }

  /* =========================================================
       CSS
    ========================================================= */

  function injectCSS() {
    if (document.getElementById("ahg-css-v6")) return;
    const style = document.createElement("style");
    style.id = "ahg-css-v6";
    style.textContent = `
        #ahg-fab{
            position:fixed;bottom:20px;right:20px;left:auto;z-index:99999;
            width:48px;height:48px;border-radius:50%;
            background:linear-gradient(135deg,#3b2d82,#1e1b4b);
            border:2px solid #4a3faf;display:flex;align-items:center;
            justify-content:center;font-size:22px;cursor:pointer;color:white;
        }
        #ahg-panel{
            position:fixed;bottom:20px;right:20px;left:auto;z-index:99999;
            background:#0f0f1e;border:1px solid #252545;border-radius:14px;
            min-width:260px;max-width:295px;font-family:'Segoe UI',sans-serif;
            color:#dde;box-shadow:0 8px 40px rgba(0,0,0,.7);
            max-height:calc(100vh - 40px);overflow:hidden;display:flex;flex-direction:column;
        }
        .a-tit{
            background:linear-gradient(135deg,#3b2d82,#1e1b4b);color:#b9a9ff;
            font-weight:700;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;
            padding:10px 14px 8px;border-radius:14px 14px 0 0;
            display:flex;align-items:center;gap:6px;cursor:grab;
        }
        .a-x{margin-left:auto;cursor:pointer;opacity:.6;font-size:18px;}
        .a-body{
            padding:10px 12px 12px;display:flex;flex-direction:column;gap:5px;
            overflow-y:auto;overflow-x:hidden;flex:1;
        }
        .a-row{
            display:flex;justify-content:space-between;align-items:center;
            padding:5px 8px;border-radius:7px;
            background:rgba(255,255,255,.04);border-left:3px solid transparent;
        }
        .a-row.ok    {background:rgba(61,220,132,.1); border-color:#3ddc84;}
        .a-row.warn  {background:rgba(255,165,0,.12); border-color:orange;}
        .a-row.danger{background:rgba(255,60,60,.14); border-color:#ff4444;}
        .a-row.infos {background:rgba(100,100,255,.1);border-color:#7878ff;}
        .a-lbl{color:#7880aa;font-size:11.5px;}
        .a-val{font-weight:700;font-size:14px;text-align:right;}
        .a-val.pos  {color:#3ddc84;}
        .a-val.neg  {color:#ff6b6b;}
        .a-val.warn {color:orange;}
        .a-val.neu  {color:#b9a9ff;}
        .a-val small{font-size:11px;font-weight:800;color:#555880;display:block;}
        .a-div{border:none;border-top:1px solid rgba(255,255,255,.07);margin:3px 0;}
        .a-sec{
            font-size:10px;letter-spacing:1px;text-transform:uppercase;
            color:#444466;padding:3px 0 1px;font-weight:700;
        }
        .a-foot{
            font-size:10px;font-weight:800;color:#333355;
            text-align:right;padding:2px 14px 8px;
        }
        .a-row.clickable{cursor:pointer;transition:.15s;}
        .a-row.clickable:hover{transform:translateX(2px);background:rgba(255,255,255,.08);}
        .a-body::-webkit-scrollbar,#ahg-details *::-webkit-scrollbar{width:8px;height:8px;}
        .a-body::-webkit-scrollbar-thumb,#ahg-details *::-webkit-scrollbar-thumb{background:#444466;border-radius:10px;}
        .a-body::-webkit-scrollbar-track,#ahg-details *::-webkit-scrollbar-track{background:transparent;}
        .v-calendar-weekly__day{position:relative;}
        .ahg-total-dia{
            position:absolute;bottom:2px;right:4px;
            font-size:14px;font-weight:700;color:#78788f;
            padding:1px 4px;border-radius:6px;pointer-events:none;
        }
        .ahg-total-dia--aberto{
            color:#b9a9ff;
            opacity:0.75;
        }
        .ahg-total-dia--aberto::after{
            content:'…';
            font-size:10px;
            margin-left:1px;
            opacity:0.8;
        }
        .a-status-detalhe{
            display:flex;flex-direction:column;gap:3px;
            margin:2px 0 3px;padding:6px 8px;
            background:rgba(100,100,255,.06);
            border-left:3px solid #7878ff;
            border-radius:0 7px 7px 0;
        }
        .a-status-detalhe-linha{
            display:grid;
            grid-template-columns:80px 1fr auto;
            align-items:center;gap:4px;
            font-size:11.5px;color:#9090bb;
        }
        .a-status-detalhe-linha--intervalo{
            opacity:0.6;font-style:italic;
        }
                .a-status-detalhe-linha--aberto{
            color:#c9bcff;opacity:1;font-style:normal;font-weight:600;
        }
        .a-status-tag{
            display:block;font-size:9.5px;font-weight:700;letter-spacing:.4px;
            text-transform:uppercase;color:#7878ff;margin-top:1px;
        }
        .ahg-manual-badge{
            position:absolute;bottom:2px;left:4px;
            font-size:10px;font-weight:700;color:#ffb347;
            padding:1px 4px;border-radius:6px;pointer-events:none;
        }
        `;
    document.head.appendChild(style);
  }

  /* =========================================================
       Estrutura do painel (FAB + painel drag)
    ========================================================= */

  function criarEstrutura() {
    if (document.getElementById("ahg-panel")) return;

    const fab = document.createElement("div");
    fab.id = "ahg-fab";
    fab.innerHTML = "⏱";
    fab.onclick = () => {
      document.getElementById("ahg-panel").style.display = "";
      fab.style.display = "none";
      STATE.panelMinimized = false;
    };
    document.body.appendChild(fab);

    const panel = document.createElement("div");
    panel.id = "ahg-panel";
    panel.style.display = "none";
    panel.innerHTML = `<div class="a-tit">⏱ Carregando...</div>`;
    document.body.appendChild(panel);

    panel.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".a-tit")) return;
      STATE.dragging = true;
      const r = panel.getBoundingClientRect();
      STATE.dragOX = e.clientX - r.left;
      STATE.dragOY = e.clientY - r.top;
    });

    document.addEventListener("mousemove", (e) => {
      if (!STATE.dragging) return;
      panel.style.left = `${e.clientX - STATE.dragOX}px`;
      panel.style.top = `${e.clientY - STATE.dragOY}px`;
      panel.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      STATE.dragging = false;
    });
  }

  /* =========================================================
       render — monta o contexto e despacha para UI
    ========================================================= */

  function render() {
    try {
      const periodoVisivel = DataHelper.getPeriodoVisivel();
      STATE.periodoSelecionado = periodoVisivel;

      const periodo = DataHelper.getPeriodoObj(
        periodoVisivel.ano,
        periodoVisivel.mes,
      );
      const periodoAtual = DataHelper.getPeriodoObj(
        new Date().getFullYear(),
        new Date().getMonth(),
      );
      const ehMesAtual =
        periodoVisivel.ano === periodoAtual.ano &&
        periodoVisivel.mes === periodoAtual.mes;

      const dias = DOM.extrairDias(periodoVisivel);

      // ── Localizar o dia de hoje ──────────────────────────────────────
      let diaHoje = dias.find((x) => x.isToday) || null;
      let domBatidas;

      if (!diaHoje) {
        // Mês histórico: v-present aponta para hoje mas não está em `dias`
        const elHoje = document.querySelector(
          ".v-calendar-weekly__day.v-present",
        );
        if (!elHoje) return; // calendário ainda não carregou

        const labelHoje = elHoje.querySelector(".v-calendar-weekly__day-label");
        const numHoje = labelHoje ? Number(labelHoje.textContent.trim()) : 0;
        if (!numHoje) return;

        const domBrutas = [...elHoje.querySelectorAll(".batida")]
          .filter((x) => !x.classList.contains("prevista"))
          .map((x) => x.textContent.trim());
        domBatidas = ManualPunches.merge(todayDateStr(), domBrutas).batidas;

        const dataHoje = new Date(periodoAtual.ano, periodoAtual.mes, numHoje);
        const isBusinessDay =
          dataHoje.getDay() !== 0 && dataHoje.getDay() !== 6;
        // Stub mínimo para _applyEventEngine abaixo
        diaHoje = {
          elemento: elHoje,
          data: dataHoje,
          isToday: true,
          isFuture: false,
          isHoliday: false,
          isBusinessDay,
          isWeekend: DataHelper.isWeekend(dataHoje),
          semana: DataHelper.getWeekNumber(dataHoje),
          diaSemana: DataHelper.DIAS_SEMANA[dataHoje.getDay()],
          batidas: domBatidas,
          trabalhado: 0,
          saldo: 0,
        };
      } else {
        domBatidas = diaHoje.batidas;
      }

      // ── EventEngine: fonte única de verdade para batidas de hoje ─────
      const workday = WorkdayStore.syncFromDom(domBatidas);
      const { effectiveBatidas, actual, frozen } = EventEngine.resolve(
        workday,
        domBatidas,
      );
      const trabalhado =
        effectiveBatidas.length > 0
          ? Jornada.calcularTrabalhado(effectiveBatidas)
          : 0;
      const saldoEfetivoBruto = diaHoje.isBusinessDay
        ? trabalhado - CONFIG.CARGA_DIARIA
        : 0;
      const emTolerancia =
        diaHoje.isBusinessDay &&
        effectiveBatidas.length > 0 &&
        Math.abs(saldoEfetivoBruto) <= CONFIG.TOLERANCIA;

      diaHoje = Object.assign({}, diaHoje, {
        batidas: effectiveBatidas,
        trabalhado,
        saldo: saldoEfetivoBruto,
        saldoEfetivo: emTolerancia ? 0 : saldoEfetivoBruto,
        frozen,
        actual,
        workday,
      });

      // ── Relatório mensal ─────────────────────────────────────────────
      const relatorio = Relatorio.gerarMensal(dias, periodo);

      let saldoSemanaJornada = relatorio.saldoSemana;
      if (!ehMesAtual) saldoSemanaJornada = 0;

      // ── RuleEngine ───────────────────────────────────────────────────
      STATE.ruleResults = RuleEngine.evaluate(
        diaHoje.batidas,
        diaHoje.trabalhado,
      );

      // ── Jornada ──────────────────────────────────────────────────────
      const jornadaHoje = Jornada.calcularDia(diaHoje, saldoSemanaJornada);

      if (frozen) {
        jornadaHoje.saidas = {
          h6: null,
          h8: null,
          h10: null,
          saidaIdeal: null,
          actualExit: actual["WORK_END"]?.time || null,
        };
        jornadaHoje.estado = { codigo: "ENCERRADO", label: "🛫 Encerrado" };
      }

      const ctx = {
        dias,
        periodo,
        relatorio,
        resumo: relatorio.resumo,
        jornadaHoje,
        frozen,
        ruleResults: STATE.ruleResults,
        workday,
      };

      checarNotifs(ctx);

      // Estado compartilhado: motor reserva + resumo na página de batida
      {
        const hojeStr = todayDateStr();
        const prev = SharedStore.get("ahg_shared_state", null);
        const prevOk = prev && prev.date === hojeStr ? prev : null;
        SharedStore.set("ahg_shared_state", {
          date: hojeStr,
          updatedAt: Date.now(),
          frozen,
          entries: workday.entries.map((e) => ({ type: e.type, time: e.time })),
          batidas: diaHoje.batidas,
          manuais: diaHoje.manuais || [],
          // vendo outro mês: mantém os saldos da semana/mês atuais já publicados
          saldoSemana: ehMesAtual
            ? relatorio.saldoSemana
            : (prevOk?.saldoSemana ?? 0),
          saldoSemanaComHoje: ehMesAtual
            ? relatorio.saldoSemanaComHoje
            : (prevOk?.saldoSemanaComHoje ?? 0),
          saldoMes: ehMesAtual
            ? relatorio.resumo.saldoMes
            : (prevOk?.saldoMes ?? null),
        });
      }

      if (document.hidden) return;

      const p = document.getElementById("ahg-panel");
      if (!p) return;

      UI.render(ctx);
      Calendario.render(dias);
    } catch (e) {
      console.error("[AHGORA PANEL]", e);
    }
  }

  /* =========================================================
       INIT
    ========================================================= */

  function start() {
    injectCSS();
    criarEstrutura();

    // Housekeeping on startup
    WorkdayStore.pruneOld(35);
    ManualPunches.prune(400);
    render();
    NotifScheduler.recover(todayDateStr());

    // Quando a aba volta ao foco: re-verifica imediatamente
    // (cobre o caso de notificações perdidas enquanto a aba estava oculta)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") render();
    });

    // MutationObserver: recalcula quando o calendário mudar de mês
    const calendario = document.querySelector(".v-calendar-weekly");
    if (calendario) {
      const observer = new MutationObserver(() => {
        // Pequeno debounce para aguardar o DOM estabilizar
        clearTimeout(START._obsTimer);
        START._obsTimer = setTimeout(() => {
          const novoPeriodo = DataHelper.getPeriodoVisivel();
          const anterior = STATE.periodoSelecionado;
          if (
            novoPeriodo.ano !== anterior.ano ||
            novoPeriodo.mes !== anterior.mes
          ) {
            console.log("[AHGORA PANEL] mês alterado →", novoPeriodo);
            render();
          }
        }, 300);
      });
      observer.observe(calendario, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    // Relógio em Worker: roda mesmo com a aba oculta
    Ticker.on(1000, () => NotifScheduler.tick()); // dispara notificações vencidas
    Ticker.on(30000, () => render()); // recalcula e checa avisos
    Ticker.on(5000, () => {
      // auto-refresh
      if (Date.now() >= STATE.nextRefresh) {
        STATE.nextRefresh = Date.now() + CONFIG.AUTO_REFRESH_MIN * 60 * 1000;
        console.log("[AHGORA PANEL] recarregando página...");
        window.top.location = CONFIG.URL_REFRESH;
      }
    });
    Ticker.on(1000, () => LunchLive.tick()); // atualiza a janela de retorno do almoço
    PunchSync.init();
    Ticker.on(2000, () => PunchSync.tick()); // recarga após registrar o ponto
    MirrorBeat.beat(); // marca o espelho como aberto imediatamente
    try {
      GM_setValue(SessionGuard.KEY, 0); // sessão ok: o próximo logout alerta de imediato
    } catch {
      /* silent */
    }
    Ticker.on(5000, () => MirrorBeat.beat()); // sinal de vida (roda também em aba oculta)
    Ticker.start();
  }

  // Namespace auxiliar para o timer do observer
  const START = {};

  /* =========================================================
       Aguarda calendário e inicia
    ========================================================= */

  const initInterval = setInterval(() => {
    if (document.querySelector(".v-calendar-weekly")) {
      clearInterval(initInterval);
      start();
    }
  }, 1000);

  /* =========================================================
       Funções de teste expostas no console
    ========================================================= */

  window.ahgTestNotif = function () {
    notif(
      `teste-${Date.now()}`,
      "🧪 Teste Ahgora",
      "Notificação de teste.",
      false,
      0,
    );
  };

  window.ahgTestBatida = function () {
    const url = DOM.getBatidaUrl();
    console.log("[AHGORA PANEL] TEST URL:", url);
    notif(
      `batida-${Date.now()}`,
      "🧪 Teste de Batida",
      "Clique para abrir a tela de registro.",
      true,
      0,
    );
  };

  window.ahgTestAlertas = function (tipo = "h8") {
    const minutos = Array.isArray(CONFIG.NOTIFICACOES[tipo])
      ? CONFIG.NOTIFICACOES[tipo]
      : [];
    minutos.forEach((min, idx) => {
      setTimeout(() => {
        notif(
          `teste-${tipo}-${min}-${Date.now()}`,
          `🧪 Teste ${tipo}`,
          `Faltam ${min} minuto${min > 1 ? "s" : ""}.`,
          min <= 3,
          0,
        );
      }, idx * 2000);
    });
    setTimeout(() => {
      notif(
        `teste-${tipo}-atingido-${Date.now()}`,
        `✅ Teste ${tipo}`,
        "Limite atingido.",
        true,
        0,
      );
    }, minutos.length * 2000);
  };

  window.ahgTestTudo = function () {
    Object.keys(CONFIG.NOTIFICACOES)
      .filter((k) => Array.isArray(CONFIG.NOTIFICACOES[k]))
      .forEach((tipo, idx) => {
        setTimeout(() => window.ahgTestAlertas(tipo), idx * 15000);
      });
  };
  window.ahgTestAlmocoLive = function () {
    LunchLive.start();
    notif(
      `dbg-lunchlive-${Date.now()}`,
      "🍽️ Hora do almoço!",
      LunchLive.corpo(),
      true,
      0,
      { tag: LunchLive.TAG },
    );
  };
  window.ahgStopAlmocoLive = () => LunchLive.stop();

  /* =========================================================
       Top window — recebe mensagens do iframe e dispara notificações
    ========================================================= */

  pedirNotif();

  try {
    const code = localStorage
      .getItem("@batidaOnline/companyCodeDefault")
      ?.trim();
    if (code) GM_setValue("ahg_company_code", code);
  } catch {
    /* silent */
  }

  const IS_TOP = window.top === window;
  if (IS_TOP) {
    console.log("[AHGORA PANEL] TOP WINDOW");

    // Recebe pedidos de notificação vindos do iframe e dispara via GM_notification
    window.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "AHG_NOTIF") return;
      const { id, title, body, urgente, ttlMs } = e.data;
      notif(id, title, body, urgente, ttlMs ?? 60 * 1000);
    });

    const naBatida = location.pathname.includes("/novabatidaonline");
    if (naBatida) {
      PunchSignal.attach();
      PunchSummary.init(); // cartão "Resumo do dia" (antes de Ticker.start())
    }

    // Motor reserva: só atua quando o espelho NÃO está ativo, e só em uma aba
    const motorReserva = () => !MirrorBeat.isOpen() && Leader.isLeader();
    Ticker.on(1000, () => {
      if (motorReserva()) NotifScheduler.tick(); // dispara o que venceu
    });
    Ticker.on(60000, () => {
      if (motorReserva()) NotifScheduler.ensureStatic(); // garante lembretes do dia
    });

    // Alerta de sessão expirada
    Ticker.on(5000, () => SessionGuard.check());

    // Recarga periódica: só na página do espelho, e nunca na tela de login
    if (!naBatida) {
      let topDeadline = Date.now() + CONFIG.AUTO_REFRESH_MIN * 60 * 1000;
      Ticker.on(5000, () => {
        if (Date.now() < topDeadline) return;
        if (SessionGuard.isLoginPage()) {
          topDeadline = Date.now() + 60 * 1000; // não apaga a senha que você está digitando
          return;
        }
        topDeadline = Infinity;
        console.log("[AHGORA PANEL] reload top");
        location.reload();
      });
    }

    Ticker.start();
    return;
  }
})();

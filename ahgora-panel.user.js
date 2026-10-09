// ==UserScript==
// @name         Ahgora — Painel Inteligente Local
// @namespace    https://github.com/jonathanfiss
// @version      2.2.0
// @description  Painel inteligente local para Ahgora
// @author       Jonathan Fiss

// @match https://mirror.app.ahgora.com.br/*
// @match https://app.ahgora.com.br/*

// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
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
    VERSAO: "2.2.0",
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
      HORARIO_ENTRADA_PADRAO: "08:00", // "HH:MM" — usado como ancoragem do lembrete de entrada
      entrada: [15, 5], // avisar 15 e 5 minutos antes da entrada
    },
    // Janela de recuperação de notificações perdidas (ms)
    // Aumentada para cobrir casos de "abri o browser agora"
    NOTIF_RECOVERY_WINDOW_MS: 4 * 60 * 60 * 1000, // 4 horas
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
      try {
        const raw = localStorage.getItem(this._KEY);
        return raw ? JSON.parse(raw) : { schedules: [] };
      } catch {
        return { schedules: [] };
      }
    },

    save(data) {
      try {
        localStorage.setItem(this._KEY, JSON.stringify(data));
      } catch {
        /* silent */
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
      const lbl = LABELS[type] || { title: `⏰ ${type}`, body: "" };
      notif(
        `sched-${id}`,
        lbl.title,
        lbl.body,
        type.includes("H10") || type === "ENTRY_REMINDER",
        0,
      );
      this._timers.delete(id);
    },

    // Disparada quando uma notificação foi perdida (página estava fechada).
    // Inclui o horário original programado na mensagem para dar contexto.
    _fireMissed(id, type, scheduledDate) {
      const data = this.load();
      const sched = data.schedules.find((s) => s.id === id);
      if (!sched || sched.fired) return;

      sched.fired = true;
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

      // ── Helper interno: upsert uma entrada no batch ──────────────────
      const upsert = (data, id, type, iso) => {
        data.schedules = data.schedules.filter(
          (s) => !(s.type === type && s.workdayDate === todayStr),
        );
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

      // ── Helper: converte minutos-desde-meia-noite em ISO do dia atual ─
      const now = new Date();
      const datePfx = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const minToIso = (min) => {
        const n = ((Math.round(min) % 1440) + 1440) % 1440;
        return `${datePfx}T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00`;
      };
      const isFuture = (iso) => new Date(iso).getTime() > Date.now();

      // ── Workday frozen: cancelar TODAS as notificações de saída ──────
      if (frozen) {
        const data = this.load();
        const EXIT_TYPES = [
          "EXPECTED_EXIT_H6",
          "EXPECTED_EXIT_H8",
          "EXPECTED_EXIT_H10",
          "EXPECTED_EXIT_IDEAL",
          "ENTRY_REMINDER",
        ];
        let changed = false;
        EXIT_TYPES.forEach((type) => {
          const before = data.schedules.length;
          data.schedules = data.schedules.filter(
            (s) => !(s.type === type && s.workdayDate === todayStr),
          );
          if (data.schedules.length !== before) {
            // limpar timers em memória
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

      // 1. Lembretes de entrada (só se entrada ainda não foi batida)
      const temEntrada = ctx.workday?.entries?.some(
        (e) => e.type === "WORK_START",
      );
      if (!temEntrada) {
        const entradaMin = hmToMin(CONFIG.NOTIFICACOES.HORARIO_ENTRADA_PADRAO);
        CONFIG.NOTIFICACOES.entrada.forEach((antecipMin) => {
          const iso = minToIso(entradaMin - antecipMin);
          if (!isFuture(iso)) return;
          upsert(
            data,
            `ENTRY_REMINDER-${antecipMin}-${todayStr}`,
            "ENTRY_REMINDER",
            iso,
          );
          changed = true;
        });
      }

      // 2. Saídas previstas
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

      // Data de hoje para comparação por data quando v-present não existe
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

        // Usa o ano/mês do período ativo, não necessariamente hoje
        const data = new Date(ano, mes, numeroDia);
        const weekDay = data.getDay();

        // isToday: v-present quando no mês atual, ou comparação de data em outros meses
        const isToday =
          isPresentClass ||
          (ano === hojeAno && mes === hojeMes && numeroDia === hojeDia);

        const batidas = [...day.querySelectorAll(".batida")]
          .filter((x) => !x.classList.contains("prevista"))
          .map((x) => x.textContent.trim());

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
                    ${this.renderRelatorios(ctx)}
                    ${CONFIG.DEBUG_NOTIF ? `${Template.divisor()}${this.renderDebugNotif(ctx)}` : ""}
                </div>
                ${Template.rodape(Hora.fmtHour(Hora.nowMin()), STATE.nextRefresh, CONFIG.VERSAO)}
            `;
    },

    renderStatus(ctx) {
      const { jornadaHoje } = ctx;
      const encerrado = jornadaHoje.estado.codigo === "ENCERRADO";
      const expandido = encerrado && STATE.statusExpandido;

      const alertaHtml = jornadaHoje.alerta
        ? Template.linha(
            "Alerta",
            `<span class="a-val neg">${jornadaHoje.alerta}</span>`,
            "danger",
          )
        : "";

      // Linha de situação: quando encerrado, vira clicável e mostra seta
      const seta = expandido ? "▾" : "▸";
      const situacaoHtml = encerrado
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

      // Detalhe expandido dos turnos
      let detalheHtml = "";
      if (expandido) {
        const { turno1, turno2 } = jornadaHoje;
        const actualExit = jornadaHoje.saidas?.actualExit;

        const linhaT1 = turno1
          ? `<div class="a-status-detalhe-linha">
                           <span>1º turno</span>
                           <span>${turno1.entrada} → ${turno1.saida ?? "--:--"}</span>
                           <span class="a-val neu" style="font-size:13px;">${Hora.fmtMin(turno1.total)}</span>
                       </div>`
          : "";

        // Intervalo
        const linhaIntervalo =
          turno1?.saida && turno2?.entrada
            ? (() => {
                const intervMin =
                  Hora.toMin(turno2.entrada) - Hora.toMin(turno1.saida);
                return `<div class="a-status-detalhe-linha a-status-detalhe-linha--intervalo">
                                    <span>Intervalo</span>
                                    <span>${turno1.saida} → ${turno2.entrada}</span>
                                    <span style="font-size:13px;color:#555880;">${Hora.fmtMin(intervMin)}</span>
                                </div>`;
              })()
            : "";

        const linhaT2 = turno2
          ? `<div class="a-status-detalhe-linha">
                           <span>2º turno</span>
                           <span>${turno2.entrada} → ${actualExit ?? turno2.saida ?? "--:--"}</span>
                           <span class="a-val neu" style="font-size:13px;">${Hora.fmtMin(turno2.total)}</span>
                       </div>`
          : "";

        detalheHtml = `
                    <div class="a-status-detalhe" id="ahg-status-detalhe">
                        ${linhaT1}
                        ${linhaIntervalo}
                        ${linhaT2}
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

        const temBatidas = d.batidas.length > 0;
        if (!temBatidas || d.isFuture) return;

        const fechado = d.batidas.length % 2 === 0; // todos os turnos têm par
        const aberto = !fechado; // último turno ainda em aberto

        // Para dias passados com turno em aberto: exibe só o que foi
        // efetivamente trabalhado (turnos fechados), sem contar o relógio atual.
        // Para hoje em aberto: usa d.trabalhado normalmente (já inclui o turno corrente via nowMin).
        let minutosExibir;
        if (aberto && !d.isToday) {
          // Soma apenas os turnos completos (pares de batidas)
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

  function notif(id, title, body, urgente = false, ttlMs = 60 * 1000) {
    const agora = Date.now();
    const ultima = STATE.notificationsFired.get(id);
    if (ultima && agora - ultima < ttlMs) return;
    STATE.notificationsFired.set(id, agora);

    const url = DOM.getBatidaUrl();
    const bodyFull = url ? `${body}\nClique para registrar o ponto.` : body;

    // 1- GM_notification direto (funciona em qualquer frame e com a aba em segundo plano)
    if (typeof GM_notification === "function") {
      GM_notification({
        title,
        text: bodyFull,
        timeout: urgente ? 0 : 8000,
        onclick: url ? () => window.open(url, "_blank", "noopener") : undefined,
      });
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
        tag: `${id}-${agora}`,
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

        domBatidas = [...elHoje.querySelectorAll(".batida")]
          .filter((x) => !x.classList.contains("prevista"))
          .map((x) => x.textContent.trim());

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
    NotifScheduler.recover(todayDateStr());
    render();

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
    const minutos = CONFIG.NOTIFICACOES[tipo] ?? [];
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
    Object.keys(CONFIG.NOTIFICACOES).forEach((tipo, idx) => {
      setTimeout(() => window.ahgTestAlertas(tipo), idx * 15000);
    });
  };

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

    let topDeadline = Date.now() + CONFIG.AUTO_REFRESH_MIN * 60 * 1000;
    Ticker.on(5000, () => {
      if (Date.now() >= topDeadline) {
        topDeadline = Infinity;
        console.log("[AHGORA PANEL] reload top");
        location.reload();
      }
    });
    Ticker.start();
    return;
  }

  /* =========================================================
       Dev helpers — exposed on window for console testing
       ahgWorkday()          — print today's persisted workday
       ahgRegisterExit(time) — manually register WORK_END e.g. "17:56"
       ahgRules()            — print rule evaluation results
       ahgNotifSchedule()    — print current notification schedule
       ahgScenarioTest()     — run end-to-end scenario assertions
    ========================================================= */

  window.ahgWorkday = function () {
    const wd = WorkdayStore.loadToday();
    console.table(wd.entries);
    console.log(
      "[ahgWorkday] status:",
      wd.status,
      "| frozen:",
      wd.entries.some((e) => e.type === "WORK_END"),
    );
    return wd;
  };

  window.ahgRegisterExit = function (time) {
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      console.error('[ahgRegisterExit] format: "HH:MM"');
      return;
    }
    const wd = WorkdayStore.registerManual("WORK_END", time);
    console.log(
      "[ahgRegisterExit] registered WORK_END:",
      time,
      "| status:",
      wd.status,
    );
    render();
  };

  window.ahgRules = function () {
    const results = STATE.ruleResults || [];
    console.table(
      results.map((r) => ({
        rule: r.rule,
        status: r.status,
        severity: r.severity,
        details: JSON.stringify(r.details),
      })),
    );
    return results;
  };

  window.ahgNotifSchedule = function () {
    const data = NotifScheduler.load();
    console.table(data.schedules);
    return data;
  };

  window.ahgScenarioTest = function () {
    console.group("[ahgScenarioTest] End-to-end scenario");

    // ── Test 1: WorkdayStore basic persistence ──
    const ts = "test-workday";
    const fakeWd = {
      schemaVersion: CONFIG.SCHEMA_VERSION,
      date: ts,
      entries: [
        {
          type: "WORK_START",
          time: "08:03",
          source: "DOM",
          createdAt: new Date().toISOString(),
        },
        {
          type: "BREAK_START",
          time: "12:01",
          source: "DOM",
          createdAt: new Date().toISOString(),
        },
        {
          type: "BREAK_END",
          time: "13:02",
          source: "DOM",
          createdAt: new Date().toISOString(),
        },
      ],
      status: "OPEN",
    };
    WorkdayStore.save(fakeWd);
    const loaded = WorkdayStore.load(ts);
    console.assert(loaded !== null, "T1: load after save");
    console.assert(loaded.entries.length === 3, "T1: entry count preserved");

    // ── Test 2: MANUAL entry not overwritten by DOM ──
    WorkdayStore.registerManual("WORK_END", "17:56");
    // Simulate DOM sync with a different exit time
    const wdAfterSync =
      WorkdayStore.load(WorkdayStore._todayStr()) || WorkdayStore.loadToday();
    // Register on today's store
    WorkdayStore.registerManual("WORK_END", "17:56");
    const wdToday = WorkdayStore.loadToday();
    const exitEntry = wdToday.entries.find((e) => e.type === "WORK_END");
    console.assert(
      exitEntry && exitEntry.source === "MANUAL",
      "T2: WORK_END is MANUAL",
    );
    console.assert(
      exitEntry && exitEntry.time === "17:56",
      "T2: WORK_END time preserved as 17:56",
    );
    console.assert(
      wdToday.status === "COMPLETED",
      "T2: status is COMPLETED after exit",
    );

    // ── Test 3: EventEngine frozen flag ──
    const { frozen } = EventEngine.resolve(wdToday, [
      "08:03",
      "12:01",
      "13:02",
      "18:00",
    ]);
    console.assert(frozen === true, "T3: frozen=true when WORK_END is actual");
    console.log("T3: frozen =", frozen, "(expect: true)");

    // ── Test 4: EventEngine MANUAL override ──
    const { effectiveBatidas } = EventEngine.resolve(wdToday, [
      "08:03",
      "12:01",
      "13:02",
      "18:00",
    ]);
    console.assert(
      effectiveBatidas[3] === "17:56",
      "T4: effectiveBatidas[3] is MANUAL 17:56, not DOM 18:00",
    );
    console.log(
      "T4: effectiveBatidas[3] =",
      effectiveBatidas[3],
      "(expect: 17:56)",
    );

    // ── Test 5: Tolerance classification ──
    const testTolerance = (saldo, expected) => {
      const withinTolerance = Math.abs(saldo) <= CONFIG.TOLERANCIA;
      const result = withinTolerance ? 0 : saldo;
      console.assert(
        result === expected,
        `T5: saldo ${saldo} → ${result} (expect ${expected})`,
      );
    };
    testTolerance(-11, -11); // outside → kept
    testTolerance(-10, 0); // boundary → zeroed
    testTolerance(-9, 0); // inside → zeroed
    testTolerance(0, 0);
    testTolerance(9, 0);
    testTolerance(10, 0); // boundary → zeroed
    testTolerance(11, 11); // outside → kept

    // ── Test 6: RuleEngine daily limit ──
    const okResult = RuleEngine.dailyLimitRule(7 * 60);
    const warnResult = RuleEngine.dailyLimitRule(9 * 60);
    const errResult = RuleEngine.dailyLimitRule(11 * 60);
    console.assert(okResult.status === "OK", "T6a: daily limit OK");
    console.assert(warnResult.status === "WARNING", "T6b: daily limit WARNING");
    console.assert(
      errResult.status === "VIOLATION",
      "T6c: daily limit VIOLATION",
    );

    // ── Test 7: RuleEngine shift limit ──
    const shiftOk = RuleEngine.shiftLimitRule(["08:00", "13:59"]); // 5h59m
    const shiftFail = RuleEngine.shiftLimitRule(["08:00", "14:01"]); // 6h01m
    console.assert(shiftOk.status === "OK", "T7a: shift OK");
    console.assert(shiftFail.status === "VIOLATION", "T7b: shift VIOLATION");

    // ── Test 8: RuleEngine break ──
    const breakOk = RuleEngine.breakRule(["08:00", "12:00", "13:00", "17:00"]); // 60m
    const breakFail = RuleEngine.breakRule([
      "08:00",
      "12:00",
      "12:20",
      "17:00",
    ]); // 20m
    console.assert(breakOk.status === "OK", "T8a: break OK");
    console.assert(breakFail.status === "VIOLATION", "T8b: break VIOLATION");

    // ── Cleanup test key ──
    localStorage.removeItem(WorkdayStore._keyFor(ts));

    console.log(
      "[ahgScenarioTest] All assertions logged above. Check for any failed ones.",
    );
    console.groupEnd();
  };
})();

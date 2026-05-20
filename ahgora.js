// ==UserScript==
// @name         Ahgora — Painel Inteligente Local v5
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Painel inteligente local para Ahgora usando apenas o DOM do calendário.
// @author       Jonathan + ChatGPT
// @match        https://mirror.app.ahgora.com.br/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       CONFIG
    ========================================================= */

    const CONFIG = {

        // Jornada
        CARGA_DIARIA: 8 * 60,

        // Limites
        MAX_HORAS_DIA: 10 * 60,
        MAX_HORAS_TURNO: 6 * 60,

        // Intervalo entre turnos
        INTERVALO_MINIMO: 30,
        INTERVALO_MAXIMO: 3 * 60,

        // Atualização
        UPDATE_INTERVAL: 1 * 1000,

        // Notificações
        NOTIFICAR_ANTES: 5,

        AUTO_REFRESH_MINUTES: 15,
        URL_REFRESH: 'https://app.ahgora.com.br/externo/mirror',
    };

    let NEXT_REFRESH = Date.now() + (CONFIG.AUTO_REFRESH_MINUTES * 60 * 1000);

    /* =========================================================
       UTILS
    ========================================================= */

    function agendarRenderMinuto() {

        const agora =
            new Date();

        const msAteProximoMinuto =
            (60 - agora.getSeconds()) * 1000
            - agora.getMilliseconds();

        setTimeout(() => {

            if (
                document.visibilityState === 'visible'
            ) {

                render();
            }

            agendarRenderMinuto();

        }, msAteProximoMinuto);
    }

    const toMin = s => {

        if (!s) return null;

        s = String(s).trim();

        const neg = s.startsWith('-');

        const [h, m] =
            s.replace(/[^0-9:]/g, '')
                .split(':')
                .map(Number);

        if (isNaN(h)) return null;

        return neg
            ? -(h * 60 + (m || 0))
            : h * 60 + (m || 0);
    };

    const fmtMin = m => {

        if (m === null || m === undefined) {
            return '--:--';
        }

        const neg = m < 0;

        const abs = Math.abs(Math.round(m));

        return `${neg ? '-' : ''}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    };

    const fmtHour = m => {

        if (m === null || m === undefined) {
            return '--:--';
        }

        const n =
            ((Math.round(m) % 1440) + 1440) % 1440;

        return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    };

    const nowMin = () => {

        const d = new Date();

        return d.getHours() * 60 + d.getMinutes();
    };

    function sameWeek(a, b) {

        const startOfWeek = d => {

            const date = new Date(d);

            const day = date.getDay();

            const diff =
                date.getDate() - day + (day === 0 ? -6 : 1);

            return new Date(date.setDate(diff));
        };

        const wa = startOfWeek(a);
        const wb = startOfWeek(b);

        return (
            wa.getFullYear() === wb.getFullYear() &&
            wa.getMonth() === wb.getMonth() &&
            wa.getDate() === wb.getDate()
        );
    }

    function getWeekNumber(date) {

        const d = new Date(
            Date.UTC(
                date.getFullYear(),
                date.getMonth(),
                date.getDate()
            )
        );

        d.setUTCDate(
            d.getUTCDate() + 4 - (d.getUTCDay() || 7)
        );

        const yearStart =
            new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    function calcularTrabalhado(batidas) {

        let total = 0;

        for (let i = 0; i < batidas.length; i += 2) {

            const entrada =
                toMin(batidas[i]);

            let saida;

            if (batidas[i + 1]) {

                saida =
                    toMin(batidas[i + 1]);

            } else {

                saida = nowMin();
            }

            total += (saida - entrada);
        }

        return total;
    }

    function fmtCountdown(ms) {

        const totalSec =
            Math.max(0, Math.floor(ms / 1000));

        const min =
            Math.floor(totalSec / 60);

        const sec =
            totalSec % 60;

        return `${min}m ${String(sec).padStart(2, '0')}s`;
    }
    /* =========================================================
       NOTIFICAÇÕES
    ========================================================= */

    const _fired = new Set();

    async function pedirNotif() {

        if (
            'Notification' in window &&
            Notification.permission === 'default'
        ) {

            await Notification
                .requestPermission()
                .catch(() => { });
        }
    }

    function notif(id, title, body, urgente = false) {

        if (
            _fired.has(id) ||
            !('Notification' in window) ||
            Notification.permission !== 'granted'
        ) return;

        _fired.add(id);

        try {

            new Notification(title, {
                body,
                requireInteraction: urgente,
                tag: id
            });

        } catch { }
    }

    function checarNotifs(resumo) {

        const now = nowMin();

        const A = CONFIG.NOTIFICAR_ANTES;

        const chk = (h, id, tit, msg, urgente) => {

            if (h === null) return;

            const f = h - now;

            if (f >= A - 1 && f <= A + 2) {

                notif(
                    `${id}-av`,
                    `⏰ ${tit}`,
                    `${msg}\nFaltam ~${A}min`,
                    urgente
                );
            }

            if (f >= -1 && f <= 1) {

                notif(
                    `${id}-ok`,
                    `✅ ${tit}`,
                    msg,
                    urgente
                );
            }
        };

        chk(
            resumo.h6,
            '6h',
            '6h atingidas',
            'Você completou o mínimo de 6h.',
            false
        );

        chk(
            resumo.h8,
            '8h',
            'Meta diária',
            'Você completou as 8h.',
            true
        );

        chk(
            resumo.h10,
            '10h',
            'Limite diário',
            '⚠ Limite diário atingido.',
            true
        );

        chk(
            resumo.saidaIdeal,
            'ideal',
            'Saída ideal',
            'Saldo semanal compensado.',
            false
        );
    }

    /* =========================================================
       EXTRAÇÃO DOM
    ========================================================= */

    function extrairDados() {

        const dias =
            [...document.querySelectorAll('.v-calendar-weekly__day')];

        const hoje = new Date();

        const resultado = [];

        dias.forEach(day => {

            if (day.classList.contains('v-outside')) {
                return;
            }

            const label =
                day.querySelector('.v-calendar-weekly__day-label');

            if (!label) return;

            const numeroDia =
                Number(label.textContent.trim());

            if (!numeroDia) return;

            const isToday =
                day.classList.contains('v-present');

            const isFuture =
                day.classList.contains('v-future');

            const isHoliday =
                [...day.querySelectorAll('.material-icons')]
                    .some(x =>
                        x.textContent.trim() === 'star'
                    );

            const data =
                new Date(
                    hoje.getFullYear(),
                    hoje.getMonth(),
                    numeroDia
                );

            const weekDay =
                data.getDay();

            const batidas =
                [...day.querySelectorAll('.batida')]
                    .filter(x =>
                        !x.classList.contains('prevista')
                    )
                    .map(x =>
                        x.textContent.trim()
                    );

            const possuiBatidas = batidas.length > 0;

            const isBusinessDay =
                (
                    weekDay !== 0 &&
                    weekDay !== 6 &&
                    !isHoliday
                )
                || possuiBatidas;

            const trabalhado =
                batidas.length > 0
                    ? calcularTrabalhado(batidas)
                    : 0;

            const saldo =
                isBusinessDay
                    ? trabalhado - CONFIG.CARGA_DIARIA
                    : 0;

            resultado.push({
                data,
                isToday,
                isFuture,
                isHoliday,
                isBusinessDay,
                batidas,
                trabalhado,
                saldo
            });
        });

        return resultado;
    }

    /* =========================================================
       RESUMO
    ========================================================= */

    function calcularResumo() {

        const dias =
            extrairDados();

        const hoje =
            dias.find(x => x.isToday);

        if (!hoje) {
            return null;
        }

        const saldoSemana = dias.filter(x =>
            sameWeek(x.data, new Date()) &&
            !x.isFuture &&
            !x.isToday &&
            x.isBusinessDay
        )
            .reduce((a, b) => a + b.saldo, 0);

        const saldoMes =
            dias
                .filter(x =>
                    x.data.getMonth() === new Date().getMonth() &&
                    !x.isFuture &&
                    x.isBusinessDay
                )
                .reduce((a, b) => a + b.saldo, 0);

        const totalMes = dias.filter(x =>
            x.data.getMonth() === new Date().getMonth() &&
            !x.isFuture &&
            x.isBusinessDay
        )
            .reduce((a, b) => a + b.trabalhado, 0);

        const diasRestantesMes =
            dias.filter(x =>
                x.isFuture &&
                x.isBusinessDay
            ).length;

        const diasRegistrados =
            dias.filter(x =>
                x.batidas.length > 0 &&
                !x.isFuture
            ).length;

        const entrada =
            hoje.batidas[0]
                ? toMin(hoje.batidas[0])
                : null;

        const ultimaBatida =
            hoje.batidas.length >= 4
                ? toMin(hoje.batidas[3])
                : null;

        const retorno11h =
            ultimaBatida !== null
                ? ultimaBatida + (11 * 60)
                : null;

        let h6 = null;
        let h8 = null;
        let h10 = null;

        if (hoje.batidas.length >= 3) {

            // SEGUNDO TURNO

            const inicioTurno2 =
                toMin(hoje.batidas[2]);

            h6 =
                inicioTurno2 +
                CONFIG.MAX_HORAS_TURNO;

        } else if (hoje.batidas.length >= 1) {

            // PRIMEIRO TURNO

            const inicioTurno1 =
                toMin(hoje.batidas[0]);

            h6 =
                inicioTurno1 +
                CONFIG.MAX_HORAS_TURNO;
        }

        if (hoje.batidas.length >= 2) {

            const entrada1 =
                toMin(hoje.batidas[0]);

            const saida1 =
                toMin(hoje.batidas[1]);

            const trabalhadoTurno1 =
                saida1 - entrada1;

            const inicioTurno2 =
                hoje.batidas[2]
                    ? toMin(hoje.batidas[2])
                    : nowMin();

            h8 =
                inicioTurno2 +
                (CONFIG.CARGA_DIARIA - trabalhadoTurno1);

            h10 =
                inicioTurno2 +
                (CONFIG.MAX_HORAS_DIA - trabalhadoTurno1);

        } else if (entrada !== null) {

            h8 =
                entrada + CONFIG.CARGA_DIARIA;

            h10 =
                entrada + CONFIG.MAX_HORAS_DIA;
        }

        const saidaIdeal =
            h8 !== null
                ? h8 - saldoSemana
                : null;

        let turno1 = null;
        let turno2 = null;

        /* =====================================================
           PRIMEIRO TURNO
        ===================================================== */

        if (hoje.batidas.length >= 1) {

            const e1 =
                toMin(hoje.batidas[0]);

            const s1 =
                hoje.batidas[1]
                    ? toMin(hoje.batidas[1])
                    : nowMin();

            turno1 = {

                entrada: hoje.batidas[0],

                saida: hoje.batidas[1] || 'agora',

                aberto: !hoje.batidas[1],

                total: s1 - e1,

                limite: CONFIG.MAX_HORAS_TURNO,

                classe:
                    (
                        (s1 - e1) >= CONFIG.MAX_HORAS_TURNO ||
                        hoje.trabalhado >= CONFIG.MAX_HORAS_DIA
                    )
                        ? 'danger'
                        : (
                            (s1 - e1) >= (CONFIG.MAX_HORAS_TURNO - 30) ||
                            hoje.trabalhado >= (CONFIG.MAX_HORAS_DIA - 30)
                        )
                            ? 'warn'
                            : 'infos',
            };
        }

        /* =====================================================
           SEGUNDO TURNO
        ===================================================== */

        if (hoje.batidas.length >= 3) {

            const e2 =
                toMin(hoje.batidas[2]);

            const s2 =
                hoje.batidas[3]
                    ? toMin(hoje.batidas[3])
                    : nowMin();

            turno2 = {

                entrada: hoje.batidas[2],

                saida: hoje.batidas[3] || 'agora',

                aberto: !hoje.batidas[3],

                total: s2 - e2,

                limite: CONFIG.MAX_HORAS_TURNO,

                classe:
                    (
                        (s2 - e2) >= CONFIG.MAX_HORAS_TURNO ||
                        hoje.trabalhado >= CONFIG.MAX_HORAS_DIA
                    )
                        ? 'danger'

                        : (
                            (s2 - e2) >= (CONFIG.MAX_HORAS_TURNO - 30) ||
                            hoje.trabalhado >= (CONFIG.MAX_HORAS_DIA - 30)
                        )
                            ? 'warn'
                            : 'infos',
            };
        }

        const status =
            (() => {

                const qtd =
                    hoje.batidas.length;

                if (qtd === 0) {
                    return '🛬 Não iniciado';
                }

                if (qtd === 1) {
                    return '🥇 Primeiro turno';
                }

                if (qtd === 2) {
                    return '⏸ Intervalo';
                }

                if (qtd === 3) {
                    return '🥈 Segundo turno';
                }

                if (qtd >= 4) {
                    return '🛫 Encerrado';
                }

                return '--';
            })();

        let retornoMinimo = null;
        let retornoMaximo = null;

        if (hoje.batidas.length === 2) {

            const saida1 =
                toMin(hoje.batidas[1]);

            retornoMinimo =
                saida1 + CONFIG.INTERVALO_MINIMO;

            retornoMaximo =
                saida1 + CONFIG.INTERVALO_MAXIMO;
        }

        let alerta = null;

        if (hoje.batidas.length >= 2) {

            const entrada1 =
                toMin(hoje.batidas[0]);

            const saida1 =
                toMin(hoje.batidas[1]);

            const turno1 =
                saida1 - entrada1;

            if (turno1 > CONFIG.MAX_HORAS_TURNO) {

                alerta =
                    '⚠️ Primeiro turno excedeu 6h';
            }
        }

        if (hoje.trabalhado > CONFIG.MAX_HORAS_DIA) {

            alerta =
                '⚠️ Limite diário excedido';
        }

        const trabalhado = dias.trabalhado

        return {
            hoje,
            saldoSemana,
            saldoMes,
            totalMes,
            dias,
            diasRestantesMes,
            diasRegistrados,
            entrada,
            turno1,
            turno2,
            retorno11h,
            h6,
            h8,
            h10,
            saidaIdeal,
            status,
            retornoMinimo,
            retornoMaximo,
            trabalhado,
            alerta
        };
    }

    /* =========================================================
       CSS
    ========================================================= */

    function injectCSS() {

        if (document.getElementById('ahg-css-v5')) {
            return;
        }

        const style =
            document.createElement('style');

        style.id = 'ahg-css-v5';

        style.textContent = `
        #ahg-fab{
            position:fixed;
            bottom:20px;
            right:20px;
            left: auto;
            z-index:99999;
            width:48px;
            height:48px;
            border-radius:50%;
            background:linear-gradient(135deg,#3b2d82,#1e1b4b);
            border:2px solid #4a3faf;
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:22px;
            cursor:pointer;
            color:white;
        }

        #ahg-panel{
            position:fixed;
            bottom:20px;
            right:20px;
            left: auto;
            z-index:99999;
            background:#0f0f1e;
            border:1px solid #252545;
            border-radius:14px;
            min-width:260px;
            max-width:290px;
            font-family:'Segoe UI',sans-serif;
            color:#dde;
            box-shadow:0 8px 40px rgba(0,0,0,.7);
            max-height: calc(100vh - 40px);
            overflow: hidden;
            display:flex;
            flex-direction:column;
        }

        .a-tit{
            background:linear-gradient(135deg,#3b2d82,#1e1b4b);
            color:#b9a9ff;
            font-weight:700;
            font-size:11px;
            letter-spacing:1.4px;
            text-transform:uppercase;
            padding:10px 14px 8px;
            border-radius:14px 14px 0 0;
            display:flex;
            align-items:center;
            gap:6px;
            cursor:grab;
        }

        .a-x{
            margin-left:auto;
            cursor:pointer;
            opacity:.6;
            font-size:18px;
        }

        .a-body{
            padding:10px 12px 12px;
            display:flex;
            flex-direction:column;
            gap:5px;
            overflow-y:auto;
            overflow-x:hidden;
            flex:1;
        }

        .a-row{
            display:flex;
            justify-content:space-between;
            align-items:center;
            padding:5px 8px;
            border-radius:7px;
            background:rgba(255,255,255,.04);
            border-left:3px solid transparent;
        }

        .a-row.ok{
            background:rgba(61,220,132,.1);
            border-color:#3ddc84;
        }

        .a-row.warn{
            background:rgba(255,165,0,.12);
            border-color:orange;
        }

        .a-row.danger{
            background:rgba(255,60,60,.14);
            border-color:#ff4444;
        }

        .a-row.infos{
            background:rgba(100,100,255,.1);
            border-color:#7878ff;
        }

        .a-lbl{
            color:#7880aa;
            font-size:11.5px;
        }

        .a-val{
            font-weight:700;
            font-size:14px;
            text-align:right;
        }

        .a-val.pos{color:#3ddc84;}
        .a-val.neg{color:#ff6b6b;}
        .a-val.warn{color:orange;}
        .a-val.neu{color:#b9a9ff;}

        .a-val small{
            font-size:11px;
            font-weight:800;
            color:#555880;
            display:block;
        }

        .a-div{
            border:none;
            border-top:1px solid rgba(255,255,255,.07);
            margin:3px 0;
        }

        .a-sec{
            font-size:10px;
            letter-spacing:1px;
            text-transform:uppercase;
            color:#444466;
            padding:3px 0 1px;
            font-weight:700;
        }

        .a-foot{
            font-size:10px;
            font-weight:800;
            color:#333355;
            text-align:right;
            padding:2px 14px 8px;
        }

        .a-row.clickable{
            cursor:pointer;
            transition:.15s;
        }

        .a-row.clickable:hover{
            transform:translateX(2px);
            background:rgba(255,255,255,.08);
        }

        .a-body::-webkit-scrollbar,
        #ahg-details *::-webkit-scrollbar{
            width:8px;
            height:8px;
        }

        .a-body::-webkit-scrollbar-thumb,
        #ahg-details *::-webkit-scrollbar-thumb{
            background:#444466;
            border-radius:10px;
        }

        .a-body::-webkit-scrollbar-track,
        #ahg-details *::-webkit-scrollbar-track{
            background:transparent;
        }
        `;

        document.head.appendChild(style);
    }

    /* =========================================================
       ESTRUTURA
    ========================================================= */

    function criarEstrutura() {

        if (document.getElementById('ahg-panel')) {
            return;
        }

        const fab =
            document.createElement('div');

        fab.id = 'ahg-fab';

        fab.innerHTML = '⏱';

        fab.onclick = () => {

            document.getElementById('ahg-panel')
                .style.display = '';

            fab.style.display = 'none';
        };

        document.body.appendChild(fab);

        const panel =
            document.createElement('div');

        panel.id = 'ahg-panel';

        panel.style.display = 'none';

        panel.innerHTML =
            `<div class="a-tit">⏱ Carregando...</div>`;

        document.body.appendChild(panel);

        let drag = false;
        let ox = 0;
        let oy = 0;

        panel.addEventListener('mousedown', e => {

            if (!e.target.closest('.a-tit')) {
                return;
            }

            drag = true;

            const r =
                panel.getBoundingClientRect();

            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
        });

        document.addEventListener('mousemove', e => {

            if (!drag) return;

            panel.style.left =
                `${e.clientX - ox}px`;

            panel.style.top =
                `${e.clientY - oy}px`;

            panel.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            drag = false;
        });
    }

    /* =========================================================
       RENDER
    ========================================================= */

    function render() {

        try {

            const r =
                calcularResumo();

            if (!r) {
                return;
            }

            checarNotifs(r);

            const p =
                document.getElementById('ahg-panel');

            if (!p) {
                return;
            }

            p.innerHTML = `
            <div class="a-tit">
                ⏱ Painel Inteligente
                <span class="a-x" id="ahg-min">–</span>
            </div>

            <div class="a-body">

                <div class="a-sec">
                    Status atual
                </div>

                <div class="a-row infos">
                    <span class="a-lbl">
                        Situação
                    </span>

                    <span class="a-val neu">
                        ${r.status}
                    </span>
                </div>

                ${r.alerta ? `
                <div class="a-row danger">
                    <span class="a-lbl">
                        Alerta
                    </span>

                    <span class="a-val neg">
                        ${r.alerta}
                    </span>
                </div>
                ` : ''}

                <hr class="a-div">

                <div class="a-sec">
                    Hoje
                </div>

                ${r.turno1 ? `
                <div class="a-row ${r.turno1.classe}">

                    <span class="a-lbl">
                        1º turno
                    </span>

                    <span class="a-val neu">

                        ${r.turno1.entrada}
                        →
                        ${r.turno1.saida}

                        <small>
                            ${fmtMin(r.turno1.total)}
                            ${r.turno1.aberto ? '· em andamento' : ''}
                        </small>

                    </span>

                </div>
                ` : ''}

                ${r.turno2 ? `
                <div class="a-row ${r.turno2.classe}">

                    <span class="a-lbl">
                        2º turno
                    </span>

                    <span class="a-val neu">

                        ${r.turno2.entrada}
                        →
                        ${r.turno2.saida}

                        <small>
                            ${fmtMin(r.turno2.total)}
                            ${r.turno2.aberto ? '· em andamento' : ''}
                        </small>

                    </span>

                </div>
                ` : ''}

                <div class="a-row infos">
                    <span class="a-lbl">
                        Trabalhado
                    </span>

                    <span class="a-val ${r.hoje.saldo >= 0 ? 'pos' : 'warn'}">
                        ${fmtMin(r.hoje.trabalhado)}
                    </span>
                </div>

                <div class="a-row infos">
                    <span class="a-lbl">
                        Saldo do dia
                    </span>

                    <span class="a-val ${r.hoje.saldo >= 0 ? 'pos' : 'neg'}">
                        ${fmtMin(r.hoje.saldo)}
                    </span>
                </div>

                <hr class="a-div">

                <div class="a-sec">
                    Saídas
                </div>

                <div class="a-row warn" >
                    <span class="a-lbl">
                        ⚠️ 6h
                    </span>

                    <span class="a-val warn">
                        ${fmtHour(r.h6)}
                    </span>
                </div>

                <div class="a-row ok">
                    <span class="a-lbl">
                        ✅ 8h
                    </span>

                    <span class="a-val pos">
                        ${fmtHour(r.h8)}
                    </span>
                </div>

                <div class="a-row danger">
                    <span class="a-lbl">
                      ⛔️ 10h
                    </span>

                    <span class="a-val neg">
                        ${fmtHour(r.h10)}
                    </span>
                </div>

                <div class="a-row infos">
                    <span class="a-lbl">
                        🏆 Saída ideal
                    </span>

                    <span class="a-val neu">
                        ${fmtHour(r.saidaIdeal)}
                    </span>
                </div>

                ${r.retornoMinimo ? `
                <hr class="a-div">

                <div class="a-sec">
                    Intervalo
                </div>

                <div class="a-row infos">
                    <span class="a-lbl">
                        ⏳ Retorno mínimo
                    </span>

                    <span class="a-val neu">
                        ${fmtHour(r.retornoMinimo)}
                    </span>
                </div>

                <div class="a-row warn">
                    <span class="a-lbl">
                        ⚠️ Retorno máximo
                    </span>

                    <span class="a-val warn">
                        ${fmtHour(r.retornoMaximo)}
                    </span>
                </div>
                ` : ''}

                <div class="a-row infos">
                    <span class="a-lbl">
                        🛌 Retorne depois das
                    </span>

                    <span class="a-val neu">
                        ${fmtHour(r.retorno11h)}
                    </span>
                </div>

                <hr class="a-div">

                <div class="a-sec">
                    Semanal — sem. ${getWeekNumber(new Date())}
                </div>

                <div class="a-row ${r.saldoSemana >= 0 ? 'ok' : 'warn'}">
                    <span class="a-lbl">
                        Saldo semanal
                    </span>

                    <span class="a-val ${r.saldoSemana >= 0 ? 'pos' : 'neg'}">
                        ${fmtMin(r.saldoSemana)}

                        <small>
                            ${r.diasRegistrados} dias registrados
                        </small>
                    </span>
                </div>

                <hr class="a-div">

                <div class="a-sec">
                    Mensal
                </div>

                <div class="a-row ${r.saldoMes >= 0 ? 'ok' : 'warn'}">
                    <span class="a-lbl">
                        Saldo mensal
                    </span>

                    <span class="a-val ${r.saldoMes >= 0 ? 'pos' : 'neg'}">
                        ${fmtMin(r.saldoMes)}

                        <small>
                            ${r.diasRestantesMes} úteis restantes
                        </small>
                    </span>
                </div>
                <div class="a-row infos clickable" id="ahg-open-details">
                        <span class="a-lbl">
                            📊 Horas realizadas
                        </span>

                        <span class="a-val neu">
                            ${fmtMin(r.totalMes)}
                        </span>
                    </div>

            </div>

            <div class="a-foot">
                Atualizado ${fmtHour(nowMin())}
    ·
    Reload em ${fmtCountdown(
                NEXT_REFRESH - Date.now()
            )}
            </div>
            `;

            document.getElementById('ahg-min')
                ?.addEventListener('click', () => {

                    p.style.display = 'none';

                    document
                        .getElementById('ahg-fab')
                        .style.display = 'flex';
                });
            document.getElementById('ahg-open-details')?.addEventListener('click', () => {
                abrirDetalhes(r);
            });

        } catch (e) {

            console.error(
                '[AHGORA PANEL]',
                e
            );
        }
    }

    function abrirDetalhes(r) {

        const antigo =
            document.getElementById('ahg-details');

        if (antigo) {
            antigo.remove();
        }

        const modal =
            document.createElement('div');

        modal.id = 'ahg-details';

        modal.style = `
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.7);
        z-index:999999;
        display:flex;
        align-items:center;
        justify-content:center;
    `;

        const box =
            document.createElement('div');

        box.style = `
            width:min(900px,95vw);
            max-height:90vh;

            overflow-y:auto;
            overflow-x:auto;

            background:#111827;

            border-radius:14px;

            padding:20px;

            color:#dde;

            font-family:Segoe UI,sans-serif;
`;

        const diasSemana = [
            'Dom',
            'Seg',
            'Ter',
            'Qua',
            'Qui',
            'Sex',
            'Sáb'
        ];

        let html = `
        <div style="
            display:flex;
            justify-content:space-between;
            align-items:center;
            margin-bottom:16px;
        ">
            <h2 style="margin:0;">
                📊 Detalhamento Mensal
            </h2>

            <button id="ahg-close-details">
                Fechar
            </button>
        </div>
    `;

        let semanaAtual = null;
        let totalSemana = 0;
        let saldoSemana = 0;

        r.dias
            .filter(x =>
                !x.isFuture &&
                x.isBusinessDay
            )
            .sort((a, b) => a.data - b.data)
            .forEach((d, idx, arr) => {

                const semana =
                    getWeekNumber(d.data);

                if (
                    semanaAtual !== null &&
                    semana !== semanaAtual
                ) {

                    /* html += `
                         <tr style="
                             background:#1f2937;
                             font-weight:bold;
                         ">
                             <td colspan="2">
                                 TOTAL SEMANA
                             </td>
                             <td>
                                 ${fmtMin(totalSemana)}
                             </td>
                             <td>
                                 ${fmtMin(saldoSemana)}
                             </td>
                         </tr>
                         <tr>
                             <td colspan="4" style="height:18px"></td>
                         </tr>
                     `; */

                    totalSemana = 0;
                    saldoSemana = 0;
                }

                if (semana !== semanaAtual) {

                    html += `
                    <h3>
                        Semana ${semana}
                    </h3>

                    <table style="
                        width:100%;
                        border-collapse:collapse;
                        margin-bottom:12px;
                    ">
                        <thead>
                            <tr>
                                <th style="text-align:left;padding:6px 4px;">
                                    Dia
                                </th>

                                <th style="text-align:left;padding:6px 4px;">
                                    Data
                                </th>

                                <th style="text-align:right;padding:6px 4px;">
                                    Horas
                                </th>

                                <th style="text-align:right;padding:6px 4px;">
                                    Saldo
                                </th>
                            </tr>
                        </thead>

                        <tbody>
                `;

                    semanaAtual = semana;
                }

                totalSemana += d.trabalhado;
                saldoSemana += d.saldo;

                html += `
                <tr>
                    <td>
                        ${diasSemana[d.data.getDay()]}
                    </td>

                    <td>
                        ${d.data.toLocaleDateString('pt-BR')}
                    </td>

                    <td align="right">
                        ${fmtMin(d.trabalhado)}
                    </td>

                    <td align="right">
                        ${fmtMin(d.saldo)}
                    </td>
                </tr>
            `;

                const next = arr[idx + 1];

                if (
                    !next ||
                    getWeekNumber(next.data) !== semana
                ) {

                    html += `
                    <tr style="
                        background:#1f2937;
                        font-weight:bold;
                    ">
                        <td colspan="2">
                            TOTAL SEMANA
                        </td>

                        <td align="right">
                            ${fmtMin(totalSemana)}
                        </td>

                        <td align="right">
                            ${fmtMin(saldoSemana)}
                        </td>
                    </tr>

                    </tbody>
                    </table>
                `;
                }
            });

        box.innerHTML = html;

        modal.appendChild(box);

        document.body.appendChild(modal);

        document
            .getElementById('ahg-close-details')
            .onclick = () => modal.remove();

        modal.onclick = e => {

            if (e.target === modal) {
                modal.remove();
            }
        };
    }

    /* =========================================================
       INIT
    ========================================================= */

    function start() {

        injectCSS();

        criarEstrutura();

        render();

        agendarRenderMinuto();

        setTimeout(() => {
            console.log('[AHGORA PANEL] recarregando página...');
            console.log(CONFIG.URL_REFRESH);
            window.top.location = CONFIG.URL_REFRESH;
        }, CONFIG.AUTO_REFRESH_MINUTES * 60 * 1000);
    }

    /* =========================================================
       WAIT CALENDAR
    ========================================================= */

    const initInterval = setInterval(() => {

        const calendar =
            document.querySelector('.v-calendar-weekly');

        if (calendar) {

            clearInterval(initInterval);

            start();
        }

    }, 1000);

    pedirNotif();

})();

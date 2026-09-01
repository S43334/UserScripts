// ==UserScript==
// @name         WhatsApp Web: Chats compacto
// @namespace    userscripts
// @version      2.0.12
// @description  Convierte la lista de Chats en una columna de avatares y la alterna desde el botón nativo Chats.
// @author       userscripts
// @match        https://web.whatsapp.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    "use strict";

    const VERSION = "2.0.12";
    const COMPACT_WIDTH = 72;
    const COMPACT_ROW_HEIGHT = 52;
    const SETTLE_MS = 800;
    const MAX_WAIT_MS = 10000;

    const STORAGE_KEY = "wa-compact-chat-list-compact";
    const LEGACY_STORAGE_KEY = "wa-compact-chat-list-hidden";
    const STYLE_ID = "wa-compact-chat-list-style";
    const HOST_ATTRIBUTE = "data-wa-compact-chat-list-host";
    const TOP_ATTRIBUTE = "data-wa-compact-chat-list-top";
    const ARCHIVE_ATTRIBUTE = "data-wa-compact-chat-list-archive";
    const AVATAR_ATTRIBUTE = "data-wa-compact-chat-avatar";
    const COMPACT_HIDDEN_ATTRIBUTE = "data-wa-compact-hidden";
    const HOST_COMPACT_CLASS = "wa-compact-chat-list-compact";
    const BODY_COMPACT_CLASS = "wa-compact-chats-compact";

    let compactPreference = readCompactPreference();
    let chatListHost = null;
    let chatsTabControl = null;
    let chatsTabActive = false;
    let tabStateKnown = false;
    let syncTimer = null;

    function readCompactPreference() {
        try {
            const currentValue = localStorage.getItem(STORAGE_KEY);
            if (currentValue !== null) {
                return currentValue === "true";
            }

            // Conserva la preferencia del userscript anterior: "oculto" se
            // convierte en "compacto" al actualizarlo.
            return localStorage.getItem(LEGACY_STORAGE_KEY) === "true";
        } catch (_) {
            return false;
        }
    }

    function saveCompactPreference() {
        try {
            localStorage.setItem(STORAGE_KEY, String(compactPreference));
        } catch (_) {
            // El modo actual seguirá funcionando aunque el navegador bloquee storage.
        }
    }

    function getSidePanel() {
        return document.querySelector("#side") || document.querySelector("#pane-side");
    }

    function findChatListHost() {
        const sidePanel = getSidePanel();
        if (!sidePanel) return null;

        // El padre directo es el elemento flex que reserva el ancho de la lista.
        return sidePanel.parentElement || sidePanel;
    }

    function isRendered(element) {
        return Boolean(element && element.isConnected && element.getClientRects().length);
    }

    function getTextAttribute(element, name) {
        return (element?.getAttribute(name) || "").trim();
    }

    function isChatControlCandidate(element) {
        if (!element || !(element instanceof Element)) return false;
        if (element.matches("input, textarea, [contenteditable=\"true\"]")) {
            return false;
        }

        // Las filas y controles internos del listado no deben confundirse con
        // el botón Chats de la barra vertical. En algunas versiones la barra
        // vertical vive dentro de #side, por eso no se excluye #side completo.
        if (element.closest("#pane-side")) {
            return false;
        }

        const testId = getTextAttribute(element, "data-testid").toLowerCase();
        const dataTab = getTextAttribute(element, "data-tab");
        const labels = [
            getTextAttribute(element, "aria-label"),
            getTextAttribute(element, "title"),
        ]
            .filter(Boolean)
            .map((value) => value.toLowerCase());

        if (
            testId.includes("chat-list-tab") ||
            testId === "chat-tab" ||
            testId.includes("chats-tab")
        ) {
            return true;
        }

        if (dataTab === "2" && element.matches("button, a, [role=\"button\"], [role=\"tab\"]")) {
            return true;
        }

        if (
            labels.some((label) =>
                /^(chats?|chat|conversaciones|lista de chats?)(?:\s|,|$)/.test(label),
            )
        ) {
            return true;
        }

        const chatIcon = element.querySelector('[data-icon="chat"], [data-icon="chats"]');
        return Boolean(chatIcon && element.closest("header, nav"));
    }

    function findChatsTabControl() {
        const selector = [
            "button",
            "a",
            '[role="button"]',
            '[role="tab"]',
            '[data-testid*="chat"]',
            '[data-tab="2"]',
        ].join(",");

        for (const element of document.querySelectorAll(selector)) {
            if (isChatControlCandidate(element)) {
                return element;
            }
        }

        return null;
    }

    function getControlState(element) {
        if (!element) return null;

        const candidates = [
            element,
            element.closest("[role=\"tab\"]"),
            element.closest("[aria-selected]"),
            element.closest("[aria-current]"),
        ].filter(Boolean);

        for (const candidate of candidates) {
            const ariaSelected = getTextAttribute(candidate, "aria-selected").toLowerCase();
            const ariaCurrent = getTextAttribute(candidate, "aria-current").toLowerCase();
            const dataActive = [
                getTextAttribute(candidate, "data-active"),
                getTextAttribute(candidate, "data-selected"),
                getTextAttribute(candidate, "data-state"),
            ]
                .join(" ")
                .toLowerCase();

            if (
                ariaSelected === "true" ||
                ariaCurrent === "true" ||
                ariaCurrent === "page" ||
                /^(active|selected|on)$/.test(dataActive)
            ) {
                return true;
            }

            if (
                ariaSelected === "false" ||
                ariaCurrent === "false" ||
                /^(inactive|unselected|off)$/.test(dataActive)
            ) {
                return false;
            }
        }

        for (const candidate of candidates) {
            const className = typeof candidate.className === "string"
                ? candidate.className.toLowerCase()
                : "";

            if (/(^|[ _-])(active|selected|current)([ _-]|$)/.test(className)) {
                return true;
            }

            if (/(^|[ _-])(inactive|unselected)([ _-]|$)/.test(className)) {
                return false;
            }
        }

        return null;
    }

    function detectChatsTabState(control = chatsTabControl) {
        const explicitState = getControlState(control);
        if (explicitState !== null) {
            return explicitState;
        }

        // Fallback para despliegues que no exponen aria-selected: si la lista
        // de chats está pintada, Chats es la pestaña activa.
        const chatList = document.querySelector(
            '[data-testid="chat-list"], #side [data-testid="cell-frame-container"], #pane-side [data-testid="cell-frame-container"]',
        );
        return isRendered(chatList) ? true : null;
    }

    function isChatsTabActive(control = chatsTabControl) {
        return detectChatsTabState(control) === true;
    }

    function findChatsControlFromTarget(target) {
        if (!(target instanceof Element)) return null;

        let element = target;
        while (element && element !== document.documentElement) {
            if (isChatControlCandidate(element)) {
                return element;
            }
            element = element.parentElement;
        }

        return null;
    }

    function findNavigationControlFromTarget(target) {
        if (!(target instanceof Element)) return null;

        const control = target.closest("button, a, [role=\"button\"], [role=\"tab\"], [tabindex]");
        if (!control || control.matches("input, textarea, [contenteditable=\"true\"]")) {
            return null;
        }

        // No contamos botones del chat ni de la lista.
        if (control.closest("#main, #pane-side")) {
            return null;
        }

        const navigationParent = control.closest("nav, [role=\"navigation\"], header");
        if (!navigationParent) return null;

        // Si #side contiene tanto la barra vertical como el listado, solo
        // aceptamos controles de la barra, no botones del encabezado de Chats.
        if (
            chatListHost &&
            chatListHost.contains(control) &&
            !control.closest("nav, [role=\"navigation\"]")
        ) {
            return null;
        }

        const testId = getTextAttribute(control, "data-testid").toLowerCase();
        const hasIcon = Boolean(
            control.matches("[data-icon]") ||
            control.querySelector("[data-icon]") ||
            control.getAttribute("aria-label") ||
            control.getAttribute("title"),
        );

        return testId.includes("tab") || hasIcon ? control : null;
    }

    function ensureStyle() {
        let style = document.getElementById(STYLE_ID);
        if (style?.dataset.version === VERSION) {
            return style;
        }

        // Permite actualizar el userscript sin que quede el CSS del botón
        // flotante de la versión anterior en una pestaña ya abierta.
        style?.remove();

        style = document.createElement("style");
        style.id = STYLE_ID;
        style.dataset.version = VERSION;
        style.textContent = `
            [${HOST_ATTRIBUTE}] {
                position: relative !important;
                transition:
                    flex-basis .28s ease,
                    width .28s ease,
                    min-width .28s ease,
                    max-width .28s ease !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] {
                flex: 0 0 ${COMPACT_WIDTH}px !important;
                width: ${COMPACT_WIDTH}px !important;
                min-width: ${COMPACT_WIDTH}px !important;
                max-width: ${COMPACT_WIDTH}px !important;
                padding: 0 !important;
                border-inline-end: 0 !important;
                overflow: hidden !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] #side,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] #pane-side {
                width: ${COMPACT_WIDTH}px !important;
                min-width: ${COMPACT_WIDTH}px !important;
                max-width: ${COMPACT_WIDTH}px !important;
                padding-inline: 0 !important;
                overflow-x: hidden !important;
            }

            /* Encabezado, búsqueda, filtros y archivados: solo se ocultan en
               el panel de Chats compacto, nunca en la barra vertical. */
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [${TOP_ATTRIBUTE}],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [${ARCHIVE_ATTRIBUTE}],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid="chatlist-header"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] header[data-testid="chatlist-header"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid="chat-list-search-container"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid="chat-list-search"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [aria-label="chat-list-filters"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid="panel-header-search"] {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] #side > header,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] #pane-side > header {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [aria-label*="archiv" i],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [title*="archiv" i],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid*="archiv" i],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] [data-testid*="archive" i] {
                display: none !important;
            }

            /* Cada conversación conserva su elemento original para que sigan
               funcionando el clic, el scroll virtual y la selección. */
                body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"],
                body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"] {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                width: ${COMPACT_WIDTH}px !important;
                min-width: ${COMPACT_WIDTH}px !important;
                max-width: ${COMPACT_WIDTH}px !important;
                height: ${COMPACT_ROW_HEIGHT}px !important;
                min-height: ${COMPACT_ROW_HEIGHT}px !important;
                max-height: ${COMPACT_ROW_HEIGHT}px !important;
                margin: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="listitem"]:has([data-testid="cell-frame-container"]) {
                box-sizing: border-box !important;
                width: ${COMPACT_WIDTH}px !important;
                min-width: ${COMPACT_WIDTH}px !important;
                max-width: ${COMPACT_WIDTH}px !important;
                height: ${COMPACT_ROW_HEIGHT}px !important;
                min-height: ${COMPACT_ROW_HEIGHT}px !important;
                max-height: ${COMPACT_ROW_HEIGHT}px !important;
                padding: 0 !important;
                overflow: hidden !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="listitem"]:has([data-testid="cell-frame-container"]) > *:not(:has([data-testid="cell-frame-container"])),
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"]:has([data-testid="cell-frame-container"]) > *:not(:has([data-testid="cell-frame-container"])) {
                display: none !important;
            }

            /* En algunas versiones hay un envoltorio adicional alrededor de
               cada fila. También debe perder su altura original para que no
               queden huecos entre avatares. */
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) div:has(> [data-testid="cell-frame-container"]) {
                box-sizing: border-box !important;
                width: ${COMPACT_WIDTH}px !important;
                min-width: ${COMPACT_WIDTH}px !important;
                max-width: ${COMPACT_WIDTH}px !important;
                height: ${COMPACT_ROW_HEIGHT}px !important;
                min-height: ${COMPACT_ROW_HEIGHT}px !important;
                max-height: ${COMPACT_ROW_HEIGHT}px !important;
                margin: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"] > *:not(:has(
                img,
                svg,
                [role="img"],
                [data-testid*="default-" i],
                [data-testid*="avatar" i],
                [data-icon="default-user"],
                [data-icon="default-group"],
                [style*="background-image"]
            )),
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"] > *:not(:has(
                img,
                svg,
                [role="img"],
                [data-testid*="default-" i],
                [data-testid*="avatar" i],
                [data-icon="default-user"],
                [data-icon="default-group"],
                [style*="background-image"]
            )) {
                display: none !important;
            }

            /* Si WhatsApp cambia la estructura interna de una fila, el
               marcador generado por el script deja únicamente el contenedor
               que contiene el avatar y elimina cualquier hermano de texto. */
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"] > *:not([${AVATAR_ATTRIBUTE}]),
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"]:not(:has([data-testid="cell-frame-container"])) > *:not([${AVATAR_ATTRIBUTE}]) {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"] > *:not([${AVATAR_ATTRIBUTE}]):not(:has([${AVATAR_ATTRIBUTE}])),
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"]:not(:has([data-testid="cell-frame-container"])) > *:not([${AVATAR_ATTRIBUTE}]):not(:has([${AVATAR_ATTRIBUTE}])) {
                display: none !important;
            }

            /* Estructura actual de WhatsApp: el primer hijo es el avatar y
               el siguiente contiene el nombre, mensaje, hora y estados. */
            body.${BODY_COMPACT_CLASS} [data-testid="cell-frame-container"] > [${AVATAR_ATTRIBUTE}] ~ *,
            body.${BODY_COMPACT_CLASS} [data-testid="cell-frame-container"] > *:not([${AVATAR_ATTRIBUTE}]) {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] [dir],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] [title],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] time,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] span:not(:has(img, svg, [role="img"], [data-testid*="default-" i], [style*="background-image"])) {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] {
                font-size: 0 !important;
                line-height: 0 !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [${AVATAR_ATTRIBUTE}] > *:not(:has(
                img,
                svg,
                [role="img"],
                [data-testid*="default-" i],
                [data-testid*="avatar" i],
                [data-icon="default-user"],
                [data-icon="default-group"],
                [style*="background-image"]
            )) {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-title"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-primary-detail"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-primary"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-secondary"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) time,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid*="unread" i] {
                display: none !important;
            }

            /* El aviso promocional de WhatsApp para Windows no cabe en una
               ventana muy estrecha y no forma parte del chat abierto. */
            body.${BODY_COMPACT_CLASS} [${COMPACT_HIDDEN_ATTRIBUTE}] {
                display: none !important;
            }

            /* Aviso "Obtener WhatsApp para Windows". Su estructura actual es
               div > div > span[data-testid="wa-square-icon"]. */
            body.${BODY_COMPACT_CLASS} div:has(> div > [data-testid="wa-square-icon"]) {
                display: none !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"] img,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"] img,
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid*="default-" i],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid*="avatar" i],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="img"],
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [style*="background-image"] {
                box-sizing: border-box !important;
                width: 48px !important;
                min-width: 48px !important;
                max-width: 48px !important;
                height: 48px !important;
                min-height: 48px !important;
                max-height: 48px !important;
                margin: 0 !important;
                border-radius: 50% !important;
                object-fit: cover !important;
            }

            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [data-testid="cell-frame-container"] > *:has(
                img,
                svg,
                [role="img"],
                [data-testid*="default-" i],
                [data-testid*="avatar" i],
                [data-icon="default-user"],
                [data-icon="default-group"],
                [style*="background-image"]
            ),
            body.${BODY_COMPACT_CLASS} [${HOST_ATTRIBUTE}] :is(#side, #pane-side) [role="row"] > *:has(
                img,
                svg,
                [role="img"],
                [data-testid*="default-" i],
                [data-testid*="avatar" i],
                [data-icon="default-user"],
                [data-icon="default-group"],
                [style*="background-image"]
            ) {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                flex: 0 0 48px !important;
                width: 48px !important;
                min-width: 48px !important;
                max-width: 48px !important;
                height: 48px !important;
                min-height: 48px !important;
                max-height: 48px !important;
                margin-inline: auto !important;
            }

            body.${BODY_COMPACT_CLASS} [data-testid="drawer-left"],
            body.${BODY_COMPACT_CLASS} [data-testid="drawer-middle"] {
                border-inline-start-width: 0 !important;
            }

            /* Responsive: evita que el panel de conversación conserve un
               min-width grande al reducir la ventana del navegador. */
            @media (max-width: 720px) {
                html,
                body,
                #app,
                [data-testid="app-wrapper"],
                .two {
                    min-width: 0 !important;
                    max-width: 100vw !important;
                    overflow-x: hidden !important;
                }

                #main {
                    flex: 1 1 0 !important;
                    width: auto !important;
                    min-width: 0 !important;
                    max-width: none !important;
                    overflow: hidden !important;
                }

                #main > *,
                #main [data-testid="conversation-panel-body"],
                #main [data-testid="conversation-panel-messages"],
                #main [data-testid="conversation-panel-header"],
                #main [data-testid="compose-box"],
                #main footer {
                    box-sizing: border-box !important;
                    min-width: 0 !important;
                    max-width: 100% !important;
                }

                #main [data-testid="conversation-panel-body"],
                #main [data-testid="conversation-panel-messages"] {
                    width: 100% !important;
                    overflow-x: hidden !important;
                }

                #main [role="row"],
                #main [data-testid="msg-container"],
                #main .message-in,
                #main .message-out {
                    min-width: 0 !important;
                    max-width: 100% !important;
                }

                #main [data-testid="msg-container"] > *,
                #main [data-testid="msg-container"] [role="button"] {
                    min-width: 0 !important;
                    max-width: 100% !important;
                }

                #main [data-testid="msg-container"] [dir="auto"],
                #main [data-testid="msg-container"] .selectable-text,
                #main [data-testid="msg-container"] span[dir="auto"],
                #main .selectable-text {
                    display: block !important;
                    box-sizing: border-box !important;
                    width: auto !important;
                    min-width: 0 !important;
                    max-width: 100% !important;
                    white-space: normal !important;
                    overflow-wrap: break-word !important;
                    word-break: normal !important;
                }

                #main [data-testid="msg-container"],
                #main .message-in,
                #main .message-out,
                #main [role="row"] {
                    width: auto !important;
                    max-width: 100% !important;
                }

                #main [data-testid="msg-container"] img,
                #main [data-testid="msg-container"] video,
                #main [data-testid="msg-container"] canvas {
                    max-width: 100% !important;
                    height: auto !important;
                }

                #main footer,
                #main [data-testid="compose-box"],
                #main footer > *,
                #main [data-testid="compose-box"] > * {
                    min-width: 0 !important;
                    max-width: 100% !important;
                }
            }
        `;

        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    function markHost(host) {
        if (chatListHost === host) return;

        if (chatListHost?.isConnected) {
            chatListHost.removeAttribute(HOST_ATTRIBUTE);
            chatListHost.classList.remove(HOST_COMPACT_CLASS);
        }

        chatListHost = host;
        if (chatListHost) {
            chatListHost.setAttribute(HOST_ATTRIBUTE, "");
        }
    }

    function markTopElements() {
        const host = chatListHost;
        if (!host) return;

        host.querySelectorAll(`[${TOP_ATTRIBUTE}], [${ARCHIVE_ATTRIBUTE}]`).forEach((element) => {
            element.removeAttribute(TOP_ATTRIBUTE);
            element.removeAttribute(ARCHIVE_ATTRIBUTE);
        });

        const topAnchors = host.querySelectorAll([
            '[data-testid="chatlist-header"]',
            '[data-testid="chat-list-search-container"]',
            '[data-testid="chat-list-search"]',
            '[aria-label="chat-list-filters"]',
            '[data-testid="panel-header-search"]',
        ].join(","));

        for (const anchor of topAnchors) {
            let topElement = anchor.closest("header");

            if (!topElement || !host.contains(topElement)) {
                topElement = anchor;
                while (topElement.parentElement && topElement.parentElement !== host) {
                    const parent = topElement.parentElement;
                    if (parent.querySelector('[data-testid="cell-frame-container"], [role="row"]')) {
                        break;
                    }
                    topElement = parent;
                }
            }

            if (topElement !== host) {
                topElement.setAttribute(TOP_ATTRIBUTE, "");
            }
        }

        const archiveElements = host.querySelectorAll([
            '[aria-label*="archiv" i]',
            '[title*="archiv" i]',
            '[data-testid*="archiv" i]',
            '[data-testid*="archive" i]',
        ].join(","));

        for (const archiveElement of archiveElements) {
            const row = archiveElement.closest(
                '[data-testid="cell-frame-container"], [role="row"], [role="listitem"]',
            );
            (row || archiveElement).setAttribute(ARCHIVE_ATTRIBUTE, "");
        }
    }

    function markAvatarRoots() {
        const sidePanel = getSidePanel();
        if (!sidePanel) return;

        const avatarSelector = [
            '[data-testid*="avatar" i]',
            '[data-testid*="default-" i]',
            '[data-icon="default-user"]',
            '[data-icon="default-group"]',
            'img[draggable="false"]',
            "img",
            "svg",
            '[role="img"]',
            '[style*="background-image"]',
        ].join(",");

        const rowSelector = [
            '[data-testid="cell-frame-container"]',
            '[role="row"]:not(:has([data-testid="cell-frame-container"]))',
        ].join(",");

        sidePanel.querySelectorAll(`[${AVATAR_ATTRIBUTE}]`).forEach((element) => {
            element.removeAttribute(AVATAR_ATTRIBUTE);
        });

        for (const row of sidePanel.querySelectorAll(rowSelector)) {
            // Solo se consideran hijos directos del contenedor de la fila. De
            // esta forma se conserva el bloque del avatar y se descartan sus
            // hermanos (nombre, mensaje, hora y contador).
            const avatarRoot = Array.from(row.children).find((child) =>
                child.matches(avatarSelector) || child.querySelector(avatarSelector),
            );

            if (avatarRoot) {
                avatarRoot.setAttribute(AVATAR_ATTRIBUTE, "");
            }
        }
    }

    function markCompactOnlyPromos() {
        const main = document.querySelector("#main") || document.body;
        if (!main) return;

        main.querySelectorAll(`[${COMPACT_HIDDEN_ATTRIBUTE}]`).forEach((element) => {
            element.removeAttribute(COMPACT_HIDDEN_ATTRIBUTE);
        });

        const candidates = main.querySelectorAll([
            '[data-testid*="download" i]',
            '[data-testid*="desktop" i]',
            '[data-testid="wa-square-icon"]',
            'a[href*="download" i]',
            'a[href*="windows" i]',
            "button",
            '[role="button"]',
        ].join(","));

        for (const candidate of candidates) {
            const text = (candidate.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();

            const looksLikeWindowsPromo =
                /(obtener|descargar|download|get)\b/.test(text) &&
                /(whatsapp|windows|escritorio|desktop)/.test(text);

            const hasDownloadMarker =
                candidate.matches('[data-testid*="download" i], [data-testid*="desktop" i], [data-testid="wa-square-icon"]') ||
                candidate.matches('a[href*="download" i], a[href*="windows" i]');

            if ((!looksLikeWindowsPromo && !hasDownloadMarker) || text.length > 220) {
                continue;
            }

            // Si el usuario envió un mensaje con esas palabras, no se toca:
            // solo se oculta el aviso independiente de descarga.
            if (candidate.closest('[data-testid="msg-container"], .message-in, .message-out')) {
                continue;
            }

            const promo = candidate.matches('[data-testid="wa-square-icon"]')
                ? candidate.closest('div:has(> div [data-testid="wa-square-icon"])') || candidate.parentElement
                : candidate.closest(
                    '[data-testid*="download" i], [data-testid*="desktop" i], [data-testid*="banner" i], a, button, [role="button"]',
                ) || candidate;
            promo.setAttribute(COMPACT_HIDDEN_ATTRIBUTE, "");
        }
    }

    function applyLayout() {
        ensureStyle();

        const compactIsActive = Boolean(chatListHost && chatsTabActive && compactPreference);

        if (chatListHost) {
            chatListHost.classList.toggle(HOST_COMPACT_CLASS, compactIsActive);
        }

        document.body?.classList.toggle(BODY_COMPACT_CLASS, compactIsActive);
    }

    function syncWithWhatsApp() {
        if (!document.body) return;

        const nextHost = findChatListHost();
        if (nextHost !== chatListHost) {
            markHost(nextHost);
        }

        chatsTabControl = findChatsTabControl();
        if (!tabStateKnown) {
            const detectedState = detectChatsTabState(chatsTabControl);
            if (detectedState !== null) {
                chatsTabActive = detectedState;
                tabStateKnown = true;
            }
        }
        markTopElements();
        markAvatarRoots();
        markCompactOnlyPromos();
        applyLayout();
    }

    function scheduleSync(delay = 120) {
        if (syncTimer) return;

        syncTimer = window.setTimeout(() => {
            syncTimer = null;
            syncWithWhatsApp();
        }, delay);
    }

    function toggleCompactMode() {
        if (!chatListHost || !chatsTabActive) return;

        compactPreference = !compactPreference;
        saveCompactPreference();
        applyLayout();
    }

    function handleNavigationClick(event) {
        const control = findChatsControlFromTarget(event.target);
        if (control) {
            // Después de visitar otra pestaña, el DOM de la lista puede seguir
            // existiendo aunque Chats ya no esté activa. En ese caso no usamos
            // el fallback visual: el primer clic debe dejar pasar la navegación.
            const activeBeforeClick = tabStateKnown
                ? chatsTabActive
                : getControlState(control) === true || isChatsTabActive(control);
            if (!activeBeforeClick) {
                // Al entrar a Chats dejamos que WhatsApp haga su navegación normal,
                // pero recordamos el destino para que el observer no vea un estado
                // transitorio como si fuera una salida de Chats.
                chatsTabActive = true;
                tabStateKnown = true;
                applyLayout();
                scheduleSync(0);
                window.setTimeout(() => scheduleSync(0), 250);
                return;
            }

            // Chats ya está abierta: el clic se convierte en el interruptor de
            // expansión/colapso y no dispara una navegación innecesaria.
            event.preventDefault();
            event.stopPropagation();
            toggleCompactMode();
            return;
        }

        const otherNavigationControl = findNavigationControlFromTarget(event.target);
        if (otherNavigationControl) {
            // Al salir de Chats, el panel vuelve inmediatamente a su ancho normal.
            // La preferencia compacta queda guardada para cuando se regrese a Chats.
            chatsTabActive = false;
            tabStateKnown = true;
            applyLayout();
            scheduleSync(0);
            window.setTimeout(() => scheduleSync(0), 250);
        }
    }

    function installChatsButtonHandler() {
        window.addEventListener("click", handleNavigationClick, true);
    }

    function cleanupLegacyUi() {
        // La versión 1.x insertaba este botón en el body. Se elimina al cargar
        // la nueva versión, incluso si la pestaña no se recargó completamente.
        document.getElementById("wa-compact-chat-list-toggle")?.remove();
        document.body?.classList.remove("wa-compact-chat-list-is-hidden");
    }

    function waitForWhatsApp() {
        const startedAt = Date.now();
        let settleTimer = null;
        let finished = false;
        let observer = null;

        const finish = () => {
            if (finished) return;
            finished = true;
            window.clearTimeout(settleTimer);
            observer?.disconnect();
            syncWithWhatsApp();
        };

        const check = () => {
            if (finished) return;
            if (!getSidePanel()) return;

            if (Date.now() - startedAt >= MAX_WAIT_MS) {
                finish();
                return;
            }

            window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(finish, SETTLE_MS);
        };

        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
        check();
    }

    function start() {
        cleanupLegacyUi();
        ensureStyle();
        installChatsButtonHandler();
        waitForWhatsApp();

        // WhatsApp puede cambiar atributos de selección sin insertar nodos;
        // este observer y el intervalo mantienen el modo sincronizado después
        // de navegar o recibir nuevas conversaciones.
        const observer = new MutationObserver(() => scheduleSync());
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        window.addEventListener("resize", () => scheduleSync(0));
        window.setInterval(() => scheduleSync(0), 1500);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();

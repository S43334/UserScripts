// ==UserScript==
// @name         Akdmic Agent Bridge & Automator (Secure & Explainable)
// @namespace    https://github.com/akdmic-agent-bridge
// @version      4.2.1
// @description  Puente WebSocket, inspector DOM y asistente/automator seguro para Akdmic, con confirmación de usuario.
// @author       s43334
// @match        https://www.akdmic.com/*
// @match        https://ingles.akdmic.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  if (window.__akdmicUnifiedAgentLoaded) return;
  window.__akdmicUnifiedAgentLoaded = true;

  const BRIDGE_WS_URLS = [
    'ws://localhost:8765/bridge',
    'ws://127.0.0.1:8765/bridge'
  ];
  const AGENT_VERSION = '4.2.1';
  const PAGE_ID = globalThis.crypto?.randomUUID?.() || `page_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const RUN_STARTED_AT = Date.now();
  const CAPABILITIES = [
    'STATE_SNAPSHOT', 'DOM_TREE', 'INTERACTIVE_ELEMENTS', 'POPUP_DETECTION',
    'DOM_MUTATION_LOG', 'UI_EVENT_LOG', 'RUNTIME_ERROR_LOG', 'NETWORK_METADATA',
    'CLICK', 'CLICK_TEXT', 'FILL', 'SELECT_OPTION', 'SET_CHECKBOX', 'FOCUS', 'SCROLL_TO',
    'DISMISS_POPUP', 'NAVIGATE_SAME_ORIGIN', 'CLICK_SEMANTIC', 'MATCH_SEMANTIC_PAIRS',
    'MATCH_PAIR', 'MATCH_ALL_PAIRS',
    'WORD_BOX_STATE', 'WORD_BOX_PLACE', 'WORD_BOX_PLACE_ALL', 'REORDER_LIST', 'INSPECT_NODES',
    'PROOFREADING_OPEN_WORD', 'PROOFREADING_OPEN_TOKEN', 'PROOFREADING_REPLACE', 'PROOFREADING_INSERT', 'PROOFREADING_DELETE', 'PROOFREADING_CANCEL',
    'DISPLAY_REASONING', 'CAPTURE_STATE', 'GET_CAPABILITIES', 'CANCEL_AUTOMATION',
    'SUBMIT', 'NAVIGATE_NEXT'
  ];
  let ws = null;
  let isConnected = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let debounceStateTimer = null;
  let reconnectAttempt = 0;
  let bridgeUrlIndex = 0;
  let connectionGeneration = 0;
  let currentAction = null;
  let lastActionSummary = null;
  let lastPreflightReview = null;
  let lastPostflightReview = null;
  let lastReviewStatus = 'NOT_RUN';
  let currentProofreadingToken = null;
  let stopAutomationRequested = false;
  let domRevision = 0;
  const recentDomChanges = [];
  const recentRuntimeEvents = [];
  const recentUiEvents = [];
  const recentPopupEvents = [];
  const handledRequestIds = new Map();
  let lastPopupKeys = new Set();
  const MAX_RECENT_EVENTS = 80;
  const MAX_ACTION_CACHE = 120;
  const MAX_STATE_BYTES = 220 * 1024;

  function readPreference(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function writePreference(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) {}
  }

  const SETTINGS = {
    get autoPlay() {
      return readPreference('akdmic_agent_autoplay', 'false') === 'true';
    },
    set autoPlay(value) {
      writePreference('akdmic_agent_autoplay', Boolean(value));
    },
    get autoSubmit() {
      return readPreference('akdmic_agent_autosubmit', 'false') === 'true';
    },
    set autoSubmit(value) {
      writePreference('akdmic_agent_autosubmit', Boolean(value));
    },
    get delay() {
      const value = Number.parseInt(readPreference('akdmic_agent_delay', '1200'), 10);
      return Number.isFinite(value) ? Math.max(300, Math.min(value, 10000)) : 1200;
    },
    set delay(value) {
      writePreference('akdmic_agent_delay', Math.max(300, Math.min(Number(value) || 1200, 10000)));
    },
    get captureNetwork() {
      return readPreference('akdmic_agent_capture_network', 'true') !== 'false';
    },
    set captureNetwork(value) {
      writePreference('akdmic_agent_capture_network', Boolean(value));
    },
    get captureUiEvents() {
      return readPreference('akdmic_agent_capture_ui', 'true') !== 'false';
    },
    set captureUiEvents(value) {
      writePreference('akdmic_agent_capture_ui', Boolean(value));
    }
  };

  // ==========================================
  // 1. BYPASS DE RESTRICCIONES & DEVTOOLS
  // ==========================================
  function applyBypasses() {
    ['contextmenu', 'copy', 'paste', 'cut', 'selectstart', 'dragstart'].forEach(evt => {
      document.addEventListener(evt, e => e.stopImmediatePropagation(), true);
    });
    document.onmousedown = null;
    document.onmouseup = null;

    try {
      const script = document.createElement('script');
      script.textContent = `
        window.detectUseConsoleApp = function() { return false; };
        window.consoleuseExc = function() { return false; };
        window.disableClick = function() { return true; };
        document.addEventListener('contextmenu', function(e) { e.stopPropagation(); }, true);
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {
      console.warn('[Bridge] Error en bypass:', e);
    }
  }

  // ==========================================
  // 2. EXTRACTOR Y REDACTOR DE SEGURIDAD DEL DOM
  // ==========================================
  function clipText(value, maxLength = 240) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function redactText(value, maxLength = 500) {
    let text = clipText(value, maxLength);
    text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/ig, '$1[REDACTED]');
    text = text.replace(/(token|secret|password|passwd|csrf|cookie|session(?:Id|_id)?|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]');
    text = text.replace(/([?&](?:token|secret|password|passwd|csrf|auth|session|sid|api[_-]?key)=)[^&#\s]+/ig, '$1[REDACTED]');
    return text;
  }

  function redactUrl(value) {
    try {
      const url = new URL(String(value || ''), window.location.href);
      return {
        origin: url.origin === window.location.origin ? 'same-origin' : '[external-origin]',
        path: redactText(url.pathname, 300),
        sameOrigin: url.origin === window.location.origin
      };
    } catch (e) {
      return { origin: '[invalid]', path: '[invalid]', sameOrigin: false };
    }
  }

  function pushRing(buffer, value, limit = MAX_RECENT_EVENTS) {
    buffer.push(value);
    while (buffer.length > limit) buffer.shift();
  }

  function sanitizeTelemetry(value, depth = 0) {
    if (depth > 3) return '[TRUNCATED]';
    if (typeof value === 'string') return redactText(value, 500);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeTelemetry(item, depth + 1));
    if (typeof value === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        if (/^(body|headers|cookie|set-cookie|authorization|token|secret|password|session|storage|stack)$/i.test(key)) {
          output[key] = '[REDACTED]';
        } else {
          output[key] = sanitizeTelemetry(item, depth + 1);
        }
      }
      return output;
    }
    return String(value).slice(0, 200);
  }

  function recordUiEvent(kind, element, extra = {}) {
    if (!SETTINGS.captureUiEvents || !element || isBridgeElement(element)) return;
    const event = {
      sequence: ++domRevision,
      timestamp: Date.now(),
      kind,
      target: describeElement(element, false),
      ...sanitizeTelemetry(extra)
    };
    pushRing(recentUiEvents, event);
    notifyDomChanged([]);
  }

  function escapeCss(value) {
    const text = String(value ?? '');
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
      return globalThis.CSS.escape(text);
    }
    return text.replace(/([\\"'#.:;,!?+*~>\[\]()={}\s])/g, '\\$1');
  }

  function escapeCssAttribute(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isBridgeElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    return Boolean(element.closest?.('#akdmic-agent-bridge-badge, #akdmic-reasoning-panel, #akdmic-agent-controls'));
  }

  function isSensitiveField(element, key = '') {
    const descriptor = [
      key,
      element?.getAttribute?.('type'),
      element?.getAttribute?.('name'),
      element?.getAttribute?.('id'),
      element?.getAttribute?.('autocomplete'),
      element?.getAttribute?.('placeholder')
    ].filter(Boolean).join(' ').toLowerCase();
    return /password|passwd|token|secret|csrf|auth|cookie|session|api[-_ ]?key|email|phone|tel|nombre|apellido|username|user[-_ ]?name/.test(descriptor);
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isBridgeElement(element)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return element.getClientRects().length > 0 || element === document.activeElement;
    } catch (e) {
      return false;
    }
  }

  function getElementSelector(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;

    if (element.id) {
      const idSelector = `#${escapeCss(element.id)}`;
      try {
        if (document.querySelectorAll(idSelector).length === 1) return idSelector;
      } catch (e) {}
    }

    const dataHref = element.getAttribute('data-href');
    if (dataHref && element.classList.contains('start-exercise-link')) {
      return `.start-exercise-link[data-href="${escapeCssAttribute(dataHref)}"]`;
    }

    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && segments.length < 5) {
      let segment = current.tagName.toLowerCase();
      const stableClass = Array.from(current.classList || [])
        .filter(name => !/^ng-|^css-|^jsx-|^sc-/.test(name))
        .slice(0, 2);
      if (stableClass.length) segment += `.${stableClass.map(escapeCss).join('.')}`;

      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName)
        : [];
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      segments.unshift(segment);
      current = current.parentElement;
    }
    return segments.length ? segments.join(' > ') : element.tagName.toLowerCase();
  }

  function getSelectorCandidates(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return [];
    const candidates = [];
    if (element.id) candidates.push(`#${escapeCss(element.id)}`);
    const dataHref = element.getAttribute('data-href');
    if (dataHref) candidates.push(`[data-href="${escapeCssAttribute(dataHref)}"]`);
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) candidates.push(`${element.tagName.toLowerCase()}[aria-label="${escapeCssAttribute(ariaLabel)}"]`);
    const name = element.getAttribute('name');
    if (name) candidates.push(`${element.tagName.toLowerCase()}[name="${escapeCssAttribute(name)}"]`);
    candidates.push(getElementSelector(element));
    return Array.from(new Set(candidates.filter(Boolean))).slice(0, 5);
  }

  function getElementAttributes(element) {
    const attributes = {};
    const allowed = [
      'id', 'class', 'role', 'name', 'type', 'href', 'src', 'title',
      'aria-label', 'aria-labelledby', 'aria-expanded', 'aria-hidden',
      'aria-modal', 'aria-selected', 'placeholder', 'data-tipo', 'data-href',
      'data-idp', 'data-abierto', 'data-closed', 'disabled', 'checked', 'selected'
    ];

    for (const name of allowed) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name);
      attributes[name] = isSensitiveField(element, name) ? '[REDACTED]' : redactText(value, 180);
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      attributes.value = isSensitiveField(element, 'value') ? '[REDACTED]' : redactText(element.value, 180);
    }
    if (element.hasAttribute('onclick')) attributes.hasOnclick = true;
    return attributes;
  }

  function describeElement(element, includeChildren = false) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const description = {
      tag: element.tagName.toLowerCase(),
      selector: getElementSelector(element),
      selectorCandidates: getSelectorCandidates(element),
      visible: isVisible(element),
      text: redactText(element.innerText || element.textContent, 220),
      attributes: getElementAttributes(element)
    };
    if (includeChildren) {
      description.children = Array.from(element.children).slice(0, 20).map(child => describeElement(child, false));
    }
    return description;
  }

  function summarizeDomTree(element, depth = 0, budget = { nodes: 0, maxNodes: 180, maxDepth: 5 }) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || isBridgeElement(element)) return null;
    if (budget.nodes >= budget.maxNodes) return { truncated: true };
    budget.nodes += 1;

    const summary = {
      tag: element.tagName.toLowerCase(),
      selector: getElementSelector(element),
      visible: isVisible(element),
      text: redactText(element.innerText || element.textContent, depth === 0 ? 500 : 160),
      attributes: getElementAttributes(element)
    };

    if (depth < budget.maxDepth) {
      const children = [];
      for (const child of Array.from(element.children).slice(0, 40)) {
        const childSummary = summarizeDomTree(child, depth + 1, budget);
        if (childSummary) children.push(childSummary);
        if (budget.nodes >= budget.maxNodes) break;
      }
      if (children.length) summary.children = children;
    } else if (element.children.length) {
      summary.childrenTruncated = true;
    }
    return summary;
  }

  function collectInteractiveElements() {
    const selector = [
      'a', 'button', 'input', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="radio"]', '[contenteditable="true"]'
    ].join(',');
    const all = Array.from(document.querySelectorAll(selector));
    const visible = all.filter(element => isVisible(element));
    return {
      total: visible.length,
      truncated: visible.length > 180,
      elements: visible.slice(0, 180).map(element => describeElement(element, false))
    };
  }

  function collectFormsAndFrames() {
    const forms = Array.from(document.forms).slice(0, 40).map(form => ({
      selector: getElementSelector(form),
      method: String(form.method || 'get').toUpperCase(),
      action: redactUrl(form.action || window.location.href),
      controls: Array.from(form.elements).slice(0, 80).map(control => describeElement(control, false))
    }));
    const frames = Array.from(document.querySelectorAll('iframe, frame')).slice(0, 20).map(frame => ({
      selector: getElementSelector(frame),
      visible: isVisible(frame),
      source: redactUrl(frame.getAttribute('src') || frame.src || ''),
      sameOrigin: (() => {
        try { return frame.contentWindow?.location?.origin === window.location.origin; } catch (e) { return false; }
      })()
    }));
    return { forms, frames };
  }

  function updatePopupHistory(popups) {
    const currentKeys = new Set(popups.map(popup => `${popup.kind}:${popup.selector}:${popup.text}`));
    for (const key of currentKeys) {
      if (!lastPopupKeys.has(key)) {
        pushRing(recentPopupEvents, {
          sequence: ++domRevision,
          timestamp: Date.now(),
          kind: 'POPUP_OPEN',
          key
        });
      }
    }
    for (const key of lastPopupKeys) {
      if (!currentKeys.has(key)) {
        pushRing(recentPopupEvents, {
          sequence: ++domRevision,
          timestamp: Date.now(),
          kind: 'POPUP_CLOSE',
          key
        });
      }
    }
    lastPopupKeys = currentKeys;
  }

  function collectVisiblePopups() {
    const selector = [
      'dialog[open]', '[role="dialog"]', '[role="alertdialog"]',
      '[aria-modal="true"]', '.modal.show', '.modal.in',
      '.swal2-container', '.sweet-alert', '.ui-dialog',
      '.toast', '.toast-container', '[role="alert"]',
      '.alert.alert-danger', '.alert.alert-warning',
      '[data-modal]', '[data-popup]', '[data-toast]',
      '.popup', '.dialog', '[class*="modal"]', '[class*="popup"]'
    ].join(',');
    const seen = new Set();
    const popups = [];
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      popups.push({
        ...describeElement(element, false),
        kind: element.matches('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, .dialog, [data-modal], [class*="modal"], [class*="popup"], .swal2-container, .sweet-alert, .ui-dialog') ? 'dialog' : 'notification',
        buttons: Array.from(element.querySelectorAll('button, a, [role="button"]')).slice(0, 12).map(button => describeElement(button, false))
      });
    }
    const result = popups.slice(0, 20);
    updatePopupHistory(result);
    return result;
  }

  function recordRuntimeEvent(kind, data = {}) {
    pushRing(recentRuntimeEvents, {
      sequence: ++domRevision,
      timestamp: Date.now(),
      kind,
      data: sanitizeTelemetry(data)
    });
    notifyDomChanged([]);
  }

  function recordDomChanges(mutations = []) {
    const list = Array.from(mutations);
    for (const mutation of list.slice(0, 60)) {
      if (isBridgeElement(mutation.target)) continue;
      const change = {
        sequence: ++domRevision,
        timestamp: Date.now(),
        type: mutation.type,
        target: describeElement(mutation.target, false)
      };

      if (mutation.type === 'attributes') {
        change.attributeName = mutation.attributeName;
        change.newValue = isSensitiveField(mutation.target, mutation.attributeName)
          ? '[REDACTED]'
          : redactText(mutation.target.getAttribute(mutation.attributeName), 180);
      } else if (mutation.type === 'childList') {
        change.added = Array.from(mutation.addedNodes).filter(node => node.nodeType === Node.ELEMENT_NODE).slice(0, 8).map(node => describeElement(node, false));
        change.removedCount = mutation.removedNodes.length;
      } else if (mutation.type === 'characterData') {
        change.text = redactText(mutation.target.textContent, 180);
      }
      recentDomChanges.push(change);
    }
    if (list.length > 60) {
      recentDomChanges.push({
        sequence: ++domRevision,
        timestamp: Date.now(),
        type: 'MUTATION_BATCH_TRUNCATED',
        omitted: list.length - 60
      });
    }
    while (recentDomChanges.length > MAX_RECENT_EVENTS) recentDomChanges.shift();
  }

  function installRuntimeHooks() {
    if (!window.__akdmicAgentRuntimeListener) {
      window.addEventListener('akdmic-bridge-runtime-event', event => {
        try {
          const detail = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
          if (detail?.kind) recordRuntimeEvent(detail.kind, detail.data || {});
        } catch (e) {
          recordRuntimeEvent('RUNTIME_EVENT_PARSE_ERROR', { message: e.message });
        }
      });
      window.__akdmicAgentRuntimeListener = true;
    }

    if (!window.__akdmicAgentHistoryHooked) {
      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        if (typeof original !== 'function' || original.__akdmicAgentWrapped) continue;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          recordRuntimeEvent('NAVIGATION', { method, url: window.location.href });
          return result;
        };
        wrapped.__akdmicAgentWrapped = true;
        history[method] = wrapped;
      }
      window.addEventListener('hashchange', () => recordRuntimeEvent('HASH_CHANGE', { url: window.location.href }));
      window.addEventListener('popstate', () => recordRuntimeEvent('POP_STATE', { url: window.location.href }));
      window.__akdmicAgentHistoryHooked = true;
    }

    try {
      const script = document.createElement('script');
      script.textContent = `
        (() => {
          const hookKey = '__akdmicAgentPageRuntimeHookV1';
          if (window[hookKey]) return;
          let captureNetwork = ${SETTINGS.captureNetwork ? 'true' : 'false'};
          const emit = (kind, data) => {
            window.dispatchEvent(new CustomEvent('akdmic-bridge-runtime-event', {
              detail: JSON.stringify({ kind, data, timestamp: Date.now() })
            }));
          };
          const safeUrl = value => {
            try {
              const url = new URL(String(value || ''), window.location.href);
              return {
                origin: url.origin === window.location.origin ? 'same-origin' : '[external-origin]',
                path: url.pathname.slice(0, 300),
                sameOrigin: url.origin === window.location.origin
              };
            } catch (error) {
              return { origin: '[invalid]', path: '[invalid]', sameOrigin: false };
            }
          };
          window.addEventListener('akdmic-agent-config', event => {
            try {
              const config = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
              if (typeof config?.captureNetwork === 'boolean') captureNetwork = config.captureNetwork;
            } catch (error) {}
          });
          const wrap = (name, kind) => {
            const original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function (...args) {
              const message = String(args[0] ?? '').slice(0, 500);
              emit(kind + '_OPEN', { message });
              try {
                const result = original.apply(this, args);
                emit(kind + '_CLOSED', { message, result: typeof result === 'boolean' ? result : undefined });
                return result;
              } catch (error) {
                emit(kind + '_ERROR', { message, error: String(error?.message || error) });
                throw error;
              }
            };
          };
          wrap('alert', 'NATIVE_ALERT');
          wrap('confirm', 'NATIVE_CONFIRM');
          wrap('prompt', 'NATIVE_PROMPT');
          wrap('open', 'WINDOW_OPEN');
          if (captureNetwork) {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
              window.fetch = async function(input, init) {
                if (!captureNetwork) return originalFetch.apply(this, arguments);
                const started = performance.now();
                const requestUrl = safeUrl(input?.url || input);
                const method = String(init?.method || input?.method || 'GET').toUpperCase();
                try {
                  const response = await originalFetch.apply(this, arguments);
                  emit('NETWORK_RESPONSE', {
                    transport: 'fetch', method, url: requestUrl,
                    status: response.status, ok: response.ok,
                    durationMs: Math.round(performance.now() - started)
                  });
                  return response;
                } catch (error) {
                  emit('NETWORK_ERROR', {
                    transport: 'fetch', method, url: requestUrl,
                    error: String(error?.message || error).slice(0, 300),
                    durationMs: Math.round(performance.now() - started)
                  });
                  throw error;
                }
              };
            }

            const OriginalXHR = window.XMLHttpRequest;
            if (OriginalXHR) {
              const originalOpen = OriginalXHR.prototype.open;
              const originalSend = OriginalXHR.prototype.send;
              OriginalXHR.prototype.open = function(method, url) {
                this.__akdmicAgentRequest = { method: String(method || 'GET').toUpperCase(), url: safeUrl(url), started: 0 };
                return originalOpen.apply(this, arguments);
              };
              OriginalXHR.prototype.send = function() {
                const request = this.__akdmicAgentRequest || { method: 'GET', url: safeUrl(''), started: 0 };
                if (!captureNetwork) return originalSend.apply(this, arguments);
                request.started = performance.now();
                this.addEventListener('loadend', () => emit('NETWORK_RESPONSE', {
                  transport: 'xhr', method: request.method, url: request.url,
                  status: this.status, ok: this.status >= 200 && this.status < 400,
                  durationMs: Math.round(performance.now() - request.started)
                }), { once: true });
                this.addEventListener('error', () => emit('NETWORK_ERROR', {
                  transport: 'xhr', method: request.method, url: request.url,
                  error: 'network-error', durationMs: Math.round(performance.now() - request.started)
                }), { once: true });
                return originalSend.apply(this, arguments);
              };
            }
          }
          for (const method of ['warn', 'error']) {
            const originalConsole = window.console?.[method];
            if (typeof originalConsole !== 'function') continue;
            window.console[method] = function(...args) {
              emit('CONSOLE_' + method.toUpperCase(), { message: args.map(String).join(' ').slice(0, 500) });
              return originalConsole.apply(this, args);
            };
          }
          window.addEventListener('error', event => emit('WINDOW_ERROR', {
            message: String(event.message || '').slice(0, 500),
            source: String(event.filename || '').slice(0, 300),
            line: event.lineno || null,
            column: event.colno || null
          }));
          window.addEventListener('unhandledrejection', event => emit('UNHANDLED_REJECTION', {
            message: String(event.reason?.message || event.reason || '').slice(0, 500)
          }));
          window[hookKey] = true;
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      window.dispatchEvent(new CustomEvent('akdmic-agent-config', {
        detail: JSON.stringify({ captureNetwork: SETTINGS.captureNetwork })
      }));
    } catch (e) {
      recordRuntimeEvent('RUNTIME_HOOK_INSTALL_ERROR', { message: e.message });
    }
  }

  function collectObservability() {
    const budget = { nodes: 0, maxNodes: 180, maxDepth: 5 };
    const body = document.body;
    const activeElement = document.activeElement && document.activeElement !== document.body
      ? describeElement(document.activeElement, false)
      : null;
    return {
      schemaVersion: 2,
      revision: domRevision,
      pageId: PAGE_ID,
      agent: {
        version: AGENT_VERSION,
        runStartedAt: RUN_STARTED_AT,
        capabilities: CAPABILITIES,
        settings: {
          captureNetwork: SETTINGS.captureNetwork,
          captureUiEvents: SETTINGS.captureUiEvents,
          autoPlay: SETTINGS.autoPlay,
          autoSubmit: SETTINGS.autoSubmit
        },
        currentAction: currentAction ? { action: currentAction.action, startedAt: currentAction.startedAt } : null,
        lastAction: lastActionSummary,
        reviewStatus: lastReviewStatus
      },
      page: {
        title: clipText(document.title, 240),
        readyState: document.readyState,
        language: document.documentElement?.lang || null,
        bodyClass: clipText(body?.className, 240),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        visibilityState: document.visibilityState,
        online: navigator.onLine,
        activeElement
      },
      dom: {
        nodeCount: document.querySelectorAll('*').length,
        structureTruncated: false,
        visibleText: redactText(body?.innerText, 2400),
        structure: body ? summarizeDomTree(body, 0, budget) : null,
        nodesIncluded: budget.nodes,
        nodesLimit: budget.maxNodes
      },
      interactive: collectInteractiveElements(),
      formsAndFrames: collectFormsAndFrames(),
      popups: collectVisiblePopups(),
      recentChanges: recentDomChanges.slice(-50),
      popupEvents: recentPopupEvents.slice(-50),
      uiEvents: recentUiEvents.slice(-50),
      runtimeEvents: recentRuntimeEvents.slice(-50)
    };
  }

  function parsePlanExerciseMetadata(link) {
    const card = link.closest('.polaroid') || link.closest('tr') || link.parentElement;
    const rawText = String(card?.innerText || link.innerText || '').replace(/\r/g, '').trim();
    const text = clipText(rawText, 1600);
    const attemptsMatch = text.match(/\bIntentos\s*:?\s*(\d+)\s+de\s+(\d+)/i);
    const scoreMatch = text.match(/\bCalificación\s*:\s*(\d+)(?!\s*de)/i);
    const passingMatch = text.match(/Calificación\s+mínima\s+aprobatoria\s*:\s*(\d+)/i);
    const evaluationMatch = text.match(/Tipo\s+de\s+evaluación\s*:\s*(.+?)(?=\s+Intentos\b|\s+Calificación\b|$)/i);
    const timeMatch = text.match(/(?:Límite\s+de\s+tiempo|Tiempo\s+mínimo)\s*:?\s*([\d\s:]+(?:min(?:utos)?|seg(?:undos)?)?)/i);
    const score = scoreMatch ? Number(scoreMatch[1]) : null;
    const passingScore = passingMatch ? Number(passingMatch[1]) : null;
    const attemptsUsed = attemptsMatch ? Number(attemptsMatch[1]) : null;
    const attemptsMax = attemptsMatch ? Number(attemptsMatch[2]) : null;
    const passedByIcon = Boolean(card?.querySelector('.ps-correcta, img[src*="/ok."]'));
    const attemptsExhausted = Boolean(
      /Intentos\s+terminados/i.test(text) ||
      (attemptsUsed !== null && attemptsMax !== null && attemptsUsed >= attemptsMax)
    );
    const passed = passedByIcon || (score !== null && passingScore !== null && score >= passingScore);
    const isAttempted = Boolean((attemptsUsed || 0) > 0 || (score !== null && score !== 0));

    return {
      title: clipText(card?.querySelector('span[style*="font-size: 15px"], span[style*="font-size: 20px"]')?.innerText, 180) || null,
      category: clipText(card?.querySelector('img[src*="iconos/"]')?.parentElement?.innerText, 100) || null,
      evaluationType: evaluationMatch ? clipText(evaluationMatch[1], 100) : null,
      attempts: { used: attemptsUsed, max: attemptsMax },
      score,
      passingScore,
      timeLimit: timeMatch ? clipText(timeMatch[1], 80) : null,
      status: passed ? 'PASSED' : (attemptsExhausted ? 'ATTEMPTS_EXHAUSTED' : (isAttempted ? 'ATTEMPTED' : 'PENDING')),
      isPassed: passed,
      isAttempted,
      attemptsExhausted,
      rawText: text
    };
  }

  function collectTimingInfo() {
    const timerSelectors = [
      '#dialog_timer', '#timer', '#exercise-timer', '.timer',
      '[id*="timer"]', '[class*="timer"]', '[id*="time"]', '[class*="time"]'
    ].join(',');
    const timerElements = Array.from(document.querySelectorAll(timerSelectors))
      .filter(element => isVisible(element))
      .slice(0, 12)
      .map(element => ({ selector: getElementSelector(element), text: clipText(element.innerText || element.textContent, 120) }));
    const visibleText = redactText(document.body?.innerText, 6000);
    const limitMatch = visibleText.match(/Límite\s+de\s+tiempo\s*:\s*([\d\s:]+)/i);
    return {
      limit: limitMatch ? clipText(limitMatch[1], 80) : null,
      visibleTimers: timerElements
    };
  }

  function wordBoxSourceRoot() {
    return document.querySelector('#matching-word-sortable, .matching-word-sortable');
  }

  function wordBoxSourceElements() {
    const root = wordBoxSourceRoot();
    const candidates = Array.from(new Set([
      ...document.querySelectorAll('[id^="id_mtc_p_"]'),
      ...document.querySelectorAll('li[id^="id_mtc_q"]')
    ]));
    return candidates.filter(element => {
      const text = normalizeSemanticText(element.innerText || element.textContent);
      return root?.contains(element) && text && isVisible(element) && !isBridgeElement(element);
    });
  }

  function wordBoxGapElements() {
    const root = wordBoxSourceRoot();
    const candidates = Array.from(new Set([
      ...document.querySelectorAll('[id^="id_mtc_p_"]'),
      ...document.querySelectorAll('li[id^="id_mtc_q"]')
    ]));
    return candidates.filter(element => {
      return !root?.contains(element) && isVisible(element) && !isBridgeElement(element) &&
        element.matches('li, .ui-sortable-handle, [class*="matching-word"]');
    });
  }

  function collectWordBoxState() {
    const sourceRoot = wordBoxSourceRoot();
    const sourceElements = wordBoxSourceElements();
    const gapElements = wordBoxGapElements();

    if (!sourceRoot && sourceElements.length === 0 && gapElements.length === 0) return null;

    const describeLine = element => {
      const line = element.closest('p, .matching-word-content, .matching-word-question, .exercise-question, .question') || element.parentElement;
      return {
        text: redactText(line?.innerText || '', 800),
        selector: line ? getElementSelector(line) : null
      };
    };

    const words = sourceElements.map((element, index) => ({
      index,
      id: element.id || null,
      text: clipText(element.innerText || element.textContent, 120),
      selector: getElementSelector(element),
      className: redactText(String(element.className || ''), 160),
      visible: isVisible(element)
    }));
    const gaps = gapElements.map((element, index) => {
      const line = describeLine(element);
      const text = clipText(element.innerText || element.textContent, 120);
      return {
        index,
        id: element.id || null,
        text,
        filled: Boolean(normalizeSemanticText(text)),
        selector: getElementSelector(element),
        className: redactText(String(element.className || ''), 160),
        lineText: line.text,
        lineSelector: line.selector,
        visible: isVisible(element)
      };
    });

    return {
      sourceSelector: sourceRoot ? getElementSelector(sourceRoot) : null,
      wordCount: words.length,
      gapCount: gaps.length,
      remainingWords: words.length,
      filledGaps: gaps.filter(gap => gap.filled).length,
      words,
      gaps
    };
  }

  function collectProofreadingState() {
    const proofreadingTable = document.querySelector('table.table-striped');
    const proofreadingMarkers = [
      'this is a proofreading exercise',
      'some of the lines in the passage have mistakes'
    ];
    const markerCandidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, div, span, strong'))
      .filter(element => isVisible(element))
      .filter(element => {
        const text = normalizeSemanticText(element.innerText || element.textContent);
        return proofreadingMarkers.some(marker => text.includes(marker));
      })
      .sort((left, right) => String(left.innerText || '').length - String(right.innerText || '').length);
    const marker = markerCandidates[0] || null;
    const root = proofreadingTable ||
      marker?.closest?.('form, .exercise-content, .proofreading-content, .cs-section-content, .col-lg-12') ||
      marker?.parentElement?.parentElement || marker?.parentElement || null;
    const tokenSelector = [
      '[onclick]', '[data-word]', '[data-token]', '[data-word-index]',
      '.proofreading-word', '.proofreading-token', '.word-token', '.word'
    ].join(',');
    const explicitScope = root || document;
    const explicitTokens = Array.from(explicitScope.querySelectorAll(tokenSelector));
    const leafTokens = root ? Array.from(root.querySelectorAll('*')).filter(element => {
      if (!isVisible(element) || isBridgeElement(element)) return false;
      const visibleChildren = Array.from(element.children).filter(child => isVisible(child));
      const raw = String(element.innerText || element.textContent || '');
      return visibleChildren.length === 0 && raw.length <= 80;
    }) : [];
    const tokenElements = Array.from(new Set([...explicitTokens, ...leafTokens]));
    const tokens = tokenElements
      .filter(element => isVisible(element) && !isBridgeElement(element))
      .map((element, index) => {
        const line = element.closest('tr, .proofreading-line, [class*="proof"], p, li') || element.parentElement;
        const rawText = String(element.innerText ?? element.textContent ?? '').slice(0, 80);
        const text = clipText(rawText, 80) || (rawText.length ? '[WHITESPACE_OR_PUNCTUATION]' : '');
        return {
          index,
          text,
          rawText,
          className: redactText(String(element.className || ''), 160),
          operationMarkers: {
            added: /add-word|add-txt|word_insert/i.test(String(element.className || '')),
            changed: /word_change|change-txt/i.test(String(element.className || '')),
            deleted: /word_delete|delete-txt/i.test(String(element.className || ''))
          },
          normalizedText: normalizeSemanticText(text),
          selector: getElementSelector(element),
          selectorCandidates: getSelectorCandidates(element),
          lineText: redactText(line?.innerText || '', 500),
          lineSelector: line ? getElementSelector(line) : null,
          tokenLike: text.length <= 80,
          hasOnclick: element.hasAttribute('onclick')
        };
      })
      .slice(0, 500);

    const lines = collectProofreadingLines(root || document);

    const modalFields = ['#word-modal', '#change-word-modal']
      .map(selector => document.querySelector(selector))
      .filter(Boolean);
    const modalElements = modalFields.map(field => field.closest?.('.modal, [role="dialog"]')).filter(Boolean);
    const visibleModal = modalElements.find(modal => isVisible(modal)) || null;
    const buttons = visibleModal
      ? Array.from(visibleModal.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(button => isVisible(button))
        .map(button => ({ text: clipText(button.innerText || button.value, 80), selector: getElementSelector(button) }))
      : [];

    return {
      rootSelector: root ? getElementSelector(root) : null,
      markerSelector: marker ? getElementSelector(marker) : null,
      tokenCount: tokens.length,
      tokens,
      lines,
      reasoningContract: {
        requiredPerLine: ['error', 'operation', 'correction', 'correctedSentence'],
        operations: ['CHANGE', 'DELETE', 'INSERT'],
        markerFields: ['changes', 'deleted', 'added']
      },
      modalOpen: Boolean(visibleModal),
      modal: visibleModal ? {
        selector: getElementSelector(visibleModal),
        originalWord: redactText(document.querySelector('#word-modal')?.value, 120),
        replacementValue: redactText(document.querySelector('#change-word-modal')?.value, 120),
        buttons
      } : null
    };
  }

  function collectProofreadingLines(root) {
    const candidates = Array.from(root.querySelectorAll('tr, p, .proofreading-line, [class*="proofreading"], [class*="proof"]'))
      .filter(element => isVisible(element))
      .map((element, index) => {
        const text = redactText(element.innerText || element.textContent, 1800);
        const marker = parseProofreadingMarkers(text);
        return {
          index,
          text,
          selector: getElementSelector(element),
          markers: marker,
          hasCorrectionMarkers: marker.changes > 0 || marker.deleted > 0 || marker.added > 0
        };
      })
      .filter(line => line.hasCorrectionMarkers || line.text.length > 60);
    return candidates.slice(0, 100);
  }

  function parseProofreadingMarkers(text) {
    const markers = { changes: 0, deleted: 0, added: 0 };
    const pattern = /(\d+)\s+(cambio|cambios|eliminado|eliminados|agregar|agregados)/gi;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      const count = Number(match[1]) || 0;
      const label = match[2].toLowerCase();
      if (label.startsWith('cambio')) markers.changes += count;
      else if (label.startsWith('elimin')) markers.deleted += count;
      else if (label.startsWith('agreg')) markers.added += count;
    }
    return markers;
  }

  function getVisualCorrectness(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return { status: 'UNKNOWN', evidence: [] };
    const scopes = [
      element.closest?.('.multiple_choice_item, .question, .exercise-question, .question-item, .answer-item, tr'),
      element.closest?.('label'),
      element.parentElement,
      element.parentElement?.parentElement,
      element.closest?.('div.row'),
      element.closest?.('div.row')?.parentElement
    ].filter(Boolean);
    let ancestor = element.parentElement;
    for (let index = 0; ancestor && index < 6; index += 1, ancestor = ancestor.parentElement) {
      scopes.push(ancestor);
    }
    const evidence = [];
    for (const scope of Array.from(new Set(scopes))) {
      const indicators = Array.from(scope.querySelectorAll?.('img.ps-correcta, img[src*="/ok."], img[src*="/error."]') || []);
      if (indicators.length === 1) {
        const source = String(indicators[0].getAttribute('src') || '').toLowerCase();
        if (/error\.(png|svg|jpg)/i.test(source) || indicators[0].classList.contains('ps-incorrecta')) {
          return { status: 'INCORRECT', evidence: ['img de evaluación /images/error.png en la pregunta'] };
        }
        if (/ok\.(png|svg|jpg)/i.test(source) || indicators[0].classList.contains('ps-correcta')) {
          return { status: 'CORRECT', evidence: ['img de evaluación /images/ok.png en la pregunta'] };
        }
      }
      const classText = String(scope.className || '').toLowerCase();
      const htmlText = String(scope.innerHTML || '').toLowerCase().slice(0, 12000);
      if (/incorrect|wrong|error|ps-incorrecta|icon-times|[/\\]error\.(png|svg|jpg)/i.test(classText + ' ' + htmlText)) {
        evidence.push('indicador visual de error en el contenedor');
        return { status: 'INCORRECT', evidence };
      }
      if (/correct|success|ps-correcta|icon-check|[/\\]ok\.(png|svg|jpg)/i.test(classText + ' ' + htmlText)) {
        evidence.push('indicador visual de acierto en el contenedor');
        return { status: 'CORRECT', evidence };
      }
    }
    return { status: 'UNKNOWN', evidence };
  }

  function normalizeSemanticText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^\s*[a-d][.)]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getChoiceContext(element) {
    const labelElement = element.closest?.('label') || element.parentElement?.querySelector?.('label');
    const optionText = clipText(labelElement?.innerText || element.parentElement?.innerText || element.value, 260);
    const container = element.closest?.('.multiple_choice_item, .question, .exercise-question, .question-item, .radio-group, li, tr') || element.parentElement?.parentElement;
    const questionCandidates = container
      ? Array.from(container.querySelectorAll('.question-text, .question-title, .multiple_choice_question, [class*="question-title"], h1, h2, h3, h4, p, strong'))
      : [];
    const optionNormalized = normalizeSemanticText(optionText);
    const questionElement = questionCandidates.find(candidate => {
      const candidateText = normalizeSemanticText(candidate.innerText || candidate.textContent);
      return candidateText && candidateText !== optionNormalized && !candidateText.includes(optionNormalized);
    });
    const lines = String(container?.innerText || '').split(/\n+/).map(line => clipText(line, 260)).filter(Boolean);
    const fallbackQuestion = lines.find(line => {
      const normalized = normalizeSemanticText(line);
      return normalized && normalized !== optionNormalized && !/^[a-d][.)]\s/i.test(line);
    }) || '';
    const questionText = clipText(questionElement?.innerText || fallbackQuestion, 300);
    return {
      questionText,
      optionText,
      questionKey: normalizeSemanticText(questionText),
      optionKey: normalizeSemanticText(optionText),
      semanticKey: `${normalizeSemanticText(questionText)}::${normalizeSemanticText(optionText)}`,
      questionSelector: container ? getElementSelector(container) : null
    };
  }

  function extractSemanticState() {
    const url = window.location.href;
    const timestamp = Date.now();
    const parsedUrl = new URL(url);

    const inputIns = document.querySelector('#id-ins')?.value || '';
    const inputMod = document.querySelector('#id-mod')?.value || '';
    const inputUni = document.querySelector('#id-uni')?.value || '';
    const inputE = document.querySelector('#id-e')?.value || '';

    let view = 'OTHER';
    if (/\/me\/courses\/\d+\/theme\/\d+\/lessons\/\d+\/exercises\/\d+/.test(url) || document.querySelector('#id-e, #save-exercise, .exercisesTab')) {
      view = 'EXERCISE';
    } else if (/\/me\/courses\/\d+\/plan/.test(url) || document.querySelector('.start-exercise-link')) {
      view = 'PLAN';
    } else if (/\/me\/courses\/\d+/.test(url) || document.querySelector('.contentCourseLine, [id^="bgMdData"]')) {
      view = 'COURSE_DASHBOARD';
    }

    const state = {
      type: 'STATE_UPDATE',
      schemaVersion: 2,
      agentVersion: AGENT_VERSION,
      pageId: PAGE_ID,
      runStartedAt: RUN_STARTED_AT,
      timestamp,
      view,
      url,
      ids: {
        courseId: inputIns || (url.match(/courses\/(\d+)/) || [])[1] || null,
        moduleId: inputMod || (url.match(/theme\/(\d+)/) || [])[1] || parsedUrl.searchParams.get('m') || null,
        lessonId: inputUni || (url.match(/lessons\/(\d+)/) || [])[1] || parsedUrl.searchParams.get('u') || null,
        exerciseId: inputE || (url.match(/exercises\/(\d+)/) || [])[1] || null
      },
      dashboard: null,
      plan: null,
      exercise: null,
      lastAction: lastActionSummary,
      review: {
        status: lastReviewStatus,
        preflight: lastPreflightReview,
        postflight: lastPostflightReview
      },
      observability: null
    };

    if (view === 'COURSE_DASHBOARD') {
      const modules = [];
      document.querySelectorAll('[id^="scrollMlLc"]').forEach(modEl => {
        const modId = modEl.getAttribute('data-id');
        const lessons = [];
        modEl.querySelectorAll('.divMd' + modId).forEach(lEl => {
          const title = lEl.querySelector('b:not(.color_orange)')?.innerText?.trim() || '';
          const lessonNumber = lEl.querySelector('b.color_orange, b[style*="font-size:25px"]')?.innerText?.trim() || '';
          const score = lEl.querySelector('span[style*="font-size:25px"]')?.innerText?.trim() || '0';
          const btn = lEl.querySelector('button[onclick*="/plan?"]');
          const planUrl = btn?.getAttribute('onclick')?.match(/'(.*?)'/)?.[1] || '';
          const exercisesText = lEl.innerText.match(/Ejercicios:\s*(\d+)\s*de\s*(\d+)/i);

          lessons.push({
            lessonNumber,
            title,
            score: parseInt(score, 10) || 0,
            planUrl,
            exercisesCompleted: exercisesText ? parseInt(exercisesText[1], 10) : 0,
            exercisesTotal: exercisesText ? parseInt(exercisesText[2], 10) : 0,
            selector: btn ? `button[onclick*="${planUrl}"]` : null
          });
        });
        modules.push({ moduleId: modId, lessons });
      });
      state.dashboard = { modules };
    }

    if (view === 'PLAN') {
      const exercises = [];
      document.querySelectorAll('.start-exercise-link').forEach((link, idx) => {
        const href = link.getAttribute('data-href') || '';
        const lessonMatch = href.match(/\/lessons\/(\d+)\//);
        const lessonId = lessonMatch ? lessonMatch[1] : null;
        const section = link.closest('.div_contenido_unidad');
        const metadata = parsePlanExerciseMetadata(link);
        exercises.push({
          index: idx,
          tipo: link.getAttribute('data-tipo') || 'desconocido',
          isOpen: link.getAttribute('data-abierto') === 'true',
          isClosed: link.getAttribute('data-closed') === 'true',
          href,
          lessonId,
          visible: isVisible(link),
          sectionVisible: section ? isVisible(section) : true,
          selector: `.start-exercise-link[data-href="${escapeCssAttribute(href)}"]`,
          ...metadata
        });
      });
      const currentLessonId = state.ids.lessonId;
      const currentLessonExercises = currentLessonId
        ? exercises.filter(exercise => exercise.lessonId === String(currentLessonId))
        : exercises;
      const sections = {};
      exercises.forEach(exercise => {
        const key = exercise.lessonId || 'unknown';
        sections[key] = (sections[key] || 0) + 1;
      });
      state.plan = {
        currentLessonId,
        totalLinksOnPage: exercises.length,
        sections,
        exercises,
        currentLessonExercises,
        visibleExercises: exercises.filter(exercise => exercise.visible && exercise.sectionVisible),
        progressSummary: {
          total: exercises.length,
          passed: exercises.filter(exercise => exercise.isPassed).length,
          attempted: exercises.filter(exercise => exercise.isAttempted).length,
          pending: exercises.filter(exercise => exercise.status === 'PENDING').length,
          attemptsExhausted: exercises.filter(exercise => exercise.attemptsExhausted).length
        }
      };
    }

    if (view === 'EXERCISE') {
      const title = document.querySelector('.nameClassExercises')?.innerText?.trim() || '';
      const instruction = document.querySelector('.cs-color-tt-exce')?.innerText?.trim() || '';
      const iconImg = document.querySelector('.cs-section-title img[src*="iconos"]');
      let exerciseType = '';
      if (iconImg) {
        const match = iconImg.src.match(/iconos\/([a-zA-Z0-9_-]+)\.png/);
        if (match) exerciseType = match[1];
      }
      if (!exerciseType) {
        if (document.querySelector('#div-content-mp')) exerciseType = 'matching_pairs';
        else if (document.querySelector('.gap_fill')) exerciseType = 'gap_fill';
        else if (document.querySelector('.multiple_choice_item')) exerciseType = 'multiple_choice';
        else if (document.querySelector('#matching-word-sortable, [id^="id_mtc_p_"], li[id^="id_mtc_q"]')) exerciseType = 'word_box';
        else exerciseType = 'texto';
      }
      if (exerciseType === 'matching_words') exerciseType = 'word_box';

      const matchingQuestions = [];
      const matchingAnswers = [];
      if (exerciseType === 'matching_pairs' || document.querySelector('#div-content-mp')) {
        document.querySelectorAll('.question[id^="p_"]').forEach(q => {
          const qId = q.id.replace('p_', '');
          const text = q.querySelector('.multimedia_matching')?.innerText?.trim() || q.innerText?.trim();
          const visual = getMatchingVisualStatus(q);
          matchingQuestions.push({
            id: qId,
            questionId: q.id,
            text,
            selector: `#${q.id}`,
            isDone: q.classList.contains('column-done-mp'),
            visualStatus: visual.status,
            visualEvidence: visual.evidence
          });
        });

        document.querySelectorAll('.answer[id^="r_"]').forEach(a => {
          const inner = a.querySelector('.multimedia_matching');
          const dataIdp = inner?.getAttribute('data-idp') || null;
          const text = inner?.innerText?.trim() || a.innerText?.trim();
          const visual = getMatchingVisualStatus(a);
          matchingAnswers.push({
            id: a.id,
            dataIdp,
            text,
            selector: `#${a.id} .multimedia_matching`,
            isDone: a.classList.contains('column-done-mp'),
            visualStatus: visual.status,
            visualEvidence: visual.evidence
          });
        });
      }

      const inputs = [];
      document.querySelectorAll('input[type="text"], input.gap_fill, textarea').forEach((inp, idx) => {
        if (isBridgeElement(inp)) return;
          inputs.push({
            index: idx,
            name: inp.name || '',
            id: inp.id || '',
            value: isSensitiveField(inp, 'value') ? '[REDACTED]' : (inp.value || ''),
            placeholder: inp.placeholder || '',
            dataAnswer: isSensitiveField(inp) ? null : (inp.getAttribute('data-answer') || inp.getAttribute('data-correct') || inp.getAttribute('data-val') || null),
            selector: inp.id ? `#${inp.id}` : (inp.name ? `input[name="${inp.name}"]` : `input:nth-of-type(${idx + 1})`)
          });
      });

      const choices = [];
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((ch, idx) => {
        if (isBridgeElement(ch)) return;
        const label = ch.closest('label')?.innerText?.trim() || ch.parentElement?.innerText?.trim() || '';
        const visual = getVisualCorrectness(ch);
        const semantic = getChoiceContext(ch);
        choices.push({
          index: idx,
          name: ch.name || '',
          value: ch.value || '',
          label,
          checked: ch.checked,
          dataCorrect: ch.getAttribute('data-correct') || null,
          visualStatus: visual.status,
          visualEvidence: visual.evidence,
          questionText: semantic.questionText,
          optionText: semantic.optionText || label,
          semanticKey: semantic.semanticKey,
          questionSelector: semantic.questionSelector,
          selector: ch.id ? `#${ch.id}` : `input[name="${ch.name}"][value="${ch.value}"]`
        });
      });

      const saveBtn = document.querySelector('#save-exercise');
      const nextBtn = document.querySelector('.btn-next-exercise, .div_botones a, a[href*="/exercises/"]');
      const scoreElem = document.querySelector('.view_modal_score');
      const wordBox = exerciseType === 'word_box' ? collectWordBoxState() : null;

      state.exercise = {
        title,
        instruction,
        type: exerciseType,
        matchingPairs: {
          questions: matchingQuestions,
          answers: matchingAnswers
        },
        proofreading: exerciseType === 'proofreading' ? collectProofreadingState() : null,
        wordBox,
        inputs,
        choices,
        isEvaluated: !!scoreElem || (saveBtn && saveBtn.style.display === 'none'),
        score: scoreElem ? scoreElem.innerText.trim() : null,
        canSubmit: !!(saveBtn && !saveBtn.disabled),
        canAdvance: !!nextBtn,
        nextSelector: nextBtn ? '.btn-next-exercise, .div_botones a, a[href*="/exercises/"]' : null,
        timing: collectTimingInfo(),
        matchingReview: {
          correct: matchingQuestions.filter(item => item.visualStatus === 'CORRECT').length,
          incorrect: matchingQuestions.filter(item => item.visualStatus === 'INCORRECT').length,
          unknown: matchingQuestions.filter(item => item.visualStatus === 'UNKNOWN').length,
          paired: matchingQuestions.filter(item => item.isDone).length
        },
        visualReview: {
          correct: choices.filter(choice => choice.visualStatus === 'CORRECT').length,
          incorrect: choices.filter(choice => choice.visualStatus === 'INCORRECT').length,
          unknown: choices.filter(choice => choice.visualStatus === 'UNKNOWN').length,
          checkedIncorrect: choices.filter(choice => choice.checked && choice.visualStatus === 'INCORRECT').map(choice => choice.selector),
          checkedCorrect: choices.filter(choice => choice.checked && choice.visualStatus === 'CORRECT').map(choice => choice.selector)
        }
      };
    }

    state.observability = collectObservability();
    state.observability.dom.structureTruncated = state.observability.dom.nodesIncluded >= state.observability.dom.nodesLimit;

    return state;
  }

  // ==========================================
  // 3. DESPACHADOR SEGURO DE ACCIONES (ALLOWLIST)
  // ==========================================
  function requireSelector(selector) {
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 600) {
      throw new Error('Selector inválido o demasiado largo.');
    }
    return selector.trim();
  }

  function queryActionElement(selector, options = {}) {
    const safeSelector = requireSelector(selector);
    let elements;
    try {
      elements = Array.from(document.querySelectorAll(safeSelector));
    } catch (error) {
      throw new Error(`Selector CSS inválido: ${error.message}`);
    }
    if (!elements.length) throw new Error(`Elemento no encontrado: ${safeSelector}`);
    if (elements.some(isBridgeElement) && !options.allowBridge) {
      throw new Error('No se permiten acciones sobre los controles del agente.');
    }
    if (Number.isInteger(options.matchIndex)) {
      if (options.matchIndex < 0 || options.matchIndex >= elements.length) {
        throw new Error(`Índice fuera de rango: ${options.matchIndex}`);
      }
      elements = [elements[options.matchIndex]];
    }
    if (options.unique !== false && elements.length > 1) {
      throw new Error(`Selector ambiguo: encontró ${elements.length} elementos.`);
    }
    const element = elements[0];
    if (options.visible !== false && !isVisible(element)) {
      throw new Error(`Elemento no visible: ${safeSelector}`);
    }
    return element;
  }

  function inspectElement(element, includeHtml = false) {
    const attributes = {};
    Array.from(element.attributes || []).forEach(attribute => {
      const name = attribute.name;
      const sensitive = /password|token|cookie|authorization|secret|session/i.test(name) || isSensitiveField(element, name);
      attributes[name] = sensitive ? '[REDACTED]' : redactText(attribute.value, 300);
    });
    const computed = isVisible(element) ? getComputedStyle(element) : null;
    const children = Array.from(element.children || []).slice(0, 40).map(child => ({
      tag: child.tagName.toLowerCase(),
      id: child.id || null,
      className: redactText(String(child.className || ''), 180),
      text: redactText(child.innerText || child.textContent, 180),
      selector: getElementSelector(child)
    }));
    return {
      tag: element.tagName.toLowerCase(),
      selector: getElementSelector(element),
      visible: isVisible(element),
      text: redactText(element.innerText || element.textContent, 600),
      attributes,
      childCount: element.children?.length || 0,
      children,
      style: computed ? {
        display: computed.display,
        visibility: computed.visibility,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        opacity: computed.opacity
      } : null,
      html: includeHtml ? redactText(element.outerHTML, 5000) : null
    };
  }

  function collectActionReviewSnapshot() {
    const checked = Array.from(document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked'))
      .filter(element => !isBridgeElement(element))
      .map(element => ({ selector: getElementSelector(element), name: element.name, value: redactText(element.value, 120) }));
    const selects = Array.from(document.querySelectorAll('select'))
      .filter(element => isVisible(element))
      .map(element => ({ selector: getElementSelector(element), value: redactText(element.value, 120), text: redactText(element.selectedOptions?.[0]?.textContent, 120) }));
    const matchingQuestions = Array.from(document.querySelectorAll('.question[id^="p_"]'));
    const proofreadingInput = document.querySelector('#change-word-modal');
    const proofreadingTokens = Array.from(document.querySelectorAll('span.word_change, span.word_insert, span.word_delete, span.add-word-pfd, span.change-txt-pfd, span.delete-txt-pfd'))
      .filter(element => !isBridgeElement(element))
      .slice(0, 120)
      .map(element => ({
        // El selector completo de cientos de tokens bloquea el preflight en
        // documentos grandes. El inventario completo vive en el snapshot;
        // aquí solo se necesita evidencia compacta para la postcondición.
        selector: element.id ? `#${CSS.escape(element.id)}` : null,
        text: redactText(element.innerText || element.textContent, 100),
        className: redactText(String(element.className || ''), 160),
        operationMarkers: {
          added: /add-word|add-txt|word_insert/i.test(String(element.className || '')),
          changed: /word_change|change-txt/i.test(String(element.className || '')),
          deleted: /word_delete|delete-txt/i.test(String(element.className || ''))
        }
      }));
    const scoreElement = document.querySelector('.view_modal_score');
    const wordBoxState = collectWordBoxState();
    const snapshot = {
      timestamp: Date.now(),
      path: redactUrl(window.location.href).path,
      view: /\/exercises\//.test(window.location.pathname) ? 'EXERCISE' : (/\/plan/.test(window.location.pathname) ? 'PLAN' : 'OTHER'),
      checked,
      selects,
      matching: {
        paired: matchingQuestions.filter(matchingIsDone).length,
        correct: matchingQuestions.filter(element => getMatchingVisualStatus(element).status === 'CORRECT').length,
        incorrect: matchingQuestions.filter(element => getMatchingVisualStatus(element).status === 'INCORRECT').length
      },
      proofreading: {
        modalOpen: Boolean(proofreadingInput && isVisible(proofreadingInput)),
        originalWord: proofreadingInput ? redactText(document.querySelector('#word-modal')?.value, 120) : null,
        replacementValue: proofreadingInput ? redactText(proofreadingInput.value, 120) : null,
        tokenStates: proofreadingTokens
      },
      wordBox: wordBoxState ? {
        wordCount: wordBoxState.wordCount,
        gapCount: wordBoxState.gapCount,
        remainingWords: wordBoxState.remainingWords,
        filledGaps: wordBoxState.filledGaps,
        gaps: wordBoxState.gaps.map(gap => ({ selector: gap.selector, text: gap.text, filled: gap.filled }))
      } : null,
      score: scoreElement ? redactText(scoreElement.innerText, 80) : null,
      canSubmit: Boolean(document.querySelector('#save-exercise:not(:disabled)'))
    };
    snapshot.signature = JSON.stringify({
      path: snapshot.path,
      view: snapshot.view,
      checked: snapshot.checked,
      selects: snapshot.selects,
      matching: snapshot.matching,
      proofreading: snapshot.proofreading,
      wordBox: snapshot.wordBox,
      score: snapshot.score,
      canSubmit: snapshot.canSubmit
    });
    return snapshot;
  }

  function buildActionReview(actionContext, status) {
    if (!actionContext?.reviewBefore) return null;
    const after = collectActionReviewSnapshot();
    const before = actionContext.reviewBefore;
    const changed = before.signature !== after.signature;
    let reviewStatus = 'UNKNOWN';
    let expected = null;
    let observed = null;

    if (status !== 'SUCCESS') {
      reviewStatus = 'FAILED';
    } else if (actionContext.action === 'FILL') {
      const element = document.querySelector(actionContext.payload.selector);
      const expectedValue = String(actionContext.payload.value ?? '');
      const actualValue = element && 'value' in element ? String(element.value) : '';
      expected = { selector: actionContext.payload.selector, valueLength: expectedValue.length };
      observed = { valueLength: actualValue.length, matches: actualValue === expectedValue };
      reviewStatus = observed.matches ? 'VERIFIED' : 'FAILED';
    } else if (actionContext.action === 'SELECT_OPTION') {
      const element = document.querySelector(actionContext.payload.selector);
      const expectedValue = String(actionContext.payload.value ?? '');
      const expectedLabel = String(actionContext.payload.label ?? '');
      const actualValue = element?.value || '';
      const actualLabel = element?.selectedOptions?.[0]?.textContent?.trim() || '';
      expected = { selector: actionContext.payload.selector, value: expectedValue || null, label: expectedLabel || null };
      observed = { value: actualValue, label: actualLabel };
      reviewStatus = (expectedValue && actualValue === expectedValue) || (expectedLabel && actualLabel === expectedLabel) ? 'VERIFIED' : 'FAILED';
    } else if (actionContext.action === 'SET_CHECKBOX') {
      const element = document.querySelector(actionContext.payload.selector);
      expected = { selector: actionContext.payload.selector, checked: Boolean(actionContext.payload.checked) };
      observed = { checked: Boolean(element?.checked) };
      reviewStatus = observed.checked === expected.checked ? 'VERIFIED' : 'FAILED';
    } else if (['PROOFREADING_OPEN_WORD', 'PROOFREADING_OPEN_TOKEN'].includes(actionContext.action)) {
      expected = { modalOpen: true };
      observed = after.proofreading;
      reviewStatus = after.proofreading.modalOpen ? 'VERIFIED' : 'FAILED';
    } else if (['PROOFREADING_REPLACE', 'PROOFREADING_INSERT', 'PROOFREADING_DELETE', 'PROOFREADING_CANCEL'].includes(actionContext.action)) {
      const tokenState = currentProofreadingToken
        ? after.proofreading.tokenStates.find(token => token.selector === currentProofreadingToken.selector)
        : null;
      const markerApplied = tokenState?.operationMarkers?.changed || tokenState?.operationMarkers?.added || tokenState?.operationMarkers?.deleted;
      expected = {
        modalOpen: false,
        operation: actionContext.action,
        visualMarker: actionContext.action === 'PROOFREADING_DELETE' ? 'deleted' : (actionContext.action === 'PROOFREADING_INSERT' ? 'added' : 'changed/added')
      };
      observed = after.proofreading;
      reviewStatus = markerApplied ? 'VERIFIED' : (after.proofreading.modalOpen ? 'UNKNOWN' : 'OBSERVED');
    } else if (['WORD_BOX_PLACE', 'WORD_BOX_PLACE_ALL'].includes(actionContext.action)) {
      const beforeWordBox = before.wordBox || { filledGaps: 0, remainingWords: 0 };
      const afterWordBox = after.wordBox || { filledGaps: 0, remainingWords: 0 };
      expected = { placementApplied: true, word: actionContext.payload?.wordText || null };
      observed = afterWordBox;
      reviewStatus = changed && afterWordBox.filledGaps >= beforeWordBox.filledGaps
        ? 'VERIFIED'
        : 'UNKNOWN';
    } else if (['MATCH_PAIR', 'MATCH_SEMANTIC_PAIRS'].includes(actionContext.action)) {
      expected = { pairingApplied: true, correctness: 'requires_evaluation' };
      observed = after.matching;
      reviewStatus = changed && after.matching.paired >= before.matching.paired ? 'OBSERVED' : 'UNKNOWN';
    } else if (['NAVIGATE_SAME_ORIGIN', 'NAVIGATE_NEXT'].includes(actionContext.action)) {
      expected = { pathChanged: true };
      observed = { before: before.path, after: after.path };
      reviewStatus = before.path !== after.path ? 'VERIFIED' : 'UNKNOWN';
    } else if (actionContext.action === 'SUBMIT') {
      expected = { evaluated: true, scoreVisible: true };
      observed = { score: after.score, canSubmit: after.canSubmit };
      reviewStatus = after.score || !after.canSubmit ? 'VERIFIED' : 'UNKNOWN';
    } else {
      reviewStatus = changed ? 'OBSERVED' : 'UNKNOWN';
      observed = { changed };
    }

    return {
      status: reviewStatus,
      timestamp: Date.now(),
      action: actionContext.action,
      changed,
      expected,
      observed,
      preflight: before,
      postflight: after
    };
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function requireConfirmed(action, payload) {
    if (payload?.confirmed !== true) {
      throw new Error(`La acción "${action}" requiere confirmación explícita.`);
    }
  }

  function actionResult(status, startedAt, data = {}, error = null) {
    const result = {
      action: currentAction?.action || null,
      status,
      executionTimeMs: performance.now() - startedAt,
      pageId: PAGE_ID,
      data,
      ...(error ? { error: redactText(error, 400) } : {})
    };
    const review = buildActionReview(currentAction, status);
    if (review) {
      result.review = review;
      lastPreflightReview = review.preflight;
      lastPostflightReview = review.postflight;
      lastReviewStatus = review.status;
    }
    lastActionSummary = {
      timestamp: Date.now(),
      status,
      executionTimeMs: Math.round(result.executionTimeMs),
      error: error ? redactText(error, 300) : null,
      reviewStatus: review?.status || null
    };
    return result;
  }

  function matchingText(element) {
    if (!element) return '';
    return clipText(element.querySelector?.('.multimedia_matching')?.innerText || element.innerText || element.textContent, 320);
  }

  function matchingRoot(element) {
    return element?.closest?.('.question[id^="p_"], .answer[id^="r_"]') || element;
  }

  function matchingIsDone(element) {
    const root = matchingRoot(element);
    if (!root) return false;
    const classText = String(root.className || '').toLowerCase();
    return root.classList.contains('column-done-mp') ||
      root.getAttribute('data-done') === 'true' ||
      root.getAttribute('aria-selected') === 'true' ||
      /column-done|matched|correct/.test(classText);
  }

  function getMatchingVisualStatus(element) {
    const root = matchingRoot(element);
    const row = root?.closest?.('.div-row-mp, .matching-pair-div-content') || root;
    if (!row) return { status: 'UNKNOWN', evidence: [] };
    const source = `${String(row.className || '')} ${String(row.innerHTML || '')}`.toLowerCase();
    if (/error\.(png|svg|jpg)|icon-times|incorrect|wrong/.test(source)) {
      return { status: 'INCORRECT', evidence: ['indicador visual de error en la fila'] };
    }
    if (/ok\.(png|svg|jpg)|icon-check|correct/.test(source)) {
      return { status: 'CORRECT', evidence: ['indicador visual de acierto en la fila'] };
    }
    return { status: 'UNKNOWN', evidence: [] };
  }

  function resolveMatchingElement(spec, role) {
    const text = role === 'question' ? spec.questionText : spec.answerText;
    const expected = normalizeSemanticText(text);
    if (!expected) throw new Error(`Falta ${role === 'question' ? 'questionText' : 'answerText'} semántico.`);

    const candidateSelector = role === 'question' ? '.question[id^="p_"]' : '.answer[id^="r_"]';
    const candidates = Array.from(document.querySelectorAll(candidateSelector))
      .filter(element => isVisible(matchingRoot(element)) && !isBridgeElement(element))
      .filter(element => normalizeSemanticText(matchingText(element)) === expected);
    if (candidates.length !== 1) {
      throw new Error(`No se encontró un ${role} semántico único: ${redactText(text, 180)} (encontrados: ${candidates.length}).`);
    }
    return role === 'answer'
      ? (candidates[0].querySelector('.multimedia_matching') || candidates[0])
      : candidates[0];
  }

  async function waitForMatchingDone(pair, timeoutMs = 1400) {
    const deadline = Date.now() + Math.max(300, Math.min(Number(timeoutMs) || 1400, 5000));
    while (Date.now() < deadline) {
      try {
        const question = resolveMatchingElement(pair, 'question');
        const answer = resolveMatchingElement(pair, 'answer');
        if (matchingIsDone(question) && matchingIsDone(answer)) return true;
      } catch (error) {
        // El sitio puede quitar/reinsertar las tarjetas durante la animación.
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  async function applySemanticMatchingPair(pair, delayMs = 90) {
    const question = resolveMatchingElement(pair, 'question');
    fireMatchingClick(question);
    await new Promise(resolve => setTimeout(resolve, Math.max(40, Math.min(delayMs, 300))));
    const answer = resolveMatchingElement(pair, 'answer');
    fireMatchingClick(answer);
    if (!(await waitForMatchingDone(pair))) {
      throw new Error(`La pareja no quedó marcada como completada: ${redactText(pair.questionText, 120)} → ${redactText(pair.answerText, 120)}`);
    }
    return true;
  }

  function fireMatchingClick(element) {
    if (!element) throw new Error('Elemento de matching inexistente.');
    element.click();
  }

  function wordBoxSources() {
    return wordBoxSourceElements();
  }

  function resolveWordBoxWord(wordText, wordId) {
    if (wordId) {
      const byId = wordBoxSources().find(element => element.id === String(wordId));
      if (!byId) throw new Error(`No se encontró la palabra disponible con id: ${redactText(wordId, 80)}.`);
      return byId;
    }
    const expected = normalizeSemanticText(wordText);
    if (!expected) throw new Error('WORD_BOX requiere wordText o wordId.');
    const candidates = wordBoxSources()
      .filter(element => normalizeSemanticText(element.innerText || element.textContent) === expected);
    if (candidates.length !== 1) {
      throw new Error(`No se encontró una palabra disponible única: ${redactText(wordText, 120)} (encontradas: ${candidates.length}). Si hay palabras repetidas, usa payload.wordId con el id exacto (p. ej. id_mtc_q2).`);
    }
    return candidates[0];
  }

  function resolveWordBoxGap(spec = {}) {
    let element = null;
    if (spec.gapSelector) {
      element = queryActionElement(spec.gapSelector, { visible: true });
    } else if (spec.gapId) {
      element = document.getElementById(String(spec.gapId));
    } else if (Number.isInteger(spec.gapIndex)) {
      element = wordBoxGapElements()[spec.gapIndex] || null;
    }
    if (!element || !isVisible(element) || isBridgeElement(element)) {
      throw new Error('No se encontró un hueco visible de WORD_BOX.');
    }
    return element;
  }

  function wordBoxGapSelector(spec, element) {
    return spec.gapSelector || (spec.gapId ? `#${String(spec.gapId)}` : getElementSelector(element));
  }

  function createWordBoxMouseEvent(type, point, buttons) {
    const pageWindow = document.defaultView || null;
    const MouseEventConstructor = pageWindow?.MouseEvent || globalThis.MouseEvent;
    const event = new MouseEventConstructor(type, {
      bubbles: true,
      cancelable: true,
      view: pageWindow,
      detail: 1,
      screenX: point.x,
      screenY: point.y,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons
    });
    try {
      Object.defineProperty(event, 'which', { configurable: true, value: buttons ? 1 : 0 });
    } catch (error) {
      // which es de solo lectura en algunos navegadores.
    }
    return event;
  }

  async function dragWordBox(source, target) {
    if (!source || !target) throw new Error('WORD_BOX requiere origen y hueco.');
    source.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const start = { x: sourceRect.left + Math.max(2, sourceRect.width / 2), y: sourceRect.top + Math.max(2, sourceRect.height / 2) };
    const end = { x: targetRect.left + Math.max(2, targetRect.width / 2), y: targetRect.top + Math.max(2, targetRect.height / 2) };
    source.dispatchEvent(createWordBoxMouseEvent('mousedown', start, 1));
    await new Promise(resolve => setTimeout(resolve, 45));
    document.dispatchEvent(createWordBoxMouseEvent('mousemove', { x: start.x + 8, y: start.y + 8 }, 1));
    await new Promise(resolve => setTimeout(resolve, 45));
    document.dispatchEvent(createWordBoxMouseEvent('mousemove', end, 1));
    target.dispatchEvent(createWordBoxMouseEvent('mousemove', end, 1));
    await new Promise(resolve => setTimeout(resolve, 70));
    target.dispatchEvent(createWordBoxMouseEvent('mouseup', end, 0));
    document.dispatchEvent(createWordBoxMouseEvent('mouseup', end, 0));
  }

  async function waitForWordBoxPlacement(gapSelector, wordText, timeoutMs = 1600) {
    const expected = normalizeSemanticText(wordText);
    const deadline = Date.now() + Math.max(300, Math.min(Number(timeoutMs) || 1600, 5000));
    while (Date.now() < deadline) {
      try {
        const gap = document.querySelector(gapSelector);
        const actual = normalizeSemanticText(gap?.innerText || gap?.textContent);
        if (gap && actual && (actual === expected || actual.includes(expected))) return true;
      } catch (error) {
        // El sitio puede re-renderizar el hueco durante la animación.
      }
      await new Promise(resolve => setTimeout(resolve, 45));
    }
    return false;
  }

  async function applyWordBoxPlacement(pair, delayMs = 80) {
    const wordText = pair?.wordText ?? pair?.word ?? pair?.text;
    const wordId = pair?.wordId;
    const source = resolveWordBoxWord(wordText, wordId);
    const gap = resolveWordBoxGap(pair);
    const gapSelector = wordBoxGapSelector(pair, gap);
    await dragWordBox(source, gap);
    await new Promise(resolve => setTimeout(resolve, Math.max(35, Math.min(Number(delayMs) || 80, 300))));
    if (!(await waitForWordBoxPlacement(gapSelector, wordText))) {
      // Algunas variantes antiguas usan clic seleccionado en lugar de drag.
      const freshSource = resolveWordBoxWord(wordText, wordId);
      const freshGap = resolveWordBoxGap({ gapSelector });
      freshSource.click();
      await new Promise(resolve => setTimeout(resolve, 50));
      freshGap.click();
    }
    if (!(await waitForWordBoxPlacement(gapSelector, wordText))) {
      throw new Error(`El hueco no quedó actualizado: ${redactText(wordText, 120)} → ${gapSelector}`);
    }
    return { wordText: clipText(wordText, 120), gapSelector };
  }

  async function executeAtomicAction(action, payload) {
    const startTime = performance.now();

    function fireMouseEvents(element) {
      if (!element) return false;
      // .click() evita incompatibilidades entre el Window del sandbox y el
      // Window de la página (especialmente en Tampermonkey/Violentmonkey).
      element.click();
      return true;
    }

    if (currentAction) {
      return actionResult('BUSY', startTime, { currentAction: currentAction.action }, 'Otra acción sigue ejecutándose.');
    }
    currentAction = {
      action,
      payload: sanitizeTelemetry(payload || {}),
      startedAt: Date.now(),
      reviewBefore: collectActionReviewSnapshot()
    };
    lastPreflightReview = currentAction.reviewBefore;
    lastReviewStatus = 'PREPARED';

    try {
      switch (action) {
        case 'CLICK': {
          const el = queryActionElement(payload.selector, {
            visible: payload.requireVisible !== false,
            unique: payload.matchIndex === undefined,
            matchIndex: Number.isInteger(payload.matchIndex) ? payload.matchIndex : undefined
          });
          fireMouseEvents(el);
          return actionResult('SUCCESS', startTime, { clicked: true, selector: payload.selector });
        }

        case 'CLICK_TEXT': {
          const targetText = redactText(payload.text, 220);
          if (!targetText) throw new Error('Falta payload.text.');
          const candidates = Array.from(document.querySelectorAll(payload.role || 'button, a, [role="button"]'))
            .filter(element => isVisible(element) && !isBridgeElement(element))
            .filter(element => clipText(element.innerText || element.textContent, 220) === targetText);
          if (candidates.length !== 1) throw new Error(`Texto ambiguo o no encontrado: ${targetText}`);
          fireMouseEvents(candidates[0]);
          return actionResult('SUCCESS', startTime, { clicked: true, selector: getElementSelector(candidates[0]), text: targetText });
        }

        case 'CLICK_SEMANTIC': {
          const questionKey = normalizeSemanticText(payload.questionText);
          const optionKey = normalizeSemanticText(payload.optionText);
          if (!questionKey || !optionKey) throw new Error('CLICK_SEMANTIC requiere questionText y optionText.');
          const candidates = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
            .filter(element => isVisible(element) && !isBridgeElement(element))
            .map(element => ({ element, context: getChoiceContext(element) }))
            .filter(item => item.context.questionKey === questionKey && item.context.optionKey === optionKey);
          if (candidates.length !== 1) {
            throw new Error(`No se encontró una opción semántica única (encontradas: ${candidates.length}).`);
          }
          fireMouseEvents(candidates[0].element);
          return actionResult('SUCCESS', startTime, {
            clicked: true,
            semanticKey: candidates[0].context.semanticKey,
            selector: getElementSelector(candidates[0].element)
          });
        }

        case 'FILL': {
          const el = queryActionElement(payload.selector, { visible: payload.requireVisible !== false });
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
            throw new Error('El elemento no es editable.');
          }
          if (isSensitiveField(el)) throw new Error('Se bloqueó el llenado de un campo sensible.');
          const value = String(payload.value ?? '');
          if (value.length > 2000) throw new Error('El valor excede el límite permitido.');
          el.focus();
          if (el.isContentEditable) el.textContent = value;
          else setNativeValue(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return actionResult('SUCCESS', startTime, { filled: true, selector: payload.selector, valueLength: value.length });
        }

        case 'SELECT_OPTION': {
          const select = queryActionElement(payload.selector, { visible: payload.requireVisible !== false });
          if (!(select instanceof HTMLSelectElement)) throw new Error('El elemento no es un select.');
          const wanted = String(payload.value ?? payload.label ?? '');
          const option = Array.from(select.options).find(item => item.value === wanted || item.textContent.trim() === wanted);
          if (!option) throw new Error('Opción no encontrada en el select.');
          select.value = option.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return actionResult('SUCCESS', startTime, { selected: true, selector: payload.selector, option: option.value });
        }

        case 'SET_CHECKBOX': {
          const control = queryActionElement(payload.selector, { visible: payload.requireVisible !== false });
          if (!(control instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(control.type)) {
            throw new Error('El elemento no es un checkbox/radio.');
          }
          const checked = Boolean(payload.checked);
          if (control.checked !== checked) control.click();
          return actionResult('SUCCESS', startTime, { checked: control.checked, selector: payload.selector });
        }

        case 'FOCUS': {
          const element = queryActionElement(payload.selector, { visible: payload.requireVisible !== false });
          element.focus();
          return actionResult('SUCCESS', startTime, { focused: true, selector: payload.selector });
        }

        case 'SCROLL_TO': {
          const element = queryActionElement(payload.selector, { visible: false });
          element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
          return actionResult('SUCCESS', startTime, { scrolled: true, selector: payload.selector });
        }

        case 'DISMISS_POPUP': {
          const popup = queryActionElement(payload.popupSelector || payload.selector, { visible: true });
          const close = payload.closeSelector
            ? queryActionElement(payload.closeSelector, { visible: true })
            : popup.querySelector('button[aria-label*="close" i], button.close, [data-dismiss="modal"], [aria-label="Cerrar"], .close');
          if (!close || !isVisible(close)) throw new Error('No se encontró un control de cierre visible.');
          fireMouseEvents(close);
          return actionResult('SUCCESS', startTime, { dismissed: true, popupSelector: payload.popupSelector || payload.selector });
        }

        case 'PROOFREADING_OPEN_WORD':
        case 'PROOFREADING_OPEN_TOKEN': {
          const word = queryActionElement(payload.selector, { visible: false });
          fireMouseEvents(word);
          const modalDeadline = Date.now() + 600;
          let modalInput = document.querySelector('#change-word-modal');
          while ((!modalInput || !isVisible(modalInput)) && Date.now() < modalDeadline) {
            await new Promise(resolve => setTimeout(resolve, 40));
            modalInput = document.querySelector('#change-word-modal');
          }
          currentProofreadingToken = {
            selector: payload.selector,
            originalWord: redactText(document.querySelector('#word-modal')?.value, 120)
          };
          if (!modalInput || !isVisible(modalInput)) throw new Error('No apareció el modal de edición de palabra.');
          return actionResult('SUCCESS', startTime, {
            opened: true,
            originalWord: redactText(document.querySelector('#word-modal')?.value, 120),
            selector: payload.selector
          });
        }

        case 'PROOFREADING_REPLACE':
        case 'PROOFREADING_INSERT':
        case 'PROOFREADING_DELETE':
        case 'PROOFREADING_CANCEL': {
          const modalInput = document.querySelector('#change-word-modal');
          if (!modalInput || !isVisible(modalInput)) throw new Error('No hay un modal de proofreading abierto.');
          if (action === 'PROOFREADING_REPLACE' || action === 'PROOFREADING_INSERT') {
            const value = String(payload.value ?? '');
            if (value.length > 200) throw new Error('La corrección excede el límite permitido.');
            if (!value.trim()) throw new Error('La inserción requiere una palabra no vacía.');
            setNativeValue(modalInput, value);
            modalInput.dispatchEvent(new Event('input', { bubbles: true }));
            modalInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const modal = modalInput.closest('.modal, [role="dialog"]') || document;
          const labels = action === 'PROOFREADING_REPLACE'
            ? ['Cambiar']
            : (action === 'PROOFREADING_INSERT' ? ['Agregar', 'Añadir', 'Insertar', 'Cambiar'] : (action === 'PROOFREADING_DELETE' ? ['Eliminar'] : ['Cancelar']));
          const buttons = Array.from(modal.querySelectorAll('button, input[type="button"], input[type="submit"]'))
            .filter(candidate => isVisible(candidate));
          const button = labels.map(label => buttons.find(candidate => clipText(candidate.innerText || candidate.value, 80) === label)).find(Boolean);
          if (!button) throw new Error(`Control de proofreading ausente: ${labels.join(' / ')}`);
          fireMouseEvents(button);
          return actionResult('SUCCESS', startTime, {
            applied: action !== 'PROOFREADING_CANCEL',
            operation: action,
            valueLength: action === 'PROOFREADING_REPLACE' || action === 'PROOFREADING_INSERT' ? String(payload.value ?? '').length : 0
          });
        }

        case 'MATCH_PAIR': {
          if (!payload.questionText || !payload.answerText) {
            throw new Error('MATCH_PAIR bloqueado: requiere questionText y answerText; no se confía en data-idp/índices antiguos.');
          }
          await applySemanticMatchingPair(payload, payload.delayMs || 90);
          return actionResult('SUCCESS', startTime, {
            matched: true,
            questionText: redactText(payload.questionText, 160),
            answerText: redactText(payload.answerText, 160)
          });
        }

        case 'MATCH_ALL_PAIRS': {
          throw new Error('MATCH_ALL_PAIRS bloqueado: requiere payload.pairs semántico para evitar emparejamientos incorrectos.');
        }

        case 'MATCH_SEMANTIC_PAIRS': {
          if (!Array.isArray(payload.pairs) || payload.pairs.length === 0 || payload.pairs.length > 100) {
            throw new Error('MATCH_SEMANTIC_PAIRS requiere entre 1 y 100 pares semánticos.');
          }
          let matched = 0;
          for (const [index, pair] of payload.pairs.entries()) {
            if (stopAutomationRequested) throw new Error('Matching cancelado por el usuario.');
            try {
              await applySemanticMatchingPair(pair, payload.delayMs || 90);
              matched += 1;
            } catch (error) {
              throw new Error(`Pareja ${index + 1}/${payload.pairs.length}: ${error.message}`);
            }
          }
          return actionResult('SUCCESS', startTime, { totalMatched: matched, pairingApplied: true, correctness: 'NOT_EVALUATED' });
        }

        case 'DISPLAY_REASONING': {
          displayReasoningInHUD(payload.title, payload.steps);
          return actionResult('SUCCESS', startTime, { displayed: true });
        }

        case 'CAPTURE_STATE': {
          const state = extractSemanticState();
          return actionResult('SUCCESS', startTime, {
            view: state.view,
            url: redactUrl(state.url),
            revision: state.observability?.revision || 0,
            pageId: PAGE_ID
          });
        }

        case 'GET_CAPABILITIES': {
          return actionResult('SUCCESS', startTime, { agentVersion: AGENT_VERSION, capabilities: CAPABILITIES });
        }

        case 'CANCEL_AUTOMATION': {
          stopAutomationRequested = true;
          SETTINGS.autoPlay = false;
          clearTimeout(automationCycleTimer);
          return actionResult('SUCCESS', startTime, { cancelled: true });
        }

        case 'WORD_BOX_STATE': {
          const wordBox = collectWordBoxState();
          if (!wordBox) throw new Error('No se detectó un ejercicio de palabras y huecos.');
          return actionResult('SUCCESS', startTime, { wordBox });
        }

        case 'INSPECT_NODES': {
          const selector = requireSelector(payload.selector);
          let elements;
          try {
            elements = Array.from(document.querySelectorAll(selector))
              .filter(element => !isBridgeElement(element));
          } catch (error) {
            throw new Error(`Selector CSS inválido: ${error.message}`);
          }
          const limit = Math.max(1, Math.min(Number(payload.limit) || 40, 100));
          return actionResult('SUCCESS', startTime, {
            selector,
            count: elements.length,
            nodes: elements.slice(0, limit).map(element => inspectElement(element, payload.includeHtml === true))
          });
        }

        case 'WORD_BOX_PLACE': {
          const placed = await applyWordBoxPlacement(payload, payload.delayMs);
          return actionResult('SUCCESS', startTime, { placed: true, ...placed });
        }

        case 'WORD_BOX_PLACE_ALL': {
          const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
          if (pairs.length < 1 || pairs.length > 100) {
            throw new Error('WORD_BOX_PLACE_ALL requiere entre 1 y 100 parejas palabra → hueco.');
          }
          const usedWords = new Set();
          const usedGaps = new Set();
          const placed = [];
          for (const pair of pairs) {
            const wordKey = normalizeSemanticText(pair?.wordText ?? pair?.word ?? pair?.text);
            const gapKey = pair?.gapSelector || pair?.gapId || `index:${pair?.gapIndex}`;
            if (!wordKey || usedWords.has(wordKey)) throw new Error('WORD_BOX contiene palabras duplicadas o vacías.');
            if (usedGaps.has(gapKey)) throw new Error('WORD_BOX contiene huecos duplicados.');
            usedWords.add(wordKey);
            usedGaps.add(gapKey);
            placed.push(await applyWordBoxPlacement(pair, payload.delayMs));
          }
          const wordBox = collectWordBoxState();
          return actionResult('SUCCESS', startTime, {
            totalPlaced: placed.length,
            placements: placed,
            remainingWords: wordBox?.remainingWords ?? null,
            filledGaps: wordBox?.filledGaps ?? null
          });
        }

        case 'REORDER_LIST': {
          const listSelector = requireSelector(payload.listSelector);
          const list = queryActionElement(listSelector, { visible: false });
          const order = Array.isArray(payload.order) ? payload.order : null;
          if (!order || order.length < 1) throw new Error('REORDER_LIST requiere payload.order con el texto de cada elemento en el orden deseado.');
          const items = Array.from(list.children);
          const remaining = items.slice();
          const ordered = [];
          for (const wanted of order) {
            const wantedText = String(wanted ?? '').trim();
            const expected = normalizeSemanticText(wanted);
            let idx = remaining.findIndex(el => (el.innerText || el.textContent || '').trim() === wantedText);
            if (idx === -1) idx = remaining.findIndex(el => normalizeSemanticText(el.innerText || el.textContent) === expected);
            if (idx === -1) throw new Error(`REORDER_LIST: no se encontró el elemento con texto: ${redactText(wanted, 80)}`);
            ordered.push(remaining[idx]);
            remaining.splice(idx, 1);
          }
          if (remaining.length) throw new Error('REORDER_LIST: el orden no cubre todos los elementos de la lista.');
          ordered.forEach(el => list.appendChild(el));
          const finalText = ordered.map(el => (el.innerText || el.textContent || '').trim()).join(' ');
          const hiddenInput = list.parentElement ? list.parentElement.querySelector('input.sortable-hidden') : null;
          if (hiddenInput) {
            setNativeValue(hiddenInput, finalText);
            hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
            hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (window.jQuery && window.jQuery.fn && window.jQuery.fn.sortable) {
            try {
              window.jQuery(list).sortable('refresh');
              window.jQuery(list).trigger('sortupdate');
              window.jQuery(list).trigger('sortstop');
            } catch (error) { /* jQuery UI puede no exponer el widget si ya se destruyó */ }
          }
          list.dispatchEvent(new Event('change', { bubbles: true }));
          return actionResult('SUCCESS', startTime, { reordered: true, listSelector, finalText: redactText(finalText, 200) });
        }

        case 'NAVIGATE_SAME_ORIGIN': {
          requireConfirmed(action, payload);
          const url = new URL(String(payload.url || ''), window.location.href);
          if (url.origin !== window.location.origin) throw new Error('Solo se permiten navegaciones al mismo origen.');
          if (!/^\/me\/courses\//.test(url.pathname)) throw new Error('Ruta fuera de la allowlist de navegación.');
          window.location.assign(`${url.pathname}${url.search}${url.hash}`);
          return actionResult('SUCCESS', startTime, { navigating: true, url: redactUrl(url.href) });
        }

        case 'SUBMIT': {
          requireConfirmed(action, payload);
          const saveBtn = document.querySelector('#save-exercise');
          if (!saveBtn) throw new Error('Botón #save-exercise no encontrado');
          fireMouseEvents(saveBtn);
          return actionResult('SUCCESS', startTime, { submitted: true });
        }

        case 'NAVIGATE_NEXT': {
          requireConfirmed(action, payload);
          const nextBtn = document.querySelector('.btn-next-congratulation, .btn-next-exercise, .div_botones a[href*="/exercises/"], a[href*="/exercises/"], #title-link');
          if (nextBtn) {
            fireMouseEvents(nextBtn);
            return actionResult('SUCCESS', startTime, { navigated: true });
          }
          throw new Error('Botón de avance no disponible');
        }

        default:
          throw new Error(`Acción no autorizada o fuera del allowlist de seguridad: ${action}`);
      }
    } catch (err) {
      return {
        ...actionResult('ERROR', startTime, {}, err.message)
      };
    } finally {
      if (action.startsWith('PROOFREADING_') && !['PROOFREADING_OPEN_WORD', 'PROOFREADING_OPEN_TOKEN'].includes(action)) {
        currentProofreadingToken = null;
      }
      currentAction = null;
    }
  }

  // ==========================================
  // 4. CONEXIÓN WEBSOCKET Y COMUNICACIÓN
  // ==========================================
  function serializeStateForBridge(state) {
    let payload = JSON.stringify(state);
    const byteLength = value => typeof TextEncoder === 'function'
      ? new TextEncoder().encode(value).length
      : value.length;
    if (byteLength(payload) <= MAX_STATE_BYTES) return payload;

    // El servidor limita los mensajes a 256 KB. Conservamos la semántica
    // principal y los eventos recientes, reduciendo únicamente el árbol y
    // los campos repetidos de proofreading.
    const compactProofreading = state.exercise?.proofreading ? {
      rootSelector: state.exercise.proofreading.rootSelector,
      markerSelector: state.exercise.proofreading.markerSelector,
      tokenCount: state.exercise.proofreading.tokenCount,
      tokens: (state.exercise.proofreading.tokens || []).slice(0, 220).map(token => ({
        index: token.index,
        text: clipText(token.text, 100),
        className: clipText(token.className, 120),
        operationMarkers: token.operationMarkers,
        selector: token.selector,
        lineSelector: token.lineSelector,
        lineText: clipText(token.lineText, 260)
      })),
      lines: (state.exercise.proofreading.lines || []).slice(0, 40),
      reasoningContract: state.exercise.proofreading.reasoningContract,
      modalOpen: state.exercise.proofreading.modalOpen,
      modal: state.exercise.proofreading.modal
    } : null;
    const compactExercise = state.exercise ? {
      ...state.exercise,
      proofreading: compactProofreading,
      choices: (state.exercise.choices || []).slice(0, 80),
      matchingPairs: state.exercise.matchingPairs ? {
        questions: (state.exercise.matchingPairs.questions || []).slice(0, 80),
        answers: (state.exercise.matchingPairs.answers || []).slice(0, 80)
      } : state.exercise.matchingPairs
    } : null;
    const compactState = {
      ...state,
      exercise: compactExercise,
      observability: {
        ...state.observability,
        dom: {
          ...state.observability?.dom,
          structure: { truncated: true, reason: 'Payload limitado por seguridad' },
          visibleText: clipText(state.observability?.dom?.visibleText, 800)
        },
        interactive: {
          ...state.observability?.interactive,
          elements: state.observability?.interactive?.elements?.slice(0, 60) || []
        },
        formsAndFrames: {
          forms: state.observability?.formsAndFrames?.forms?.slice(0, 12) || [],
          frames: state.observability?.formsAndFrames?.frames?.slice(0, 12) || []
        },
        popupEvents: state.observability?.popupEvents?.slice(-20) || [],
        uiEvents: state.observability?.uiEvents?.slice(-20) || [],
        recentChanges: state.observability?.recentChanges?.slice(-20) || [],
        runtimeEvents: state.observability?.runtimeEvents?.slice(-20) || []
      }
    };
    payload = JSON.stringify(compactState);
    return byteLength(payload) <= MAX_STATE_BYTES ? payload : JSON.stringify({
      type: 'STATE_UPDATE',
      schemaVersion: 2,
      agentVersion: AGENT_VERSION,
      pageId: PAGE_ID,
      timestamp: Date.now(),
      view: state.view,
      url: state.url,
      ids: state.ids,
      message: 'Snapshot reducido por límite de seguridad.'
    });
  }

  function sendState() {
    if (ws && isConnected && ws.readyState === WebSocket.OPEN) {
      try {
        const state = extractSemanticState();
        ws.send(serializeStateForBridge(state));
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'STATE_UPDATE',
          schemaVersion: 2,
          agentVersion: AGENT_VERSION,
          pageId: PAGE_ID,
          timestamp: Date.now(),
          view: 'UNKNOWN',
          url: redactText(window.location.pathname, 300),
          error: 'No se pudo generar el snapshot DOM.'
        }));
      }
    }
  }

  function notifyDomChanged(mutations = []) {
    if (mutations.length) recordDomChanges(mutations);
    clearTimeout(debounceStateTimer);
    debounceStateTimer = setTimeout(sendState, 150);
  }

  function connectBridge() {
    const generation = ++connectionGeneration;
    if (ws) {
      try { ws.close(); } catch (e) {}
    }

    updateBadgeStatus(false, 'Conectando...');

    try {
      const targetUrl = BRIDGE_WS_URLS[bridgeUrlIndex];
      ws = new WebSocket(targetUrl);

      ws.onopen = () => {
        if (generation !== connectionGeneration) return;
        isConnected = true;
        reconnectAttempt = 0;
        updateBadgeStatus(true, 'Conectado');
        ws.send(JSON.stringify({
          type: 'HELLO',
          schemaVersion: 2,
          agentVersion: AGENT_VERSION,
          pageId: PAGE_ID,
          capabilities: CAPABILITIES
        }));
        sendState();

        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'HEARTBEAT',
              timestamp: Date.now(),
              schemaVersion: 2,
              agentVersion: AGENT_VERSION,
              pageId: PAGE_ID
            }));
          }
        }, 10000);
      };

      ws.onmessage = async (evt) => {
        if (generation !== connectionGeneration) return;
        try {
          const msg = JSON.parse(evt.data);

          if (msg.pageId && msg.pageId !== PAGE_ID) {
            if (msg.requestId && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'ACTION_RESULT',
                requestId: msg.requestId,
                pageId: PAGE_ID,
                status: 'STALE_PAGE',
                error: 'La acción estaba dirigida a otra pestaña.'
              }));
            }
            return;
          }

          if (msg.type === 'GET_STATE') {
            sendState();
          } else if (msg.type === 'EXECUTE_ACTION') {
            if (msg.requestId && handledRequestIds.has(msg.requestId)) {
              ws.send(JSON.stringify(handledRequestIds.get(msg.requestId)));
              return;
            }
            const res = await executeAtomicAction(msg.action, msg.payload || {});
            const result = {
              type: 'ACTION_RESULT',
              requestId: msg.requestId || null,
              pageId: PAGE_ID,
              ...res
            };
            if (msg.requestId) {
              handledRequestIds.set(msg.requestId, result);
              while (handledRequestIds.size > MAX_ACTION_CACHE) {
                handledRequestIds.delete(handledRequestIds.keys().next().value);
              }
            }
            ws.send(JSON.stringify(result));
            setTimeout(sendState, 100);
          }
        } catch (e) {
          recordRuntimeEvent('BRIDGE_MESSAGE_ERROR', { message: e.message });
        }
      };

      ws.onclose = () => {
        if (generation !== connectionGeneration) return;
        isConnected = false;
        clearInterval(heartbeatTimer);
        updateBadgeStatus(false, 'Desconectado');
        bridgeUrlIndex = (bridgeUrlIndex + 1) % BRIDGE_WS_URLS.length;
        clearTimeout(reconnectTimer);
        const delay = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttempt, 5)) + Math.floor(Math.random() * 300));
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectBridge();
        }, delay);
      };

      ws.onerror = () => {
        if (generation !== connectionGeneration) return;
        isConnected = false;
        updateBadgeStatus(false, 'Error');
      };
    } catch (e) {
      if (generation !== connectionGeneration) return;
      updateBadgeStatus(false, 'Error inicial');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectBridge();
      }, Math.min(30000, 1000 * (2 ** Math.min(reconnectAttempt++, 5))));
    }
  }

  // ==========================================
  // 5. ASISTENTE / AUTOMATOR UNIFICADO
  // ==========================================
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assistantStatusElem = null;
  let automationCycleTimer = null;

  function updateAssistantStatus(message) {
    const text = clipText(message, 300);
    console.log(`[Akdmic Agent] ${text}`);
    if (assistantStatusElem) assistantStatusElem.textContent = text;
  }

  function getCurrentView() {
    return extractSemanticState().view;
  }

  function buildLocalReasoningPlan(state = extractSemanticState()) {
    const plan = {
      currentView: state.view,
      activityTitle: state.exercise?.title || 'Sin título',
      activityType: state.exercise?.type || 'desconocido',
      reasoningSteps: [],
      proposedActions: [],
      securityMode: 'USER_CONFIRMATION_REQUIRED',
      autoAdvanceBlocked: true
    };
    if (state.view !== 'EXERCISE' || !state.exercise) return plan;

    if (state.exercise.type === 'matching_pairs') {
      const answers = state.exercise.matchingPairs?.answers || [];
      for (const question of state.exercise.matchingPairs?.questions || []) {
        const answer = answers.find(item => item.dataIdp === question.id);
        if (!answer) continue;
        plan.reasoningSteps.push({
          question: question.text,
          selectedAnswer: answer.text,
          evidence: `data-idp="${question.id}" coincide con ${question.questionId}`,
          confidence: 1
        });
        plan.proposedActions.push({ action: 'MATCH_PAIR', payload: { questionSelector: question.selector, answerSelector: answer.selector } });
      }
    } else if (state.exercise.type === 'multiple_choice') {
      for (const choice of state.exercise.choices || []) {
        if (!['true', '1', 'yes', 'correct'].includes(String(choice.dataCorrect || '').toLowerCase())) continue;
        plan.reasoningSteps.push({
          question: choice.name || 'Opción múltiple',
          selectedAnswer: choice.label || choice.value,
          evidence: `data-correct="${choice.dataCorrect}"`,
          confidence: 1
        });
        plan.proposedActions.push({
          action: 'CLICK_SEMANTIC',
          payload: { questionText: choice.questionText, optionText: choice.optionText }
        });
      }
    } else if (state.exercise.type === 'gap_fill') {
      for (const input of state.exercise.inputs || []) {
        if (!input.dataAnswer) continue;
        plan.reasoningSteps.push({
          question: input.placeholder || input.name || input.id || `Campo ${input.index + 1}`,
          selectedAnswer: input.dataAnswer,
          evidence: `Respuesta declarada para ${input.selector}`,
          confidence: 1
        });
        plan.proposedActions.push({ action: 'FILL', payload: { selector: input.selector, value: input.dataAnswer } });
      }
    } else if (state.exercise.type === 'word_box') {
      const wordBox = state.exercise.wordBox;
      plan.reasoningSteps.push({
        question: `Ejercicio de palabras y huecos (${wordBox?.gapCount || 0} huecos)`,
        selectedAnswer: 'Requiere parejas semánticas palabra → selector de hueco',
        evidence: 'El DOM declara #matching-word-sortable, id_mtc_p_* e id_mtc_q*.',
        confidence: 1
      });
    } else if (state.exercise.type === 'active_learning') {
      plan.reasoningSteps.push({
        type: 'USER_INPUT_REQUIRED',
        question: 'La actividad solicita una experiencia o comentario personal.',
        selectedAnswer: 'Esperar respuesta del usuario',
        evidence: 'El ejercicio declara una consigna abierta y requiere escribir un comentario para continuar.',
        confidence: 1
      });
    }
    return plan;
  }

  const Solvers = {
    async solveMatchingPairs(semanticPairs = []) {
      if (!Array.isArray(semanticPairs) || semanticPairs.length === 0) {
        updateAssistantStatus('Matching detenido: requiere un plan semántico pregunta → respuesta; no se usa data-idp a ciegas.');
        return false;
      }
      updateAssistantStatus('Aplicando parejas semánticas y verificando cada una...');
      const result = await executeAtomicAction('MATCH_SEMANTIC_PAIRS', { pairs: semanticPairs, delayMs: 70 });
      updateAssistantStatus(result.status === 'SUCCESS'
        ? `Parejas colocadas: ${result.data?.totalMatched || 0}. La corrección se confirma al evaluar.`
        : `Matching detenido: ${result.error || 'fallo de verificación'}`);
      return result.status === 'SUCCESS';
    },

    async solveMultipleChoice() {
      const controls = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      if (!controls.length) return false;
      updateAssistantStatus('Seleccionando opciones marcadas por la página...');
      const groups = {};
      controls.forEach(control => {
        const name = control.name || 'default';
        (groups[name] ||= []).push(control);
      });
      let selected = 0;
      for (const group of Object.values(groups)) {
        if (stopAutomationRequested) break;
        const target = group.find(control => (
          control.getAttribute('data-correct') === 'true' ||
          control.getAttribute('data-respuesta') === 'true' ||
          control.value === '1'
        ));
        if (target && !target.checked) {
          target.click();
          selected += 1;
          await sleep(180);
        }
      }
      updateAssistantStatus(`Opciones colocadas: ${selected}. Revisa antes de evaluar.`);
      return selected > 0;
    },

    async solveGapFill() {
      const inputs = Array.from(document.querySelectorAll('input.gap_fill, input[data-answer], input[data-correct], .gap_fill input'));
      let filled = 0;
      for (const input of inputs) {
        if (stopAutomationRequested) break;
        const answer = input.getAttribute('data-answer') || input.getAttribute('data-correct') || input.getAttribute('data-val');
        if (!answer || isSensitiveField(input)) continue;
        input.focus();
        input.value = answer;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        filled += 1;
        await sleep(180);
      }
      updateAssistantStatus(filled ? `Campos colocados: ${filled}. Revisa antes de evaluar.` : 'No hay respuestas disponibles en los atributos del DOM.');
      return filled > 0;
    },

    async solveWordBox(semanticPairs = []) {
      if (!Array.isArray(semanticPairs) || semanticPairs.length === 0) {
        updateAssistantStatus('Arrastrar y soltar detenido: requiere parejas semánticas palabra → hueco.');
        return false;
      }
      updateAssistantStatus('Colocando palabras por texto y verificando cada hueco...');
      const result = await executeAtomicAction('WORD_BOX_PLACE_ALL', { pairs: semanticPairs, delayMs: 60 });
      updateAssistantStatus(result.status === 'SUCCESS'
        ? `Palabras colocadas: ${result.data?.totalPlaced || 0}. Revisa antes de evaluar.`
        : `Arrastrar y soltar detenido: ${result.error || 'fallo de verificación'}`);
      return result.status === 'SUCCESS';
    },

    async solveCurrent() {
      const state = extractSemanticState();
      if (state.view !== 'EXERCISE' || !state.exercise) {
        updateAssistantStatus(`La vista actual es ${state.view}; no es un ejercicio.`);
        return false;
      }
      if (state.exercise.isEvaluated) {
        updateAssistantStatus('La actividad ya está evaluada; no se modifica.');
        return false;
      }
      const localPlan = buildLocalReasoningPlan(state);
      if (localPlan.reasoningSteps.length) displayReasoningInHUD(localPlan.activityTitle, localPlan.reasoningSteps);

      let solved = false;
      switch (state.exercise.type) {
        case 'matching_pairs':
          solved = await Solvers.solveMatchingPairs();
          break;
        case 'multiple_choice':
          solved = await Solvers.solveMultipleChoice();
          break;
        case 'gap_fill':
          solved = await Solvers.solveGapFill();
          break;
        case 'word_box':
          solved = await Solvers.solveWordBox();
          break;
        case 'active_learning':
          updateAssistantStatus('Actividad abierta: se requiere consultar al usuario antes de escribir, evaluar o avanzar.');
          solved = false;
          break;
        case 'texto':
          updateAssistantStatus('Actividad informativa detectada; no se autoavanza.');
          break;
        default:
          solved = await Solvers.solveMultipleChoice() || await Solvers.solveGapFill();
      }

      if (solved && SETTINGS.autoSubmit) {
        await sleep(SETTINGS.delay);
        const saveButton = document.querySelector('#save-exercise:not(:disabled)');
        if (saveButton && isVisible(saveButton)) {
          updateAssistantStatus('Auto-enviar activado: evaluando...');
          saveButton.click();
        }
      }
      return solved;
    }
  };

  const Navigator = {
    openFirstPlan() {
      if (getCurrentView() !== 'COURSE_DASHBOARD') {
        updateAssistantStatus('La página actual no es el dashboard del curso.');
        return false;
      }
      const button = document.querySelector('button[onclick*="/plan?"]');
      if (!button) {
        updateAssistantStatus('No se encontró un botón de plan.');
        return false;
      }
      updateAssistantStatus('Abriendo el plan de la primera lección...');
      button.click();
      return true;
    },

    openNextExercise() {
      if (getCurrentView() !== 'EXERCISE') {
        updateAssistantStatus('Estoy en una vista segura; no abro ejercicios desde aquí.');
        return false;
      }
      const nextButton = document.querySelector('.btn-next-congratulation, .btn-next-exercise, .div_botones a[href*="/exercises/"], a[href*="/exercises/"], #title-link');
      if (!nextButton) {
        updateAssistantStatus('No hay un siguiente ejercicio disponible.');
        return false;
      }
      nextButton.click();
      return true;
    },

    async runCycle() {
      if (!SETTINGS.autoPlay || stopAutomationRequested) return;
      clearTimeout(automationCycleTimer);
      const view = getCurrentView();
      if (view === 'COURSE_DASHBOARD') {
        this.openFirstPlan();
      } else if (view === 'PLAN') {
        const currentLessonId = new URL(window.location.href).searchParams.get('u');
        const links = Array.from(document.querySelectorAll('.start-exercise-link[data-abierto="true"]'))
          .filter(link => !currentLessonId || (link.getAttribute('data-href') || '').includes(`/lessons/${currentLessonId}/`));
        if (links[0]) {
          updateAssistantStatus('Auto-Play activado: abriendo la siguiente actividad...');
          links[0].click();
        } else {
          updateAssistantStatus('No hay una actividad desbloqueada para esta lección.');
        }
      } else if (view === 'EXERCISE') {
        const solved = await Solvers.solveCurrent();
        if (solved && SETTINGS.autoPlay) {
          automationCycleTimer = setTimeout(() => this.openNextExercise(), SETTINGS.delay);
        }
      }
    }
  };

  // ==========================================
  // 6. INTERFAZ VISUAL: BADGE, RAZONAMIENTO Y CONTROLES
  // ==========================================
  let badgeElem = null;

  function updateBadgeStatus(connected, text) {
    if (!badgeElem) return;
    const dot = badgeElem.querySelector('.bridge-dot');
    const label = badgeElem.querySelector('.bridge-label');
    if (dot) dot.style.background = connected ? '#22c55e' : '#ef4444';
    if (label) label.innerText = `Agent Bridge: ${text}`;
  }

  function displayReasoningInHUD(title, steps = []) {
    let panel = document.getElementById('akdmic-reasoning-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'akdmic-reasoning-panel';
      document.body.appendChild(panel);
    }

    const stepsHtml = steps.map((s, idx) => `
      <div class="reason-item">
        <div class="reason-q"><b>${idx + 1}. ${escapeHtml(s.question || 'Pregunta')}</b></div>
        <div class="reason-a">➔ <span style="color:#38bdf8;">${escapeHtml(s.selectedAnswer || s.action || '')}</span></div>
        <div class="reason-ev">💡 <i>${escapeHtml(s.evidence || 'Evidencia verificada')}</i> (Confianza: ${Math.round((s.confidence || 1) * 100)}%)</div>
      </div>
    `).join('');

    panel.innerHTML = `
      <div class="reason-header">
        <span>🧠 Razonamiento del Agente: <b>${escapeHtml(title || 'Análisis')}</b></span>
        <button id="close-reason-btn" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:16px;">×</button>
      </div>
      <div class="reason-body">
        <div class="reason-alert">🛑 <b>Modo Seguro:</b> Las respuestas se colocaron en pantalla. Revisa y presiona Evaluar cuando estés listo.</div>
        ${stepsHtml}
      </div>
    `;
    panel.style.display = 'block';

    document.getElementById('close-reason-btn')?.addEventListener('click', () => {
      panel.style.display = 'none';
    });
  }

  function injectHUDStyles() {
    if (typeof GM_addStyle !== 'undefined') {
      GM_addStyle(`
        #akdmic-agent-bridge-badge {
          position: fixed;
          top: 10px;
          right: 15px;
          z-index: 9999999;
          background: rgba(15, 23, 42, 0.92);
          backdrop-filter: blur(6px);
          color: #f8fafc;
          padding: 6px 12px;
          border-radius: 20px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          pointer-events: auto;
          cursor: pointer;
        }
        .bridge-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #ef4444;
          transition: background 0.3s;
        }
        #akdmic-reasoning-panel {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 9999998;
          width: 380px;
          max-height: 480px;
          background: #0f172a;
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 12px;
          box-shadow: 0 12px 30px rgba(0,0,0,0.5);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: none;
          overflow: hidden;
        }
        .reason-header {
          background: #1e293b;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #334155;
        }
        .reason-body {
          padding: 12px;
          overflow-y: auto;
          max-height: 410px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .reason-alert {
          background: #1e3a5f;
          border: 1px solid #2563eb;
          color: #bfdbfe;
          font-size: 11px;
          padding: 8px;
          border-radius: 6px;
        }
        .reason-item {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
        }
        .reason-q { color: #e2e8f0; margin-bottom: 4px; }
        .reason-a { font-weight: bold; margin-bottom: 4px; }
        .reason-ev { font-size: 11px; color: #94a3b8; }
        #akdmic-agent-controls {
          position: fixed;
          right: 15px;
          bottom: 18px;
          z-index: 9999997;
          width: 330px;
          background: linear-gradient(145deg, #1e293b, #0f172a);
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 12px;
          box-shadow: 0 12px 30px rgba(0,0,0,0.45);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          overflow: hidden;
        }
        #akdmic-agent-controls .agent-controls-header {
          background: #0284c7;
          padding: 9px 12px;
          font-weight: 700;
          font-size: 13px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
        }
        #akdmic-agent-controls .agent-controls-body {
          padding: 11px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        #akdmic-agent-controls .agent-status {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 7px;
          color: #cbd5e1;
          font-size: 11px;
          line-height: 1.35;
          padding: 7px 8px;
          min-height: 30px;
        }
        #akdmic-agent-controls button {
          border: 0;
          border-radius: 7px;
          padding: 8px 9px;
          color: #fff;
          background: #2563eb;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
        }
        #akdmic-agent-controls button:hover { filter: brightness(1.12); }
        #akdmic-agent-controls button.agent-success { background: #16a34a; }
        #akdmic-agent-controls button.agent-warning { background: #d97706; }
        #akdmic-agent-controls button.agent-danger { background: #dc2626; }
        #akdmic-agent-controls .agent-row { display: flex; gap: 7px; }
        #akdmic-agent-controls .agent-row button { flex: 1; }
        #akdmic-agent-controls label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #cbd5e1;
          font-size: 11px;
        }
      `);
    }

    badgeElem = document.createElement('div');
    badgeElem.id = 'akdmic-agent-bridge-badge';
    badgeElem.innerHTML = '<div class="bridge-dot"></div><span class="bridge-label">Agent Bridge: Iniciando...</span>';
    document.body.appendChild(badgeElem);

    badgeElem.addEventListener('click', () => {
      const panel = document.getElementById('akdmic-reasoning-panel');
      if (panel) {
        panel.style.display = (panel.style.display === 'none') ? 'block' : 'none';
      }
    });
  }

  function injectAssistantControls() {
    if (document.getElementById('akdmic-agent-controls')) return;

    const container = document.createElement('section');
    container.id = 'akdmic-agent-controls';
    container.innerHTML = `
      <div class="agent-controls-header">
        <span>⚡ Akdmic Agent: Bridge + Automator</span>
        <span id="akdmic-agent-controls-toggle">▼</span>
      </div>
      <div class="agent-controls-body">
        <div class="agent-status"><span id="akdmic-agent-status">Listo. Modo seguro activo.</span></div>
        <div class="agent-row">
          <button id="akdmic-agent-open-plan" class="agent-success">Abrir plan</button>
          <button id="akdmic-agent-preview" class="agent-warning">Ver plan</button>
          <button id="akdmic-agent-solve" class="agent-warning">Resolver actual</button>
        </div>
        <div class="agent-row">
          <button id="akdmic-agent-next">Siguiente ejercicio</button>
          <button id="akdmic-agent-autoplay">▶ Auto-Play: OFF</button>
        </div>
        <label><span>Auto-enviar evaluación</span><input id="akdmic-agent-autosubmit" type="checkbox" ${SETTINGS.autoSubmit ? 'checked' : ''}></label>
        <label><span>Observar metadatos de red</span><input id="akdmic-agent-capture-network" type="checkbox" ${SETTINGS.captureNetwork ? 'checked' : ''}></label>
        <label><span>Observar eventos UI</span><input id="akdmic-agent-capture-ui" type="checkbox" ${SETTINGS.captureUiEvents ? 'checked' : ''}></label>
        <label><span>Retardo (ms)</span><input id="akdmic-agent-delay" type="number" min="300" max="10000" step="100" value="${SETTINGS.delay}" style="width:78px"></label>
      </div>
    `;
    document.body.appendChild(container);

    assistantStatusElem = document.getElementById('akdmic-agent-status');
    const body = container.querySelector('.agent-controls-body');
    const toggle = document.getElementById('akdmic-agent-controls-toggle');
    container.querySelector('.agent-controls-header').addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'flex' : 'none';
      toggle.textContent = collapsed ? '▼' : '▲';
    });

    const autoPlayButton = document.getElementById('akdmic-agent-autoplay');
    const renderAutoPlay = () => {
      autoPlayButton.textContent = SETTINGS.autoPlay ? '⏹ Auto-Play: ON' : '▶ Auto-Play: OFF';
      autoPlayButton.className = SETTINGS.autoPlay ? 'agent-danger' : '';
    };
    renderAutoPlay();

    document.getElementById('akdmic-agent-open-plan').addEventListener('click', () => Navigator.openFirstPlan());
    document.getElementById('akdmic-agent-preview').addEventListener('click', () => {
      const plan = buildLocalReasoningPlan();
      if (!plan.reasoningSteps.length) updateAssistantStatus(`No hay una deducción segura para ${plan.activityType}.`);
      else displayReasoningInHUD(plan.activityTitle, plan.reasoningSteps);
    });
    document.getElementById('akdmic-agent-solve').addEventListener('click', () => Solvers.solveCurrent());
    document.getElementById('akdmic-agent-next').addEventListener('click', () => Navigator.openNextExercise());
    autoPlayButton.addEventListener('click', () => {
      SETTINGS.autoPlay = !SETTINGS.autoPlay;
      stopAutomationRequested = !SETTINGS.autoPlay;
      renderAutoPlay();
      updateAssistantStatus(SETTINGS.autoPlay ? 'Auto-Play activado por el usuario.' : 'Auto-Play detenido.');
      if (SETTINGS.autoPlay) Navigator.runCycle();
      else clearTimeout(automationCycleTimer);
    });
    document.getElementById('akdmic-agent-autosubmit').addEventListener('change', event => {
      SETTINGS.autoSubmit = event.target.checked;
      updateAssistantStatus(SETTINGS.autoSubmit ? 'Auto-enviar activado; úsalo solo si lo confirmas.' : 'Auto-enviar desactivado.');
    });
    document.getElementById('akdmic-agent-capture-network').addEventListener('change', event => {
      SETTINGS.captureNetwork = event.target.checked;
      window.dispatchEvent(new CustomEvent('akdmic-agent-config', {
        detail: JSON.stringify({ captureNetwork: SETTINGS.captureNetwork })
      }));
      updateAssistantStatus(SETTINGS.captureNetwork ? 'Captura de metadatos de red activada.' : 'Captura de red desactivada.');
    });
    document.getElementById('akdmic-agent-capture-ui').addEventListener('change', event => {
      SETTINGS.captureUiEvents = event.target.checked;
      updateAssistantStatus(SETTINGS.captureUiEvents ? 'Captura de eventos UI activada.' : 'Captura de eventos UI desactivada.');
    });
    document.getElementById('akdmic-agent-delay').addEventListener('change', event => {
      SETTINGS.delay = event.target.value;
      updateAssistantStatus(`Retardo configurado: ${SETTINGS.delay} ms.`);
    });
  }

  function exposeReadOnlyPageApi() {
    try {
      Object.defineProperty(window, '__akdmicAgentApi', {
        configurable: false,
        enumerable: false,
        value: Object.freeze({
          version: AGENT_VERSION,
          pageId: PAGE_ID,
          capabilities: [...CAPABILITIES],
          getState: () => extractSemanticState(),
          refreshState: () => sendState(),
          stopAutomation: () => {
            stopAutomationRequested = true;
            SETTINGS.autoPlay = false;
            clearTimeout(automationCycleTimer);
          }
        })
      });
    } catch (e) {
      recordRuntimeEvent('PAGE_API_EXPOSE_ERROR', { message: e.message });
    }
  }

  // ==========================================
  // 7. INICIALIZACIÓN
  // ==========================================
  function init() {
    applyBypasses();
    installRuntimeHooks();
    injectHUDStyles();
    injectAssistantControls();
    exposeReadOnlyPageApi();
    connectBridge();

    const observer = new MutationObserver(notifyDomChanged);
    const observerTarget = document.body || document.documentElement;
    if (observerTarget) {
      observer.observe(observerTarget, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    document.addEventListener('click', event => recordUiEvent('CLICK', event.target), true);
    document.addEventListener('input', event => {
      const target = event.target;
      if (!target || isBridgeElement(target)) return;
      recordUiEvent('INPUT', target, {
        value: isSensitiveField(target) ? '[REDACTED]' : redactText(target.value, 120),
        valueLength: typeof target.value === 'string' ? target.value.length : null
      });
    }, true);
    document.addEventListener('change', event => recordUiEvent('CHANGE', event.target), true);
    document.addEventListener('submit', event => recordUiEvent('SUBMIT', event.target), true);
    document.addEventListener('focusin', event => recordUiEvent('FOCUS_IN', event.target), true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Enter') recordUiEvent('KEY', event.target, { key: event.key });
    }, true);
    window.addEventListener('online', () => recordRuntimeEvent('NETWORK_ONLINE'));
    window.addEventListener('offline', () => recordRuntimeEvent('NETWORK_OFFLINE'));
    document.addEventListener('visibilitychange', () => recordRuntimeEvent('VISIBILITY_CHANGE', { state: document.visibilityState }));
    window.addEventListener('pagehide', () => recordRuntimeEvent('PAGE_HIDE', { url: redactUrl(window.location.href) }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

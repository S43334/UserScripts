// ==UserScript==
// @name         ChatGPT → Portapapeles (Markdown/JSON)
// @namespace    local.chatgpt.exporter
// @version      1.1.0
// @description  Copia toda la conversación de ChatGPT o sus últimos mensajes en Markdown o JSON.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const HOST_ID = 'chatgpt-clipboard-exporter';
  const WAIT_AFTER_SCROLL_MS = 180;
  const WAIT_AFTER_JUMP_MS = 450;

  if (document.getElementById(HOST_ID)) {
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-label', 'Exportador de conversación de ChatGPT');

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .panel {
        width: min(300px, calc(100vw - 36px));
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid rgba(128, 128, 128, .35);
        border-radius: 14px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .22);
      }

      .title {
        margin: 0 0 10px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: .01em;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }

      label {
        display: grid;
        gap: 4px;
        font-size: 11px;
        opacity: .78;
      }

      select,
      input,
      button {
        width: 100%;
        box-sizing: border-box;
        min-height: 36px;
        border: 1px solid rgba(128, 128, 128, .45);
        border-radius: 9px;
        font: inherit;
      }

      select,
      input {
        padding: 0 9px;
        background: Field;
        color: FieldText;
      }

      input:disabled {
        opacity: .55;
      }

      button {
        padding: 0 12px;
        cursor: pointer;
        background: #10a37f;
        color: #fff;
        font-size: 13px;
        font-weight: 700;
      }

      button:hover:not(:disabled) {
        filter: brightness(1.08);
      }

      button:focus-visible,
      select:focus-visible,
      input:focus-visible {
        outline: 2px solid #5da9ff;
        outline-offset: 2px;
      }

      button:disabled {
        cursor: wait;
        opacity: .65;
      }

      .status {
        min-height: 15px;
        margin: 9px 2px 0;
        color: GrayText;
        font-size: 11px;
        line-height: 1.35;
      }

      @media (max-width: 520px) {
        :host {
          right: 10px;
          bottom: 10px;
        }

        .panel {
          width: min(300px, calc(100vw - 20px));
        }
      }
    </style>

    <section class="panel">
      <p class="title">Extraer conversación</p>
      <div class="row">
        <label>
          Formato
          <select id="format" aria-label="Formato de exportación">
            <option value="markdown">Markdown (recomendado)</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label>
          Mensajes que se copiarán
          <select id="scope" aria-label="Alcance de la exportación">
            <option value="all">Todo el chat</option>
            <option value="last">Sólo los últimos</option>
          </select>
        </label>
        <label id="count-label" hidden>
          Cantidad de mensajes
          <input id="count" type="number" min="1" step="1" value="2" inputmode="numeric"
            aria-label="Cantidad de mensajes más recientes">
        </label>
        <button id="copy" type="button">Copiar conversación</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>
  `;

  (document.body || document.documentElement).appendChild(host);

  const formatSelect = shadow.querySelector('#format');
  const scopeSelect = shadow.querySelector('#scope');
  const countLabel = shadow.querySelector('#count-label');
  const countInput = shadow.querySelector('#count');
  const copyButton = shadow.querySelector('#copy');
  const status = shadow.querySelector('#status');
  let busy = false;

  formatSelect.addEventListener('change', () => {
    status.textContent = formatSelect.value === 'json'
      ? 'JSON conserva cada mensaje como texto Markdown.'
      : 'Markdown conserva mejor listas y bloques de código.';
  });

  scopeSelect.addEventListener('change', () => {
    const onlyLast = scopeSelect.value === 'last';
    countLabel.hidden = !onlyLast;
    countInput.disabled = !onlyLast;
    status.textContent = onlyLast
      ? 'Se copiarán los mensajes más recientes en orden cronológico.'
      : 'Se copiará la conversación completa en orden cronológico.';
  });

  countInput.disabled = true;

  copyButton.addEventListener('click', async () => {
    if (busy) {
      return;
    }

    busy = true;
    copyButton.disabled = true;
    status.textContent = 'Recopilando la conversación…';

    try {
      const conversation = selectMessages(
        await collectConversation(),
        scopeSelect.value,
        countInput.value,
      );
      const output = formatSelect.value === 'json'
        ? toJson(conversation)
        : toMarkdown(conversation);

      await copyToClipboard(output);
      const formatName = formatSelect.value === 'json' ? 'JSON' : 'Markdown';
      status.textContent = `${conversation.messages.length} mensaje(s) copiado(s) como ${formatName}.`;
    } catch (error) {
      status.textContent = getFriendlyError(error);
    } finally {
      busy = false;
      copyButton.disabled = false;
    }
  });

  function getFriendlyError(error) {
    const message = error instanceof Error ? error.message : '';

    if (message === 'NO_MESSAGES') {
      return 'No encontré mensajes. Abre una conversación y vuelve a intentarlo.';
    }

    if (message === 'COPY_FAILED') {
      return 'El navegador bloqueó el portapapeles. Permite el acceso y reintenta.';
    }

    return 'No se pudo extraer la conversación. Reintenta cuando termine de cargar.';
  }

  function selectMessages(conversation, scope, requestedCount) {
    if (scope !== 'last') {
      return conversation;
    }

    const count = Math.max(1, Math.floor(Number(requestedCount) || 1));
    countInput.value = String(count);

    return {
      ...conversation,
      messages: conversation.messages.slice(-count),
    };
  }

  async function collectConversation() {
    const root = findConversationRoot();
    const scroller = findScrollContainer(root);
    const savedScroll = saveScroll(scroller);
    const records = new Map();
    let insertionOrder = 0;

    const scan = () => {
      const nodes = getMessageNodes(root);
      const occurrences = new Map();

      nodes.forEach((node, index) => {
        const message = parseMessage(node, index);

        if (!message || !message.content.trim()) {
          return;
        }

        const identity = getMessageIdentity(node, message);
        const occurrenceKey = `${message.role}|${message.content.slice(0, 120)}`;
        const occurrence = occurrences.get(occurrenceKey) || 0;
        occurrences.set(occurrenceKey, occurrence + 1);
        const key = identity || `${occurrenceKey}|${occurrence}`;
        const current = records.get(key) || findSimilarRecord(records, message);

        if (current) {
          if (isMoreComplete(message, current)) {
            current.role = message.role;
            current.content = message.content;
            current.markdown = message.markdown;
            current.orderHint = message.orderHint ?? current.orderHint;
          }
          return;
        }

        records.set(key, {
          role: message.role,
          content: message.content,
          markdown: message.markdown,
          orderHint: message.orderHint,
          order: insertionOrder++,
        });
      });
    };

    try {
      setScrollTop(scroller, 0);
      await delay(WAIT_AFTER_JUMP_MS);
      scan();

      let previousHeight = -1;
      for (let pass = 0; pass < 2; pass += 1) {
        const height = getScrollHeight(scroller);
        const viewport = getViewportHeight(scroller);
        const step = Math.max(280, Math.floor(viewport * 0.8));

        for (let top = 0; top <= height; top += step) {
          setScrollTop(scroller, Math.min(top, height));
          await delay(WAIT_AFTER_SCROLL_MS);
          scan();
        }

        setScrollTop(scroller, height);
        await delay(WAIT_AFTER_JUMP_MS);
        scan();

        const newHeight = getScrollHeight(scroller);
        if (newHeight === height || newHeight === previousHeight) {
          break;
        }
        previousHeight = newHeight;
      }
    } finally {
      restoreScroll(scroller, savedScroll);
    }

    if (!records.size) {
      throw new Error('NO_MESSAGES');
    }

    const messages = Array.from(records.values()).sort(compareMessageOrder);

    return {
      title: getConversationTitle(),
      messages,
    };
  }

  function compareMessageOrder(a, b) {
    // Los índices de ChatGPT son la fuente principal. Para estructuras antiguas
    // sin índice, el orden de descubrimiento (recorrido de arriba abajo) sirve
    // como respaldo y mantiene un comparador estable incluso si se mezclan ambos.
    const aPosition = Number.isFinite(a.orderHint) ? a.orderHint : a.order;
    const bPosition = Number.isFinite(b.orderHint) ? b.orderHint : b.order;
    return aPosition - bPosition || a.order - b.order;
  }

  function findConversationRoot() {
    return document.querySelector('main')
      || document.querySelector('[role="main"]')
      || document.body
      || document.documentElement;
  }

  function findScrollContainer(root) {
    let current = root;

    while (current && current !== document.body && current !== document.documentElement) {
      const style = getComputedStyle(current);
      const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);

      if (scrollable && current.scrollHeight > current.clientHeight + 10) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function saveScroll(scroller) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      return { window: true, top: window.scrollY, left: window.scrollX };
    }

    return { window: false, top: scroller.scrollTop, left: scroller.scrollLeft };
  }

  function restoreScroll(scroller, saved) {
    if (saved.window) {
      window.scrollTo(saved.left, saved.top);
      return;
    }

    scroller.scrollLeft = saved.left;
    scroller.scrollTop = saved.top;
  }

  function setScrollTop(scroller, top) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      window.scrollTo({ top, left: window.scrollX, behavior: 'auto' });
      return;
    }

    scroller.scrollTop = top;
  }

  function getScrollHeight(scroller) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    }
    return scroller.scrollHeight;
  }

  function getViewportHeight(scroller) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      return window.innerHeight || 800;
    }
    return scroller.clientHeight || 800;
  }

  function getMessageNodes(root) {
    const roleNodes = Array.from(root.querySelectorAll('[data-message-author-role]'))
      .filter(isVisible)
      .filter(node => !node.closest(`#${HOST_ID}`));

    if (roleNodes.length) {
      return removeNestedNodes(roleNodes);
    }

    const turnNodes = Array.from(root.querySelectorAll(
      'article, [data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]',
    ))
      .filter(isVisible)
      .filter(node => !node.closest(`#${HOST_ID}`));

    return removeNestedNodes(turnNodes);
  }

  function removeNestedNodes(nodes) {
    const nodeSet = new Set(nodes);
    return nodes.filter(node => {
      let parent = node.parentElement;
      while (parent) {
        if (nodeSet.has(parent)) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function isVisible(node) {
    const style = getComputedStyle(node);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && (node.getClientRects().length > 0 || Boolean(node.textContent.trim()));
  }

  function parseMessage(node, index) {
    const contentRoot = findContentRoot(node);
    const clone = contentRoot.cloneNode(true);
    cleanClone(clone);

    const markdown = htmlToMarkdown(clone).trim();
    const content = normalizePlainText(clone.innerText || clone.textContent || '');

    if (!markdown && !content) {
      return null;
    }

    return {
      role: resolveRole(node, contentRoot, index),
      content: content || markdown,
      markdown: markdown || content,
      orderHint: getOrderHint(node),
    };
  }

  function findContentRoot(node) {
    const candidates = Array.from(node.querySelectorAll(
      '[data-message-content], [data-testid="message-content"], .markdown, .prose, [class*="markdown"], .whitespace-pre-wrap',
    ))
      .filter(candidate => !candidate.closest('button, [role="button"]'))
      .filter(candidate => (candidate.innerText || candidate.textContent || '').trim());

    if (!candidates.length) {
      return node;
    }

    return candidates.sort((a, b) => {
      const aLength = (a.innerText || a.textContent || '').length;
      const bLength = (b.innerText || b.textContent || '').length;
      return bLength - aLength;
    })[0];
  }

  function cleanClone(clone) {
    clone.querySelectorAll([
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[aria-hidden="true"]',
      'script',
      'style',
      'svg',
      'nav',
      'aside',
      '[data-testid*="copy"]',
      '[data-testid*="feedback"]',
      '[data-testid*="action"]',
      '[data-testid*="regenerate"]',
    ].join(',')).forEach(element => element.remove());
  }

  function resolveRole(node, contentRoot, index) {
    const attributes = [
      node.getAttribute('data-message-author-role'),
      node.getAttribute('data-role'),
      node.getAttribute('data-author'),
      node.getAttribute('data-testid'),
      node.className,
    ]
      .filter(value => typeof value === 'string')
      .join(' ')
      .toLowerCase();

    if (/\buser\b/.test(attributes) || attributes.includes('user-message')) {
      return 'user';
    }

    if (/\b(assistant|bot)\b/.test(attributes) || attributes.includes('assistant-message')) {
      return 'assistant';
    }

    if (contentRoot.matches('.markdown, .prose, [class*="markdown"]')
      || contentRoot.querySelector('.markdown, .prose, [class*="markdown"]')) {
      return 'assistant';
    }

    if (contentRoot.matches('.whitespace-pre-wrap')
      || contentRoot.querySelector('.whitespace-pre-wrap')) {
      return 'user';
    }

    return index % 2 === 0 ? 'user' : 'assistant';
  }

  function getOrderHint(node) {
    const numericHint = [
      'data-turn-index',
      'data-message-index',
      'data-index',
    ].map(attribute => getClosestAttribute(node, attribute))
      .find(value => /^\d+$/.test(value || ''));

    if (numericHint !== undefined) {
      return Number(numericHint);
    }

    const testId = getClosestAttribute(node, 'data-testid') || '';
    const match = testId.match(/(?:conversation-turn|turn|message)[-_](\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function getMessageIdentity(node, message) {
    const identity = [
      ['data-message-id', getClosestAttribute(node, 'data-message-id')],
      ['data-turn-id', getClosestAttribute(node, 'data-turn-id')],
      ['data-testid', getClosestAttribute(node, 'data-testid')],
    ].find(([, value]) => value && /(?:message|turn|conversation)/i.test(value));

    if (identity) {
      return `${identity[0]}:${identity[1]}`;
    }

    return message.orderHint === null ? null : `order:${message.orderHint}`;
  }

  function getClosestAttribute(node, attribute) {
    let current = node;

    while (current && current !== document.body) {
      const value = current.getAttribute?.(attribute);
      if (value) {
        return value;
      }
      current = current.parentElement;
    }

    return null;
  }

  function findSimilarRecord(records, message) {
    const prefix = message.content.slice(0, 100);

    if (prefix.length < 24) {
      return null;
    }

    for (const record of records.values()) {
      if (record.role !== message.role) {
        continue;
      }

      const existingPrefix = record.content.slice(0, 100);
      if (existingPrefix.startsWith(prefix) || prefix.startsWith(existingPrefix)) {
        return record;
      }
    }

    return null;
  }

  function isMoreComplete(next, current) {
    return next.content.length > current.content.length
      || next.markdown.length > current.markdown.length;
  }

  function normalizePlainText(value) {
    return value
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function htmlToMarkdown(root) {
    return normalizeMarkdown(convertNode(root, { inPre: false, inList: false }));
  }

  function convertNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return context.inPre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes)
      .map(child => convertNode(child, context))
      .join('');

    if (['script', 'style', 'noscript', 'button', 'svg'].includes(tag)) {
      return '';
    }

    if (tag === 'br') {
      return '\n';
    }

    if (tag === 'pre') {
      const code = node.querySelector('code');
      const languageClass = code?.className?.match(/(?:language|lang)-([\w+-]+)/i);
      const language = languageClass ? languageClass[1] : '';
      const codeText = (code ? code.textContent : node.textContent || '')
        .replace(/^\n/, '')
        .replace(/\n$/, '');
      return `\n\n\`\`\`${language}\n${codeText}\n\`\`\`\n\n`;
    }

    if (tag === 'code') {
      return context.inPre ? node.textContent || '' : `\`${escapeInlineCode(node.textContent || '')}\``;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `\n\n${'#'.repeat(level)} ${convertInlineChildren(node)}\n\n`;
    }

    if (tag === 'blockquote') {
      const quote = normalizeMarkdown(convertNodeChildren(node, { ...context, inList: false }));
      return `\n\n${quote.split('\n').map(line => line ? `> ${line}` : '>').join('\n')}\n\n`;
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children)
        .filter(child => child.tagName?.toLowerCase() === 'li')
        .map((item, index) => {
          const marker = tag === 'ol' ? `${index + 1}.` : '-';
          return `${marker} ${convertListItem(item, context)}`;
        })
        .join('\n');
      return `\n\n${items}\n\n`;
    }

    if (tag === 'li') {
      return convertListItem(node, context);
    }

    if (tag === 'a') {
      const label = normalizeMarkdown(children()).trim();
      const href = node.getAttribute('href') || '';
      if (!label) {
        return '';
      }
      if (/^(?:https?:|mailto:|#)/i.test(href)) {
        return `[${label}](${href})`;
      }
      return label;
    }

    if (tag === 'img') {
      const alt = (node.getAttribute('alt') || '').trim();
      return alt ? `[imagen: ${alt}]` : '[imagen]';
    }

    if (tag === 'hr') {
      return '\n\n---\n\n';
    }

    if (tag === 'table') {
      return tableToMarkdown(node);
    }

    if (tag === 'strong' || tag === 'b') {
      const value = normalizeMarkdown(children()).trim();
      return value ? `**${value}**` : '';
    }

    if (tag === 'em' || tag === 'i') {
      const value = normalizeMarkdown(children()).trim();
      return value ? `*${value}*` : '';
    }

    if (tag === 'del' || tag === 's') {
      const value = normalizeMarkdown(children()).trim();
      return value ? `~~${value}~~` : '';
    }

    if (['p', 'div', 'section', 'article', 'header', 'footer', 'figure'].includes(tag)) {
      return `\n\n${children()}\n\n`;
    }

    return children();
  }

  function convertNodeChildren(node, context) {
    return Array.from(node.childNodes)
      .map(child => convertNode(child, context))
      .join('');
  }

  function convertInlineChildren(node) {
    return normalizeMarkdown(convertNodeChildren(node, { inPre: false, inList: false }))
      .replace(/\n+/g, ' ')
      .trim();
  }

  function convertListItem(node, context) {
    const parts = Array.from(node.childNodes)
      .map(child => convertNode(child, { ...context, inList: true }))
      .join('');
    return normalizeMarkdown(parts)
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map(row => {
      const cells = Array.from(row.children)
        .filter(cell => ['th', 'td'].includes(cell.tagName.toLowerCase()))
        .map(cell => normalizeMarkdown(convertNodeChildren(cell, { inPre: false, inList: false }))
          .replace(/\|/g, '\\|')
          .replace(/\n+/g, ' ')
          .trim());
      return cells;
    }).filter(row => row.length);

    if (!rows.length) {
      return '';
    }

    const width = Math.max(...rows.map(row => row.length));
    const normalizedRows = rows.map(row => [...row, ...Array(width - row.length).fill('')]);
    const separator = Array(width).fill('---');
    const lines = [
      `| ${normalizedRows[0].join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...normalizedRows.slice(1).map(row => `| ${row.join(' | ')} |`),
    ];
    return `\n\n${lines.join('\n')}\n\n`;
  }

  function normalizeMarkdown(value) {
    return value
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeInlineCode(value) {
    return value.replace(/`/g, '\\`').replace(/\n/g, ' ');
  }

  function getConversationTitle() {
    const explicitTitle = document.querySelector('[data-testid="conversation-title"]')?.textContent;
    const documentTitle = document.title
      .replace(/\s*[|—-]\s*ChatGPT\s*$/i, '')
      .replace(/^ChatGPT\s*[|—-]\s*/i, '')
      .trim();
    const title = (explicitTitle || documentTitle || 'Conversación de ChatGPT')
      .replace(/\s+/g, ' ')
      .trim();
    return title || 'Conversación de ChatGPT';
  }

  function roleLabel(role) {
    if (role === 'user') {
      return 'Usuario';
    }
    if (role === 'assistant') {
      return 'Asistente';
    }
    return 'Mensaje';
  }

  function toMarkdown(conversation) {
    const sections = conversation.messages.map(message => {
      const body = (message.markdown || message.content || '(sin texto)').trim();
      return `## ${roleLabel(message.role)}\n\n${body}`;
    });

    return `# ${conversation.title.replace(/[\r\n]+/g, ' ')}\n\n${sections.join('\n\n')}\n`;
  }

  function toJson(conversation) {
    return JSON.stringify({
      title: conversation.title,
      messages: conversation.messages.map(message => ({
        role: message.role,
        content: message.markdown || message.content || '',
      })),
    }, null, 2);
  }

  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();

      if (!copied) {
        throw new Error('COPY_FAILED');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'COPY_FAILED') {
        throw error;
      }
      throw new Error('COPY_FAILED');
    }
  }

  function delay(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }
})();

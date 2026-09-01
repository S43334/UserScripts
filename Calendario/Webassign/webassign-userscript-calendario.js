// ==UserScript==
// @name         WebAssign → Google Calendar (Bubble Menu & Auto-Sync)
// @namespace    https://webassign.net/
// @version      3.18.0
// @description  Sincronización segura de WebAssign con Google Calendar y exportación local de actividades a LaTeX con imágenes, medios renderizados y frames interactivos desde la misma Bubble Menu.
// @match        https://webassign.net/*
// @match        https://*.webassign.net/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      d1y697tm02rkex.cloudfront.net
// ==/UserScript==

(() => {
  'use strict';

  // =========================================================
  // Mapa modular del userscript (un solo archivo, IIFE aislada)
  // 1. Calendar: configuración, sesión y persistencia
  // 2. Interfaz compartida: Bubble Menu, modal y toast
  // 3. Exportación WebAssign → LaTeX: parser, medios y archivos
  // 4. WebAssign: descubrimiento de actividades para Calendar
  // 5. Google Identity Services: autenticación
  // 6. Google Calendar: API y sincronización
  // 7. Utilidades comunes
  // Las ediciones del exportador deben permanecer dentro del módulo 3.
  // =========================================================

  // ---------------------------------------------------------
  // Claves de Almacenamiento Protegido (Sandbox GM)
  // ---------------------------------------------------------
  const CONFIG_KEY = 'wa_gc_config_v2';
  const TOKEN_KEY = 'wa_gc_token_v2';

  const LATEX_EXPORT_DB_NAME = 'webassign-calendar-latex-export';
  const LATEX_EXPORT_DB_VERSION = 1;
  const LATEX_EXPORT_DB_STORE = 'course-folders';
  const LATEX_EXPORT_ROOT_NAME = '08_TAREAS';
  const LATEX_EXPORT_IMAGE_DIRECTORY = 'imagenes';
  const LATEX_EXPORT_TIMEOUT = 30000;
  const LATEX_EXPORT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const LATEX_EXPORT_MAX_IMAGE_PIXELS = 25_000_000;
  const LATEX_EXPORT_IMAGE_OPTIONS = 'width=0.92\\linewidth,height=0.42\\textheight,keepaspectratio';
  const LATEX_EXPORT_VARIANTS = Object.freeze({
    clean: Object.freeze({ directory: 'actividad-limpia', fileName: 'actividad-limpia.tex' }),
    resolved: Object.freeze({ directory: 'actividad-resuelta', fileName: 'actividad-resuelta.tex' }),
  });
  const LATEX_EXPORT_RASTER_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
  ]);
  // Debe mantenerse sincronizada con las cabeceras @connect: Tampermonkey bloquea
  // GM_xmlhttpRequest hacia cualquier host ausente de @connect aunque esté aquí.
  // Solo hostnames exactos; un comodín como *.cloudfront.net abriría el exportador
  // a cualquier distribución de terceros.
  const LATEX_EXPORT_IMAGE_HOSTS = new Set([
    'd1y697tm02rkex.cloudfront.net',
  ]);
  const LATEX_EXPORT_FRAME_HOSTS = new Set([
    'webassign.net',
    'www.webassign.net',
  ]);

  // Datos institucionales de portada. Son marcadores genéricos: cada usuario
  // define los suyos desde la configuración local del script (GM_setValue),
  // nunca en el repositorio. Se emiten con escapes LaTeX para mantener
  // compilación pdflatex-portable.
  const LATEX_STUDENT_DEFAULTS = {
    author: String.raw`Apellido Apellido, Nombre`,
    matricula: '00000000',
    career: String.raw`Carrera`,
    school: String.raw`Escuela`,
    university: String.raw`Universidad`,
  };

  const GOOGLE_IDENTITY_URL = 'https://accounts.google.com/gsi/client';
  const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
  const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
  const GOOGLE_TIMEOUT = 20000;

  const MANAGED_PROPERTY = 'webassignManaged';
  const COURSE_PROPERTY = 'webassignCourse';
  const ASSIGNMENT_PROPERTY = 'webassignAssignment';

  const DEFAULT_CONFIG = {
    clientId: '',
    student: { ...LATEX_STUDENT_DEFAULTS },
    calendarId: 'primary',
    emailReminderMinutes: 60,
    popupReminderMinutes: 0,
    autoSync: true,
    autoSyncMinutes: 10,
  };

  // Variables de Estado en Memoria
  let config = loadConfig();
  let googleAccessToken = '';
  let googleAccessTokenExpiresAt = 0;
  let googleTokenClient = null;
  let googleIdentityPromise = null;

  let syncing = false;
  let panel = null;
  let statusElement = null;
  let autoSyncTimer = null;
  let badgeUpdateTimer = null;

  let isMenuOpen = false;
  let bubbleMenuContainer = null;
  let settingsModal = null;
  let settingsCloseButton = null;
  let settingsReturnFocus = null;
  let toastTimeout = null;

  const latexExportState = {
    exporting: false,
    directoryHandle: null,
    courseKey: null,
    courseName: '',
  };

  // ---------------------------------------------------------
  // [MÓDULO 1] Calendar: almacenamiento aislado y sesión
  // ---------------------------------------------------------

  function storageGet(key, defaultValue = null) {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key, null);
        if (val === null || val === undefined) return defaultValue;
        if (typeof val === 'object') return val;
        try {
          return JSON.parse(val);
        } catch (_) {
          return val;
        }
      }
    } catch (e) {
      console.warn('[WebAssign Calendar] Error al leer GM_getValue:', e);
    }
    return defaultValue;
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, typeof value === 'object' ? JSON.stringify(value) : value);
      }
    } catch (e) {
      console.error('[WebAssign Calendar] Error al guardar en GM_setValue:', e);
    }
  }

  function storageDelete(key) {
    try {
      if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(key);
      }
    } catch (e) {
      console.error('[WebAssign Calendar] Error al eliminar GM_deleteValue:', e);
    }
  }

  function loadConfig() {
    const saved = storageGet(CONFIG_KEY, null);
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_CONFIG };
    const savedStudent = saved.student && typeof saved.student === 'object' ? saved.student : {};
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      student: { ...LATEX_STUDENT_DEFAULTS, ...savedStudent },
      calendarId: 'primary',
    };
  }

  function saveConfig(next) {
    config = { ...DEFAULT_CONFIG, ...next, calendarId: 'primary' };
    storageSet(CONFIG_KEY, config);
  }

  function saveToken(token, expiresInSeconds) {
    // Margen de seguridad de 60 segundos antes de la expiración real
    const expiresAt = Date.now() + Math.max(expiresInSeconds - 60, 60) * 1000;
    const tokenData = { token, expiresAt };

    storageSet(TOKEN_KEY, tokenData);
    googleAccessToken = token;
    googleAccessTokenExpiresAt = expiresAt;

    updateSessionBadge();
  }

  function loadSavedToken() {
    const saved = storageGet(TOKEN_KEY, null);
    if (saved && saved.token && saved.expiresAt > Date.now()) {
      googleAccessToken = saved.token;
      googleAccessTokenExpiresAt = saved.expiresAt;
      return saved.token;
    }
    purgeToken();
    return null;
  }

  function isTokenValid() {
    return Boolean(
      googleAccessToken && Date.now() + 5000 < googleAccessTokenExpiresAt
    );
  }

  function purgeToken() {
    googleAccessToken = '';
    googleAccessTokenExpiresAt = 0;
    googleTokenClient = null;
    storageDelete(TOKEN_KEY);
    updateSessionBadge();
  }

  // ---------------------------------------------------------
  // [MÓDULO 2] Interfaz compartida: inicialización y Bubble Menu
  // ---------------------------------------------------------

  if (window.top !== window.self) {
    initLatexFrameBridge();
    return;
  }

  init();

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
    window.addEventListener('load', boot);
  }

  function initLatexFrameBridge() {
    window.addEventListener('message', async (event) => {
      if (event.source !== window.parent) return;

      const request = event.data;
      if (!request || request.type !== 'wa-latex-capture-frame' || !request.requestId) return;

      let parentOrigin = '';
      try {
        const parentUrl = new URL(event.origin);
        if (parentUrl.protocol !== 'https:') return;
        if (
          parentUrl.hostname !== 'webassign.net'
          && !parentUrl.hostname.endsWith('.webassign.net')
        ) return;
        parentOrigin = parentUrl.origin;
      } catch (_) {
        return;
      }

      const response = {
        type: 'wa-latex-capture-frame-result',
        requestId: String(request.requestId),
        ok: false,
        contentType: 'image/png',
      };

      try {
        const blob = await latexCaptureFrameDocument(document);

        const bytes = await blob.arrayBuffer();
        if (bytes.byteLength > LATEX_EXPORT_MAX_IMAGE_BYTES) {
          throw new Error('La imagen de la gráfica supera el límite permitido.');
        }

        response.ok = true;
        response.bytes = bytes;
      } catch (error) {
        response.error = error?.message || 'No se pudo capturar la gráfica interactiva.';
      }

      window.parent.postMessage(response, parentOrigin);
    });
  }

  function latexFindLargestCanvas(documentNode) {
    return Array.from(documentNode?.querySelectorAll('canvas') || [])
      .filter((candidate) => candidate.width > 0 && candidate.height > 0)
      .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0] || null;
  }

  function latexCanvasToPngBlob(canvas) {
    if (!canvas || canvas.width * canvas.height > LATEX_EXPORT_MAX_IMAGE_PIXELS) {
      return Promise.reject(new Error('El canvas de la gráfica supera el límite permitido.'));
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('La conversión del canvas tardó demasiado.'));
      }, Math.min(LATEX_EXPORT_TIMEOUT, 5000));

      try {
        canvas.toBlob((result) => {
          window.clearTimeout(timeout);
          if (result) resolve(result);
          else reject(new Error('El canvas no pudo convertirse a PNG.'));
        }, 'image/png');
      } catch (error) {
        window.clearTimeout(timeout);
        if (error?.name === 'SecurityError') {
          // Canvas contaminado por una imagen sin CORS: el llamador puede recargarla.
          const tainted = new Error('El canvas quedó contaminado por una imagen sin CORS.');
          tainted.tainted = true;
          reject(tainted);
          return;
        }
        reject(error);
      }
    });
  }

  function latexFindLargestSvg(documentNode) {
    return Array.from(documentNode?.querySelectorAll('svg') || [])
      .filter((candidate) => {
        const bounds = candidate.getBoundingClientRect?.();
        return (bounds?.width || candidate.clientWidth) > 0
          && (bounds?.height || candidate.clientHeight) > 0;
      })
      .sort((left, right) => {
        const leftBounds = left.getBoundingClientRect();
        const rightBounds = right.getBoundingClientRect();
        return (rightBounds.width * rightBounds.height) - (leftBounds.width * leftBounds.height);
      })[0] || null;
  }

  async function latexSvgToPngBlob(svg) {
    if (!svg) throw new Error('La gráfica interactiva no expone un SVG capturable.');

    const bounds = svg.getBoundingClientRect();
    const width = Math.ceil(bounds.width || svg.clientWidth || 0);
    const height = Math.ceil(bounds.height || svg.clientHeight || 0);
    if (!width || !height || width * height > LATEX_EXPORT_MAX_IMAGE_PIXELS) {
      throw new Error('El SVG de la gráfica supera el límite de dimensiones permitido.');
    }

    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const serialized = new XMLSerializer().serializeToString(clone);
    const objectUrl = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
    try {
      const image = await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error('La rasterización del SVG tardó demasiado.'));
        }, Math.min(LATEX_EXPORT_TIMEOUT, 5000));
        const candidate = new Image();
        candidate.onload = () => {
          window.clearTimeout(timeout);
          resolve(candidate);
        };
        candidate.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('El SVG de la gráfica no pudo rasterizarse.'));
        };
        candidate.src = objectUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: false });
      if (!context) throw new Error('No se pudo preparar el conversor del SVG.');
      context.drawImage(image, 0, 0, width, height);
      return latexCanvasToPngBlob(canvas);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function latexCaptureFrameDocument(documentNode) {
    if (!documentNode) {
      throw new Error('La gráfica interactiva no expone un documento capturable.');
    }

    const view = documentNode.defaultView || window;
    const deadline = Date.now() + Math.min(LATEX_EXPORT_TIMEOUT, 5000);
    let nudged = false;

    while (Date.now() <= deadline) {
      const canvas = latexFindLargestCanvas(documentNode);
      if (canvas) return latexCanvasToPngBlob(canvas);

      const svg = latexFindLargestSvg(documentNode);
      if (svg) return latexSvgToPngBlob(svg);

      if (!nudged) {
        nudged = true;
        // Algunas gráficas legacy de WebAssign esperan a que el iframe entre
        // en viewport antes de reemplazar el spinner por su canvas. La captura
        // puede ejecutarse antes de ese evento, así que reproducimos el mínimo
        // estímulo de visibilidad dentro del propio documento del frame.
        try { view.dispatchEvent(new view.Event('scroll')); } catch (_) {}
        try { view.dispatchEvent(new view.Event('resize')); } catch (_) {}
        Array.from(documentNode.querySelectorAll('.int3dgraph, .graphing-item, .graph'))
          .forEach((node) => {
            try {
              node.dispatchEvent(new view.Event('appear', { bubbles: true }));
            } catch (_) {}
          });
      }

      await new Promise((resolve) => view.setTimeout(resolve, 100));
    }

    throw new Error('La gráfica interactiva no expone un canvas o SVG capturable.');
  }

  function boot() {
    createPanelSafe();
    loadSavedToken();
    startBadgeTelemetry();
    void restoreLatexFolderForCurrentCourse();

    loadGoogleIdentityServices().catch(() => {});

    // Reintentos controlados para asegurar que el DOM de WebAssign/React y las tareas se lean
    [500, 1500, 3000].forEach((delay) => {
      window.setTimeout(async () => {
        createPanelSafe();
        updateAssignmentCount();
        updateSessionBadge();
        if (delay === 1500) void restoreLatexFolderForCurrentCourse();

        if (delay === 1500 && config.autoSync) {
          scheduleAutoSync();
          if (isTokenValid()) {
            updateStatus('Sincronización silenciosa al iniciar…', 'info');
            await syncNow(true, false);
          }
        }
      }, delay);
    });
  }

  // ---------------------------------------------------------
  // [MÓDULO 2] Interfaz compartida: Bubble Menu y modal
  // ---------------------------------------------------------

  function createPanelSafe() {
    if (document.querySelector('#wa-bubble-menu-root')) {
      updateAssignmentCount();
      updateSessionBadge();
      return;
    }

    if (!document.body && !document.documentElement) return;

    injectStyles();

    // Contenedor principal de Bubble Menu
    bubbleMenuContainer = document.createElement('div');
    bubbleMenuContainer.id = 'wa-bubble-menu-root';
    bubbleMenuContainer.className = 'wa-bubble-container';

    // Lista de Píldoras / Acciones Desplegables
    const pillList = document.createElement('div');
    pillList.className = 'wa-bubble-pill-list';
    pillList.id = 'wa-bubble-pill-list';

    // Píldora 1: Estado de Sincronización / Actividades
    const pillStatus = document.createElement('div');
    pillStatus.className = 'wa-bubble-pill wa-pill-status';
    const pillStatusDot = document.createElement('span');
    pillStatusDot.className = 'wa-pill-dot';
    const pillStatusText = document.createElement('span');
    pillStatusText.id = 'wa-pill-status-text';
    pillStatusText.textContent = '3 actividades · Inactiva';
    pillStatus.appendChild(pillStatusDot);
    pillStatus.appendChild(pillStatusText);

    // Píldora 2: Sincronizar Ahora (Botón Primario)
    const pillSync = document.createElement('button');
    pillSync.type = 'button';
    pillSync.className = 'wa-bubble-pill wa-pill-action wa-pill-sync';
    pillSync.innerHTML = `<span>⚡</span> <span>Sincronizar ahora</span>`;
    pillSync.addEventListener('click', async () => {
      toggleBubbleMenu(false);
      await syncNow(false, true);
    });

    // Píldora 3: Exportar la actividad actual a LaTeX
    const pillExport = document.createElement('button');
    pillExport.type = 'button';
    pillExport.className = 'wa-bubble-pill wa-pill-action wa-pill-export';
    pillExport.innerHTML = `<span aria-hidden="true">📄</span> <span>Exportar LaTeX</span>`;
    pillExport.setAttribute('aria-label', 'Exportar la actividad actual de WebAssign a LaTeX');
    pillExport.addEventListener('click', () => {
      toggleBubbleMenu(false);
      startLatexExportFromGesture(pillExport);
    });

    // Píldora 4: Configuración (Abre Modal Minimalista)
    const pillSettings = document.createElement('button');
    pillSettings.type = 'button';
    pillSettings.className = 'wa-bubble-pill wa-pill-action wa-pill-settings';
    pillSettings.innerHTML = `<span>⚙️</span> <span>Ajustes</span>`;
    pillSettings.setAttribute('aria-controls', 'wa-settings-modal');
    pillSettings.setAttribute('aria-haspopup', 'dialog');
    pillSettings.setAttribute('aria-expanded', 'false');
    pillSettings.addEventListener('click', () => {
      toggleBubbleMenu(false);
      toggleSettingsModal(true, pillSettings);
    });

    // Píldora 5: Desconectar
    const pillPurge = document.createElement('button');
    pillPurge.type = 'button';
    pillPurge.className = 'wa-bubble-pill wa-pill-action wa-pill-danger';
    pillPurge.innerHTML = `<span>🔒</span> <span>Desconectar</span>`;
    pillPurge.addEventListener('click', () => {
      purgeToken();
      updateStatus('Token eliminado de la sesión.', 'info');
      toggleBubbleMenu(false);
    });

    pillList.appendChild(pillStatus);
    pillList.appendChild(pillSync);
    pillList.appendChild(pillExport);
    pillList.appendChild(pillSettings);
    pillList.appendChild(pillPurge);

    // Botón Gatillo Flotante (Bubble Trigger)
    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'wa-bubble-trigger';
    triggerBtn.title = 'WebAssign → Google Calendar';
    triggerBtn.setAttribute('aria-label', 'Abrir menú de WebAssign');
    triggerBtn.setAttribute('aria-controls', pillList.id);
    triggerBtn.setAttribute('aria-expanded', 'false');

    const triggerIcon = document.createElement('div');
    triggerIcon.className = 'wa-trigger-icon';
    triggerIcon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

    const triggerBadge = document.createElement('span');
    triggerBadge.id = 'wa-trigger-badge';
    triggerBadge.className = 'wa-trigger-badge';
    triggerBadge.textContent = '3';

    triggerBtn.appendChild(triggerIcon);
    triggerBtn.appendChild(triggerBadge);

    triggerBtn.addEventListener('click', () => {
      toggleBubbleMenu(!isMenuOpen);
    });

    bubbleMenuContainer.appendChild(pillList);
    bubbleMenuContainer.appendChild(triggerBtn);
    (document.body || document.documentElement).appendChild(bubbleMenuContainer);

    // Modal de Configuración Flotante (Limpio y Fuera de la Vista Principal)
    createSettingsModal();

    // Cerrar menú al hacer clic fuera
    document.addEventListener('click', (e) => {
      if (isMenuOpen && !bubbleMenuContainer.contains(e.target) && !settingsModal?.contains(e.target)) {
        toggleBubbleMenu(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (settingsModal?.classList.contains('wa-modal-visible')) {
          e.preventDefault();
          toggleSettingsModal(false);
        } else if (isMenuOpen) {
          e.preventDefault();
          toggleBubbleMenu(false);
        }
        return;
      }

      if (e.key === 'Tab' && settingsModal?.classList.contains('wa-modal-visible')) {
        trapSettingsFocus(e);
      }
    });

    // Toast flotante discreto de estado
    statusElement = document.createElement('div');
    statusElement.id = 'wa-bubble-toast';
    statusElement.className = 'wa-bubble-toast';
    statusElement.setAttribute('role', 'status');
    statusElement.setAttribute('aria-live', 'polite');
    statusElement.setAttribute('aria-atomic', 'true');
    (document.body || document.documentElement).appendChild(statusElement);
  }

  function toggleBubbleMenu(open) {
    isMenuOpen = open;
    if (bubbleMenuContainer) {
      bubbleMenuContainer.classList.toggle('wa-menu-open', open);
      const trigger = bubbleMenuContainer.querySelector('.wa-bubble-trigger');
      trigger?.setAttribute('aria-expanded', String(open));
    }
    if (open) {
      const firstAction = bubbleMenuContainer?.querySelector('.wa-bubble-pill:not(.wa-pill-status)');
      firstAction?.focus();
    }
  }

  function createSettingsModal() {
    settingsModal = document.createElement('div');
    settingsModal.id = 'wa-settings-modal';
    settingsModal.className = 'wa-settings-modal';
    settingsModal.setAttribute('role', 'dialog');
    settingsModal.setAttribute('aria-modal', 'true');
    settingsModal.setAttribute('aria-labelledby', 'wa-settings-title');
    settingsModal.setAttribute('aria-hidden', 'true');
    settingsModal.tabIndex = -1;

    const card = document.createElement('div');
    card.className = 'wa-modal-card';

    const header = document.createElement('div');
    header.className = 'wa-modal-header';
    header.innerHTML = `<strong id="wa-settings-title">Ajustes de Sincronización</strong>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.className = 'wa-modal-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar ajustes');
    settingsCloseButton = closeBtn;
    closeBtn.addEventListener('click', () => toggleSettingsModal(false));
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'wa-modal-body';

    // Client ID
    const labelClientId = document.createElement('label');
    labelClientId.className = 'wa-modal-label';
    labelClientId.textContent = 'Google Client ID';
    const inputClientId = document.createElement('input');
    inputClientId.id = 'wa-modal-client-id';
    inputClientId.type = 'text';
    inputClientId.placeholder = '1234567890-abc.apps.googleusercontent.com';
    inputClientId.value = config.clientId || '';
    labelClientId.appendChild(inputClientId);

    // AutoSync
    const labelAutoSync = document.createElement('label');
    labelAutoSync.className = 'wa-modal-checkbox';
    const inputAutoSync = document.createElement('input');
    inputAutoSync.id = 'wa-modal-auto-sync';
    inputAutoSync.type = 'checkbox';
    inputAutoSync.checked = Boolean(config.autoSync);
    labelAutoSync.appendChild(inputAutoSync);
    labelAutoSync.appendChild(document.createTextNode(' Sincronizar automáticamente en segundo plano'));

    // Intervalo
    const labelInterval = document.createElement('label');
    labelInterval.className = 'wa-modal-label';
    labelInterval.textContent = 'Frecuencia de sincronización';
    const selectInterval = document.createElement('select');
    selectInterval.id = 'wa-modal-interval';
    [5, 10, 15, 30].forEach((mins) => {
      const opt = document.createElement('option');
      opt.value = String(mins);
      opt.textContent = `Cada ${mins} minutos`;
      if (config.autoSyncMinutes === mins) opt.selected = true;
      selectInterval.appendChild(opt);
    });
    labelInterval.appendChild(selectInterval);

    // Exportación local de ejercicios a LaTeX
    const latexSection = document.createElement('fieldset');
    latexSection.className = 'wa-settings-section';

    const latexLegend = document.createElement('legend');
    latexLegend.textContent = 'Exportación de ejercicios';

    const latexFolderStatus = document.createElement('p');
    latexFolderStatus.id = 'wa-latex-folder-status';
    latexFolderStatus.className = 'wa-latex-folder-status';
    latexFolderStatus.setAttribute('aria-live', 'polite');

    const latexFolderActions = document.createElement('div');
    latexFolderActions.className = 'wa-latex-folder-actions';

    const pickFolderBtn = document.createElement('button');
    pickFolderBtn.type = 'button';
    pickFolderBtn.className = 'wa-modal-secondary';
    pickFolderBtn.textContent = 'Elegir carpeta';
    pickFolderBtn.addEventListener('click', () => {
      startLatexFolderSelectionFromGesture();
    });

    const forgetFolderBtn = document.createElement('button');
    forgetFolderBtn.type = 'button';
    forgetFolderBtn.className = 'wa-modal-secondary wa-modal-secondary-danger';
    forgetFolderBtn.textContent = 'Olvidar permiso';
    forgetFolderBtn.addEventListener('click', () => {
      void forgetLatexFolderForCurrentCourse();
    });

    latexFolderActions.appendChild(pickFolderBtn);
    latexFolderActions.appendChild(forgetFolderBtn);
    latexSection.appendChild(latexLegend);
    latexSection.appendChild(latexFolderStatus);
    latexSection.appendChild(latexFolderActions);

    // Botón Guardar
    const saveBtn = document.createElement('button');
    saveBtn.className = 'wa-modal-save';
    saveBtn.textContent = 'Guardar y Aplicar';
    saveBtn.addEventListener('click', () => {
      saveConfig({
        clientId: inputClientId.value.trim(),
        autoSync: inputAutoSync.checked,
        autoSyncMinutes: Number(selectInterval.value),
      });
      scheduleAutoSync();
      updateStatus('Configuración guardada.', 'success');
      toggleSettingsModal(false);
    });

    body.appendChild(labelClientId);
    body.appendChild(labelAutoSync);
    body.appendChild(labelInterval);
    body.appendChild(latexSection);
    body.appendChild(saveBtn);

    card.appendChild(header);
    card.appendChild(body);
    settingsModal.appendChild(card);
    (document.body || document.documentElement).appendChild(settingsModal);
    updateLatexFolderLabel();
  }

  function toggleSettingsModal(open, returnFocus = document.activeElement) {
    if (settingsModal) {
      const settingsTrigger = document.querySelector('.wa-pill-settings');
      settingsTrigger?.setAttribute('aria-expanded', String(open));
      if (open) {
        settingsReturnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
        updateLatexFolderLabel();
      }
      settingsModal.classList.toggle('wa-modal-visible', open);
      settingsModal.setAttribute('aria-hidden', String(!open));
      if (open) {
        window.requestAnimationFrame(() => settingsCloseButton?.focus());
      } else {
        const focusTarget = settingsReturnFocus;
        settingsReturnFocus = null;
        if (focusTarget && document.contains(focusTarget)) focusTarget.focus();
      }
    }
  }

  function injectStyles() {
    if (document.querySelector('#wa-bubble-calendar-style')) return;

    const style = document.createElement('style');
    style.id = 'wa-bubble-calendar-style';
    style.textContent = `
      .wa-bubble-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      .wa-bubble-trigger {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.15);
        background: #1e1e1e;
        color: #ffffff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        transition: transform 0.2s ease, background 0.25s ease, border-color 0.25s ease;
        position: relative;
        padding: 0;
      }
      .wa-bubble-trigger:hover {
        transform: scale(1.06);
        background: #282828;
      }
      .wa-bubble-container.wa-menu-open .wa-bubble-trigger {
        transform: none;
        background: #2563eb;
        border-color: #3b82f6;
      }

      .wa-trigger-badge {
        position: absolute;
        top: -3px;
        right: -3px;
        background: #3b82f6;
        color: #ffffff;
        font-size: 10px;
        font-weight: 700;
        min-width: 18px;
        height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        box-sizing: border-box;
        border: 2px solid #121212;
        line-height: 1;
        padding: 0 2px;
      }

      .wa-bubble-pill-list {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(12px) scale(0.95);
        transform-origin: bottom right;
        transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .wa-bubble-container.wa-menu-open .wa-bubble-pill-list {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }

      .wa-bubble-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 16px;
        border-radius: 9999px;
        background: #18181b;
        color: #f4f4f5;
        font-size: 13px;
        font-weight: 500;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        cursor: pointer;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s, border-color 0.2s;
        white-space: nowrap;
        user-select: none;
      }
      .wa-bubble-pill:hover {
        transform: translateX(-4px) scale(1.02);
      }

      .wa-pill-status {
        cursor: default;
        background: #27272a;
        font-size: 12px;
        color: #a1a1aa;
        border-color: rgba(255, 255, 255, 0.06);
      }
      .wa-pill-status:hover { transform: none; }
      .wa-pill-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444;
      }
      .wa-pill-dot.active {
        background: #22c55e;
        box-shadow: 0 0 8px #22c55e;
      }

      .wa-pill-sync {
        background: #2563eb;
        color: #ffffff;
        border-color: #3b82f6;
      }
      .wa-pill-sync:hover {
        background: #1d4ed8;
      }

      .wa-pill-export {
        background: #047857;
        color: #ffffff;
        border-color: #10b981;
      }
      .wa-pill-export:hover {
        background: #065f46;
      }
      .wa-pill-export:disabled,
      .wa-pill-sync:disabled {
        cursor: wait;
        opacity: 0.7;
      }

      .wa-pill-settings:hover {
        background: #3f3f46;
      }

      .wa-pill-danger {
        color: #f87171;
        font-size: 12px;
      }
      .wa-pill-danger:hover {
        background: #450a0a;
        border-color: #7f1d1d;
      }

      .wa-bubble-pill:focus-visible,
      .wa-modal-card button:focus-visible,
      .wa-modal-card input:focus-visible,
      .wa-modal-card select:focus-visible {
        outline: 2px solid #93c5fd;
        outline-offset: 3px;
      }

      /* Modal de Ajustes */
      .wa-settings-modal {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      .wa-settings-modal.wa-modal-visible {
        opacity: 1;
        pointer-events: auto;
      }
      .wa-modal-card {
        background: #18181b;
        color: #f4f4f5;
        border: 1px solid #3f3f46;
        border-radius: 16px;
        width: 360px;
        max-width: calc(100vw - 32px);
        max-height: 90vh;
        overflow: auto;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      }
      .wa-modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid #27272a;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .wa-modal-close {
        background: transparent;
        border: none;
        color: #a1a1aa;
        font-size: 20px;
        cursor: pointer;
      }
      .wa-modal-close:hover { color: white; }
      .wa-modal-body { padding: 20px; }
      .wa-modal-label {
        display: block;
        font-size: 12px;
        color: #a1a1aa;
        margin-bottom: 14px;
      }
      .wa-modal-label input, .wa-modal-label select {
        display: block;
        width: 100%;
        margin-top: 6px;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid #3f3f46;
        background: #09090b;
        color: white;
        box-sizing: border-box;
      }

      .wa-settings-section {
        border: 1px solid #3f3f46;
        border-radius: 10px;
        margin: 12px 0 16px;
        padding: 12px;
      }
      .wa-settings-section legend {
        color: #a7f3d0;
        font-size: 12px;
        font-weight: 700;
        padding: 0 6px;
      }
      .wa-latex-folder-status {
        color: #d4d4d8;
        font-size: 12px;
        line-height: 1.45;
        margin: 0 0 10px;
        overflow-wrap: anywhere;
      }
      .wa-latex-folder-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .wa-modal-secondary {
        border: 1px solid #52525b;
        border-radius: 8px;
        background: #27272a;
        color: #f4f4f5;
        cursor: pointer;
        font-size: 12px;
        padding: 8px 10px;
      }
      .wa-modal-secondary:hover {
        background: #3f3f46;
      }
      .wa-modal-secondary-danger {
        color: #fca5a5;
      }
      .wa-modal-checkbox {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 12px;
        color: #d4d4d8;
        margin-bottom: 14px;
        cursor: pointer;
      }
      .wa-modal-save {
        width: 100%;
        padding: 10px;
        border-radius: 8px;
        border: none;
        background: #3b82f6;
        color: white;
        font-weight: 600;
        cursor: pointer;
        margin-top: 6px;
      }
      .wa-modal-save:hover { background: #2563eb; }

      /* Toast de Notificación a la izquierda de la burbuja */
      .wa-bubble-toast {
        position: fixed;
        bottom: 28px;
        right: 84px;
        background: rgba(24, 24, 27, 0.96);
        color: #f4f4f5;
        border: 1px solid rgba(255, 255, 255, 0.12);
        padding: 9px 15px;
        border-radius: 9999px;
        font-size: 12px;
        font-weight: 500;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        opacity: 0;
        transform: translateX(12px) scale(0.96);
        pointer-events: none;
        transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        z-index: 2147483647;
        max-width: min(440px, calc(100vw - 120px));
        white-space: normal;
      }
      .wa-bubble-toast.visible {
        opacity: 1;
        transform: translateX(0) scale(1);
      }
      .wa-bubble-toast.success { border-color: #22c55e; color: #86efac; }
      .wa-bubble-toast.error { border-color: #ef4444; color: #fca5a5; }
      .wa-bubble-toast.info { border-color: #3b82f6; color: #93c5fd; }

      @media (prefers-reduced-motion: reduce) {
        .wa-bubble-container *,
        .wa-bubble-toast {
          animation: none !important;
          transition: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function updateStatus(message, type = '') {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = `wa-bubble-toast visible ${type}`;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      statusElement.classList.remove('visible');
    }, 4500);
  }

  function updateAssignmentCount() {
    const assignments = extractAssignments();
    const badge = document.querySelector('#wa-trigger-badge');
    if (badge) badge.textContent = String(assignments.length);
  }

  function updateSessionBadge() {
    const statusText = document.querySelector('#wa-pill-status-text');
    const dot = document.querySelector('.wa-pill-dot');
    const assignments = extractAssignments();

    if (!statusText) return;

    if (isTokenValid()) {
      const remainingSeconds = Math.max(0, Math.round((googleAccessTokenExpiresAt - Date.now()) / 1000));
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;
      statusText.textContent = `${assignments.length} tareas · Activa (${mins}m ${secs < 10 ? '0' : ''}${secs}s)`;
      if (dot) dot.className = 'wa-pill-dot active';
    } else {
      statusText.textContent = `${assignments.length} tareas · Expirada`;
      if (dot) dot.className = 'wa-pill-dot';
    }
  }

  function startBadgeTelemetry() {
    if (badgeUpdateTimer) clearInterval(badgeUpdateTimer);
    badgeUpdateTimer = setInterval(() => {
      updateSessionBadge();
    }, 5000);
  }

  // ---------------------------------------------------------
  // [MÓDULO 3] WebAssign → LaTeX: selección, parser y exportación
  // ---------------------------------------------------------

  function parseWebAssignJsonAttribute(element, attributeName) {
    const raw = element?.getAttribute(attributeName) || '';
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (_) {
      try {
        return JSON.parse(decodeHtmlEntities(raw));
      } catch (_) {
        return null;
      }
    }
  }

  function getExpectedWebAssignQuestionCount() {
    const pageBottom = document.querySelector('#js-page-bottom');
    const pageProps = parseWebAssignJsonAttribute(pageBottom, 'data-assignment-props');
    const pageCount = Number(pageProps?.questionCount);
    if (Number.isInteger(pageCount) && pageCount > 0) return pageCount;

    const assignmentWrapper = document.querySelector('#js-assignment-wrapper');
    const assignmentData = parseWebAssignJsonAttribute(assignmentWrapper, 'data-assignment-data');
    const total = Number(assignmentData?.total);
    return Number.isInteger(total) && total > 0 ? total : null;
  }

  function getCurrentWebAssignAssignment() {
    const assignmentRoot = document.querySelector(
      '[id^="assignment"][data-assignment-name], .assignment[data-assignment-name]'
    );
    const questionRoot = assignmentRoot || document;
    const questions = Array.from(questionRoot.querySelectorAll('.waQBox'))
      .filter((question) => question.querySelector('article.v2Content, .studentQuestionContent'))
      .sort((a, b) => {
        const left = Number(a.dataset.viewPosition || 0);
        const right = Number(b.dataset.viewPosition || 0);
        return left - right;
      });

    const header = document.querySelector('#js-assignment-header');
    const headerData = parseWebAssignJsonAttribute(header, 'data-assignment-name');
    const headerName = typeof headerData === 'object'
      ? headerData?.assignment_name
      : headerData;
    const assignmentName = String(
      assignmentRoot?.dataset.assignmentName
      || headerName
      || ''
    ).trim();

    if (!assignmentName || !questions.length) return null;

    const course = getCourseInfo();
    return {
      name: assignmentName,
      course,
      questions,
      expectedQuestionCount: getExpectedWebAssignQuestionCount() || questions.length,
    };
  }

  // [MÓDULO 3A] Exportación LaTeX: carpeta por curso y permisos
  function latexCourseKey() {
    const course = getCourseInfo();
    const id = String(course.id || '').trim();
    const name = latexSafeFileName(course.name || 'curso-webassign', 'curso-webassign');
    return `webassign:${location.hostname}:${id || name}`;
  }

  function latexSafeFileName(value, fallback = 'archivo') {
    const normalized = String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
      .replace(/[$%#&{}~^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');

    if (!normalized || normalized === '.' || normalized === '..') return fallback;
    return normalized.slice(0, 120);
  }

  function latexSafePathSegments(path) {
    const raw = String(path || '').replace(/\\/g, '/');
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      throw new Error('Ruta de exportación no válida.');
    }

    return raw.split('/').filter(Boolean).map((segment) => {
      if (segment === '.' || segment === '..') {
        throw new Error('Ruta de exportación no válida.');
      }
      return latexSafeFileName(segment, 'archivo');
    });
  }

  function openLatexFolderDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB no está disponible en este navegador.'));
        return;
      }

      const request = window.indexedDB.open(
        LATEX_EXPORT_DB_NAME,
        LATEX_EXPORT_DB_VERSION
      );

      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LATEX_EXPORT_DB_STORE)) {
          request.result.createObjectStore(LATEX_EXPORT_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error || new Error('No se pudo abrir el almacenamiento de carpetas.')
      );
    });
  }

  async function saveLatexFolderHandle(courseKey, handle) {
    const database = await openLatexFolderDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(LATEX_EXPORT_DB_STORE, 'readwrite');
        transaction.objectStore(LATEX_EXPORT_DB_STORE).put(handle, courseKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error('No se pudo guardar la carpeta de exportación.')
        );
      });
    } finally {
      database.close();
    }
  }

  async function loadLatexFolderHandle(courseKey) {
    const database = await openLatexFolderDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(LATEX_EXPORT_DB_STORE, 'readonly');
        const request = transaction.objectStore(LATEX_EXPORT_DB_STORE).get(courseKey);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(
          request.error || new Error('No se pudo leer la carpeta de exportación.')
        );
      });
    } finally {
      database.close();
    }
  }

  async function deleteLatexFolderHandle(courseKey) {
    const database = await openLatexFolderDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(LATEX_EXPORT_DB_STORE, 'readwrite');
        transaction.objectStore(LATEX_EXPORT_DB_STORE).delete(courseKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error('No se pudo olvidar la carpeta de exportación.')
        );
      });
    } finally {
      database.close();
    }
  }

  function setLatexFolderState(handle, courseKey, courseName) {
    latexExportState.directoryHandle = handle;
    latexExportState.courseKey = courseKey;
    latexExportState.courseName = courseName || '';
    updateLatexFolderLabel();
  }

  function hasCurrentLatexFolder() {
    return Boolean(
      latexExportState.directoryHandle
      && latexExportState.courseKey
      && latexExportState.courseKey === latexCourseKey()
    );
  }

  async function restoreLatexFolderForCurrentCourse() {
    const assignment = getCurrentWebAssignAssignment();
    if (!assignment) {
      updateLatexFolderLabel();
      return false;
    }

    const courseKey = latexCourseKey();
    if (hasCurrentLatexFolder()) return true;

    try {
      const handle = await loadLatexFolderHandle(courseKey);
      if (!handle || handle.kind !== 'directory') return false;

      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return false;

      setLatexFolderState(handle, courseKey, assignment.course.name);
      return true;
    } catch (_) {
      return false;
    } finally {
      updateLatexFolderLabel();
    }
  }

  function updateLatexFolderLabel() {
    const label = document.querySelector('#wa-latex-folder-status');
    if (!label) return;

    const assignment = getCurrentWebAssignAssignment();
    const courseName = assignment?.course?.name || getCourseInfo().name || 'curso actual';

    if (hasCurrentLatexFolder()) {
      label.textContent = `Curso: ${courseName}. Carpeta: ${latexExportState.directoryHandle.name}`;
      return;
    }

    label.textContent = `Curso: ${courseName}. Selecciona la carpeta ${LATEX_EXPORT_ROOT_NAME}.`;
  }

  function pickLatexFolderFromGesture() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('Este navegador no permite seleccionar carpetas directamente. Usa Chrome o Edge.');
    }

    const picker = window.showDirectoryPicker({
      id: 'webassign-latex-export',
      mode: 'readwrite',
      startIn: 'desktop',
    });

    return picker.then(async (handle) => {
      if (!handle || handle.kind !== 'directory') {
        throw new Error('La selección no corresponde a una carpeta.');
      }
      if (handle.name !== LATEX_EXPORT_ROOT_NAME) {
        throw new Error(`Selecciona la carpeta ${LATEX_EXPORT_ROOT_NAME} de Cálculo Multivariado.`);
      }

      const assignment = getCurrentWebAssignAssignment();
      if (!assignment) throw new Error('Abre una actividad de WebAssign antes de elegir carpeta.');

      const courseKey = latexCourseKey();
      setLatexFolderState(handle, courseKey, assignment.course.name);
      await saveLatexFolderHandle(courseKey, handle);
      return handle;
    });
  }

  function ensureLatexFolderFromGesture() {
    const assignment = getCurrentWebAssignAssignment();
    if (!assignment) {
      throw new Error('Abre una actividad de WebAssign para exportarla.');
    }

    if (hasCurrentLatexFolder()) {
      const handle = latexExportState.directoryHandle;
      // Consultar primero evita dejar una exportación pendiente cuando el
      // permiso ya está concedido. Solo se solicita renovación si el navegador
      // devuelve "prompt" o "denied" y aún expone requestPermission().
      const permission = typeof handle.queryPermission === 'function'
        ? handle.queryPermission({ mode: 'readwrite' })
        : Promise.resolve('prompt');

      return permission.then((result) => {
        if (result === 'granted') return handle;
        if (typeof handle.requestPermission !== 'function') {
          throw new Error('No se concedió permiso de escritura para la carpeta.');
        }
        return handle.requestPermission({ mode: 'readwrite' }).then((renewed) => {
          if (renewed !== 'granted') throw new Error('No se concedió permiso de escritura para la carpeta.');
          return handle;
        });
      });
    }

    // No se hace ningún await antes de showDirectoryPicker: debe conservarse
    // el gesto que originó la selección de carpeta.
    return pickLatexFolderFromGesture();
  }

  function startLatexFolderSelectionFromGesture() {
    let folderPromise;
    try {
      folderPromise = ensureLatexFolderFromGesture();
    } catch (error) {
      updateStatus(error?.message || 'No se pudo seleccionar la carpeta.', 'error');
      return;
    }

    void folderPromise.then(() => {
      updateLatexFolderLabel();
      updateStatus(`Carpeta ${LATEX_EXPORT_ROOT_NAME} configurada para el curso.`, 'success');
    }).catch((error) => {
      updateStatus(
        error?.name === 'AbortError'
          ? 'Selección de carpeta cancelada.'
          : (error?.message || 'No se pudo seleccionar la carpeta.'),
        'error'
      );
    });
  }

  async function forgetLatexFolderForCurrentCourse() {
    const assignment = getCurrentWebAssignAssignment();
    if (!assignment) {
      updateStatus('Abre una actividad de WebAssign para administrar su carpeta.', 'info');
      return;
    }

    try {
      await deleteLatexFolderHandle(latexCourseKey());
      latexExportState.directoryHandle = null;
      latexExportState.courseKey = null;
      latexExportState.courseName = '';
      updateLatexFolderLabel();
      updateStatus('Permiso de carpeta olvidado. No se eliminaron archivos.', 'info');
    } catch (error) {
      updateStatus(error?.message || 'No se pudo olvidar el permiso.', 'error');
    }
  }

  function trapSettingsFocus(event) {
    if (!settingsModal) return;

    const focusable = Array.from(settingsModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
    )).filter((element) => element.offsetParent !== null);

    if (!focusable.length) {
      event.preventDefault();
      settingsModal.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setLatexExportButtonState(running) {
    const button = document.querySelector('.wa-pill-export');
    if (!button) return;

    button.disabled = Boolean(running);
    button.setAttribute('aria-busy', String(Boolean(running)));
    button.innerHTML = running
      ? `<span aria-hidden="true">⏳</span> <span>Exportando…</span>`
      : `<span aria-hidden="true">📄</span> <span>Exportar LaTeX</span>`;
  }

  // [MÓDULO 3B] Exportación LaTeX: escapes, fórmulas y serialización
  function latexEscapeText(value) {
    const source = String(value ?? '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[−–—]/g, '-');
    const replacements = {
      '\\': '\\textbackslash{}',
      '{': '\\{',
      '}': '\\}',
      '&': '\\&',
      '%': '\\%',
      '$': '\\$',
      '#': '\\#',
      '_': '\\_',
      '^': '\\textasciicircum{}',
      '~': '\\textasciitilde{}',
      'ℕ': '\\ensuremath{\\mathbb{N}}', 'ℤ': '\\ensuremath{\\mathbb{Z}}',
      'ℚ': '\\ensuremath{\\mathbb{Q}}', 'ℝ': '\\ensuremath{\\mathbb{R}}',
      'ℂ': '\\ensuremath{\\mathbb{C}}',
      '≤': '\\ensuremath{\\leq}', '≥': '\\ensuremath{\\geq}',
      '≠': '\\ensuremath{\\neq}', '±': '\\ensuremath{\\pm}',
      '×': '\\ensuremath{\\times}', '·': '\\ensuremath{\\cdot}',
      '∞': '\\ensuremath{\\infty}', '∪': '\\ensuremath{\\cup}',
      '∩': '\\ensuremath{\\cap}', '∅': '\\ensuremath{\\varnothing}',
      '∈': '\\ensuremath{\\in}', '∉': '\\ensuremath{\\notin}',
      '⊂': '\\ensuremath{\\subset}', '⊆': '\\ensuremath{\\subseteq}',
      '→': '\\ensuremath{\\to}', '↔': '\\ensuremath{\\leftrightarrow}',
      'á': "\\'a", 'é': "\\'e", 'í': "\\'{\\i}", 'ó': "\\'o", 'ú': "\\'u",
      'Á': "\\'A", 'É': "\\'E", 'Í': "\\'I", 'Ó': "\\'O", 'Ú': "\\'U",
      'ñ': '\\~n', 'Ñ': '\\~N', 'ü': '\\"u', 'Ü': '\\"U',
    };

    let escaped = '';
    for (const character of source) {
      escaped += replacements[character] || character;
    }
    return escaped;
  }

  function latexEscapeUrl(value) {
    return String(value || '')
      .replace(/[{}\\]/g, '')
      .replace(/\s/g, '%20');
  }

  function normalizeLatexFormula(value) {
    return String(value || '')
      .replace(/\u2212/g, '-')
      .replace(/\u00D7/g, '\\times ')
      .replace(/\u2264/g, '\\leq ')
      .replace(/\u2265/g, '\\geq ')
      .replace(/\u2260/g, '\\neq ')
      .replace(/\u221E/g, '\\infty ')
      .trim();
  }

  function latexMathMlOperator(value) {
    const operators = {
      '−': '-', '×': '\\times ', '·': '\\cdot ', '≤': '\\leq ', '≥': '\\geq ',
      '≠': '\\neq ', '∞': '\\infty ', '∪': '\\cup ', '∩': '\\cap ', '∅': '\\varnothing ',
      'π': '\\pi ', 'θ': '\\theta ', 'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ',
      'λ': '\\lambda ', 'μ': '\\mu ', 'σ': '\\sigma ', 'φ': '\\phi ',
    };
    return operators[value] || latexEscapeText(value);
  }

  function latexMathMlNode(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return latexMathMlOperator(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.localName.toLowerCase();
    const children = Array.from(node.childNodes).map(latexMathMlNode).join('');
    const first = node.children[0] ? latexMathMlNode(node.children[0]) : '';
    const second = node.children[1] ? latexMathMlNode(node.children[1]) : '';

    switch (tag) {
      case 'math':
      case 'mrow':
      case 'semantics':
      case 'annotation-xml':
        return children;
      case 'mi':
      case 'mn':
        return latexEscapeText(node.textContent || '');
      case 'mo':
        return latexMathMlOperator(node.textContent || '');
      case 'mtext':
        return `\\text{${latexEscapeText(node.textContent || '')}}`;
      case 'mspace':
        return ' ';
      case 'msup':
        return `{${first}}^{${second}}`;
      case 'msub':
        return `{${first}}_{${second}}`;
      case 'msubsup':
        return `{${first}}_{${second}}^{${node.children[2] ? latexMathMlNode(node.children[2]) : ''}}`;
      case 'mfrac':
        return `\\frac{${first}}{${second}}`;
      case 'msqrt':
        return `\\sqrt{${children}}`;
      case 'mroot':
        return `\\sqrt[${second}]{${first}}`;
      case 'mfenced': {
        const open = node.getAttribute('open') || '(';
        const close = node.getAttribute('close') || ')';
        const separator = node.getAttribute('separators') || ',';
        return `\\left${latexMathMlOperator(open)}${children.replace(/,/g, separator)}\\right${latexMathMlOperator(close)}`;
      }
      default:
        return children || latexEscapeText(node.textContent || '');
    }
  }

  function latexMathMlToTex(rawMathMl) {
    try {
      const documentNode = new DOMParser().parseFromString(String(rawMathMl || ''), 'application/xml');
      const math = documentNode.querySelector('math');
      return latexMathMlNode(math || documentNode.documentElement).trim();
    } catch (_) {
      return latexEscapeText(String(rawMathMl || ''));
    }
  }

  function latexFormulaWrapper(value, display = false) {
    const formula = normalizeLatexFormula(value);
    if (!formula) return '';
    return display ? `\\[\n${formula}\n\\]` : `\\(${formula}\\)`;
  }

  function getLatexImageCandidates(image) {
    const candidates = [
      image.currentSrc,
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
    ];

    const srcSet = image.getAttribute('srcset') || image.getAttribute('data-srcset') || '';
    if (srcSet && !/^data:image\//i.test(srcSet.trim())) {
      candidates.push(
        ...srcSet.split(',').map((entry) => entry.trim().split(/\s+/)[0])
      );
    }

    return [...new Set(
      candidates
        .map((candidate) => latexUpgradeInsecureUrl(String(candidate || '').trim()))
        .filter(Boolean)
    )];
  }

  // WebAssign publica varias figuras con src http:// y el navegador las promueve
  // solo (upgrade-insecure-requests), por eso cargan bien en pantalla. La allowlist
  // exige https, así que la candidata debe evaluarse ya promovida o se rechazaría un
  // recurso perfectamente válido. Promover nunca degrada la conexión.
  function latexUpgradeInsecureUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value || /^data:/i.test(value)) return value;
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'http:') return value;
      url.protocol = 'https:';
      return url.href;
    } catch (_) {
      return value;
    }
  }

  function getLatexImageSource(image) {
    return getLatexImageCandidates(image).find((candidate) => latexImageUrlAllowed(candidate)) || '';
  }

  // Devuelve el host de la primera candidata rechazada, solo para diagnóstico.
  // No habilita la descarga: la allowlist sigue siendo la única autoridad.
  function latexRejectedImageHost(image) {
    for (const candidate of getLatexImageCandidates(image)) {
      if (latexImageUrlAllowed(candidate)) continue;
      try {
        return new URL(candidate, location.href).hostname.toLowerCase();
      } catch (_) {
        // Candidata no parseable como URL: continuar con la siguiente.
      }
    }
    return '';
  }

  function isLatexContentImage(image) {
    if (!image || image.closest('article.v2Content, .studentQuestionContent') === null) return false;
    if (image.closest(
      '.waMark, .correctHint, .padMark, .questionResources, .qButtons, .smw, .extraContent, .MathJax, .MathJax_Preview, .MJX_Assistive_MathML'
    )) return false;
    if (image.closest('[hidden], [style*="display: none"]')) return false;
    if (image.closest('[aria-hidden="true"]') && !image.closest('.graphing-item')) return false;

    return true;
  }

  function isLatexProblemImage(image) {
    return isLatexContentImage(image) && Boolean(getLatexImageSource(image));
  }

  function shouldCaptureLatexImageElement(image) {
    return isLatexContentImage(image)
      && Boolean(image.closest('.graphing-item, figure, .graph'));
  }

  function latexImageLabel(image, fallback) {
    const graphTitle = image.closest('.graphing-item')?.querySelector('.graph-title')?.textContent;
    return latexSafeFileName(graphTitle || image.getAttribute('alt') || fallback, fallback);
  }

  function collectLatexImages(article, questionNumber, context) {
    Array.from(article.querySelectorAll('img'))
      .filter(isLatexContentImage)
      .forEach((image) => {
        context.imageStats.elementCount++;

        const source = getLatexImageSource(image);
        const rejectedHost = source ? '' : latexRejectedImageHost(image);
        if (rejectedHost) context.rejectedHosts.add(rejectedHost);

        if (!source && !shouldCaptureLatexImageElement(image)) {
          context.imageStats.unavailableCount++;
          // Se registra un recurso omitido para que el documento explique la ausencia
          // en vez de degradar en silencio al texto alternativo.
          context.imageByElement.set(image, {
            skipped: true,
            rejectedHost,
            fileName: '',
            downloaded: false,
            captured: false,
            error: rejectedHost
              ? `Host de imagen no permitido: ${rejectedHost}`
              : 'La imagen no expone una fuente descargable ni una superficie capturable.',
          });
          return;
        }

        if (source && context.imageBySource.has(source)) {
          const resource = context.imageBySource.get(source);
          resource.elements.push(image);
          context.imageByElement.set(image, resource);
          return;
        }

        const ordinal = String(context.nextImageNumber++).padStart(2, '0');
        const label = latexImageLabel(image, `figura-${ordinal}`).replace(/\s+/g, '-');
        const fileName = `q${String(questionNumber).padStart(2, '0')}-${label}-${ordinal}.png`;
        const resource = {
          source,
          rejectedHost,
          diagnosticSource: source || `DOM:${label}`,
          fileName,
          alt: String(image.getAttribute('alt') || '').trim(),
          element: image,
          elements: [image],
          downloaded: false,
          blob: null,
          error: null,
        };

        context.imageByElement.set(image, resource);
        if (source) {
          context.imageBySource.set(source, resource);
          context.imageStats.sourceCount++;
        } else {
          context.domImageResources.push(resource);
        }
      });
  }

  function collectLatexRenderedMedia(article, questionNumber, context) {
    Array.from(article.querySelectorAll('.graphing-item'))
      .forEach((figure) => {
        if (context.renderedByElement.has(figure)) return;

        const surface = latexFindLargestCanvas(figure)
          || latexFindLargestSvg(figure);
        if (!surface) return;

        const ordinal = String(context.nextRenderedNumber++).padStart(2, '0');
        const fileName = `q${String(questionNumber).padStart(2, '0')}-grafica-renderizada-${ordinal}.png`;
        const resource = {
          figure,
          surface,
          diagnosticSource: `renderizado:q${String(questionNumber).padStart(2, '0')}-${ordinal}`,
          fileName,
          captured: false,
          blob: null,
          error: null,
        };

        context.renderedByElement.set(figure, resource);
        context.renderedMedia.push(resource);
      });
  }

  function getLatexBackgroundImageSources(element) {
    const values = [element.getAttribute('style') || ''];
    try {
      values.push(getComputedStyle(element).backgroundImage || '');
    } catch (_) {
      // El estilo computado puede no estar disponible durante una actualización del DOM.
    }

    const sources = [];
    const expression = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    values.forEach((value) => {
      let match;
      while ((match = expression.exec(value))) {
        const source = latexUpgradeInsecureUrl(String(match[2] || '').trim());
        if (source) sources.push(source);
      }
    });
    return [...new Set(sources)];
  }

  function collectLatexBackgroundImages(article, questionNumber, context) {
    const nodes = [article, ...article.querySelectorAll('.graphing-item, .graphing-item *')];
    nodes.forEach((element) => {
      getLatexBackgroundImageSources(element)
        .filter((source) => latexImageUrlAllowed(source))
        .forEach((source) => {
          const existing = context.imageBySource.get(source);
          if (existing) {
            context.backgroundByElement.set(element, existing);
            return;
          }

          const ordinal = String(context.nextImageNumber++).padStart(2, '0');
          const fileName = `q${String(questionNumber).padStart(2, '0')}-grafica-fondo-${ordinal}.png`;
          const resource = {
            source,
            diagnosticSource: source,
            fileName,
            alt: '',
            element: null,
            elements: [],
            downloaded: false,
            blob: null,
            error: null,
          };

          context.imageBySource.set(source, resource);
          context.backgroundByElement.set(element, resource);
          context.imageStats.sourceCount++;
        });
    });
  }

  function collectLatexInteractiveGraphs(article, questionNumber, context) {
    Array.from(article.querySelectorAll('iframe'))
      .filter((iframe) => (
        iframe.classList.contains('iframeGraph')
        && latexInteractiveFrameUrlAllowed(iframe.getAttribute('src') || '')
      ))
      .forEach((iframe) => {
        const source = latexRedactUrl(iframe.getAttribute('src') || '');
        if (!source || context.interactiveByElement.has(iframe)) return;

        const ordinal = String(context.nextInteractiveNumber++).padStart(2, '0');
        const fileName = `q${String(questionNumber).padStart(2, '0')}-grafica-interactiva-${ordinal}.png`;
        const resource = {
          iframe,
          source,
          fileName,
          captured: false,
          blob: null,
          error: null,
        };

        context.interactiveByElement.set(iframe, resource);
        context.interactiveGraphs.push(resource);
      });
  }

  function getLatexResourceForImage(image, context) {
    return context.imageByElement.get(image)
      || context.imageBySource.get(getLatexImageSource(image))
      || null;
  }

  function latexExtractWatchItUrl(link) {
    const rawHref = String(link?.getAttribute('href') || '');
    const linkText = latexTidy(link?.textContent || '');
    if (!/watch_it/i.test(rawHref) && !/\bwatch\s*it\b/i.test(linkText)) return '';

    const match = rawHref.match(
      /open_bc_enhanced\(\s*['"]watch_it['"]\s*,\s*(['"])(.*?)\1/i
    );
    const rawUrl = String(match?.[2] || '').replace(/&amp;/gi, '&').trim();
    return latexRedactUrl(rawUrl);
  }

  function collectLatexVideoLinks(question) {
    const links = [];
    const seen = new Set();

    for (const link of question?.querySelectorAll('a') || []) {
      const url = latexExtractWatchItUrl(link);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({
        url,
        label: latexTidy(link.textContent || '') || 'Watch It',
      });
    }

    return links;
  }

  function readLatexQuestionStatus(question) {
    const marks = Array.from(question.querySelectorAll('.waMark'));
    const classes = marks.map((mark) => String(mark.className || ''));
    let status = '';
    if (classes.some((value) => /mCorrect/i.test(value))) status = 'correcta';
    else if (classes.some((value) => /mIncorrect|mWrong/i.test(value))) status = 'incorrecta';
    else if (classes.some((value) => /mPartial/i.test(value))) status = 'parcial';

    const feedback = Array.from(question.querySelectorAll('.correctHint, .hint[role="status"]'))
      .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' ');

    const header = question.querySelector('.js-question-header');
    const display = parseWebAssignJsonAttribute(header, 'data-question-display');
    const score = display?.summary?.total;
    const scoreText = Number.isFinite(Number(score?.score)) && Number.isFinite(Number(score?.total))
      ? `${score.score}/${score.total}`
      : '';

    return { status, feedback, scoreText };
  }

  function getLatexQuestionModel(question, position, context) {
    const article = question.querySelector('article.v2Content, .studentQuestionContent');
    if (!article) return null;

    const questionNumber = Number(question.dataset.viewPosition) || position + 1;
    collectLatexImages(article, questionNumber, context);
    collectLatexBackgroundImages(article, questionNumber, context);
    collectLatexRenderedMedia(article, questionNumber, context);
    collectLatexInteractiveGraphs(article, questionNumber, context);

    return {
      article,
      number: questionNumber,
      status: readLatexQuestionStatus(question),
      videos: collectLatexVideoLinks(question),
    };
  }

  function latexNodeClassMatches(node, selector) {
    return node.nodeType === Node.ELEMENT_NODE && node.matches(selector);
  }

  function latexSerializeChildren(node, context, mode) {
    return Array.from(node.childNodes)
      .map((child) => latexSerializeNode(child, context, mode))
      .join('');
  }

  function latexSerializeChoiceFieldset(fieldset, context, mode) {
    const legend = fieldset.querySelector('legend');
    const legendText = legend ? latexTidy(latexSerializeChildren(legend, context, mode)) : 'Opciones';
    const controls = Array.from(fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const optionLines = controls.map((control) => {
      const label = Array.from(fieldset.querySelectorAll('label')).find(
        (candidate) => candidate.htmlFor === control.id
      ) || control.parentElement;
      const optionText = label ? latexTidy(latexSerializeChildren(label, context, mode)) : '';
      const mark = control.closest('.blank')?.querySelector('.waMark');
      const markClass = String(mark?.className || '');
      const selected = Boolean(control.checked);
      const suffix = mode === 'resolved'
        ? [
          selected ? '\\textbf{(seleccionada)}' : '',
          /mCorrect/i.test(markClass) ? '\\textbf{[correcta]}' : '',
          /mIncorrect|mWrong/i.test(markClass) ? '\\textbf{[incorrecta]}' : '',
        ].filter(Boolean).join(' ')
        : '';
      return `  \\item ${optionText}${suffix ? ` ${suffix}` : ''}`;
    }).filter((line) => line.trim() !== '\\item');

    const list = `\\begin{itemize}[leftmargin=*]\n${optionLines.join('\n')}\n\\end{itemize}`;
    return `\\noindent\\textbf{${legendText}}\\par\n${list}`;
  }

  function getLatexControlLabel(control) {
    if (!control?.id) return '';
    const label = Array.from(control.closest('.input-group, .subblock, article')?.querySelectorAll('label') || [])
      .find((candidate) => candidate.htmlFor === control.id);
    return label?.textContent.replace(/\s+/g, ' ').trim() || '';
  }

  function getLatexMathTypeResponses(group) {
    const seenBoxIds = new Set();
    return Array.from(group.querySelectorAll('.mathtype-wrapper, .mathtype[data-boxid]'))
      .map((wrapper) => {
        const boxId = wrapper.dataset.boxid || wrapper.querySelector('[data-boxid]')?.dataset.boxid || '';
        if (!boxId || seenBoxIds.has(boxId)) return null;
        seenBoxIds.add(boxId);
        const hidden = Array.from(group.querySelectorAll('input[type="hidden"]'))
          .find((input) => input.id === boxId || input.name === boxId);
        if (!hidden) return null;
        return { boxId, value: hidden.value || '' };
      })
      .filter(Boolean);
  }

  function formatLatexResponseValue(value) {
    const text = String(value || '').trim();
    if (!text) return '\\textit{sin respuesta}';
    if (/^<math[\s>]/i.test(text)) return `\\(${latexMathMlToTex(text)}\\)`;
    return `\\texttt{${latexEscapeText(text)}}`;
  }

  function latexResponseLabel(group, index) {
    const part = group.closest('.subblock')?.querySelector('.label-level1')?.textContent
      .replace(/\s+/g, ' ')
      .trim();
    if (part) return `Respuesta ${latexEscapeText(part)}`;
    return index > 0 ? `Respuesta ${index + 1}` : 'Respuesta';
  }

  function latexSerializeInputGroup(group, context, mode) {
    if (group.querySelector('fieldset.choice')) {
      return latexSerializeChoiceFieldset(group.querySelector('fieldset.choice'), context, mode);
    }

    const entries = [];
    getLatexMathTypeResponses(group).forEach((entry) => entries.push({
      value: entry.value,
      isMath: true,
    }));

    Array.from(group.querySelectorAll('input, textarea, select'))
      .filter((control) => {
        const type = String(control.type || '').toLowerCase();
        return !['hidden', 'radio', 'checkbox', 'file', 'button', 'submit'].includes(type)
          && !control.closest('.mathtype-wrapper');
      })
      .forEach((control) => {
        let value = '';
        if (control.tagName.toLowerCase() === 'select') {
          value = control.selectedOptions?.[0]?.textContent?.trim() || '';
        } else {
          value = control.value || '';
        }
        entries.push({ value, isMath: false, label: getLatexControlLabel(control) });
      });

    if (!entries.length) return '';

    const responseLines = entries.map((entry, index) => {
      const label = entry.label || latexResponseLabel(group, index);
      const value = mode === 'resolved'
        ? formatLatexResponseValue(entry.value)
        : '\\fbox{\\rule{0pt}{1.3em}\\makebox[4cm]{}}';
      return `\\noindent\\textit{${label}: }${value}\\par`;
    });

    return responseLines.join('\n');
  }

  function latexRenderImage(image, context) {
    const resource = getLatexResourceForImage(image, context);
    const isInlineImage = latexIsInlineImage(image);
    const rendered = isInlineImage
      ? latexRenderInlineResourceImage(resource)
      : latexRenderResourceImage(resource);
    if (rendered) return rendered;

    if (isInlineImage) {
      const reason = latexEscapeText(
        resource?.error || 'La imagen no se registró durante la exploración de la actividad.'
      );
      return `\\textit{[Imagen no exportada: ${reason}]}`;
    }

    const alt = latexEscapeText(image.getAttribute('alt') || 'Figura');
    return `${latexRenderImageFailureBox(resource)}\n\\textit{Figura: ${alt}}`;
  }

  // El PDF debe distinguir una figura que nunca existió de una que falló al
  // descargarse. Sin esto, ambos casos se ven idénticos y obligan a abrir DevTools.
  function latexRenderImageFailureBox(resource) {
    const reason = latexEscapeText(
      resource?.error || 'La imagen no se registró durante la exploración de la actividad.'
    );
    const origin = resource?.rejectedHost
      || (resource?.diagnosticSource ? latexDiagnosticSource(resource.diagnosticSource) : '');
    const originLine = origin ? `\\\\ Origen: ${latexEscapeText(origin)}` : '';
    return `\\fbox{\\parbox{0.92\\linewidth}{\\small\\textbf{Imagen no exportada.}\\\\ Motivo: ${reason}${originLine}}}\\par`;
  }

  function latexRenderResourceImage(resource) {
    if (!resource || (!resource.downloaded && !resource.captured)) return '';
    return `\\includegraphics[${LATEX_EXPORT_IMAGE_OPTIONS}]{${LATEX_EXPORT_IMAGE_DIRECTORY}/${resource.fileName}}`;
  }

  function latexRenderInlineResourceImage(resource) {
    if (!resource || (!resource.downloaded && !resource.captured)) return '';
    return `\\raisebox{-0.2ex}{\\includegraphics[height=1.2em,keepaspectratio]{${LATEX_EXPORT_IMAGE_DIRECTORY}/${resource.fileName}}}`;
  }

  function latexIsInlineImage(image) {
    if (!image) return false;
    const alt = String(image.getAttribute('alt') || '');
    const source = String(image.currentSrc || image.getAttribute('src') || '');
    return /set of real numbers/i.test(alt) || /(?:^|[\\/])reals?\\.gif(?:[?#]|$)/i.test(source);
  }

  function latexRenderFigure(figure, context, mode) {
    const image = Array.from(figure.querySelectorAll('img')).find(isLatexContentImage) || null;
    const iframe = figure.querySelector('iframe.iframeGraph');
    const title = latexTidy(latexSerializeChildren(
      figure.querySelector('.graph-title') || figure,
      context,
      mode
    )) || 'Figura';
    const description = figure.querySelector('.atd');
    const descriptionText = description
      ? latexTidy(latexSerializeChildren(description, context, mode))
      : '';
    const imageResource = image ? getLatexResourceForImage(image, context) : null;
    const renderedResource = context.renderedByElement.get(figure);
    const backgroundResource = [figure, ...figure.querySelectorAll('*')]
      .map((element) => context.backgroundByElement.get(element))
      .find(Boolean);
    const imageText = latexRenderResourceImage(imageResource)
      || latexRenderResourceImage(renderedResource)
      || latexRenderResourceImage(backgroundResource)
      || (image
        ? latexRenderImage(image, context)
        : (iframe ? latexRenderIframe(iframe, context) : ''));

    const visual = imageText
      ? [
        '\\begin{center}',
        imageText,
        '\\par\\smallskip',
        `\\textbf{${title}}`,
        '\\end{center}',
      ].join('\n')
      : '';

    return [
      visual,
      descriptionText ? `\\par\\small\\textit{Descripci\\'on:} ${descriptionText}\\par` : '',
      '\\medskip',
    ].filter(Boolean).join('\n');
  }

  function latexRedactUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      const sensitiveKeys = [];
      for (const key of url.searchParams.keys()) {
        if (/userpass|sid|session|csrftoken|csrf|token|jwt|password|auth/i.test(key)) {
          sensitiveKeys.push(key);
        }
      }
      sensitiveKeys.forEach((key) => url.searchParams.delete(key));
      url.username = '';
      url.password = '';
      url.hash = '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function latexEscapeHref(value) {
    return latexEscapeUrl(value)
      .replace(/([%#&_])/g, '\\$1');
  }

  function latexRenderIframe(iframe, context) {
    const source = latexRedactUrl(iframe.getAttribute('src') || '');
    if (!source) return '';

    const resource = context.interactiveByElement.get(iframe);
    if (resource?.captured) {
      return [
        '\\par\\noindent',
        `\\href{${latexEscapeHref(resource.source)}}{\\includegraphics[${LATEX_EXPORT_IMAGE_OPTIONS}]{${LATEX_EXPORT_IMAGE_DIRECTORY}/${resource.fileName}}}`,
        '\\par\\noindent\\textit{La imagen enlaza con la gr\'afica interactiva.}\\par',
      ].join('\n');
    }

    return `\\par\\noindent\\textit{Gr\\'afica interactiva: }\\url{${latexEscapeUrl(source)}}\\par`;
  }

  function latexRenderStatus(status, mode) {
    if (mode !== 'resolved' || !status) return '';
    const parts = [];
    if (status.status) parts.push(`Estado: ${latexEscapeText(status.status)}`);
    if (status.scoreText) parts.push(`Puntuaci\\'on: ${latexEscapeText(status.scoreText)}`);
    if (status.feedback) parts.push(`Retroalimentaci\\'on: ${latexEscapeText(status.feedback)}`);
    if (!parts.length) return '';
    const rendered = parts.join('. ').replace(/[.!?]+$/g, '');
    return `\\par\\noindent\\textit{${rendered}.}\\par`;
  }

  function latexRenderVideoLinks(videos) {
    if (!Array.isArray(videos) || !videos.length) return '';

    const items = videos.map((video) => (
      `  \\item \\href{${latexEscapeHref(video.url)}}{Video explicativo (${latexEscapeText(video.label || 'Watch It')})}`
    ));

    return [
      '\\par\\noindent\\textbf{Material de apoyo integrado:}\\par',
      '\\begin{itemize}[leftmargin=*,itemsep=0.2em,topsep=0.25em]',
      items.join('\n'),
      '\\end{itemize}',
    ].join('\n');
  }

  function latexSerializeNode(node, context, mode) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return latexEscapeText(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const type = String(node.getAttribute('type') || '').toLowerCase();

    if (tag === 'iframe') return latexRenderIframe(node, context);
    if (tag === 'img') {
      return isLatexContentImage(node) ? latexRenderImage(node, context) : '';
    }

    if (latexNodeClassMatches(node, '.waMark, .correctHint, .padMark, .questionResources, .qButtons, .smw, .extraContent')) return '';
    if (latexNodeClassMatches(node, '[aria-hidden="true"], .MathJax_Preview, .MJX_Assistive_MathML')) return '';
    if (latexNodeClassMatches(node, 'strong.region')) return '';
    if (tag === 'div' && /text-align\s*:\s*right/i.test(node.getAttribute('style') || '')) return '';

    if (tag === 'script') {
      if (/^math\/tex/.test(type)) {
        return latexFormulaWrapper(node.textContent || '', /mode\s*=\s*display/i.test(type));
      }
      if (/^math\/mml/.test(type)) {
        return latexFormulaWrapper(latexMathMlToTex(node.textContent || ''), false);
      }
      return '';
    }

    if (latexNodeClassMatches(node, '.MathJax')) {
      if (!context.useMathJaxFallback) return '';
      const mathMl = node.getAttribute('data-mathml');
      return mathMl ? latexFormulaWrapper(latexMathMlToTex(mathMl), Boolean(node.closest('.MathJax_Display'))) : '';
    }

    if (latexNodeClassMatches(node, '.graphing-item')) return latexRenderFigure(node, context, mode);
    if (latexNodeClassMatches(node, '.input-group')) return latexSerializeInputGroup(node, context, mode);
    if (tag === 'fieldset' && latexNodeClassMatches(node, '.choice')) return latexSerializeChoiceFieldset(node, context, mode);

    if (tag === 'ul' || tag === 'ol') {
      const environment = tag === 'ol' ? 'enumerate' : 'itemize';
      const items = Array.from(node.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((child) => `  \\item ${latexTidy(latexSerializeChildren(child, context, mode))}`)
        .join('\n');
      return `\\begin{${environment}}[leftmargin=*]\n${items}\n\\end{${environment}}`;
    }

    if (tag === 'li') return latexSerializeChildren(node, context, mode);
    if (tag === 'br') return '\n';
    if (tag === 'em' || tag === 'i') return `\\emph{${latexTidy(latexSerializeChildren(node, context, mode))}}`;
    if (tag === 'strong' || tag === 'b') return `\\textbf{${latexTidy(latexSerializeChildren(node, context, mode))}}`;
    if (tag === 'sub') return `\\ensuremath{_{${latexTidy(latexSerializeChildren(node, context, mode))}}}`;
    if (tag === 'sup') return `\\ensuremath{^{${latexTidy(latexSerializeChildren(node, context, mode))}}}`;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return '';
    if (tag === 'summary') return '';

    const content = latexSerializeChildren(node, context, mode);
    const block = new Set([
      'article', 'section', 'div', 'p', 'header', 'footer', 'aside', 'main',
      'fieldset', 'legend', 'details', 'dt', 'dd', 'table', 'tr', 'td', 'th',
    ]).has(tag) || node.classList.contains('paragraph') || node.classList.contains('regionblock');

    return block ? `\n${content}\n` : content;
  }

  function latexTidy(value) {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function latexRenderQuestion(model, context, mode) {
    const body = latexTidy(latexSerializeNode(model.article, context, mode));
    const videos = latexRenderVideoLinks(model.videos);
    const state = latexRenderStatus(model.status, mode);
    return [
      `\\section*{Problema ${model.number}}`,
      body,
      videos,
      state,
    ].filter(Boolean).join('\n\n');
  }

  function latexPdfMetadata(value) {
    return String(value || '')
      .replace(/[{}\\%#$&_\^~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Identidad de portada vigente: configuración del usuario sobre los marcadores.
  function latexStudent() {
    const stored = config && typeof config.student === 'object' ? config.student : {};
    return { ...LATEX_STUDENT_DEFAULTS, ...stored };
  }

  function latexDocumentPreamble(activity, mode) {
    const LATEX_STUDENT = latexStudent();
    const activityTitle = latexEscapeText(activity.name);
    const courseName = latexEscapeText(activity.course.name || 'Curso WebAssign');
    const modeTitle = mode === 'resolved' ? 'Estado actual' : 'Ejercicio limpio';
    const pdfTitle = latexPdfMetadata(`${activity.name} --- ${modeTitle}`);
    const pdfSubject = latexPdfMetadata(activity.course.name || 'Curso WebAssign');

    return String.raw`\documentclass[12pt,letterpaper]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[spanish,es-noquoting,es-tabla]{babel}
\usepackage{geometry}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{float}
\usepackage{xcolor}
\usepackage{lmodern}
\usepackage{setspace}
\usepackage{fancyhdr}
\usepackage{parskip}
\usepackage{enumitem}
\usepackage{hyperref}
\usepackage{xurl}

\geometry{
  top=2cm,
  bottom=2cm,
  left=2.5cm,
  right=2cm
}

\definecolor{anahuacDark}{HTML}{5F0100}
\definecolor{anahuacOrange}{HTML}{FF8200}
\definecolor{anahuacGray}{HTML}{5A5A5A}

\pagestyle{fancy}
\fancyhf{}
\lhead{\parbox[b]{0.66\headwidth}{\raggedright\color{anahuacDark}\scriptsize\textit{${courseName}}}}
\rhead{\parbox[b]{0.28\headwidth}{\raggedleft\color{anahuacGray}\scriptsize ${LATEX_STUDENT.author}}}
\fancyfoot[C]{\thepage}
\renewcommand{\headrulewidth}{0.4pt}
\renewcommand{\headrule}{\hbox to\headwidth{\color{anahuacOrange}\leaders\hrule height\headrulewidth\hfill}}
\setlength{\headheight}{30pt}
\setlength{\parindent}{0pt}
\setlength{\emergencystretch}{3em}
\setstretch{1.08}
\setcounter{secnumdepth}{0}
\setlist{leftmargin=*,itemsep=0.2em,topsep=0.25em,parsep=0pt,partopsep=0pt}
\raggedbottom
\Urlmuskip=0mu plus 2mu\relax

\hypersetup{
  pdftitle={${pdfTitle}},
  pdfauthor={${LATEX_STUDENT.author}},
  pdfsubject={${pdfSubject}},
  colorlinks=true,
  linkcolor=anahuacDark,
  urlcolor=anahuacDark,
  citecolor=anahuacDark
}

\begin{document}

\thispagestyle{empty}

\begin{center}
  {\LARGE\bfseries ${activityTitle}\par}
  \vspace{0.45em}
  {\normalsize\bfseries ${LATEX_STUDENT.author}\par}
  {\footnotesize Matr\'icula: ${LATEX_STUDENT.matricula}\par}
  {\footnotesize ${LATEX_STUDENT.career}\par}
  {\footnotesize ${LATEX_STUDENT.school}, ${LATEX_STUDENT.university}\par}
  \vspace{0.35em}
  {\footnotesize ${courseName} --- ${modeTitle}\par}
\end{center}

\newpage

`;
  }

  function latexRenderActivity(activity, models, context, mode) {
    const sections = models.map((model) => latexRenderQuestion(model, context, mode));
    return `${latexDocumentPreamble(activity, mode)}${sections.join('\n\n\\clearpage\n\n')}\n\n\\end{document}\n`;
  }

  // [MÓDULO 3C] Exportación LaTeX: imágenes y frames interactivos
  function latexImageUrlAllowed(rawUrl) {
    if (/^data:image\//i.test(String(rawUrl || ''))) return true;
    // Una candidata vacía resolvería contra location.href y pasaría como recurso
    // del origen actual, lo que haría descargar el HTML de la actividad.
    if (!String(rawUrl || '').trim()) return false;

    try {
      const url = new URL(rawUrl, location.href);
      const currentOrigin = new URL(location.href).origin;
      return url.protocol === 'https:'
        && (url.origin === currentOrigin || LATEX_EXPORT_IMAGE_HOSTS.has(url.hostname.toLowerCase()));
    } catch (_) {
      return false;
    }
  }

  function latexInteractiveFrameUrlAllowed(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return url.protocol === 'https:'
        && (url.origin === location.origin || LATEX_EXPORT_FRAME_HOSTS.has(url.hostname.toLowerCase()));
    } catch (_) {
      return false;
    }
  }

  async function latexPrepareIframeForCapture(iframe) {
    if (!iframe) return null;

    const ownerWindow = iframe.ownerDocument?.defaultView || window;
    let frameDocument = null;
    let sameOrigin = true;
    let frameLocation = '';

    try {
      frameDocument = iframe.contentDocument;
      frameLocation = iframe.contentWindow?.location?.href || '';
    } catch (_) {
      sameOrigin = false;
    }

    let loadPromise = null;
    if (
      sameOrigin
      && iframe.getAttribute('src')
      && (!frameDocument || frameDocument.readyState === 'loading' || frameLocation === 'about:blank')
    ) {
      loadPromise = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          iframe.removeEventListener('load', finish);
          resolve();
        };

        iframe.addEventListener('load', finish, { once: true });
        ownerWindow.setTimeout(finish, Math.min(LATEX_EXPORT_TIMEOUT, 5000));
      });
    }

    try {
      iframe.scrollIntoView({ block: 'center', inline: 'nearest' });
      ownerWindow.dispatchEvent(new ownerWindow.Event('scroll'));
    } catch (_) {}

    await new Promise((resolve) => {
      if (typeof ownerWindow.requestAnimationFrame === 'function') {
        ownerWindow.requestAnimationFrame(() => resolve());
      } else {
        ownerWindow.setTimeout(resolve, 50);
      }
    });

    if (loadPromise) await loadPromise;
    await new Promise((resolve) => ownerWindow.setTimeout(resolve, 100));

    try {
      return iframe.contentDocument;
    } catch (_) {
      return null;
    }
  }

  async function latexCaptureIframeDirect(iframe) {
    const frameDocument = await latexPrepareIframeForCapture(iframe);
    if (!frameDocument) {
      throw new Error('La gráfica está en otro origen y requiere el puente del iframe.');
    }

    return latexCaptureFrameDocument(frameDocument);
  }

  async function latexRequestIframeCapture(iframe) {
    const rawSource = iframe.getAttribute('src') || '';
    if (!latexInteractiveFrameUrlAllowed(rawSource)) {
      return Promise.reject(new Error('El origen de la gráfica no está permitido.'));
    }

    await latexPrepareIframeForCapture(iframe);

    let targetOrigin;
    try {
      targetOrigin = new URL(rawSource, location.href).origin;
    } catch (_) {
      return Promise.reject(new Error('La URL de la gráfica interactiva no es válida.'));
    }

    return new Promise((resolve, reject) => {
      const requestId = globalThis.crypto?.randomUUID?.()
        || `wa-frame-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let timeout = 0;

      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.origin !== targetOrigin) return;
        const response = event.data;
        if (
          !response
          || response.type !== 'wa-latex-capture-frame-result'
          || String(response.requestId) !== String(requestId)
        ) return;

        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (!response.ok) {
          reject(new Error(response.error || 'No se pudo capturar la gráfica interactiva.'));
          return;
        }

        const bytes = response.bytes;
        if (!bytes || typeof bytes.byteLength !== 'number') {
          reject(new Error('El frame recibido no contiene una imagen válida.'));
          return;
        }

        try {
          resolve(new Blob([bytes], { type: response.contentType || 'image/png' }));
        } catch (_) {
          reject(new Error('No se pudo reconstruir la imagen de la gráfica.'));
        }
      };

      window.addEventListener('message', onMessage);
      timeout = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('No se recibió el frame de la gráfica interactiva.'));
      }, Math.min(LATEX_EXPORT_TIMEOUT, 8000));
      try {
        if (!iframe.contentWindow) throw new Error('La ventana de la gráfica no está disponible.');
        iframe.contentWindow.postMessage({
          type: 'wa-latex-capture-frame',
          requestId,
        }, targetOrigin);
      } catch (error) {
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        reject(error);
      }
    });
  }

  async function captureLatexInteractiveGraphs(context) {
    const ownerWindow = context.interactiveGraphs[0]?.iframe?.ownerDocument?.defaultView || window;
    const previousScroll = {
      x: Number(ownerWindow.scrollX || 0),
      y: Number(ownerWindow.scrollY || 0),
    };

    try {
      // Cada iframe debe estar visible para que WebAssign cree o conserve su canvas.
      // La secuencia evita que un scroll posterior vuelva a descargar el frame
      // que otro worker todavía está intentando capturar.
      await latexMapWithConcurrency(context.interactiveGraphs, 1, async (resource) => {
        try {
          let blob;
          try {
            blob = await latexCaptureIframeDirect(resource.iframe);
          } catch (_) {
            blob = await latexRequestIframeCapture(resource.iframe);
          }

          resource.blob = latexValidateImageBlob(blob);
          resource.captured = true;
        } catch (error) {
          resource.error = error?.message || 'No se pudo capturar la gráfica interactiva.';
        }
        return resource;
      });
    } finally {
      ownerWindow.scrollTo(previousScroll.x, previousScroll.y);
    }

    return context.interactiveGraphs;
  }

  async function latexCaptureImageElement(image) {
    if (!image) throw new Error('No se encontró el elemento de imagen.');

    if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
      if (typeof image.decode === 'function') {
        let timeout;
        try {
          await Promise.race([
            image.decode(),
            new Promise((_, reject) => {
              timeout = window.setTimeout(
                () => reject(new Error('La imagen visible tardó demasiado en cargar.')),
                Math.min(LATEX_EXPORT_TIMEOUT, 5000)
              );
            }),
          ]);
        } finally {
          window.clearTimeout(timeout);
        }
      }
    }

    const width = Number(image.naturalWidth || image.width || 0);
    const height = Number(image.naturalHeight || image.height || 0);
    if (!width || !height || width * height > LATEX_EXPORT_MAX_IMAGE_PIXELS) {
      throw new Error('La imagen visible no tiene dimensiones capturables.');
    }

    try {
      return await latexDrawSurfaceToPngBlob(image, width, height);
    } catch (error) {
      if (!error?.tainted) throw error;
    }

    // El canvas quedó contaminado porque WebAssign cargó la imagen sin CORS.
    // Se recarga la misma URL con crossOrigin explícito; no se contacta ningún
    // destino nuevo, solo el recurso que la página ya había pedido.
    const reloadUrl = String(image.currentSrc || image.src || '').trim();
    if (!reloadUrl) {
      throw new Error('El canvas quedó contaminado y la imagen no expone una URL recargable.');
    }

    const corsImage = await latexLoadCorsImage(reloadUrl);
    const corsWidth = Number(corsImage.naturalWidth || width);
    const corsHeight = Number(corsImage.naturalHeight || height);
    if (!corsWidth || !corsHeight || corsWidth * corsHeight > LATEX_EXPORT_MAX_IMAGE_PIXELS) {
      throw new Error('La imagen recargada con CORS no tiene dimensiones capturables.');
    }
    return latexDrawSurfaceToPngBlob(corsImage, corsWidth, corsHeight);
  }

  function latexDrawSurfaceToPngBlob(surface, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: false });
    if (!context) throw new Error('No se pudo preparar la captura de la imagen visible.');
    context.drawImage(surface, 0, 0, width, height);
    return latexCanvasToPngBlob(canvas);
  }

  function latexLoadCorsImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const timeout = window.setTimeout(() => {
        image.src = '';
        reject(new Error('La recarga CORS de la imagen tardó demasiado.'));
      }, Math.min(LATEX_EXPORT_TIMEOUT, 8000));

      image.onload = () => {
        window.clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('El servidor de la imagen no expone encabezados CORS.'));
      };
      image.src = url;
    });
  }

  async function captureLatexRenderedMedia(context) {
    await latexMapWithConcurrency(context.renderedMedia, 2, async (resource) => {
      try {
        const tag = resource.surface.tagName.toLowerCase();
        const blob = tag === 'canvas'
          ? await latexCanvasToPngBlob(resource.surface)
          : await latexSvgToPngBlob(resource.surface);
        resource.blob = latexValidateImageBlob(blob);
        resource.captured = true;
      } catch (error) {
        resource.error = error?.message || 'No se pudo capturar el gráfico renderizado.';
      }
      return resource;
    });
    return context.renderedMedia;
  }

  function latexDiagnosticSource(rawUrl) {
    const redacted = latexRedactUrl(rawUrl);
    try {
      const url = new URL(redacted || rawUrl, location.href);
      return `${url.hostname}${url.pathname}`;
    } catch (_) {
      return 'recurso-desconocido';
    }
  }

  function reportLatexResourceFailures(resources, type) {
    const failures = resources.filter((resource) => resource.error);
    if (!failures.length) return;

    console.warn(
      `[WebAssign LaTeX] ${failures.length} ${type}(s) no se pudieron procesar:`,
      failures.map((resource) => ({
        recurso: latexDiagnosticSource(resource.source || resource.diagnosticSource),
        motivo: resource.error,
      }))
    );
  }

  function reportLatexMediaInventory(context) {
    console.info('[WebAssign LaTeX] Inventario de medios:', {
      elementosImagen: context.imageStats.elementCount,
      fuentesImagen: context.imageStats.sourceCount,
      imagenesParaCapturaDOM: context.domImageResources.length,
      graficosRenderizados: context.renderedMedia.length,
      framesInteractivos: context.interactiveGraphs.length,
      imagenesSinFuente: context.imageStats.unavailableCount,
      hostsRechazados: [...(context.rejectedHosts || [])],
    });

    if (context.rejectedHosts?.size) {
      console.warn(
        '[WebAssign LaTeX] Hosts de imagen fuera de la allowlist:',
        [...context.rejectedHosts].join(', '),
        '— agrégalos a LATEX_EXPORT_IMAGE_HOSTS y a @connect si son legítimos.'
      );
    }
  }

  // [MÓDULO 3D] Exportación LaTeX: escritura segura de archivos
  function latexHeaderValue(headers, name) {
    const expression = new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]+)`, 'i');
    return String(headers || '').match(expression)?.[1]?.trim() || '';
  }

  function latexValidateImageBlob(blob) {
    if (!blob || blob.size <= 0) throw new Error('La imagen está vacía.');
    if (blob.size > LATEX_EXPORT_MAX_IMAGE_BYTES) throw new Error('La imagen supera el límite permitido.');

    const type = String(blob.type || '').toLowerCase().split(';')[0].trim();
    if (type && type !== 'application/octet-stream' && !LATEX_EXPORT_RASTER_TYPES.has(type)) {
      throw new Error('El recurso no es una imagen rasterizada permitida.');
    }
    return blob;
  }

  function getLatexXmlHttpRequest() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
      return GM.xmlHttpRequest.bind(GM);
    }
    return null;
  }

  function latexRequestExternalBlob(url, anonymous) {
    return new Promise((resolve, reject) => {
      const request = getLatexXmlHttpRequest();
      if (!request) {
        reject(new Error('Tampermonkey no expone GM_xmlhttpRequest para la imagen externa.'));
        return;
      }

      request({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: LATEX_EXPORT_TIMEOUT,
        anonymous,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            const error = new Error(`La imagen respondió HTTP ${response.status}.`);
            error.status = response.status;
            error.retryable = [0, 401, 403].includes(response.status);
            reject(error);
            return;
          }

          const finalUrl = response.finalUrl || url;
          if (!latexImageUrlAllowed(finalUrl)) {
            reject(new Error('La redirección de la imagen no está permitida.'));
            return;
          }

          const bytes = response.response;
          if (!bytes || bytes.byteLength > LATEX_EXPORT_MAX_IMAGE_BYTES) {
            reject(new Error('La imagen supera el límite permitido.'));
            return;
          }

          try {
            const contentType = latexHeaderValue(response.responseHeaders, 'content-type').split(';')[0].trim();
            resolve(latexValidateImageBlob(new Blob([bytes], { type: contentType })));
          } catch (error) {
            reject(error);
          }
        },
        ontimeout: () => {
          const error = new Error('Tiempo agotado al descargar una imagen.');
          error.retryable = true;
          reject(error);
        },
        onerror: () => {
          const error = new Error('No se pudo descargar una imagen.');
          error.retryable = true;
          reject(error);
        },
        onabort: () => reject(new Error('Descarga de imagen cancelada.')),
      });
    });
  }

  async function latexFetchExternalBlob(url) {
    let lastError = null;
    for (const anonymous of [true, false]) {
      try {
        return await latexRequestExternalBlob(url, anonymous);
      } catch (error) {
        lastError = error;
        if (!error?.retryable || anonymous === false) break;
      }
    }
    throw lastError || new Error('No se pudo descargar una imagen.');
  }

  async function latexFetchImageBlob(rawUrl) {
    if (!latexImageUrlAllowed(rawUrl)) throw new Error('El dominio de la imagen no está permitido.');
    if (/^data:image\//i.test(String(rawUrl))) {
      return latexValidateImageBlob(await fetch(rawUrl).then((response) => response.blob()));
    }

    const url = new URL(rawUrl, location.href);
    const currentOrigin = new URL(location.href).origin;
    if (url.origin === currentOrigin) {
      const response = await fetch(url.href, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`La imagen respondió HTTP ${response.status}.`);
      if (new URL(response.url, location.href).origin !== currentOrigin) {
        throw new Error('La respuesta de la imagen salió del origen permitido.');
      }
      return latexValidateImageBlob(await response.blob());
    }

    return latexFetchExternalBlob(url.href);
  }

  function latexLoadImage(blob) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('El navegador no pudo decodificar la imagen.'));
      };
      image.src = objectUrl;
    });
  }

  async function latexRasterizeImage(blob) {
    let bitmap = null;
    let image = null;
    try {
      if (typeof createImageBitmap === 'function') {
        bitmap = await latexCreateImageBitmap(blob);
      } else {
        image = await latexLoadImage(blob);
      }

      const width = bitmap?.width || image?.naturalWidth || image?.width || 0;
      const height = bitmap?.height || image?.naturalHeight || image?.height || 0;
      if (!width || !height || width * height > LATEX_EXPORT_MAX_IMAGE_PIXELS) {
        throw new Error('La imagen supera el límite de dimensiones permitido.');
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: false });
      if (!context) throw new Error('No se pudo preparar el conversor de imagen.');
      context.drawImage(bitmap || image, 0, 0, width, height);

      const png = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('No se pudo convertir la imagen a PNG.'));
        }, 'image/png');
      });
      return latexValidateImageBlob(png);
    } finally {
      bitmap?.close?.();
    }
  }

  function latexCreateImageBitmap(blob) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        settled = true;
        reject(new Error('La decodificación de la imagen tardó demasiado.'));
      }, Math.min(LATEX_EXPORT_TIMEOUT, 5000));

      createImageBitmap(blob).then((bitmap) => {
        if (settled) {
          bitmap?.close?.();
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        resolve(bitmap);
      }).catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async function latexMapWithConcurrency(items, limit, task) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Math.min(Math.max(1, Number(limit) || 1), Math.max(1, items.length));
    if (!items.length) return results;

    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    }

    // WebAssign reemplaza Array.from con un polyfill legacy que ignora el
    // segundo argumento (mapFn). Crear los workers explícitamente evita que
    // el descargador/capturador quede en cero sin lanzar ningún error.
    const pendingWorkers = [];
    for (let workerIndex = 0; workerIndex < workers; workerIndex++) {
      pendingWorkers.push(worker());
    }
    await Promise.all(pendingWorkers);
    return results;
  }

  async function downloadLatexImages(context) {
    const resources = [
      ...context.imageBySource.values(),
      ...context.domImageResources,
    ];
    await latexMapWithConcurrency(resources, 2, async (resource) => {
      try {
        let blob;
        if (resource.source) {
          try {
            blob = await latexFetchImageBlob(resource.source);
          } catch (sourceError) {
            if (!resource.element) throw sourceError;
            try {
              blob = await latexCaptureImageElement(resource.element);
              resource.recoveredFromDom = true;
            } catch (domError) {
              throw new Error(`${sourceError.message} La captura DOM también falló: ${domError.message}`);
            }
          }
        } else {
          blob = await latexCaptureImageElement(resource.element);
        }

        // pdflatex lee PNG y JPEG de forma nativa: re-encodear por canvas solo
        // agrega superficie de fallo. GIF, WEBP y BMP sí requieren rasterizado.
        const blobType = String(blob?.type || '').toLowerCase().split(';')[0].trim();
        if (blobType === 'image/png') {
          resource.blob = latexValidateImageBlob(blob);
        } else if (blobType === 'image/jpeg') {
          resource.blob = latexValidateImageBlob(blob);
          // graphicx elige el lector por extensión: un JPEG no puede llamarse .png.
          resource.fileName = resource.fileName.replace(/\.png$/i, '.jpg');
        } else if (resource.recoveredFromDom || !resource.source) {
          resource.blob = latexValidateImageBlob(blob);
        } else {
          resource.blob = await latexRasterizeImage(blob);
        }
        resource.downloaded = true;
      } catch (error) {
        resource.error = error?.message || 'No se pudo procesar la imagen.';
      }
      return resource;
    });
    return resources;
  }

  async function latexDirectoryExists(rootHandle, path) {
    let current = rootHandle;
    for (const segment of latexSafePathSegments(path)) {
      try {
        current = await current.getDirectoryHandle(segment);
      } catch (error) {
        if (error?.name === 'NotFoundError') return null;
        throw error;
      }
    }
    return current;
  }

  async function latexGetOrCreateDirectory(rootHandle, path) {
    let current = rootHandle;
    for (const segment of latexSafePathSegments(path)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
  }

  async function latexFileExists(directoryHandle, fileName) {
    try {
      await directoryHandle.getFileHandle(fileName);
      return true;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      throw error;
    }
  }

  async function latexWriteFile(directoryHandle, fileName, content) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    let writable;
    try {
      writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
    } catch (error) {
      try { await writable?.abort(); } catch (_) { }
      throw error;
    }
  }

  async function latexWriteBlob(directoryHandle, fileName, blob) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    let writable;
    try {
      writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try { await writable?.abort(); } catch (_) { }
      throw error;
    }
  }

  async function latexConfirmOverwrite(rootHandle, activityFolder, resources) {
    const activityDirectory = await latexDirectoryExists(rootHandle, activityFolder);
    if (!activityDirectory) return true;

    const existing = [];

    for (const variant of Object.values(LATEX_EXPORT_VARIANTS)) {
      const variantDirectory = await latexDirectoryExists(activityDirectory, variant.directory);
      if (!variantDirectory) continue;

      if (await latexFileExists(variantDirectory, variant.fileName)) {
        existing.push(`${variant.directory}/${variant.fileName}`);
      }

      const imageDirectory = await latexDirectoryExists(
        variantDirectory,
        LATEX_EXPORT_IMAGE_DIRECTORY
      );
      if (imageDirectory) {
        for (const resource of resources.filter((item) => item.downloaded || item.captured)) {
          if (await latexFileExists(imageDirectory, resource.fileName)) {
            existing.push(`${variant.directory}/${LATEX_EXPORT_IMAGE_DIRECTORY}/${resource.fileName}`);
          }
        }
      }
    }

    if (!existing.length) return true;
    return window.confirm(
      `Ya existen ${existing.length} archivo(s) generados para esta actividad. ¿Sobrescribirlos?`
    );
  }

  async function writeLatexExport(rootHandle, activity, resources, cleanText, resolvedText) {
    const activityFolder = latexSafeFileName(activity.name, 'actividad-webassign');
    const approved = await latexConfirmOverwrite(rootHandle, activityFolder, resources);
    if (!approved) return false;

    const activityDirectory = await latexGetOrCreateDirectory(rootHandle, activityFolder);

    const variantPayloads = [
      { variant: LATEX_EXPORT_VARIANTS.clean, content: cleanText },
      { variant: LATEX_EXPORT_VARIANTS.resolved, content: resolvedText },
    ];

    for (const { variant, content } of variantPayloads) {
      const variantDirectory = await latexGetOrCreateDirectory(activityDirectory, variant.directory);
      const imageDirectory = await latexGetOrCreateDirectory(
        variantDirectory,
        LATEX_EXPORT_IMAGE_DIRECTORY
      );

      for (const resource of resources.filter((item) => item.downloaded || item.captured)) {
        await latexWriteBlob(imageDirectory, resource.fileName, resource.blob);
      }

      await latexWriteFile(variantDirectory, variant.fileName, content);
    }

    return true;
  }

  // [MÓDULO 3E] Exportación LaTeX: orquestación del caso de uso
  function finishLatexExportButtonState() {
    latexExportState.exporting = false;
    setLatexExportButtonState(false);
  }

  async function runLatexExport(directoryPromise, initialAssignment) {
    try {
      const rootHandle = await directoryPromise;
      const activity = getCurrentWebAssignAssignment() || initialAssignment;
      if (!activity) throw new Error('La actividad dejó de estar disponible.');

      updateStatus(`Analizando ${activity.questions.length} preguntas de WebAssign…`, 'info');
      const context = {
        imageBySource: new Map(),
        imageByElement: new WeakMap(),
        domImageResources: [],
        rejectedHosts: new Set(),
        imageStats: {
          elementCount: 0,
          sourceCount: 0,
          unavailableCount: 0,
        },
        nextImageNumber: 1,
        backgroundByElement: new WeakMap(),
        renderedByElement: new WeakMap(),
        renderedMedia: [],
        nextRenderedNumber: 1,
        interactiveByElement: new WeakMap(),
        interactiveGraphs: [],
        nextInteractiveNumber: 1,
        useMathJaxFallback: false,
      };
      const models = activity.questions
        .map((question, index) => getLatexQuestionModel(question, index, context))
        .filter(Boolean);
      context.useMathJaxFallback = !models.some(
        (model) => model.article.querySelector('script[type^="math/tex"]')
      );
      reportLatexMediaInventory(context);

      const resources = await downloadLatexImages(context);
      const downloaded = resources.filter((resource) => resource.downloaded).length;
      const failed = resources.length - downloaded;
      reportLatexResourceFailures(resources, 'imagen');

      const renderedResources = await captureLatexRenderedMedia(context);
      const renderedCaptured = renderedResources.filter((resource) => resource.captured).length;
      const failedRendered = renderedResources.length - renderedCaptured;
      reportLatexResourceFailures(renderedResources, 'gráfico renderizado');

      const interactiveResources = await captureLatexInteractiveGraphs(context);
      const capturedFrames = interactiveResources.filter((resource) => resource.captured).length;
      const failedFrames = interactiveResources.length - capturedFrames;
      reportLatexResourceFailures(interactiveResources, 'gráfica interactiva');

      // El inventario se emite antes de descargar, así que por sí solo no dice si
      // los recursos llegaron. Este resumen cierra esa brecha de diagnóstico.
      console.info('[WebAssign LaTeX] Resultado de recursos:', {
        imagenesDescargadas: downloaded,
        imagenesFallidas: failed,
        graficosCapturados: renderedCaptured,
        graficosFallidos: failedRendered,
        framesCapturados: capturedFrames,
        framesFallidos: failedFrames,
      });

      updateStatus(
        `Generando LaTeX y preparando ${downloaded + renderedCaptured} imagen(es), ${capturedFrames} gráfica(s) 3D…`,
        'info'
      );

      const cleanText = latexRenderActivity(activity, models, context, 'clean');
      const resolvedText = latexRenderActivity(activity, models, context, 'resolved');
      const allResources = [...resources, ...renderedResources, ...interactiveResources];
      const written = await writeLatexExport(
        rootHandle,
        activity,
        allResources,
        cleanText,
        resolvedText
      );

      if (!written) {
        // Sin esta traza, una cancelación de sobrescritura es indistinguible en la
        // consola de una descarga que falló: ambas dejan la carpeta sin cambios.
        console.warn(
          '[WebAssign LaTeX] Escritura cancelada: se conservó la exportación existente.',
          `Se habían preparado ${downloaded + renderedCaptured} imagen(es).`
        );
        updateStatus('Exportación cancelada; no se sobrescribieron archivos.', 'info');
        return;
      }

      const countMessage = activity.expectedQuestionCount !== models.length
        ? `${models.length}/${activity.expectedQuestionCount} preguntas visibles`
        : `${models.length} preguntas`;
      const imageMessage = `${downloaded + renderedCaptured} imagen(es)`;
      const frameMessage = capturedFrames
        ? `, ${capturedFrames} gráfica(s) 3D capturada(s) y enlazada(s)`
        : '';
      const failedMessage = failed ? `, ${failed} imagen(es) omitida(s)` : '';
      const failedRenderedMessage = failedRendered
        ? `, ${failedRendered} gráfico(s) renderizado(s) omitido(s)`
        : '';
      const failedFrameMessage = failedFrames
        ? `, ${failedFrames} gráfica(s) conservada(s) como enlace`
        : '';
      updateStatus(
        `Exportación completada: ${countMessage}, ${imageMessage}${frameMessage}${failedMessage}${failedRenderedMessage}${failedFrameMessage}.`,
        'success'
      );
    } catch (error) {
      updateStatus(
        error?.name === 'AbortError'
          ? 'Exportación cancelada.'
          : (error?.message || 'No se pudo exportar la actividad.'),
        'error'
      );
    } finally {
      finishLatexExportButtonState();
    }
  }

  function startLatexExportFromGesture(trigger) {
    if (latexExportState.exporting) return;

    const assignment = getCurrentWebAssignAssignment();
    if (!assignment) {
      updateStatus('Abre una actividad de WebAssign para exportar sus ejercicios.', 'info');
      return;
    }

    latexExportState.exporting = true;
    setLatexExportButtonState(true);

    let directoryPromise;
    try {
      // La selección/renovación de permiso ocurre antes de cualquier await.
      directoryPromise = ensureLatexFolderFromGesture();
    } catch (error) {
      finishLatexExportButtonState();
      updateStatus(error?.message || 'No se pudo preparar la carpeta de exportación.', 'error');
      return;
    }

    void runLatexExport(directoryPromise, assignment, trigger);
  }

  // ---------------------------------------------------------
  // [MÓDULO 4] WebAssign: extracción de actividades para Calendar
  // ---------------------------------------------------------

  // WebAssign muestra fechas como "Thursday, August 20, 2026 at 11:59 PM CST".
  // Date.parse() nativo falla con este formato (el " at " y el nombre de huso
  // horario lo rompen en varios motores), así que lo interpretamos a mano.
  const WA_TZ_OFFSETS = { CST: 6, CDT: 5, EST: 5, EDT: 4, MST: 7, MDT: 6, PST: 8, PDT: 7 };
  const WA_MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

  function parseWebAssignDueDate(text) {
    const match = String(text).match(
      /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*([A-Z]{2,5})?/i
    );
    if (!match) return NaN;

    const [, monthName, day, year, hourStr, minuteStr, meridiem, tz] = match;
    const monthIndex = WA_MONTHS.indexOf(monthName.toLowerCase());
    if (monthIndex === -1) return NaN;

    let hour = Number(hourStr) % 12;
    if (/pm/i.test(meridiem)) hour += 12;

    // La institución (Universidad Anahuac) opera en hora de Ciudad de México (UTC-6 fijo);
    // si WebAssign muestra otro huso horario conocido, se respeta ese offset.
    const offset = WA_TZ_OFFSETS[(tz || '').toUpperCase()] ?? 6;
    return Date.UTC(Number(year), monthIndex, Number(day), hour + offset, Number(minuteStr), 0);
  }

  function extractAssignments() {
    const wrapper = document.querySelector('#js-student-myAssignmentsWrapper');
    const raw = wrapper ? decodeHtmlEntities(wrapper.dataset.assignments || '') : '';

    // Algunas vistas de WebAssign (p.ej. la pestaña "All Assignments") no traen
    // el wrapper con JSON embebido; en ese caso leemos directo del DOM.
    if (!raw) return extractAssignmentsFromDOM();

    let payload;

    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return extractAssignmentsFromDOM();
    }

    const assignments = Array.isArray(payload.current_assignments) ? payload.current_assignments : [];
    const result = [];

    for (const assignment of assignments) {
      if (!assignment || typeof assignment !== 'object') continue;

      const id = String(assignment.id || '');
      const name = String(assignment.name || assignment.a_name || '').trim();
      const seconds = Number(assignment.due?.seconds);

      if (!id || !name || !Number.isFinite(seconds)) continue;

      result.push({
        id,
        name,
        dueTimestamp: seconds * 1000,
        restrictions: assignment.restrictions || {},
      });
    }

    return dedupeAssignments(result);
  }

  function extractAssignmentsFromDOM() {
    const result = [];

    // Vista clásica "My Assignments" (tablas Current/Past Assignments), filas
    // con data-test="assignment_<id>" y fecha en td[data-test="due"].
    document.querySelectorAll('tr[data-test^="assignment_"]').forEach((row) => {
      const id = String(row.dataset.test || '').replace(/^assignment_/, '');
      const link = row.querySelector('a[data-test^="assignment_link_"]');
      const name = link?.textContent.trim() || '';
      const dueText = row.querySelector('[data-test="due"] span')?.textContent.trim() || '';

      if (!id || !name || !dueText) return;

      const parsed = parseWebAssignDueDate(dueText);
      if (!Number.isFinite(parsed)) return;

      result.push({ id, name, dueTimestamp: parsed, restrictions: {} });
    });

    // Widget React de "Current Assignments" en el dashboard principal.
    document.querySelectorAll('[data-test="assignmentLink"][data-assignment-id]').forEach((link) => {
      const id = String(link.dataset.assignmentId || '');
      const name = link.querySelector('span')?.textContent.trim() || '';
      const dueText = link.querySelector('.css-1awps7l')?.textContent.trim() || '';

      if (!id || !name || !dueText) return;

      const parsed = parseWebAssignDueDate(dueText);
      if (!Number.isFinite(parsed)) return;

      result.push({ id, name, dueTimestamp: parsed, restrictions: {} });
    });

    return dedupeAssignments(result);
  }

  function dedupeAssignments(assignments) {
    return [...new Map(assignments.map((item) => [item.id, item])).values()];
  }

  function getCourseInfo() {
    const analytics = window.CengageAnalytics;
    const course = analytics?.course || {};
    const titleFromDocument = document.title.split('|')[0].trim();
    const wrapper = document.querySelector('#js-student-subHeader');
    const rawCourseId = wrapper?.dataset.courseId || '';

    const courseId = String(course.id || rawCourseId || location.pathname);
    const courseName = String(course.name || titleFromDocument || 'Curso WebAssign').trim();

    return { id: courseId, name: courseName };
  }

  function getAssignmentUrl(assignmentId) {
    const link = document.querySelector(`[data-test="assignmentLink"][data-assignment-id="${CSS.escape(assignmentId)}"]`);
    return link?.href || location.href;
  }

  function buildCalendarEvents(assignments) {
    const course = getCourseInfo();

    return assignments
      .map((assignment) => {
        const due = new Date(assignment.dueTimestamp);

        return {
          key: `${course.id}|${assignment.id}`,
          courseId: course.id,
          assignmentId: assignment.id,
          courseName: course.name,
          assignmentName: assignment.name,
          url: getAssignmentUrl(assignment.id),
          start: due.toISOString(),
          end: due.toISOString(),
        };
      });
  }

  // ---------------------------------------------------------
  // [MÓDULO 5] Google Identity Services: autenticación
  // ---------------------------------------------------------

  function getGoogleObject() {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow.google?.accounts?.oauth2) {
      return unsafeWindow.google;
    }
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
      return window.google;
    }
    return null;
  }

  function hasGoogleIdentityServices() {
    return Boolean(getGoogleObject()?.accounts?.oauth2?.initTokenClient);
  }

  function loadGoogleIdentityServices() {
    if (hasGoogleIdentityServices()) return Promise.resolve();
    if (googleIdentityPromise) return googleIdentityPromise;

    googleIdentityPromise = new Promise((resolve, reject) => {
      let script = document.querySelector('script[data-wa-google-identity]');
      if (!script) {
        script = document.createElement('script');
        script.src = GOOGLE_IDENTITY_URL;
        script.async = true;
        script.defer = true;
        script.dataset.waGoogleIdentity = '1';
        (document.head || document.documentElement).appendChild(script);
      }

      let checkCount = 0;
      const pollInterval = window.setInterval(() => {
        checkCount++;
        if (hasGoogleIdentityServices()) {
          window.clearInterval(pollInterval);
          window.clearTimeout(timeout);
          resolve();
        }
      }, 200);

      const timeout = window.setTimeout(() => {
        window.clearInterval(pollInterval);
        if (hasGoogleIdentityServices()) {
          resolve();
        } else {
          reject(new Error('Google Identity Services tardó demasiado en cargar.'));
        }
      }, GOOGLE_TIMEOUT);

      script.addEventListener('load', () => {
        if (hasGoogleIdentityServices()) {
          window.clearInterval(pollInterval);
          window.clearTimeout(timeout);
          resolve();
        }
      }, { once: true });

      script.addEventListener('error', () => {
        window.clearInterval(pollInterval);
        window.clearTimeout(timeout);
        reject(new Error('Error de red al cargar Google Identity Services.'));
      }, { once: true });
    }).catch((error) => {
      googleIdentityPromise = null;
      throw error;
    });

    return googleIdentityPromise;
  }

  async function getGoogleAccessToken(interactiveAuth = false) {
    if (!config.clientId) {
      const error = new Error('Primero configura tu Google Client ID.');
      error.code = 'CLIENT_ID_MISSING';
      throw error;
    }

    if (isTokenValid()) return googleAccessToken;

    const restoredToken = loadSavedToken();
    if (restoredToken && isTokenValid()) return restoredToken;

    if (!interactiveAuth) {
      const error = new Error('La sesión de Google expiró. Haz clic en "Conectar".');
      error.code = 'TOKEN_EXPIRED';
      throw error;
    }

    await loadGoogleIdentityServices();

    return new Promise((resolve, reject) => {
      let finished = false;

      const fail = (message) => {
        if (finished) return;
        finished = true;
        reject(new Error(message));
      };

      try {
        const googleObj = getGoogleObject();
        if (!googleObj?.accounts?.oauth2?.initTokenClient) {
          fail('Google Identity Services no está listo.');
          return;
        }

        googleTokenClient = googleObj.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: GOOGLE_SCOPE,
          callback: (response) => {
            if (finished) return;

            if (!response || response.error || !response.access_token) {
              fail(
                response?.error === 'access_denied'
                  ? 'Permiso denegado por el usuario.'
                  : 'Google no devolvió un token de acceso válido.'
              );
              return;
            }

            finished = true;
            const expiresIn = Number(response.expires_in) || 3600;
            saveToken(response.access_token, expiresIn);
            resolve(response.access_token);
          },
          error_callback: (error) => {
            fail(
              String(error?.type) === 'popup_failed_to_open'
                ? 'El navegador bloqueó la ventana emergente. Habilita popups.'
                : 'Error al abrir el cuadro de diálogo de autorización.'
            );
          },
        });

        googleTokenClient.requestAccessToken({ prompt: '' });
      } catch (error) {
        fail(error?.message || 'Error al invocar el cliente de OAuth de Google.');
      }
    });
  }

  // ---------------------------------------------------------
  // [MÓDULO 6] Google Calendar: consumo de API v3
  // ---------------------------------------------------------

  async function googleApiRequest(path, options = {}, token) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), GOOGLE_TIMEOUT);

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    const request = {
      method: options.method || 'GET',
      headers,
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(`${GOOGLE_API}${path}`, request);
      const raw = await response.text();
      let payload = null;

      if (raw) {
        try { payload = JSON.parse(raw); } catch (_) {}
      }

      if (!response.ok) {
        const error = new Error(
          payload?.error?.message || `Google Calendar HTTP ${response.status}`
        );
        error.status = response.status;
        throw error;
      }

      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function calendarEventsPath(suffix = '') {
    return `/calendars/${encodeURIComponent(config.calendarId)}/events${suffix}`;
  }

  async function listManagedEvents(courseId, token) {
    const result = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams();
      params.append('privateExtendedProperty', `${MANAGED_PROPERTY}=1`);
      params.set('maxResults', '2500');
      params.set('showDeleted', 'false');
      if (pageToken) params.set('pageToken', pageToken);

      const payload = await googleApiRequest(calendarEventsPath(`?${params}`), {}, token);

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error('Respuesta inválida al consultar eventos existentes en Google.');
      }

      result.push(...payload.items);
      pageToken = payload.nextPageToken || '';
    } while (pageToken);

    return result;
  }

  function buildGoogleEvent(event) {
    return {
      summary: `⏰ WebAssign · ${event.assignmentName}`,
      description: [
        `Curso: ${event.courseName}`,
        `Actividad: ${event.assignmentName}`,
        '',
        'Evento sincronizado automáticamente desde WebAssign.',
        '',
        `Enlace directo: ${event.url}`,
      ].join('\n'),
      start: { dateTime: event.start, timeZone: 'America/Mexico_City' },
      end: { dateTime: event.end, timeZone: 'America/Mexico_City' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: config.emailReminderMinutes },
          { method: 'popup', minutes: config.popupReminderMinutes },
        ],
      },
      source: { title: 'WebAssign', url: event.url },
      extendedProperties: {
        private: {
          [MANAGED_PROPERTY]: '1',
          [COURSE_PROPERTY]: String(event.courseId),
          [ASSIGNMENT_PROPERTY]: String(event.assignmentId),
        },
      },
    };
  }

  function eventAssignmentId(event) {
    const fromExt = event?.extendedProperties?.private?.[ASSIGNMENT_PROPERTY];
    if (fromExt) return String(fromExt);

    // Fallback: extraer de la URL en la descripción o del origen si existe
    const sourceUrl = event?.source?.url || event?.description || '';
    const match = sourceUrl.match(/data-assignment-id="?(\d+)"?|deploymentId=(\d+)|assignment[/-](\d+)/i);
    return match ? (match[1] || match[2] || match[3]) : '';
  }

  function sameEvent(existing, desired) {
    const existingStart = String(existing?.start?.dateTime || existing?.start || '');
    const existingEnd = String(existing?.end?.dateTime || existing?.end || '');
    const desiredStart = String(desired?.start?.dateTime || desired?.start || '');
    const desiredEnd = String(desired?.end?.dateTime || desired?.end || '');

    return (
      existing?.summary === desired?.summary &&
      existing?.description === desired?.description &&
      existingStart.slice(0, 19) === desiredStart.slice(0, 19) &&
      existingEnd.slice(0, 19) === desiredEnd.slice(0, 19)
    );
  }

  // ---------------------------------------------------------
  // [MÓDULO 6] Google Calendar: núcleo de sincronización
  // ---------------------------------------------------------

  async function syncNow(isBackground = false, interactiveAuth = false) {
    if (syncing) return;
    syncing = true;

    const syncButton = document.querySelector('.wa-pill-sync');
    if (syncButton) {
      syncButton.disabled = true;
      syncButton.innerHTML = `<span>⏳</span> <span>Sincronizando…</span>`;
    }

    try {
      const assignments = extractAssignments();
      updateAssignmentCount();

      if (!assignments.length) {
        if (!isBackground) throw new Error('No se detectaron actividades en la página actual.');
        return;
      }

      const events = buildCalendarEvents(assignments);
      if (!events.length) {
        updateStatus('Sin actividades pendientes por vencer.', 'success');
        return;
      }

      if (!isBackground) {
        updateStatus(`Procesando ${events.length} actividades. Verificando autenticación…`);
      }

      const token = await getGoogleAccessToken(interactiveAuth);
      const course = getCourseInfo();

      updateStatus(`Sincronizando ${events.length} actividades con Google Calendar…`);

      const existingEvents = await listManagedEvents(course.id, token);
      const byAssignment = new Map();

      for (const ev of existingEvents) {
        let assId = eventAssignmentId(ev);
        if (!assId && ev.summary) {
          // Si no tiene extended property, emparejar por título exacto
          const matchDesired = events.find(d => ev.summary.includes(d.assignmentName));
          if (matchDesired) assId = matchDesired.assignmentId;
        }

        if (assId) {
          if (!byAssignment.has(assId)) {
            byAssignment.set(assId, ev);
          }
        }
      }

      let created = 0, updated = 0, unchanged = 0;

      // Crear / Actualizar
      for (const desired of events) {
        const current = byAssignment.get(desired.assignmentId);

        if (!current) {
          await googleApiRequest(
            calendarEventsPath('?sendUpdates=none'),
            { method: 'POST', body: buildGoogleEvent(desired) },
            token
          );
          created++;
          continue;
        }

        const body = buildGoogleEvent(desired);
        if (sameEvent(current, body)) {
          unchanged++;
          continue;
        }

        await googleApiRequest(
          calendarEventsPath(`/${encodeURIComponent(current.id)}?sendUpdates=none`),
          { method: 'PATCH', body },
          token
        );
        updated++;
      }

      updateStatus(
        `Completado: ${created} creadas, ${updated} actualizadas, ${unchanged} sin cambios.`,
        'success'
      );
    } catch (error) {
      console.error('[WebAssign Calendar]', error);

      // Si la API responde con 401 (no autorizado) o el token expiró, purgar inmediatamente
      if (error?.status === 401 || error?.code === 'TOKEN_EXPIRED') {
        purgeToken();
      }

      updateStatus(error?.message || 'Error en la sincronización.', 'error');
    } finally {
      syncing = false;
      updateSessionBadge();

      if (syncButton) {
        syncButton.disabled = false;
        syncButton.innerHTML = `<span>⚡</span> <span>Sincronizar ahora</span>`;
      }
    }
  }

  // ---------------------------------------------------------
  // [MÓDULO 6] Google Calendar: sincronización automática
  // ---------------------------------------------------------

  function scheduleAutoSync() {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }

    if (!config.autoSync) return;

    const minutes = Math.max(Number(config.autoSyncMinutes) || 10, 5);

    autoSyncTimer = setInterval(() => {
      if (isTokenValid()) {
        syncNow(true, false);
      } else {
        updateStatus('Sesión expirada. Presiona "Conectar" para continuar sincronizando.', 'error');
      }
    }, minutes * 60 * 1000);
  }

  // ---------------------------------------------------------
  // [MÓDULO 7] Utilidades comunes
  // ---------------------------------------------------------

  function decodeHtmlEntities(value) {
    const element = document.createElement('textarea');
    element.innerHTML = value;
    return element.value;
  }
})();

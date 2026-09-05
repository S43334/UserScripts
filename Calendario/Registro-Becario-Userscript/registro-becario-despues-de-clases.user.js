// ==UserScript==
// @name         Registro Becario + Soy León · Horarios compatibles
// @namespace    https://registrobecariosre.netlify.app/
// @version      2.9.0
// @description  Automatiza turnos becarios, comparte ocupación universitaria y distingue AFIs, servicio y no disponibilidad entre ambos calendarios.
// @match        https://registrobecariosre.netlify.app/*
// @match        https://soyleon.anahuacqro.edu.mx/eventos/facelift/calendario*
// @match        https://soyleon.anahuacqro.edu.mx/principal/menu*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'rb-after-class-config-v2';
  const LEGACY_STORAGE_KEY = 'rb-after-class-config-v1';
  const MONTHS = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const DAY_ALIASES = {
    lun: 1, lunes: 1,
    mar: 2, martes: 2,
    mie: 3, miercoles: 3,
    jue: 4, jueves: 4,
    vie: 5, viernes: 5,
  };
  const DEFAULT_SEMESTER = {
    start: '2026-08-10',
    end: '2026-12-04',
  };
  const EXPECTED_TIMEZONE = 'America/Mexico_City';
  const ANAHUAC_DAY = '2026-08-26';
  // Calendario escolar Anáhuac 202660: semanas de evaluaciones y días inhábiles.
  const CALENDAR_BLOCK_RANGES = [
    {
      start: '2026-09-26',
      end: '2026-10-03',
      reason: 'evaluaciones intersemestrales',
    },
    {
      start: '2026-11-28',
      end: '2026-12-04',
      reason: 'evaluaciones finales',
    },
  ];
  const CALENDAR_INHABIL_DATES = new Map([
    ['2026-09-16', 'día inhábil Anáhuac'],
    ['2026-11-02', 'día inhábil Anáhuac'],
    ['2026-11-16', 'día inhábil Anáhuac'],
  ]);
  const DEFAULT_MAX_REGISTERS = 20;
  const HOURS_PER_BLOCK = 1.5;
  const SCAN_INTERVAL_MS = 60 * 1000;
  const VIEW_SCAN_DELAY_MS = 180;
  const MAX_SESSION_DECISIONS = 200;
  const MODULE_BLOCKS = [
    ['08:30', '10:00'], ['10:00', '11:30'], ['11:30', '13:00'], ['13:00', '14:30'],
    ['14:30', '16:00'], ['16:00', '17:30'], ['17:30', '19:00'], ['19:00', '20:30'],
  ];
  const MODULE_SLOTS = MODULE_BLOCKS.map(([start, end]) => ({
    start,
    end,
    startMin: toMinutes(start),
    endMin: toMinutes(end),
  }));
  const MODULE_END_BY_START = new Map(MODULE_SLOTS.map((slot) => [slot.start, slot.end]));
  const DEFAULT_CONFIG = {
    source: 'manual',
    classLines: '',
    maxGapMinutes: 0,
    importedSchedule: null,
    customBusyBlocks: [],
    googleCalendar: {
      clientId: '',
      calendarId: 'primary',
    },
  };
  const GOOGLE_IDENTITY_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
  const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
  const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
  const GOOGLE_CALENDAR_ID = 'primary';
  const GOOGLE_SOURCE_URL = 'https://registrobecariosre.netlify.app/';
  const GOOGLE_MANAGED_PROPERTY = 'rbAfterClassManaged';
  const GOOGLE_SEMESTER_PROPERTY = 'rbAfterClassSemester';
  const GOOGLE_KIND_PROPERTY = 'rbAfterClassKind';
  const GOOGLE_KEY_PROPERTY = 'rbAfterClassKey';
  const GOOGLE_API_TIMEOUT_MS = 20000;
  const SHARED_SCHEDULE_KEY = 'rb-shared-schedule-v1';
  const CALENDAR_DB_KEY = 'rb-calendar-db-v1';
  const CALENDAR_DB_VERSION = 1;
  const CALENDAR_DB_MAX_EVENTS = 500;
  const CALENDAR_DB_MAX_SHIFTS = 200;
  const CALENDAR_DB_MAX_WRITE_ATTEMPTS = 3;
  const CALENDAR_DB_DOWNLOAD_NAME = 'calendario-db.json';
  const DATABASE_SOURCE_REGISTRATION = 'registro-becario';
  const DATABASE_SOURCE_SOY_LEON = 'soy-leon';
  const DATABASE_SOURCE_IMPORT = 'import';
  const SOY_LEON_EVENTS_HOST = 'soyleon.anahuacqro.edu.mx';
  const SOY_LEON_EVENTS_PATH = '/eventos/facelift/calendario';
  const SOY_LEON_MENU_PATH = '/principal/menu';
  const SOY_LEON_EVENTS_URL = `https://${SOY_LEON_EVENTS_HOST}${SOY_LEON_EVENTS_PATH}`;
  const SOY_LEON_ESTIMATED_DURATION_MINUTES = 90;
  const IS_SOY_LEON_CALENDAR_PAGE = location.hostname === SOY_LEON_EVENTS_HOST
    && location.pathname.startsWith(SOY_LEON_EVENTS_PATH);
  const IS_SOY_LEON_MENU_PAGE = location.hostname === SOY_LEON_EVENTS_HOST
    && location.pathname.startsWith(SOY_LEON_MENU_PATH);
  const IS_SOY_LEON_EVENTS_PAGE = IS_SOY_LEON_CALENDAR_PAGE || IS_SOY_LEON_MENU_PAGE;
  const SOY_LEON_ROOT_ID = 'rb-soy-leon-events-root';
  const SOY_LEON_STYLES_ID = 'rb-soy-leon-events-styles';

  function getActiveSemester() {
    if (config?.source === 'imported' && config?.importedSchedule?.semester) {
      const { start, end } = config.importedSchedule.semester;
      if (isISODate(start) && isISODate(end)) return { start, end };
    }
    return DEFAULT_SEMESTER;
  }

  function getMaxRegisters() {
    if (config?.importedSchedule?.targetHours) {
      const hours = Number(config.importedSchedule.targetHours);
      if (Number.isFinite(hours) && hours > 0) return Math.round(hours / HOURS_PER_BLOCK);
    }
    if (config?.importedSchedule?.targetRegisters) {
      const count = Number(config.importedSchedule.targetRegisters);
      if (Number.isFinite(count) && count > 0) return Math.round(count);
    }
    return DEFAULT_MAX_REGISTERS;
  }

  function getGoogleSemesterKey() {
    const sem = getActiveSemester();
    return `${sem.start}_${sem.end}`;
  }

  function isSlotProhibited(dateISO, start) {
    const weekday = fromISO(dateISO).getDay();
    const customBlocked = config?.importedSchedule?.restrictions?.blockedSlots;
    if (Array.isArray(customBlocked) && customBlocked.length > 0) {
      const isBlocked = customBlocked.some((item) => {
        const w = Number(item.weekday) || (item.day ? DAY_ALIASES[normalize(item.day)] : null);
        return w === weekday && item.start === start;
      });
      if (isBlocked) return true;
    }
    // Regla predeterminada: Miércoles 11:30–13:00
    return weekday === 3 && start === '11:30';
  }

  function isSlotExceptionAllowed(dateISO, start) {
    const weekday = fromISO(dateISO).getDay();
    const customAllowed = config?.importedSchedule?.restrictions?.allowedSlots;
    if (Array.isArray(customAllowed) && customAllowed.length > 0) {
      const isAllowed = customAllowed.some((item) => {
        const w = Number(item.weekday) || (item.day ? DAY_ALIASES[normalize(item.day)] : null);
        return w === weekday && item.start === start;
      });
      if (isAllowed) return true;
    }
    // Regla predeterminada: Miércoles 13:00–14:30
    return weekday === 3 && start === '13:00';
  }

  function normalizeBusyBlocks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const result = [];
    raw.forEach((entry) => {
      const start = String(entry?.start || '');
      if (!MODULE_END_BY_START.has(start)) return;
      const label = typeof entry?.label === 'string' ? entry.label.trim().slice(0, 60) : '';
      if (entry?.mode === 'date') {
        const date = String(entry?.date || '');
        if (!isISODate(date)) return;
        const key = `date:${date}|${start}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push({ mode: 'date', date, start, label });
        return;
      }
      const weekday = Number(entry?.weekday);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5) return;
      const key = `weekday:${weekday}|${start}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ mode: 'weekday', weekday, start, label });
    });
    return result;
  }

  function isCustomBusySlot(dateISO, start) {
    const weekday = fromISO(dateISO).getDay();
    const blocks = config?.customBusyBlocks || [];
    return blocks.some((block) => (
      block.start === start
      && (block.mode === 'date' ? block.date === dateISO : block.weekday === weekday)
    ));
  }

  function getBusyBlockEntriesForDate(dateISO) {
    const weekday = fromISO(dateISO).getDay();
    const blocks = config?.customBusyBlocks || [];
    return blocks
      .filter((block) => (block.mode === 'date' ? block.date === dateISO : block.weekday === weekday))
      .map((block) => {
        const end = MODULE_END_BY_START.get(block.start);
        if (!end) return null;
        return {
          start: block.start,
          end,
          startMin: toMinutes(block.start),
          endMin: toMinutes(end),
          name: `No disponible${block.label ? `: ${block.label}` : ''}`,
          isBusyBlock: true,
        };
      })
      .filter(Boolean);
  }

  function getClassesForDate(schedule, dateISO) {
    const weekday = fromISO(dateISO).getDay();
    const base = schedule[weekday] || [];
    const busyEntries = getBusyBlockEntriesForDate(dateISO);
    if (!busyEntries.length) return base;
    return [...base, ...busyEntries].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  let config = loadConfig();
  let isMenuOpen = false;
  let bubbleContainer = null;
  let triggerBadge = null;
  let pillStatusDot = null;
  let pillStatusText = null;
  let pillScanBtn = null;
  let pillScanText = null;
  let pillPauseBtn = null;
  let pillPauseText = null;
  let pillGcalBtn = null;
  let pillGcalText = null;
  let toastElement = null;
  let toastTimeout = null;

  let viewScanTimer = null;
  let semesterScanTimer = null;
  let lastSignature = '';
  let lastKnownSiteName = '';
  let nameScanPending = false;

  let semesterScanActive = false;
  let confirmationOpen = false;
  let confirmationBusy = false;
  let internalNavigation = false;
  let scanAbortRequested = false;
  let scanAbortMessage = '';
  let scanInitialState = null;
  let automationPaused = false;
  let pauseReason = '';
  let officialShiftState = createShiftState([]);
  let candidateQueue = [];
  let queueKeys = new Set();
  let invalidShiftQueue = [];
  let invalidShiftKeys = new Set();
  const invalidShiftDecisions = new Map();
  let replacementQueue = [];
  const replacementDecisions = new Map();
  const sessionDecisions = new Map();
  let ownedMyShiftsOverlay = false;
  let googleSyncActive = false;
  let googleIdentityScriptPromise = null;
  let googleTokenClient = null;
  let googleAccessToken = '';
  let googleAccessTokenExpiresAt = 0;

  let calendarDatabase = null;
  let calendarDatabaseWritePromise = Promise.resolve();
  let calendarDatabaseMutationCounter = 0;
  let soyLeonState = {
    database: null,
    schedule: null,
    events: [],
    eventStatuses: [],
    matches: [],
    conflicts: [],
    busyConflicts: [],
    classConflicts: [],
    otherEvents: [],
    eventSource: '',
    error: '',
    lastScanAt: 0,
  };
  let soyLeonScanTimer = null;
  let registrationDatabaseListener = null;
  let soyLeonDatabaseListener = null;
  let soyLeonMutationObserver = null;

  init();

  function init() {
    if (IS_SOY_LEON_EVENTS_PAGE) {
      initSoyLeonEvents();
      return;
    }
    injectStyles();
    if (document.body) {
      boot();
    } else {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    }
  }

  function boot() {
    initRegistrationDatabaseAdapter();
    publishSharedSchedule(config);
    createBubbleMenu();
    observePage();
    scheduleViewScan();
    // Precarga la biblioteca oficial para que la ventana OAuth pueda abrirse
    // conservando el gesto del usuario cuando pulse Exportar.
    loadGoogleIdentityServices().catch(() => {});
    window.setTimeout(() => startSemesterScan('initial'), 1200);
  }

  function loadConfig() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (!saved) {
      try {
        saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
      } catch (_) {
        saved = null;
      }
    }
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_CONFIG };

    const storedImported = saved.importedSchedule || saved.imported || null;
    const importedResult = storedImported ? validateImportedSchedule(storedImported) : { value: null, errors: [] };
    const importedSchedule = importedResult.errors.length ? null : importedResult.value;
    const requestedSource = saved.source === 'imported' ? 'imported' : 'manual';
    const gap = Number(saved.maxGapMinutes);

    return {
      source: requestedSource === 'imported' && importedSchedule ? 'imported' : 'manual',
      classLines: typeof saved.classLines === 'string' ? saved.classLines : DEFAULT_CONFIG.classLines,
      maxGapMinutes: Number.isFinite(gap) ? clamp(Math.round(gap), 0, 180) : DEFAULT_CONFIG.maxGapMinutes,
      importedSchedule,
      customBusyBlocks: normalizeBusyBlocks(saved.customBusyBlocks),
      googleCalendar: normalizeGoogleCalendarConfig(saved.googleCalendar),
    };
  }

  function persistConfig(nextConfig) {
    const next = {
      source: nextConfig.source === 'imported' && nextConfig.importedSchedule ? 'imported' : 'manual',
      classLines: typeof nextConfig.classLines === 'string' ? nextConfig.classLines : '',
      maxGapMinutes: clamp(Math.round(Number(nextConfig.maxGapMinutes) || 0), 0, 180),
      importedSchedule: nextConfig.importedSchedule || null,
      customBusyBlocks: normalizeBusyBlocks(nextConfig.customBusyBlocks),
      googleCalendar: normalizeGoogleCalendarConfig(nextConfig.googleCalendar),
    };
    const previousClientId = config?.googleCalendar?.clientId || '';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      return { ok: false, error: 'No se pudo guardar la configuración en localStorage.' };
    }
    config = next;
    publishSharedSchedule(config);
    if (previousClientId !== next.googleCalendar.clientId) resetGoogleAccessToken();
    lastSignature = '';
    scheduleViewScan();
    return { ok: true };
  }

  function gmGetValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        return Promise.resolve(GM_getValue(key, fallback));
      }
      if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
        return Promise.resolve(GM.getValue(key, fallback));
      }
    } catch (_) {}
    return Promise.resolve(fallback);
  }

  function gmSetValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        return Promise.resolve(GM_setValue(key, value));
      }
      if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        return Promise.resolve(GM.setValue(key, value));
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.reject(new Error('El gestor de userscripts no expone almacenamiento GM.'));
  }

  function addGMValueChangeListener(key, callback) {
    if (typeof GM_addValueChangeListener !== 'function') return null;
    try {
      return GM_addValueChangeListener(key, (_name, _oldValue, newValue) => {
        callback(newValue);
      });
    } catch (_) {
      return null;
    }
  }

  function addSharedScheduleListener(callback) {
    return addGMValueChangeListener(SHARED_SCHEDULE_KEY, callback);
  }

  function addCalendarDatabaseListener(callback) {
    return addGMValueChangeListener(CALENDAR_DB_KEY, callback);
  }

  function normalizeSharedSlotList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const weekday = Number(entry?.weekday);
        const start = parseClock(entry?.start);
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5 || !start) return null;
        return {
          weekday,
          start: start.text,
          reason: typeof entry?.reason === 'string' ? entry.reason.trim().slice(0, 120) : '',
        };
      })
      .filter(Boolean);
  }

  function getSharedCalendarBlocks() {
    return {
      ranges: CALENDAR_BLOCK_RANGES.map((range) => ({ ...range })),
      dates: [...CALENDAR_INHABIL_DATES.entries()].map(([date, reason]) => ({ date, reason })),
      anahuacDay: { date: ANAHUAC_DAY, reason: 'día Anáhuac' },
    };
  }

  function buildSharedSchedulePayload(nextConfig) {
    const imported = nextConfig?.source === 'imported' ? nextConfig.importedSchedule : null;
    let classes = [];

    if (imported && Array.isArray(imported.classes)) {
      classes = imported.classes.map((entry) => ({
        weekday: Number(entry.weekday),
        start: String(entry.start),
        end: String(entry.end),
        name: String(entry.name || 'Clase'),
      }));
    } else {
      const parsed = parseSchedule(nextConfig?.classLines || '');
      if (parsed.errors.length) return null;
      classes = Object.entries(parsed.schedule).flatMap(([weekday, entries]) => (
        entries.map((entry) => ({
          weekday: Number(weekday),
          start: entry.start,
          end: entry.end,
          name: entry.name || 'Clase manual',
        }))
      ));
    }

    const semester = imported?.semester && isISODate(imported.semester.start) && isISODate(imported.semester.end)
      ? { start: imported.semester.start, end: imported.semester.end }
      : { ...DEFAULT_SEMESTER };
    const restrictions = imported?.restrictions || {};

    return {
      version: 1,
      source: imported ? 'imported' : 'manual',
      timezone: EXPECTED_TIMEZONE,
      semester,
      classes,
      restrictions: {
        blockedSlots: normalizeSharedSlotList(restrictions.blockedSlots),
        allowedSlots: normalizeSharedSlotList(restrictions.allowedSlots),
      },
      customBusyBlocks: normalizeBusyBlocks(nextConfig?.customBusyBlocks).map((block) => ({
        mode: block.mode,
        ...(block.mode === 'date' ? { date: block.date } : { weekday: block.weekday }),
        start: block.start,
        label: block.label,
      })),
      calendarBlocks: getSharedCalendarBlocks(),
      publishedAt: Date.now(),
    };
  }

  function publishSharedSchedule(nextConfig) {
    if (IS_SOY_LEON_EVENTS_PAGE) return;
    const payload = buildSharedSchedulePayload(nextConfig);
    if (!payload) return;

    const schedule = normalizeSharedSchedule(payload);
    if (schedule) {
      updateCalendarDatabase((database) => ({
        ...database,
        schedule,
      }), { source: DATABASE_SOURCE_REGISTRATION }).catch((error) => {
        console.warn('[Registro Becario] No se pudo guardar la base JSON compartida.', error);
      });
    }
    gmSetValue(SHARED_SCHEDULE_KEY, payload).catch((error) => {
      console.warn('[Registro Becario] No se pudo compartir el horario con Soy León.', error);
    });
  }

  function normalizeSharedSchedule(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { return null; }
    }
    if (!value || typeof value !== 'object' || Number(value.version) !== 1) return null;
    if (value.timezone !== EXPECTED_TIMEZONE) return null;
    if (!value.semester || !isISODate(value.semester.start) || !isISODate(value.semester.end)) return null;
    if (!Array.isArray(value.classes)) return null;

    const classes = value.classes.map((entry) => {
      const weekday = Number(entry?.weekday);
      const start = parseClock(entry?.start);
      const end = parseClock(entry?.end);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5 || !start || !end || end.minutes <= start.minutes) {
        return null;
      }
      return {
        weekday,
        start: start.text,
        end: end.text,
        startMin: start.minutes,
        endMin: end.minutes,
        name: String(entry.name || 'Clase'),
      };
    }).filter(Boolean);

    if (!classes.length) return null;
    return {
      version: 1,
      source: value.source === 'imported' ? 'imported' : 'manual',
      timezone: EXPECTED_TIMEZONE,
      semester: { start: value.semester.start, end: value.semester.end },
      classes: classes.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin),
      restrictions: {
        blockedSlots: normalizeSharedSlotList(value.restrictions?.blockedSlots),
        allowedSlots: normalizeSharedSlotList(value.restrictions?.allowedSlots),
      },
      customBusyBlocks: normalizeBusyBlocks(value.customBusyBlocks),
      calendarBlocks: value.calendarBlocks || getSharedCalendarBlocks(),
      publishedAt: Number(value.publishedAt) || 0,
    };
  }

  function getScheduleClassesForDate(schedule, dateISO) {
    const weekday = fromISO(dateISO).getDay();
    return getScheduleClassesForWeekday(schedule, weekday);
  }

  function getScheduleClassesForWeekday(schedule, weekday) {
    if (Array.isArray(schedule?.classes)) {
      return schedule.classes.filter((entry) => entry.weekday === weekday);
    }
    return Array.isArray(schedule?.[weekday]) ? schedule[weekday] : [];
  }

  function isUniversityClassSlot(schedule, weekday, start) {
    const slot = MODULE_SLOTS.find((entry) => entry.start === start);
    if (!slot) return false;
    return getScheduleClassesForWeekday(schedule, weekday)
      .some((entry) => rangesOverlap(
        slot.startMin,
        slot.endMin,
        entry.startMin ?? toMinutes(entry.start),
        entry.endMin ?? toMinutes(entry.end),
      ));
  }

  function getScheduleBusyBlocksForDate(schedule, dateISO) {
    const weekday = fromISO(dateISO).getDay();
    return normalizeBusyBlocks(schedule?.customBusyBlocks)
      .filter((block) => block.mode === 'date' ? block.date === dateISO : block.weekday === weekday)
      .map((block) => ({
        ...block,
        end: MODULE_END_BY_START.get(block.start),
        startMin: toMinutes(block.start),
        endMin: toMinutes(MODULE_END_BY_START.get(block.start)),
      }));
  }

  function rangesOverlap(startMin, endMin, entryStartMin, entryEndMin) {
    return startMin < entryEndMin && endMin > entryStartMin;
  }

  function getKnownOfficialShifts() {
    const stored = calendarDatabase?.becario?.officialShifts;
    if (Array.isArray(stored)) {
      return stored.map(normalizeDatabaseShift).filter(Boolean);
    }
    return [...officialShiftState.keys].map((key) => createShiftRecord(key)).filter(Boolean);
  }

  function getKnownSoyLeonEvents() {
    return (Array.isArray(calendarDatabase?.soyLeon?.events) ? calendarDatabase.soyLeon.events : [])
      .map(normalizeDatabaseEvent)
      .filter((event) => event?.isAfi);
  }

  function getSlotOccupancy(dateISO, slot, schedule) {
    const startMin = slot.startMin ?? toMinutes(slot.start);
    const endMin = slot.endMin ?? toMinutes(slot.end);
    const classes = getScheduleClassesForDate(schedule, dateISO)
      .filter((entry) => rangesOverlap(startMin, endMin, entry.startMin ?? toMinutes(entry.start), entry.endMin ?? toMinutes(entry.end)));
    const busyBlocks = getScheduleBusyBlocksForDate(schedule, dateISO)
      .filter((entry) => rangesOverlap(startMin, endMin, entry.startMin, entry.endMin));
    const services = getKnownOfficialShifts()
      .filter((entry) => entry.dateISO === dateISO && rangesOverlap(startMin, endMin, entry.startMin, entry.endMin));
    // El AFI es una referencia independiente y debe seguir visible aunque
    // coincida con una clase, un turno o un bloque de no disponibilidad.
    const afis = getKnownSoyLeonEvents()
      .filter((entry) => entry.dateISO === dateISO && entry.startMin >= startMin && entry.startMin < endMin);
    const registeredAfis = afis.filter((event) => event.isRegistered);
    return { classes, busyBlocks, services, afis, registeredAfis };
  }

  function createEmptyCalendarDatabase() {
    return {
      version: CALENDAR_DB_VERSION,
      timezone: EXPECTED_TIMEZONE,
      revision: 0,
      updatedAt: 0,
      updatedBy: '',
      mutationId: '',
      schedule: null,
      becario: {
        officialShifts: [],
        lastSeenAt: 0,
      },
      soyLeon: {
        events: [],
        lastSeenAt: 0,
        source: '',
      },
    };
  }

  function normalizeDatabaseShift(raw) {
    const dateISO = String(raw?.dateISO || raw?.date || '').trim();
    const start = parseClock(raw?.start);
    const fallbackEnd = start ? MODULE_END_BY_START.get(start.text) : '';
    const end = parseClock(raw?.end || fallbackEnd);
    if (!isISODate(dateISO) || !start || !end || end.minutes <= start.minutes) return null;
    return {
      key: `${dateISO}|${start.text}`,
      dateISO,
      start: start.text,
      end: end.text,
      startMin: start.minutes,
      endMin: end.minutes,
      status: raw?.status === 'invalid' ? 'invalid' : 'active',
      reason: typeof raw?.reason === 'string' ? raw.reason.trim().slice(0, 160) : '',
      observedAt: Number(raw?.observedAt) || 0,
    };
  }

  function normalizeDatabaseEvent(raw) {
    const id = String(raw?.id || raw?.eventId || '').trim();
    const dateISO = String(raw?.dateISO || raw?.date || '').slice(0, 10);
    const start = normalizeSoyLeonClock(raw?.start || raw?.time || raw?.ev_eve_time);
    if (!id || !isISODate(dateISO) || !start) return null;
    const title = String(raw?.title || raw?.name || 'Evento sin título').trim().slice(0, 180);
    const rawRegistered = raw?.isRegistered;
    const rawAfi = raw?.isAfi ?? raw?.afi;
    return {
      id,
      title,
      dateISO,
      start: start.text,
      startMin: start.minutes,
      timeText: start.text,
      place: String(raw?.place || '').trim().slice(0, 180),
      isRegistered: rawRegistered === true || rawRegistered === 1 || rawRegistered === '1' || rawRegistered === 'true',
      isAfi: rawAfi === true || rawAfi === 1 || rawAfi === '1' || rawAfi === 'true' || normalize(title).startsWith('afi'),
      source: raw?.source === 'eventsData' ? 'eventsData' : 'cards',
      observedAt: Number(raw?.observedAt) || 0,
    };
  }

  function normalizeCalendarDatabase(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { return null; }
    }
    if (!value || typeof value !== 'object' || Number(value.version) !== CALENDAR_DB_VERSION) return null;
    if (value.timezone && value.timezone !== EXPECTED_TIMEZONE) return null;

    const scheduleSource = value.schedule
      || value.sharedSchedule
      || (value.semester && Array.isArray(value.classes) ? value : null);
    const schedule = scheduleSource ? normalizeSharedSchedule(scheduleSource) : null;
    const shiftsByKey = new Map();
    (Array.isArray(value.becario?.officialShifts) ? value.becario.officialShifts : [])
      .map(normalizeDatabaseShift)
      .filter(Boolean)
      .forEach((shift) => shiftsByKey.set(shift.key, shift));
    const eventsById = new Map();
    (Array.isArray(value.soyLeon?.events) ? value.soyLeon.events : [])
      .map(normalizeDatabaseEvent)
      .filter(Boolean)
      .forEach((event) => eventsById.set(event.id, event));

    const officialShifts = [...shiftsByKey.values()]
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startMin - b.startMin)
      .slice(-CALENDAR_DB_MAX_SHIFTS);
    const events = [...eventsById.values()]
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startMin - b.startMin || a.title.localeCompare(b.title))
      .slice(-CALENDAR_DB_MAX_EVENTS);
    const revision = Number(value.revision);
    const updatedBy = [DATABASE_SOURCE_REGISTRATION, DATABASE_SOURCE_SOY_LEON, DATABASE_SOURCE_IMPORT]
      .includes(value.updatedBy)
      ? value.updatedBy
      : '';

    return {
      version: CALENDAR_DB_VERSION,
      timezone: EXPECTED_TIMEZONE,
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      updatedAt: Number(value.updatedAt) || 0,
      updatedBy,
      mutationId: typeof value.mutationId === 'string' ? value.mutationId.slice(0, 120) : '',
      schedule,
      becario: {
        officialShifts,
        lastSeenAt: Number(value.becario?.lastSeenAt) || 0,
      },
      soyLeon: {
        events,
        lastSeenAt: Number(value.soyLeon?.lastSeenAt) || 0,
        source: value.soyLeon?.source === 'eventsData' ? 'eventsData' : (events.length ? 'cards' : ''),
      },
    };
  }

  function updateCalendarDatabase(mutator, metadata = {}) {
    const defaultSource = IS_SOY_LEON_EVENTS_PAGE
      ? DATABASE_SOURCE_SOY_LEON
      : DATABASE_SOURCE_REGISTRATION;
    const source = [DATABASE_SOURCE_REGISTRATION, DATABASE_SOURCE_SOY_LEON, DATABASE_SOURCE_IMPORT]
      .includes(metadata.source)
      ? metadata.source
      : defaultSource;
    const task = calendarDatabaseWritePromise.then(async () => {
      let lastConflict = null;
      for (let attempt = 1; attempt <= CALENDAR_DB_MAX_WRITE_ATTEMPTS; attempt += 1) {
        const stored = await gmGetValue(CALENDAR_DB_KEY, calendarDatabase);
        const current = normalizeCalendarDatabase(stored) || createEmptyCalendarDatabase();
        const candidate = mutator(current) || current;
        const mutationId = `${source}:${Date.now().toString(36)}:${(++calendarDatabaseMutationCounter).toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        const next = normalizeCalendarDatabase({
          ...candidate,
          version: CALENDAR_DB_VERSION,
          timezone: EXPECTED_TIMEZONE,
          revision: current.revision + 1,
          updatedAt: Date.now(),
          updatedBy: source,
          mutationId,
        }) || current;
        await gmSetValue(CALENDAR_DB_KEY, next);
        const confirmed = normalizeCalendarDatabase(await gmGetValue(CALENDAR_DB_KEY, next));
        if (confirmed?.mutationId === mutationId) {
          calendarDatabase = confirmed;
          return confirmed;
        }
        lastConflict = new Error('La base JSON cambió mientras se guardaba; reintentando la mutación.');
      }
      throw lastConflict || new Error('No se pudo confirmar la actualización de la base JSON.');
    });
    calendarDatabaseWritePromise = task.catch(() => {});
    return task;
  }

  function applySoyLeonDatabase(raw) {
    const database = normalizeCalendarDatabase(raw) || createEmptyCalendarDatabase();
    calendarDatabase = database;
    soyLeonState.database = database;
    soyLeonState.schedule = database.schedule;
    soyLeonState.error = database.schedule
      ? ''
      : 'Importa el horario desde Registro Becario o abre esa página una vez para inicializar la base.';
    updateSoyLeonControls();
  }

  async function importCalendarDatabase(raw) {
    const parsed = normalizeCalendarDatabase(raw);
    if (!parsed) throw new Error('El archivo no tiene un JSON de calendario válido o usa otra zona horaria.');
    if (!parsed.schedule) throw new Error('El JSON no contiene un horario con semestre y clases.');
    const saved = await updateCalendarDatabase(() => parsed, { source: DATABASE_SOURCE_IMPORT });
    await gmSetValue(SHARED_SCHEDULE_KEY, saved.schedule);
    return saved;
  }

  async function exportCalendarDatabase() {
    const stored = await gmGetValue(CALENDAR_DB_KEY, calendarDatabase);
    const database = normalizeCalendarDatabase(stored) || createEmptyCalendarDatabase();
    const blob = new Blob([JSON.stringify(database, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = CALENDAR_DB_DOWNLOAD_NAME;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function hasGMStorageApi() {
    return typeof GM_getValue === 'function'
      || (typeof GM !== 'undefined' && typeof GM.getValue === 'function');
  }

  function initRegistrationDatabaseAdapter() {
    if (!hasGMStorageApi()) return;
    gmGetValue(CALENDAR_DB_KEY, null).then((raw) => {
      calendarDatabase = normalizeCalendarDatabase(raw) || createEmptyCalendarDatabase();
      scheduleViewScan();
    }).catch(() => {
      calendarDatabase = createEmptyCalendarDatabase();
    });
    registrationDatabaseListener = addCalendarDatabaseListener((raw) => {
      const next = normalizeCalendarDatabase(raw);
      if (!next) return;
      calendarDatabase = next;
      scheduleViewScan();
      updateControls();
    });
  }

  function initSoyLeonEvents() {
    injectSoyLeonStyles();
    createSoyLeonBubble();
    observeSoyLeonPage();

    if (!hasGMStorageApi()) {
      soyLeonState.error = 'Activa la versión integrada del userscript en el mismo gestor.';
      updateSoyLeonControls();
      return;
    }

    gmGetValue(CALENDAR_DB_KEY, null).then(async (raw) => {
      const database = normalizeCalendarDatabase(raw);
      if (database?.schedule) {
        applySoyLeonDatabase(database);
      } else {
        // Migración transparente del puente anterior: el primer acceso guarda la
        // programación existente dentro de la base completa.
        const legacy = await gmGetValue(SHARED_SCHEDULE_KEY, null);
        const legacySchedule = normalizeSharedSchedule(legacy);
        if (legacySchedule) {
          const migrated = await updateCalendarDatabase(() => ({
            ...(database || createEmptyCalendarDatabase()),
            schedule: legacySchedule,
          }), { source: DATABASE_SOURCE_IMPORT });
          applySoyLeonDatabase(migrated);
        } else {
          applySoyLeonDatabase(database || createEmptyCalendarDatabase());
        }
      }
      scheduleSoyLeonScan(0);
    }).catch(() => {
      applySoyLeonDatabase(createEmptyCalendarDatabase());
      scheduleSoyLeonScan(0);
    });

    soyLeonDatabaseListener = addCalendarDatabaseListener((raw) => {
      const before = JSON.stringify({
        schedule: soyLeonState.database?.schedule || null,
        officialShifts: soyLeonState.database?.becario?.officialShifts || [],
        events: soyLeonState.database?.soyLeon?.events || [],
      });
      applySoyLeonDatabase(raw);
      const after = JSON.stringify({
        schedule: soyLeonState.database?.schedule || null,
        officialShifts: soyLeonState.database?.becario?.officialShifts || [],
        events: soyLeonState.database?.soyLeon?.events || [],
      });
      if (before === after) return;
      scheduleSoyLeonScan(0);
      showSoyLeonToast(
        soyLeonState.database?.becario?.lastSeenAt
          ? 'Base actualizada: revisé también tus turnos becarios.'
          : (soyLeonState.schedule ? 'Horario actualizado desde la base JSON.' : 'La base JSON no contiene un horario válido.'),
        soyLeonState.schedule ? 'success' : 'error',
      );
    });

    window.setTimeout(() => scheduleSoyLeonScan(0), 350);
  }

  function applySoyLeonSchedule(raw) {
    const database = createEmptyCalendarDatabase();
    database.schedule = normalizeSharedSchedule(raw);
    applySoyLeonDatabase(database);
  }

  function createSoyLeonBubble() {
    if (document.querySelector(`#${SOY_LEON_ROOT_ID}`)) return;

    const root = document.createElement('div');
    root.id = SOY_LEON_ROOT_ID;
    root.className = 'rb-sl-root';
    root.innerHTML = `
      <div class="rb-sl-speed-list" id="rb-sl-speed-list" aria-hidden="true">
        <div class="rb-sl-status-pill" role="status">
          <span class="rb-sl-status-dot" id="rb-sl-status-dot"></span>
          <span id="rb-sl-status-text">Preparando horario…</span>
        </div>
        <button type="button" class="rb-sl-pill rb-sl-pill-primary" id="rb-sl-open-panel">
          <span aria-hidden="true">✨</span><span>Ver compatibles</span>
        </button>
        <button type="button" class="rb-sl-pill" id="rb-sl-refresh">
          <span aria-hidden="true">↻</span><span>Actualizar</span>
        </button>
      </div>
      <button type="button" class="rb-sl-trigger" id="rb-sl-trigger" aria-label="Abrir estados de AFIs" aria-expanded="false">
        <span aria-hidden="true">📅</span>
        <span class="rb-sl-badge" id="rb-sl-badge" hidden>0</span>
      </button>
      <section class="rb-sl-panel" id="rb-sl-panel" role="dialog" aria-modal="false" aria-labelledby="rb-sl-panel-title" hidden>
        <div class="rb-sl-panel-header">
          <div>
            <h2 id="rb-sl-panel-title">AFIs y ocupación</h2>
            <p id="rb-sl-panel-summary">Analizando los eventos cargados…</p>
          </div>
          <button type="button" class="rb-sl-close" id="rb-sl-close-panel" aria-label="Cerrar panel">×</button>
        </div>
        <div class="rb-sl-panel-body">
          <div class="rb-sl-legend" aria-label="Leyenda de ocupación">
            <span class="rb-sl-legend-item rb-sl-legend-university">Clase</span>
            <span class="rb-sl-legend-item rb-sl-legend-busy">No disponible</span>
            <span class="rb-sl-legend-item rb-sl-legend-service">Servicio</span>
            <span class="rb-sl-legend-item rb-sl-legend-afi">AFI</span>
          </div>
          <div id="rb-sl-results"></div>
        </div>
      </section>
      <div class="rb-sl-toast" id="rb-sl-toast" role="status" aria-live="polite"></div>
    `;
    (document.body || document.documentElement).appendChild(root);

    root.querySelector('#rb-sl-trigger').addEventListener('click', () => {
      const open = !root.classList.contains('rb-sl-menu-open');
      root.classList.toggle('rb-sl-menu-open', open);
      root.querySelector('#rb-sl-trigger').setAttribute('aria-expanded', String(open));
      root.querySelector('#rb-sl-speed-list').setAttribute('aria-hidden', String(!open));
    });
    root.querySelector('#rb-sl-open-panel').addEventListener('click', () => {
      setSoyLeonPanel(true);
      setSoyLeonMenu(false);
    });
    root.querySelector('#rb-sl-close-panel').addEventListener('click', () => setSoyLeonPanel(false));
    root.querySelector('#rb-sl-refresh').addEventListener('click', () => {
      setSoyLeonMenu(false);
      scheduleSoyLeonScan(0);
      showSoyLeonToast('Eventos actualizados.', 'success');
    });
    root.querySelector('#rb-sl-results').addEventListener('click', (event) => {
      const result = event.target.closest('[data-rb-sl-event]');
      if (!result) return;
      setSoyLeonPanel(false);
      focusSoyLeonEvent(result.dataset.rbSlEvent);
    });
    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) {
        setSoyLeonMenu(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setSoyLeonMenu(false);
        setSoyLeonPanel(false);
      }
    });
  }

  function setSoyLeonMenu(open) {
    const root = document.querySelector(`#${SOY_LEON_ROOT_ID}`);
    if (!root) return;
    root.classList.toggle('rb-sl-menu-open', open);
    root.querySelector('#rb-sl-trigger')?.setAttribute('aria-expanded', String(open));
    root.querySelector('#rb-sl-speed-list')?.setAttribute('aria-hidden', String(!open));
  }

  function setSoyLeonPanel(open) {
    const root = document.querySelector(`#${SOY_LEON_ROOT_ID}`);
    const panel = root?.querySelector('#rb-sl-panel');
    if (!root || !panel) return;
    panel.hidden = !open;
    panel.setAttribute('aria-hidden', String(!open));
    root.classList.toggle('rb-sl-panel-open', open);
    document.body?.classList.toggle('rb-sl-panel-reserved', open);
    if (open) renderSoyLeonPanel();
  }

  function showSoyLeonToast(message, type = 'info') {
    const toast = document.querySelector('#rb-sl-toast');
    if (!toast) return;
    window.clearTimeout(showSoyLeonToast.timer);
    toast.textContent = message;
    toast.className = `rb-sl-toast rb-sl-toast-${type} rb-sl-toast-visible`;
    showSoyLeonToast.timer = window.setTimeout(() => {
      toast.className = 'rb-sl-toast';
    }, 3500);
  }

  function updateSoyLeonControls() {
    const root = document.querySelector(`#${SOY_LEON_ROOT_ID}`);
    if (!root) return;
    const statusDot = root.querySelector('#rb-sl-status-dot');
    const statusText = root.querySelector('#rb-sl-status-text');
    const badge = root.querySelector('#rb-sl-badge');
    const schedule = soyLeonState.schedule;
    const count = soyLeonState.matches.length;
    const conflictCount = soyLeonState.conflicts.length;
    const otherCount = soyLeonState.otherEvents.length;
    const serviceCount = soyLeonState.conflicts.filter((status) => status.isServiceConflict).length;
    const busyCount = soyLeonState.busyConflicts.length;
    const relevantCount = count + conflictCount + otherCount;

    if (!schedule) {
      statusText.textContent = soyLeonState.error || 'Sin horario compartido';
      statusDot.className = 'rb-sl-status-dot rb-sl-status-danger';
      badge.hidden = true;
    } else {
      const summary = [`${count} compatible${count === 1 ? '' : 's'}`];
      if (serviceCount) summary.push(`${serviceCount} con servicio`);
      if (busyCount) summary.push(`${busyCount} no disponible${busyCount === 1 ? '' : 's'}`);
      if (otherCount) summary.push(`${otherCount} otro${otherCount === 1 ? '' : 's'} AFI`);
      statusText.textContent = summary.join(' · ');
      statusDot.className = `rb-sl-status-dot ${busyCount ? 'rb-sl-status-danger' : (count ? 'rb-sl-status-active' : 'rb-sl-status-warning')}`;
      badge.hidden = relevantCount === 0;
      badge.textContent = String(relevantCount);
    }
    renderSoyLeonPanel();
  }

  function renderSoyLeonPanel() {
    const root = document.querySelector(`#${SOY_LEON_ROOT_ID}`);
    if (!root) return;
    const summary = root.querySelector('#rb-sl-panel-summary');
    const results = root.querySelector('#rb-sl-results');
    const schedule = soyLeonState.schedule;
    if (!summary || !results) return;

    if (!schedule) {
      summary.textContent = soyLeonState.error || 'No hay horario disponible.';
      results.innerHTML = '<p class="rb-sl-empty">Abre el registro becario y asegúrate de tener un horario activo.</p>';
      return;
    }

    const sem = `${formatDate(schedule.semester.start)}–${formatDate(schedule.semester.end)}`;
    const conflictCount = soyLeonState.conflicts.length;
    const matchCount = soyLeonState.matches.length;
    const otherCount = soyLeonState.otherEvents.length;
    const totalCount = matchCount + conflictCount + otherCount;
    summary.textContent = `${countLabel(totalCount, 'AFI')}: ${countLabel(matchCount, 'compatible')}${conflictCount ? ` · ${countLabel(conflictCount, 'ocupado')}` : ''}${otherCount ? ` · ${countLabel(otherCount, 'otro')}` : ''} · semestre ${sem}`;
    if (!totalCount) {
      results.innerHTML = '<p class="rb-sl-empty">No hay AFIs futuros cargados para este semestre.</p>';
      return;
    }

    const renderItems = (items, resultClass = '') => items.map((status) => `
      <button type="button" class="rb-sl-result ${resultClass}" data-rb-sl-event="${escapeHTML(status.id)}">
        <span class="rb-sl-result-date">${escapeHTML(formatDateLong(status.dateISO))} · ${escapeHTML(status.timeText)}</span>
        <strong>${escapeHTML(status.title || 'Evento sin título')}</strong>
        <span>${escapeHTML(status.place || 'Lugar por confirmar')} · ${escapeHTML(getSoyLeonStatusDetail(status))}</span>
      </button>
    `).join('');
    const renderSection = (title, items, resultClass = '') => items.length ? `
      <div class="rb-sl-section ${resultClass.includes('conflict') ? 'rb-sl-section-conflict' : ''}">
        <h3>${escapeHTML(title)}</h3>
        ${renderItems(items, resultClass)}
      </div>
    ` : '';
    const serviceConflicts = soyLeonState.conflicts.filter((status) => status.isServiceConflict);
    const busyConflicts = soyLeonState.conflicts.filter((status) => status.isBusyConflict && !status.isServiceConflict);
    const classConflicts = soyLeonState.conflicts.filter((status) => status.isClassConflict && !status.isServiceConflict && !status.isBusyConflict);
    const calendarConflicts = soyLeonState.conflicts.filter((status) => status.isCalendarConflict && !status.isServiceConflict && !status.isBusyConflict && !status.isClassConflict);
    results.innerHTML = [
      renderSection('AFIs compatibles después de clase', soyLeonState.matches, 'rb-sl-result-compatible'),
      renderSection('AFIs con servicio becario', serviceConflicts, 'rb-sl-result-service'),
      renderSection('AFIs en no disponible', busyConflicts, 'rb-sl-result-busy rb-sl-result-conflict'),
      renderSection('AFIs durante clase', classConflicts, 'rb-sl-result-class'),
      renderSection('AFIs en día bloqueado', calendarConflicts, 'rb-sl-result-calendar'),
      renderSection('Otros AFIs futuros', soyLeonState.otherEvents, 'rb-sl-result-afi'),
    ].join('');
  }

  function countLabel(count, singular) {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
  }

  function observeSoyLeonPage() {
    if (soyLeonMutationObserver || !document.body) return;
    soyLeonMutationObserver = new MutationObserver((mutations) => {
      const root = document.querySelector(`#${SOY_LEON_ROOT_ID}`);
      const pageChanged = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : null;
        return !target || !root || !root.contains(target);
      });
      if (pageChanged) scheduleSoyLeonScan();
    });
    soyLeonMutationObserver.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(`#${SOY_LEON_ROOT_ID}`)) return;
      if (target.closest('[onclick*="inscribirEvento"], .fl-btn-inscribirme, .fl-btn-asistire')) {
        // Soy León actualiza el estado de inscripción de forma asíncrona. Se
        // comprueba después de la respuesta visual y una segunda vez por si el
        // portal tarda en reemplazar el botón por «Inscrito».
        window.setTimeout(() => scheduleSoyLeonScan(0), 900);
        window.setTimeout(() => scheduleSoyLeonScan(0), 2500);
      }
      if (target.closest('#btnViewList, #btnViewCalendar, #btnFilter, #eventsCalendar, #eventsGrid, #agendaEventsList')) {
        scheduleSoyLeonScan(180);
      }
    }, true);
    document.querySelector('#searchInput')?.addEventListener('input', () => scheduleSoyLeonScan(180));
  }

  function scheduleSoyLeonScan(delay = 120) {
    window.clearTimeout(soyLeonScanTimer);
    soyLeonScanTimer = window.setTimeout(scanSoyLeonEvents, delay);
  }

  function scanSoyLeonEvents() {
    clearSoyLeonMarks();
    const events = extractSoyLeonEvents();
    soyLeonState.events = events;
    void recordSoyLeonEvents(events).catch((error) => {
      console.warn('[Soy León] No se pudo actualizar la base JSON de eventos.', error);
    });
    const statuses = events.map((event) => getSoyLeonEventStatus(event, soyLeonState.schedule, soyLeonState.database));
    const relevantStatuses = statuses.filter((status) => status.relevant);
    const matches = relevantStatuses.filter((status) => status.isCompatible);
    const conflicts = relevantStatuses.filter((status) => (
      status.isServiceConflict
      || status.isBusyConflict
      || status.isClassConflict
      || status.isCalendarConflict
    ));
    const busyConflicts = conflicts.filter((status) => status.isBusyConflict);
    const classConflicts = conflicts.filter((status) => status.isClassConflict);
    const otherEvents = relevantStatuses.filter((status) => !status.isCompatible && !conflicts.includes(status));
    const sortEvents = (items) => items.sort((a, b) => (
      a.dateISO.localeCompare(b.dateISO) || a.startMin - b.startMin || a.title.localeCompare(b.title)
    ));
    soyLeonState.eventStatuses = statuses;
    soyLeonState.matches = matches;
    soyLeonState.conflicts = sortEvents(conflicts);
    soyLeonState.busyConflicts = sortEvents(busyConflicts);
    soyLeonState.classConflicts = sortEvents(classConflicts);
    soyLeonState.otherEvents = sortEvents(otherEvents);
    sortEvents(matches);
    soyLeonState.lastScanAt = Date.now();
    statuses.forEach(markSoyLeonEventStatus);
    updateSoyLeonControls();
  }

  function clearSoyLeonMarks() {
    document.querySelectorAll('.rb-sl-compatible, .rb-sl-conflict, .rb-sl-busy, .rb-sl-service, .rb-sl-class, .rb-sl-calendar, .rb-sl-registered, .rb-sl-afi').forEach((element) => {
      element.classList.remove('rb-sl-compatible', 'rb-sl-conflict', 'rb-sl-busy', 'rb-sl-service', 'rb-sl-class', 'rb-sl-calendar', 'rb-sl-registered', 'rb-sl-afi');
      if (element.dataset.rbSlOriginalTitle !== undefined) {
        element.setAttribute('title', element.dataset.rbSlOriginalTitle);
        delete element.dataset.rbSlOriginalTitle;
      }
    });
    document.querySelectorAll('.rb-sl-status-badge').forEach((element) => {
      element.parentElement?.classList.remove('rb-sl-compatible-host');
      element.parentElement?.classList.remove('rb-sl-status-host');
      element.remove();
    });
    document.querySelectorAll('.rb-sl-focus').forEach((element) => element.classList.remove('rb-sl-focus'));
  }

  function markSoyLeonEventStatus(status) {
    getSoyLeonCards(status.id).forEach((card) => {
      const classes = [];
      const labels = [];
      if (status.isServiceConflict) {
        classes.push('rb-sl-service');
        labels.push(`Servicio ${status.service.start}–${status.service.end}`);
      }
      if (status.isBusyConflict) {
        classes.push('rb-sl-busy', 'rb-sl-conflict');
        labels.push(`No disponible${status.busy.label ? `: ${status.busy.label}` : ''}`);
      }
      if (status.isCompatible) {
        classes.push('rb-sl-compatible');
        labels.push(`AFI después de ${status.afterClass.className}`);
      } else if (status.isClassConflict) {
        classes.push('rb-sl-class');
        labels.push('Durante una clase');
      }
      if (status.isCalendarConflict) {
        classes.push('rb-sl-calendar');
        labels.push(status.calendarBlockReason);
      }
      if (status.isRegistered) {
        classes.push('rb-sl-registered');
        labels.push(status.isAfi ? 'AFI inscrito' : 'Evento inscrito');
      }
      if (!classes.length) {
        classes.push('rb-sl-afi');
        labels.push('AFI observado');
      }
      card.classList.add(...classes);
      if (card.dataset.rbSlOriginalTitle === undefined) {
        card.dataset.rbSlOriginalTitle = card.getAttribute('title') || '';
      }
      card.title = `${status.title}: ${labels.join(' · ')}`;

      if (card.querySelector('.rb-sl-status-badge')) return;
      const container = card.querySelector('.fl-event-card-info, .fl-agenda-event-info') || card.firstElementChild || card;
      container.classList.add('rb-sl-status-host');
      const badge = document.createElement('span');
      badge.className = `rb-sl-status-badge ${classes.map((name) => `${name}-badge`).join(' ')}`;
      badge.textContent = labels.join(' · ');
      badge.title = labels.join(' · ');
      badge.setAttribute('aria-label', labels.join(' · '));
      container.prepend(badge);
    });
  }

  function getSoyLeonCards(eventId) {
    return [...document.querySelectorAll('.fl-event-card[data-event-id], .fl-agenda-event-card[data-event-id]')]
      .filter((card) => card.dataset.eventId === eventId);
  }

  function focusSoyLeonEvent(eventId) {
    let card = getSoyLeonCards(eventId)[0];
    if (!card && document.querySelector('#btnViewList')) {
      document.querySelector('#btnViewList').click();
      window.setTimeout(() => focusSoyLeonEvent(eventId), 240);
      return;
    }
    if (!card) {
      showSoyLeonToast('El evento no está visible con los filtros actuales.', 'info');
      return;
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('rb-sl-focus');
    window.setTimeout(() => card.classList.remove('rb-sl-focus'), 2200);
  }

  function extractSoyLeonEvents() {
    const registeredIds = extractSoyLeonRegisteredEventIds();
    const structured = extractSoyLeonStructuredEvents(registeredIds);
    const structuredById = new Map(structured.map((event) => [event.id, event]));
    const cards = [...document.querySelectorAll('.fl-event-card[data-event-id], .fl-agenda-event-card[data-event-id]')];
    const cardEvents = cards
      .map((card) => extractSoyLeonCardEvent(card, structuredById.get(card.dataset.eventId)))
      .map((event) => event ? { ...event, isRegistered: registeredIds.has(event.id) || event.isRegistered } : event);
    const cardById = new Map(cardEvents.filter(Boolean).map((event) => [event.id, event]));

    if (structured.length) {
      soyLeonState.eventSource = 'eventsData';
      return structured.map((event) => ({
        ...event,
        isRegistered: registeredIds.has(event.id) || event.isRegistered,
        element: cardById.get(event.id)?.element || null,
      })).filter((event) => event.isAfi);
    }
    soyLeonState.eventSource = 'cards';
    return [...cardById.values()].filter((event) => event.isAfi);
  }

  function extractSoyLeonRegisteredEventIds() {
    const registeredIds = new Set();
    for (const script of document.scripts) {
      const source = script.textContent || '';
      const assignment = source.match(/\b(?:const|let|var)\s+eventosInscritos\s*=\s*/);
      if (!assignment || assignment.index === undefined) continue;
      const arrayStart = source.indexOf('[', assignment.index + assignment[0].length);
      if (arrayStart < 0) continue;
      const arrayEnd = findJsonArrayEnd(source, arrayStart);
      if (arrayEnd < 0) continue;
      try {
        const values = JSON.parse(source.slice(arrayStart, arrayEnd + 1));
        if (Array.isArray(values)) {
          values.map((value) => String(value).trim()).filter(Boolean).forEach((id) => registeredIds.add(id));
        }
      } catch (_) {
        continue;
      }
    }
    // Fallback para el estado que el portal pinta después de una inscripción,
    // cuando el script inline todavía conserva la lista anterior.
    document.querySelectorAll('.fl-event-card[data-event-id], .fl-agenda-event-card[data-event-id]').forEach((card) => {
      const id = String(card.dataset.eventId || '').trim();
      if (!id) return;
      const registeredLabel = [...card.querySelectorAll('button')]
        .map((button) => normalize(`${button.textContent || ''} ${button.title || ''} ${button.getAttribute('aria-label') || ''}`))
        .find((label) => label.includes('inscrito') && !label.includes('lista de espera'));
      if (registeredLabel) registeredIds.add(id);
    });
    return registeredIds;
  }

  function extractSoyLeonStructuredEvents(registeredIds = new Set()) {
    const marker = 'const eventsData = Object.values('; 
    for (const script of document.scripts) {
      const source = script.textContent || '';
      const markerIndex = source.indexOf(marker);
      if (markerIndex < 0) continue;
      const objectStart = source.indexOf('{', markerIndex + marker.length);
      if (objectStart < 0) continue;
      const objectEnd = findJsonObjectEnd(source, objectStart);
      if (objectEnd < 0) continue;
      try {
        const data = JSON.parse(source.slice(objectStart, objectEnd + 1));
        return Object.values(data).map((event) => normalizeSoyLeonRawEvent(event, registeredIds)).filter(Boolean);
      } catch (_) {
        continue;
      }
    }
    return [];
  }

  function findJsonObjectEnd(source, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function findJsonArrayEnd(source, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '[') {
        depth += 1;
      } else if (character === ']') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function normalizeSoyLeonRawEvent(raw, registeredIds = new Set()) {
    const id = String(raw?.ev_eve_uID || raw?.eventUID || raw?.id || '').trim();
    const dateISO = String(raw?.ev_eve_datestart || '').slice(0, 10);
    const start = normalizeSoyLeonClock(raw?.ev_eve_time);
    if (!id || !isISODate(dateISO) || !start) return null;
    const title = String(raw.ev_eve_name || 'Evento sin título').trim();
    return {
      id,
      title,
      dateISO,
      start: start.text,
      startMin: start.minutes,
      timeText: start.text,
      place: String(raw.ev_eve_place || '').trim(),
      isRegistered: registeredIds.has(id),
      isAfi: String(raw?.ev_eve_afi || '') === '1' || normalize(title).startsWith('afi'),
      element: null,
    };
  }

  function extractSoyLeonCardEvent(card, structured) {
    const id = String(card.dataset.eventId || '').trim();
    if (!id) return null;
    const title = card.querySelector('.fl-event-card-title, .fl-agenda-event-title')?.textContent.trim() || structured?.title || 'Evento sin título';
    const isAfi = Boolean(card.querySelector('.fl-event-card-afi, .fl-agenda-event-afi')) || Boolean(structured?.isAfi);
    const metaItems = [...card.querySelectorAll('.fl-event-card-meta-item, .fl-agenda-event-meta-item')]
      .map((element) => element.textContent.trim())
      .filter(Boolean);
    const timeElement = card.querySelector('img[src*="/time.svg"]')?.parentElement;
    const time = normalizeSoyLeonClock(timeElement?.textContent || metaItems.find((value) => /\d{1,2}:\d{2}/.test(value)) || structured?.start);
    const place = card.querySelector('img[src*="/location.svg"]')?.parentElement?.textContent.trim()
      || metaItems.find((value) => !/\d{1,2}:\d{2}/.test(value))
      || structured?.place
      || '';
    const dateISO = structured?.dateISO || extractSoyLeonCardDate(card);
    if (!dateISO || !time) return structured ? { ...structured, element: card } : null;
    return {
      id,
      title,
      dateISO,
      start: time.text,
      startMin: time.minutes,
      timeText: time.text,
      place,
      isAfi,
      element: card,
    };
  }

  function extractSoyLeonCardDate(card) {
    const day = card.querySelector('.fl-event-card-date-day')?.textContent.trim();
    const month = card.querySelector('.fl-event-card-date-month')?.textContent.trim();
    if (!day || !month) {
      const selected = document.querySelector('#selectedDateLabel')?.textContent.trim() || '';
      return parseSoyLeonDateLabel(selected);
    }
    return parseSoyLeonDateLabel(`${day} de ${month}`);
  }

  function parseSoyLeonDateLabel(label) {
    const match = String(label).toLocaleLowerCase('es-MX').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .match(/(\d{1,2})\s+de\s+([a-z]+)/i);
    if (!match) return '';
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const month = monthNames.indexOf(match[2]);
    if (month < 0) {
      const short = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
      const shortIndex = short.indexOf(match[2].slice(0, 3));
      if (shortIndex < 0) return '';
      return buildSoyLeonISODate(Number(match[1]), shortIndex);
    }
    return buildSoyLeonISODate(Number(match[1]), month);
  }

  function buildSoyLeonISODate(day, month) {
    const year = soyLeonState.schedule?.semester?.start.slice(0, 4) || getMexicoTodayISO().slice(0, 4);
    const dateISO = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isISODate(dateISO) ? dateISO : '';
  }

  function normalizeSoyLeonClock(value) {
    const raw = String(value || '').trim().toUpperCase();
    const twelveHour = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\b/);
    if (twelveHour) {
      const clockHours = Number(twelveHour[1]);
      const minutes = Number(twelveHour[2]);
      if (clockHours < 1 || clockHours > 12 || minutes > 59) return null;
      let hours = clockHours % 12;
      if (twelveHour[3] === 'PM') hours += 12;
      return { text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, minutes: hours * 60 + minutes };
    }
    const twentyFourHour = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s|$)/);
    if (!twentyFourHour) return null;
    const hours = Number(twentyFourHour[1]);
    const minutes = Number(twentyFourHour[2]);
    if (hours > 23 || minutes > 59) return null;
    return { text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, minutes: hours * 60 + minutes };
  }

  function getMexicoTodayISO() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: EXPECTED_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date()).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch (_) {
      return iso(new Date());
    }
  }

  function isSharedCalendarBlocked(dateISO, schedule) {
    return Boolean(getSharedCalendarBlockReason(dateISO, schedule));
  }

  function getSharedCalendarBlockReason(dateISO, schedule) {
    const blocks = schedule?.calendarBlocks || {};
    const range = Array.isArray(blocks.ranges)
      ? blocks.ranges.find((entry) => dateISO >= entry.start && dateISO <= entry.end)
      : null;
    if (range?.reason) return String(range.reason);
    const date = Array.isArray(blocks.dates)
      ? blocks.dates.find((entry) => entry.date === dateISO)
      : null;
    if (date?.reason) return String(date.reason);
    if (blocks.anahuacDay?.date === dateISO) return String(blocks.anahuacDay.reason || 'día bloqueado');
    return '';
  }

  function findBecarioConflict(event, database = soyLeonState.database) {
    if (!event?.dateISO || event.dateISO < getMexicoTodayISO()) return null;
    const shift = database?.becario?.officialShifts
      ?.filter((record) => record.dateISO === event.dateISO)
      .find((record) => event.startMin >= record.startMin && event.startMin < record.endMin);
    if (!shift) return null;
    return {
      conflict: true,
      serviceStart: shift.start,
      serviceEnd: shift.end,
      serviceKey: shift.key,
    };
  }

  function getSoyLeonEventStatus(event, schedule, database = soyLeonState.database) {
    const service = (Array.isArray(database?.becario?.officialShifts) ? database.becario.officialShifts : [])
      .map(normalizeDatabaseShift)
      .filter(Boolean)
      .filter((record) => record.dateISO === event.dateISO)
      .find((record) => event.startMin >= record.startMin && event.startMin < record.endMin) || null;
    const busy = getScheduleBusyBlocksForDate(schedule, event.dateISO)
      .find((block) => event.startMin >= block.startMin && event.startMin < block.endMin) || null;
    const classEntries = getScheduleClassesForDate(schedule, event.dateISO)
      .filter((entry) => event.startMin >= (entry.startMin ?? toMinutes(entry.start))
        && event.startMin < (entry.endMin ?? toMinutes(entry.end)));
    const calendarBlockReason = getSharedCalendarBlockReason(event.dateISO, schedule);
    const afterClass = schedule ? matchSoyLeonEvent(event, schedule) : null;
    const todayISO = getMexicoTodayISO();
    const inSemester = Boolean(schedule?.semester)
      && event.dateISO >= schedule.semester.start
      && event.dateISO <= schedule.semester.end;
    const relevant = event.dateISO >= todayISO && inSemester;

    return {
      ...event,
      service,
      busy,
      classEntries,
      afterClass,
      calendarBlockReason,
      inSemester,
      relevant,
      isServiceConflict: Boolean(service),
      isBusyConflict: Boolean(busy),
      isClassConflict: classEntries.length > 0,
      isCalendarConflict: Boolean(calendarBlockReason),
      isCompatible: Boolean(
        afterClass
        && classEntries.length === 0
        && !service
        && !busy
        && !calendarBlockReason,
      ),
    };
  }

  function getSoyLeonStatusDetail(status) {
    const details = [];
    if (status.isRegistered) details.push(status.isAfi ? 'AFI inscrito' : 'Evento inscrito');
    if (status.service) details.push(`Servicio ${status.service.start}–${status.service.end}`);
    if (status.busy) details.push(`No disponible${status.busy.label ? `: ${status.busy.label}` : ''}`);
    if (status.classEntries.length) {
      const names = [...new Set(status.classEntries.map((entry) => entry.name || 'clase'))];
      details.push(`Durante ${names.join(' / ')}`);
    }
    if (status.afterClass) details.push(`Después de ${status.afterClass.className}`);
    if (status.calendarBlockReason) details.push(status.calendarBlockReason);
    return details.length ? details.join(' · ') : 'AFI observado';
  }

  async function recordSoyLeonEvents(events) {
    const observedAt = Date.now();
    const source = soyLeonState.eventSource === 'eventsData' ? 'eventsData' : 'cards';
    const observedEvents = events.map((event) => normalizeDatabaseEvent({
      ...event,
      source,
      observedAt,
    })).filter(Boolean);
    const next = await updateCalendarDatabase((database) => {
      // El menú principal solo expone una parte de los eventos. Conservamos el
      // conjunto ya observado y no permitimos que un botón «Inscribirme» del
      // menú borre un «Inscrito» confirmado en el calendario completo.
      const eventMap = new Map(database.soyLeon.events.map((event) => [event.id, event]));
      observedEvents.forEach((event) => {
        const previous = eventMap.get(event.id);
        eventMap.set(event.id, {
          ...previous,
          ...event,
          isAfi: Boolean(event.isAfi || previous?.isAfi),
          isRegistered: source === 'eventsData'
            ? event.isRegistered
            : Boolean(event.isRegistered || previous?.isRegistered),
        });
      });
      return {
        ...database,
        soyLeon: {
          ...database.soyLeon,
          events: [...eventMap.values()],
          lastSeenAt: observedAt,
          source,
        },
      };
    }, { source: DATABASE_SOURCE_SOY_LEON });
    calendarDatabase = next;
    soyLeonState.database = next;
  }

  function matchSoyLeonEvent(event, schedule) {
    if (!event?.dateISO || event.dateISO < getMexicoTodayISO()) return null;
    if (event.dateISO < schedule.semester.start || event.dateISO > schedule.semester.end) return null;
    if (isSharedCalendarBlocked(event.dateISO, schedule)) return null;

    const weekday = fromISO(event.dateISO).getDay();
    const matchingClasses = schedule.classes
      .filter((entry) => entry.weekday === weekday
        && (entry.endMin ?? toMinutes(entry.end)) <= event.startMin)
      .sort((a, b) => a.startMin - b.startMin);
    if (!matchingClasses.length) return null;
    const previousClass = matchingClasses[matchingClasses.length - 1];
    return {
      className: previousClass.name,
      afterClassEnd: previousClass.end,
    };
  }

  function normalizeGoogleCalendarConfig(raw) {
    return {
      clientId: typeof raw?.clientId === 'string' ? raw.clientId.trim() : '',
      // La primera versión solo sincroniza el calendario principal por diseño.
      calendarId: GOOGLE_CALENDAR_ID,
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function normalize(value) {
    return String(value)
      .toLocaleLowerCase('es-MX')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function parseClock(value) {
    const match = String(value).trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    if (hours > 23 || minutes > 59) return null;
    return {
      text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
      minutes: hours * 60 + minutes,
    };
  }

  function parseSchedule(text) {
    const schedule = emptySchedule();
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);

    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;

      const match = line
        .replace(/[–—]/g, '-')
        .match(/^([^\s:]+)\s*:?\s*(\d{1,2}(?::?\d{2})?)\s*(?:-|a|hasta)\s*(\d{1,2}(?::?\d{2})?)$/i);

      if (!match) {
        errors.push(`Línea ${index + 1}: usa "Lun 08:30-10:00".`);
        return;
      }

      const day = DAY_ALIASES[normalize(match[1])];
      const start = parseClock(match[2]);
      const end = parseClock(match[3]);
      if (!day || !start || !end || end.minutes <= start.minutes) {
        errors.push(`Línea ${index + 1}: día u horario inválido.`);
        return;
      }

      schedule[day].push({
        start: start.text,
        end: end.text,
        startMin: start.minutes,
        endMin: end.minutes,
        name: 'Clase manual',
      });
    });

    Object.entries(schedule).forEach(([weekday, classes]) => {
      classes.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
      for (let index = 1; index < classes.length; index += 1) {
        if (classes[index - 1].endMin > classes[index].startMin) {
          errors.push(`Día ${weekday}: hay clases traslapadas.`);
          break;
        }
      }
    });

    return { schedule, errors };
  }

  function validateImportedSchedule(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { value: null, errors: ['El JSON debe contener un objeto de horario.'] };
    }
    if (Number(raw.version) !== 1) errors.push('version debe ser 1.');
    if (typeof raw.owner !== 'string' || !raw.owner.trim()) errors.push('owner debe ser un texto no vacío.');
    if (raw.timezone !== EXPECTED_TIMEZONE) errors.push(`timezone debe ser ${EXPECTED_TIMEZONE}.`);

    const semester = raw.semester;
    let semesterStart = DEFAULT_SEMESTER.start;
    let semesterEnd = DEFAULT_SEMESTER.end;
    if (!semester || typeof semester !== 'object') {
      errors.push('Falta semester con start y end.');
    } else {
      if (!isISODate(semester.start)) errors.push('semester.start no es una fecha ISO válida.');
      if (!isISODate(semester.end)) errors.push('semester.end no es una fecha ISO válida.');
      if (isISODate(semester.start) && isISODate(semester.end)) {
        if (fromISO(semester.end) < fromISO(semester.start)) {
          errors.push('semester.end debe ser posterior a semester.start.');
        } else {
          semesterStart = semester.start;
          semesterEnd = semester.end;
        }
      }
    }

    if (!Array.isArray(raw.classes)) {
      errors.push('classes debe ser un arreglo.');
    }

    const classes = [];
    if (Array.isArray(raw.classes)) {
      raw.classes.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`classes[${index}] debe ser un objeto.`);
          return;
        }
        const weekday = Number(entry.weekday);
        const start = parseClock(entry.start);
        const end = parseClock(entry.end);
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5) {
          errors.push(`classes[${index}].weekday debe estar entre 1 y 5.`);
        }
        if (!start || !end || end.minutes <= start.minutes) {
          errors.push(`classes[${index}] tiene un horario inválido.`);
        }
        if (!name) errors.push(`classes[${index}].name debe ser un texto no vacío.`);
        if (Number.isInteger(weekday) && weekday >= 1 && weekday <= 5 && start && end && end.minutes > start.minutes && name) {
          classes.push({
            weekday,
            start: start.text,
            end: end.text,
            startMin: start.minutes,
            endMin: end.minutes,
            name,
          });
        }
      });
    }

    const byDay = emptySchedule();
    classes.forEach((entry) => byDay[entry.weekday].push(entry));
    Object.entries(byDay).forEach(([weekday, dayClasses]) => {
      dayClasses.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
      for (let index = 1; index < dayClasses.length; index += 1) {
        if (dayClasses[index - 1].endMin > dayClasses[index].startMin) {
          errors.push(`weekday ${weekday}: hay clases traslapadas.`);
          break;
        }
      }
    });

    if (errors.length) return { value: null, errors: uniqueStrings(errors) };
    return {
      value: {
        version: 1,
        owner: raw.owner.trim(),
        timezone: EXPECTED_TIMEZONE,
        semester: { start: semesterStart, end: semesterEnd },
        targetHours: raw.targetHours || (raw.targetRegisters ? Number(raw.targetRegisters) * HOURS_PER_BLOCK : undefined),
        targetRegisters: raw.targetRegisters || (raw.targetHours ? Math.round(Number(raw.targetHours) / HOURS_PER_BLOCK) : undefined),
        restrictions: raw.restrictions || undefined,
        classes: classes.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin),
      },
      errors: [],
    };
  }

  function emptySchedule() {
    return { 1: [], 2: [], 3: [], 4: [], 5: [] };
  }

  function uniqueStrings(values) {
    return [...new Set(values)];
  }

  function getActiveSchedule() {
    if (config.source === 'imported' && config.importedSchedule) {
      const schedule = emptySchedule();
      config.importedSchedule.classes.forEach((entry) => {
        schedule[entry.weekday].push({ ...entry });
      });
      return { schedule, errors: [] };
    }
    return parseSchedule(config.classLines);
  }

  function hasScheduleConfiguration() {
    return Boolean(config.source === 'imported' ? config.importedSchedule : config.classLines.trim());
  }

  function toMinutes(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
  }

  function clockFromMinutes(value) {
    const total = clamp(Math.round(Number(value) || 0), 0, 24 * 60 - 1);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  function parseTimeRange(value) {
    const match = String(value || '').match(/(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/);
    if (!match) return null;
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    if (!start || !end || end.minutes <= start.minutes) return null;
    return { start: start.text, end: end.text, startMin: start.minutes, endMin: end.minutes };
  }

  function iso(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function fromISO(value) {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function isISODate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && iso(fromISO(value)) === value;
  }

  function addDays(date, amount) {
    const result = new Date(date);
    result.setDate(result.getDate() + amount);
    return result;
  }

  function mondayOf(date) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return addDays(result, -((result.getDay() + 6) % 7));
  }

  function isWeekend(date) {
    return date.getDay() === 0 || date.getDay() === 6;
  }

  function isAdjacentDay(dateISOa, dateISOb) {
    const diffDays = Math.round((fromISO(dateISOb) - fromISO(dateISOa)) / 86400000);
    return Math.abs(diffDays) === 1;
  }

  function inSemester(date) {
    const sem = getActiveSemester();
    return iso(date) >= sem.start && iso(date) <= sem.end;
  }

  /* Helpers para cálculo de fechas dinámicas */
  function startOfDayDate(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function getTodayISO() {
    return iso(startOfDayDate(new Date()));
  }

  function getMinCandidateDateISO() {
    // Si hoy es 19 de agosto, hoy + 7 días es 26 de agosto (inclusive bloqueado).
    // Las propuestas de disponibilidad se consideran únicamente a partir del 27 de agosto (hoy + 8 días).
    return iso(addDays(startOfDayDate(new Date()), 8));
  }

  function getCalendarBlockReason(dateOrISO) {
    const dateISO = typeof dateOrISO === 'string' ? dateOrISO : iso(dateOrISO);
    const range = CALENDAR_BLOCK_RANGES.find(({ start, end }) => (
      dateISO >= start && dateISO <= end
    ));
    if (range?.reason) return range.reason;
    if (CALENDAR_INHABIL_DATES.has(dateISO)) return CALENDAR_INHABIL_DATES.get(dateISO);
    if (dateISO === ANAHUAC_DAY) return 'día Anáhuac';
    if (isWeekend(fromISO(dateISO))) return 'fin de semana';
    return '';
  }

  function isCalendarBlocked(dateOrISO) {
    return Boolean(getCalendarBlockReason(dateOrISO));
  }

  function weekStartForDateISO(dateISO) {
    return iso(mondayOf(fromISO(dateISO)));
  }

  function getSemesterWeeks() {
    const weeks = [];
    const sem = getActiveSemester();
    for (let date = fromISO(sem.start); iso(date) <= sem.end; date = addDays(date, 7)) {
      weeks.push(iso(date));
    }
    return weeks;
  }

  function formatDate(dateOrISO) {
    const date = typeof dateOrISO === 'string' ? fromISO(dateOrISO) : dateOrISO;
    return `${date.getDate()} de ${MONTHS[date.getMonth()]}`;
  }

  function formatDateLong(dateISO) {
    const date = fromISO(dateISO);
    const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    return `${names[date.getDay()]} ${date.getDate()} de ${MONTHS[date.getMonth()]}`;
  }

  function formatHours(count) {
    return `${(count * HOURS_PER_BLOCK).toFixed(1).replace('.0', '')} h`;
  }

  function parsePeriodLabel() {
    const label = document.querySelector('#periodLabel')?.textContent.trim() || '';
    const normalized = normalize(label);
    const weekMatch = normalized.match(/^(\d{1,2})\s*[–—-]\s*(\d{1,2})\s+de\s+([^\s]+)\s+(\d{4})$/);
    if (weekMatch) {
      const endDay = Number(weekMatch[2]);
      const month = MONTHS.indexOf(weekMatch[3]);
      const year = Number(weekMatch[4]);
      if (month >= 0 && Number.isInteger(year)) {
        const endDate = new Date(year, month, endDay);
        const dates = [];
        for (let offset = -4; offset <= 0; offset += 1) dates.push(addDays(endDate, offset));
        return { view: 'week', dates, weekStartISO: iso(dates[0]) };
      }
    }

    const dayMatch = normalized.match(/(?:^|\s)(\d{1,2})\s+de\s+([^\s]+)\s+(\d{4})$/);
    if (dayMatch) {
      const day = Number(dayMatch[1]);
      const month = MONTHS.indexOf(dayMatch[2]);
      const year = Number(dayMatch[3]);
      if (month >= 0 && Number.isInteger(year)) {
        const date = new Date(year, month, day);
        return { view: 'day', dates: [date], dateISO: iso(date), weekStartISO: iso(mondayOf(date)) };
      }
    }

    const monthMatch = normalized.match(/^([^\s]+)\s+(\d{4})$/);
    if (monthMatch) {
      const month = MONTHS.indexOf(monthMatch[1]);
      const year = Number(monthMatch[2]);
      if (month >= 0 && Number.isInteger(year)) return { view: 'month', month, year };
    }
    return null;
  }

  function getView() {
    const pressed = document.querySelector('[id^="vDay"][aria-pressed="true"], [id^="vWeek"][aria-pressed="true"], [id^="vMonth"][aria-pressed="true"]');
    if (pressed?.id === 'vDay') return 'day';
    if (pressed?.id === 'vMonth') return 'month';
    if (pressed?.id === 'vWeek') return 'week';
    if (document.querySelector('#content table.week')) return 'week';
    if (document.querySelector('#content .day-list')) return 'day';
    if (document.querySelector('#content .month-grid')) return 'month';
    return null;
  }

  function getSlots(view) {
    const ranges = [];
    if (view === 'week') {
      document.querySelectorAll('#content table.week tbody tr').forEach((row) => {
        const range = parseTimeRange(row.querySelector('th.hour')?.textContent);
        if (range) ranges.push(range);
      });
    } else if (view === 'day') {
      document.querySelectorAll('#content .day-block > .time').forEach((element) => {
        const range = parseTimeRange(element.textContent);
        if (range) ranges.push(range);
      });
    }
    const unique = new Map();
    ranges.forEach((range) => {
      if (MODULE_END_BY_START.get(range.start) === range.end) unique.set(`${range.start}-${range.end}`, range);
    });
    return [...unique.values()].sort((a, b) => a.startMin - b.startMin);
  }

  function getAvailableButtons() {
    const buttons = new Map();
    const minCandidateISO = getMinCandidateDateISO();

    document.querySelectorAll('#content .spot-btn[data-add="1"][data-date][data-slot]').forEach((button) => {
      const end = MODULE_END_BY_START.get(button.dataset.slot);
      if (!end || button.disabled) return;
      const date = button.dataset.date;
      if (!isISODate(date) || date === ANAHUAC_DAY || isCalendarBlocked(date) || !inSemester(fromISO(date))) return;

      // REGLA 1: Exclusión de disponibilidad desde hoy hasta hoy + 7 días (se requiere date >= minCandidateISO)
      if (date < minCandidateISO) return;

      // REGLA 2: Prohibir detección de disponibilidad en bloques restringidos
      if (isSlotProhibited(date, button.dataset.slot)) return;
      // REGLA 3: Los bloques marcados manualmente como "no disponible" son rojos
      // y nunca pueden entrar como disponibilidad para un turno nuevo.
      if (isCustomBusySlot(date, button.dataset.slot)) return;

      const key = `${date}|${button.dataset.slot}`;
      if (officialShiftState.keys.has(key)) return;
      if (!buttons.has(key)) buttons.set(key, button);
    });
    return buttons;
  }

  function hasModuleSlotInDom(dateISO, start) {
    return [...document.querySelectorAll('#content [data-date][data-slot]')].some((element) => (
      element.dataset.date === dateISO
      && element.dataset.slot === start
      && (element.matches('[data-add="1"]') || element.matches('[data-rm]'))
    ));
  }

  function findDailyCandidates(classes, slots, dateISO, availableKeys) {
    const sortedClasses = classes
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.endMin - b.endMin || b.startMin - a.startMin);
    const sortedSlots = [...slots].sort((a, b) => a.startMin - b.startMin);
    const results = [];

    for (let i = 0; i < sortedSlots.length; i += 1) {
      const slot1 = sortedSlots[i];
      if (isSlotProhibited(dateISO, slot1.start)) continue;

      const previousClass = sortedClasses.find((entry) => entry.endMin === slot1.startMin);
      const isException = isSlotExceptionAllowed(dateISO, slot1.start);

      if (!previousClass && !isException) continue;

      const crossesLaterClass = sortedClasses.some((entry) => (
        entry.startMin > (previousClass ? previousClass.startMin : slot1.startMin - 90)
        && entry.startMin < slot1.endMin
      ));
      if (crossesLaterClass) continue;

      const nextClassStart = sortedClasses
        .filter((entry) => entry.startMin >= slot1.endMin)
        .reduce((minimum, entry) => Math.min(minimum, entry.startMin), Infinity);
      if (slot1.endMin > nextClassStart) continue;

      const afterLabel = previousClass ? previousClass.end : `${slot1.start}`;
      const className = previousClass?.name || (isException ? 'Excepción horaria' : 'Clase manual');

      // Comprobar si existe un segundo bloque contiguo consecutivo (Turno Doble = 3.0 h)
      const slot2 = sortedSlots[i + 1];
      const canDouble = Boolean(
        slot2 && slot2.startMin === slot1.endMin
        && !isSlotProhibited(dateISO, slot2.start)
        && slot2.endMin <= nextClassStart,
      );
      if (canDouble) {
        results.push({
          isDouble: true,
          slots: [slot1, slot2],
          slot: slot1,
          keys: [`${dateISO}|${slot1.start}`, `${dateISO}|${slot2.start}`],
          key: `${dateISO}|${slot1.start}`,
          after: afterLabel,
          className,
          durationHours: 3.0,
        });
      }

      // Bloque sencillo (1.5 h) como alternativa / fallback: los bloques habilitados solo por una
      // excepción (ej. miércoles 13:00, que no sigue a una clase real) nunca se proponen sueltos
      // a menos que el bloque contiguo (ej. 14:30) también esté realmente disponible ahora mismo;
      // si no se conoce la disponibilidad real, basta con que el doble sea estructuralmente posible.
      const isPureException = isException && !previousClass;
      const secondKeyAvailable = canDouble
        && (!availableKeys || availableKeys.has(`${dateISO}|${slot2.start}`));
      const allowSingle = !isPureException || secondKeyAvailable;
      if (allowSingle) {
        results.push({
          isDouble: false,
          slots: [slot1],
          slot: slot1,
          keys: [`${dateISO}|${slot1.start}`],
          key: `${dateISO}|${slot1.start}`,
          after: afterLabel,
          className,
          durationHours: 1.5,
        });
      }
    }
    return results;
  }

  function getMatchesForView(period, schedule, availableButtons) {
    const result = { available: [], full: [] };
    if (!period || !period.dates) return result;

    const minCandidateISO = getMinCandidateDateISO();

    period.dates.forEach((date) => {
      const dateISO = iso(date);
      if (!inSemester(date) || dateISO === ANAHUAC_DAY || isCalendarBlocked(dateISO)) return;

      // REGLA 1: No mostrar candidatos en UI dentro de la ventana de exclusión de 7 días
      if (dateISO < minCandidateISO) return;

      const classes = getClassesForDate(schedule, dateISO);
      const renderedSlots = getSlots(getView());
      const candidates = findDailyCandidates(classes, renderedSlots.length ? renderedSlots : MODULE_SLOTS, dateISO, availableButtons);
      if (!candidates.length) return;

      // Evaluar candidatos dando preferencia a turnos dobles
      for (const candidate of candidates) {
        const allAvailable = candidate.keys.every((k) => availableButtons.has(k));
        const allInDom = candidate.slots.every((s) => hasModuleSlotInDom(dateISO, s.start));

        const match = {
          date,
          dateISO,
          key: candidate.key,
          keys: candidate.keys,
          slot: candidate.slot,
          slots: candidate.slots,
          isDouble: candidate.isDouble,
          durationHours: candidate.durationHours,
          after: candidate.after,
          className: candidate.className,
          available: allAvailable,
        };

        if (allAvailable) {
          result.available.push(match);
          break; // Tomar la mejor opción disponible para este día
        } else if (allInDom) {
          result.full.push(match);
        }
      }
    });

    result.available.sort(compareCandidates);
    result.full.sort(compareCandidates);
    return result;
  }

  function compareCandidates(a, b) {
    // 1. Cronológico: fechas más cercanas primero
    if (a.dateISO !== b.dateISO) return a.dateISO.localeCompare(b.dateISO);
    // 2. Preferencia por turnos dobles contiguos (3.0 h sobre 1.5 h)
    if (Boolean(a.isDouble) !== Boolean(b.isDouble)) return a.isDouble ? -1 : 1;
    // 3. Hora de inicio
    const startA = a.slots ? a.slots[0].startMin : (a.slot?.startMin || 0);
    const startB = b.slots ? b.slots[0].startMin : (b.slot?.startMin || 0);
    return startA - startB;
  }

  function getRegistrationVisualSchedule(activeSchedule) {
    const sharedPayload = buildSharedSchedulePayload(config);
    const sharedSchedule = sharedPayload ? normalizeSharedSchedule(sharedPayload) : null;
    if (sharedSchedule) return sharedSchedule;

    const classes = Object.entries(activeSchedule || {}).flatMap(([weekday, entries]) => (
      (Array.isArray(entries) ? entries : []).map((entry) => ({
        ...entry,
        weekday: Number(weekday),
      }))
    ));
    return {
      semester: getActiveSemester(),
      classes,
      customBusyBlocks: normalizeBusyBlocks(config.customBusyBlocks),
    };
  }

  function getRegistrationSlotContainers(dateISO, start, options = {}) {
    const containers = new Set();
    const includeFullCells = options.includeFullCells !== false;
    document.querySelectorAll('#content [data-date][data-slot]').forEach((element) => {
      if (element.dataset.date !== dateISO || element.dataset.slot !== start) return;
      containers.add(element.closest('td, .day-block') || element);
    });

    if (!includeFullCells) return [...containers];

    // Cuando el módulo está lleno, no quedan botones con data-date/data-slot.
    // Recuperar la celda por la coordenada de la tabla permite mantener visibles
    // las referencias amarilla, roja y naranja aunque ya haya dos personas.
    if (getView() === 'week') {
      const table = document.querySelector('#content table.week');
      const period = parsePeriodLabel();
      const columnIndex = table ? getWeekColumnIndex(table, dateISO, period) : -1;
      if (table && columnIndex >= 0) {
        getWeekCellsAtColumn(table, columnIndex).forEach((cell) => {
          const range = parseTimeRange(cell.parentElement?.querySelector('th.hour')?.textContent);
          if (range?.start === start && cell.matches('td') && cell.querySelector('.spot, .spot-btn')) containers.add(cell);
        });
      }
    } else if (getView() === 'day') {
      document.querySelectorAll('#content .day-block').forEach((block) => {
        const range = parseTimeRange(block.querySelector(':scope > .time')?.textContent);
        if (range?.start === start && block.querySelector('.spots')) containers.add(block);
      });
    }
    return [...containers];
  }

  function addRegistrationOccupancyBadges(container, statuses) {
    const labels = [];
    const addBadge = (kind, text) => {
      const badge = document.createElement('span');
      badge.className = `rb-after-class-occupancy-badge rb-after-class-occupancy-badge-${kind}`;
      badge.textContent = text;
      labels.push(text);
      return badge;
    };
    const wrapper = document.createElement('div');
    wrapper.className = 'rb-after-class-occupancy-badges';

    if (statuses.classes.length) {
      const names = [...new Set(statuses.classes.map((entry) => entry.name || 'Clase'))];
      wrapper.append(addBadge('university', `Clase: ${names.join(' / ')}`));
    }
    if (statuses.busyBlocks.length) {
      const labelsText = [...new Set(statuses.busyBlocks.map((entry) => entry.label).filter(Boolean))];
      wrapper.append(addBadge('busy', labelsText.length ? `No disponible: ${labelsText.join(' / ')}` : 'No disponible'));
    }
    if (statuses.services.length) {
      const times = [...new Set(statuses.services.map((entry) => `${entry.start}–${entry.end}`))];
      wrapper.append(addBadge('service', `Servicio: ${times.join(' / ')}`));
    }
    if (statuses.afis.length) {
      const registered = statuses.afis.filter((event) => event.isRegistered);
      const observed = statuses.afis.filter((event) => !event.isRegistered);
      if (observed.length) {
        const titles = [...new Set(observed.map((event) => event.title || 'AFI'))].slice(0, 2);
        const suffix = observed.length > titles.length ? ` +${observed.length - titles.length}` : '';
        wrapper.append(addBadge('afi', `AFI: ${titles.join(' / ')}${suffix}`));
      }
      if (registered.length) {
        const titles = [...new Set(registered.map((event) => event.title || 'AFI'))].slice(0, 2);
        const suffix = registered.length > titles.length ? ` +${registered.length - titles.length}` : '';
        wrapper.append(addBadge('afi-registered', `AFI inscrito: ${titles.join(' / ')}${suffix}`));
      }
    }

    if (!labels.length) return;
    if (container.matches('.day-block')) {
      const spots = container.querySelector('.spots');
      container.insertBefore(wrapper, spots || null);
    } else {
      container.prepend(wrapper);
    }
    if (!('rbOccupancyTitle' in container.dataset)) {
      container.dataset.rbOccupancyTitle = container.getAttribute('title') || '';
    }
    container.title = labels.join(' · ');
  }

  function getKnownAfiEventsByDate() {
    const eventsByDate = new Map();
    getKnownSoyLeonEvents().forEach((event) => {
      const events = eventsByDate.get(event.dateISO) || [];
      events.push(event);
      eventsByDate.set(event.dateISO, events);
    });
    eventsByDate.forEach((events) => events.sort((a, b) => (
      a.startMin - b.startMin || a.title.localeCompare(b.title)
    )));
    return eventsByDate;
  }

  function getAfiMarkerLabel(events) {
    const registeredCount = events.filter((event) => event.isRegistered).length;
    const totalLabel = `${events.length} AFI${events.length === 1 ? '' : 's'}`;
    if (!registeredCount) return totalLabel;
    return `${totalLabel} · ${registeredCount} inscrito${registeredCount === 1 ? '' : 's'}`;
  }

  function getAfiMarkerTitle(events) {
    return events
      .map((event) => `${event.isRegistered ? 'Inscrito: ' : ''}${event.title} (${event.timeText})`)
      .join(' · ')
      .slice(0, 1000);
  }

  function preserveAfiMarkerTitle(element, events) {
    if (element.dataset.rbAfiOriginalTitle === undefined) {
      element.dataset.rbAfiOriginalTitle = element.getAttribute('title') || '';
    }
    const title = getAfiMarkerTitle(events);
    element.title = title;
    return title;
  }

  function addAfiMarkerBadge(container, events) {
    let badge = container.querySelector(':scope > .rb-after-class-afi-day-badge');
    if (!badge) {
      badge = document.createElement('span');
      container.append(badge);
    }
    const registered = events.some((event) => event.isRegistered);
    badge.className = `rb-after-class-afi-day-badge${registered ? ' rb-after-class-afi-day-badge-registered' : ''}`;
    const label = getAfiMarkerLabel(events);
    badge.textContent = label;
    badge.title = getAfiMarkerTitle(events);
    badge.setAttribute('aria-label', badge.title);
    return label;
  }

  function markRegistrationAfiDayContainer(container, events) {
    if (!container || !events.length) return;
    container.classList.add('rb-after-class-afi-day');
    if (events.some((event) => event.isRegistered)) {
      container.classList.add('rb-after-class-afi-registered-day');
    }
    addAfiMarkerBadge(container, events);
    preserveAfiMarkerTitle(container, events);
  }

  function getRegistrationMonthDayISO(dayButton, period) {
    const directDate = String(dayButton.dataset.goto || '');
    if (isISODate(directDate)) return directDate;
    if (!period || period.view !== 'month') return '';

    const dayMatch = String(dayButton.querySelector('.num')?.textContent || '').match(/\d{1,2}/);
    if (!dayMatch) return '';
    const date = new Date(period.year, period.month, Number(dayMatch[0]));
    if (date.getFullYear() !== period.year || date.getMonth() !== period.month) return '';
    return iso(date);
  }

  function markRegistrationAfiMonthMarkers(period) {
    if (period?.view !== 'month') return;
    const eventsByDate = getKnownAfiEventsByDate();
    document.querySelectorAll('#content .mday').forEach((dayButton) => {
      const dateISO = getRegistrationMonthDayISO(dayButton, period);
      const events = eventsByDate.get(dateISO) || [];
      if (events.length) markRegistrationAfiDayContainer(dayButton, events);
    });
  }

  function markRegistrationAfiPeriodMarkers(view, period) {
    if (!period?.dates?.length) return;
    const eventsByDate = getKnownAfiEventsByDate();

    if (view === 'week') {
      const table = document.querySelector('#content table.week');
      if (!table) return;
      period.dates.forEach((date) => {
        const dateISO = iso(date);
        const events = eventsByDate.get(dateISO) || [];
        if (!events.length) return;
        const columnIndex = getWeekColumnIndex(table, dateISO, period);
        const header = columnIndex >= 0 ? table.querySelector('thead tr')?.children[columnIndex] : null;
        if (!header) return;
        header.classList.add('rb-after-class-afi-column');
        if (events.some((event) => event.isRegistered)) {
          header.classList.add('rb-after-class-afi-registered-column');
        }
        addAfiMarkerBadge(header, events);
        preserveAfiMarkerTitle(header, events);
      });
      return;
    }

    if (view === 'day') {
      const dateISO = iso(period.dates[0]);
      const events = eventsByDate.get(dateISO) || [];
      if (!events.length) return;
      const content = document.querySelector('#content');
      if (!content) return;
      content.classList.add('rb-after-class-afi-day-view');
      let banner = content.querySelector(':scope > .rb-after-class-afi-banner');
      if (!banner) {
        banner = document.createElement('div');
        content.prepend(banner);
      }
      const label = getAfiMarkerLabel(events);
      const title = getAfiMarkerTitle(events);
      banner.className = `rb-after-class-afi-banner${events.some((event) => event.isRegistered) ? ' rb-after-class-afi-banner-registered' : ''}`;
      banner.textContent = `⚑ ${label}`;
      banner.title = title;
      banner.setAttribute('aria-label', title);
    }
  }

  function markRegistrationSlotOccupancy(dateISO, slot, schedule) {
    const statuses = getSlotOccupancy(dateISO, slot, schedule);
    if (!statuses.classes.length && !statuses.busyBlocks.length && !statuses.services.length && !statuses.afis.length) return;

    const containers = getRegistrationSlotContainers(dateISO, slot.start);
    const serviceContainers = new Set(getRegistrationSlotContainers(dateISO, slot.start, { includeFullCells: false }));
    containers.forEach((container) => {
      if (statuses.classes.length) container.classList.add('rb-after-class-university-cell');
      if (statuses.busyBlocks.length) container.classList.add('rb-after-class-busy-cell');
      if (statuses.services.length && serviceContainers.has(container)) container.classList.add('rb-after-class-service-cell');
      if (statuses.afis.length) container.classList.add('rb-after-class-afi-cell');
      if (statuses.registeredAfis.length) container.classList.add('rb-after-class-afi-registered-cell');
      addRegistrationOccupancyBadges(container, serviceContainers.has(container)
        ? statuses
        : { ...statuses, services: [] });
    });
  }

  function markRegistrationMonthOccupancy(schedule) {
    document.querySelectorAll('#content .mday[data-goto]').forEach((dayButton) => {
      const dateISO = dayButton.dataset.goto;
      if (!isISODate(dateISO)) return;
      const statuses = MODULE_SLOTS.reduce((result, slot) => {
        const next = getSlotOccupancy(dateISO, slot, schedule);
        result.classes.push(...next.classes);
        result.busyBlocks.push(...next.busyBlocks);
        result.services.push(...next.services);
        result.afis.push(...next.afis);
        result.registeredAfis.push(...next.registeredAfis);
        return result;
      }, { classes: [], busyBlocks: [], services: [], afis: [], registeredAfis: [] });
      statuses.classes = [...new Map(statuses.classes.map((entry) => [`${entry.start}-${entry.end}-${entry.name}`, entry])).values()];
      statuses.busyBlocks = [...new Map(statuses.busyBlocks.map((entry) => [`${entry.mode}-${entry.date || entry.weekday}-${entry.start}`, entry])).values()];
      statuses.services = [...new Map(statuses.services.map((entry) => [entry.key, entry])).values()];
      statuses.afis = [...new Map(statuses.afis.map((event) => [event.id, event])).values()];
      statuses.registeredAfis = [...new Map(statuses.registeredAfis.map((event) => [event.id, event])).values()];
      if (!statuses.classes.length && !statuses.busyBlocks.length && !statuses.services.length && !statuses.afis.length) return;

      if (statuses.classes.length) dayButton.classList.add('rb-after-class-university-day');
      if (statuses.busyBlocks.length) dayButton.classList.add('rb-after-class-busy-day');
      if (statuses.services.length) dayButton.classList.add('rb-after-class-service-day');
      if (statuses.afis.length) dayButton.classList.add('rb-after-class-afi-day');
      if (statuses.registeredAfis.length) dayButton.classList.add('rb-after-class-afi-registered-day');

      const labels = [];
      if (statuses.classes.length) labels.push('Clases de universidad');
      if (statuses.busyBlocks.length) labels.push('No disponible');
      if (statuses.services.length && !dayButton.querySelector('.rb-after-class-owned-badge')) labels.push('Servicio becario');
      if (statuses.afis.length) {
        const registeredCount = statuses.registeredAfis.length;
        const observedCount = statuses.afis.length - registeredCount;
        if (observedCount) labels.push(`${observedCount} AFI${observedCount === 1 ? '' : 's'}`);
        if (registeredCount) labels.push(`${registeredCount} AFI inscrito${registeredCount === 1 ? '' : 's'}`);
      }
      if (!labels.length) return;
      if (!('rbOccupancyTitle' in dayButton.dataset)) {
        dayButton.dataset.rbOccupancyTitle = dayButton.getAttribute('title') || '';
      }
      dayButton.title = labels.join(' · ');

      const badge = document.createElement('span');
      badge.className = `rb-after-class-occupancy-day-badge${statuses.registeredAfis.length ? ' rb-after-class-occupancy-day-badge-registered' : ''}`;
      badge.textContent = labels.join(' · ');
      dayButton.append(badge);
    });
  }

  function clearMarks() {
    document.querySelectorAll('.rb-after-class-cell').forEach((element) => {
      element.classList.remove('rb-after-class-cell');
    });
    document.querySelectorAll('.rb-after-class-badge').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-occupancy-badges').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-university-cell, .rb-after-class-busy-cell, .rb-after-class-service-cell, .rb-after-class-afi-cell, .rb-after-class-afi-registered-cell').forEach((element) => {
      element.classList.remove('rb-after-class-university-cell', 'rb-after-class-busy-cell', 'rb-after-class-service-cell', 'rb-after-class-afi-cell', 'rb-after-class-afi-registered-cell');
      if (element.dataset.rbOccupancyTitle !== undefined) {
        element.setAttribute('title', element.dataset.rbOccupancyTitle);
        delete element.dataset.rbOccupancyTitle;
      } else {
        element.removeAttribute('title');
      }
    });
    document.querySelectorAll('.rb-after-class-university-day, .rb-after-class-busy-day, .rb-after-class-service-day, .rb-after-class-afi-day, .rb-after-class-afi-registered-day').forEach((element) => {
      element.classList.remove('rb-after-class-university-day', 'rb-after-class-busy-day', 'rb-after-class-service-day', 'rb-after-class-afi-day', 'rb-after-class-afi-registered-day');
      if (element.dataset.rbOccupancyTitle !== undefined) {
        element.setAttribute('title', element.dataset.rbOccupancyTitle);
        delete element.dataset.rbOccupancyTitle;
      } else {
        element.removeAttribute('title');
      }
    });
    document.querySelectorAll('.rb-after-class-occupancy-day-badge').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-afi-day-badge, .rb-after-class-afi-banner').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-afi-column, .rb-after-class-afi-registered-column').forEach((element) => {
      element.classList.remove('rb-after-class-afi-column', 'rb-after-class-afi-registered-column');
    });
    document.querySelectorAll('#content.rb-after-class-afi-day-view').forEach((element) => {
      element.classList.remove('rb-after-class-afi-day-view');
    });
    document.querySelectorAll('[data-rb-afi-original-title]').forEach((element) => {
      const originalTitle = element.dataset.rbAfiOriginalTitle || '';
      if (originalTitle) element.setAttribute('title', originalTitle);
      else element.removeAttribute('title');
      delete element.dataset.rbAfiOriginalTitle;
    });
    document.querySelectorAll('.rb-after-class-owned-day').forEach((element) => {
      element.classList.remove('rb-after-class-owned-day');
      if (element.dataset.rbOwnedTitle) {
        element.setAttribute('title', element.dataset.rbOwnedTitle);
        delete element.dataset.rbOwnedTitle;
      } else {
        element.removeAttribute('title');
      }
    });
    document.querySelectorAll('.rb-after-class-owned-badge').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-invalid-column').forEach((element) => {
      element.classList.remove('rb-after-class-invalid-column');
    });
    document.querySelectorAll('.rb-after-class-invalid-cell').forEach((element) => {
      element.classList.remove('rb-after-class-invalid-cell');
      if (element.dataset.rbInvalidTitle) {
        element.setAttribute('title', element.dataset.rbInvalidTitle);
        delete element.dataset.rbInvalidTitle;
      } else {
        element.removeAttribute('title');
      }
    });
    document.querySelectorAll('.rb-after-class-invalid-badge').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-calendar-blocked-column').forEach((element) => {
      element.classList.remove('rb-after-class-calendar-blocked-column');
    });
    document.querySelectorAll('.rb-after-class-calendar-blocked-day').forEach((element) => {
      element.classList.remove('rb-after-class-calendar-blocked-day');
    });
    document.querySelectorAll('.rb-after-class-calendar-blocked-badge').forEach((element) => element.remove());
    document.querySelectorAll('.rb-after-class-calendar-blocked-banner').forEach((element) => element.remove());
    document.querySelectorAll('#content.rb-after-class-calendar-blocked-day-view').forEach((element) => {
      element.classList.remove('rb-after-class-calendar-blocked-day-view');
    });
  }

  function markOwnedMonthDays() {
    const timesByDate = new Map();
    getKnownOfficialShifts().forEach((record) => {
      const { dateISO, start, end } = record;
      const times = timesByDate.get(dateISO) || [];
      times.push(`${start}–${end}`);
      timesByDate.set(dateISO, times);
    });

    document.querySelectorAll('#content .mday[data-goto]').forEach((dayButton) => {
      const dateISO = dayButton.dataset.goto;
      const times = timesByDate.get(dateISO);
      if (!times?.length) return;
      const timeText = [...new Set(times)].join(' / ');

      dayButton.classList.add('rb-after-class-owned-day');
      dayButton.dataset.rbOwnedTitle = dayButton.getAttribute('title') || '';
      dayButton.title = `Tienes un turno de servicio becario: ${timeText}`;

      const badge = document.createElement('span');
      badge.className = 'rb-after-class-owned-badge';
      badge.textContent = `✓ Mi turno: ${timeText}`;
      dayButton.append(badge);
    });
  }

  function getWeekColumnIndex(table, dateISO, period) {
    const dateIndex = period?.dates?.findIndex((date) => iso(date) === dateISO) ?? -1;
    if (dateIndex >= 0) return dateIndex + 1;

    const source = [...table.querySelectorAll('[data-date], [data-goto]')].find((element) => (
      element.dataset.date === dateISO || element.dataset.goto === dateISO
    ));
    const sourceCell = source?.closest('th, td');
    if (sourceCell?.parentElement) return [...sourceCell.parentElement.children].indexOf(sourceCell);

    return -1;
  }

  function getWeekCellsAtColumn(table, columnIndex) {
    const occupied = [];
    [...table.rows].forEach((row, rowIndex) => {
      const rowMap = occupied[rowIndex] || [];
      let logicalIndex = 0;
      [...row.cells].forEach((cell) => {
        while (rowMap[logicalIndex]) logicalIndex += 1;
        const columnSpan = Math.max(cell.colSpan || 1, 1);
        const rowSpan = Math.max(cell.rowSpan || 1, 1);
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
          const targetRow = occupied[rowIndex + rowOffset] || [];
          for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
            targetRow[logicalIndex + columnOffset] = cell;
          }
          occupied[rowIndex + rowOffset] = targetRow;
        }
        logicalIndex += columnSpan;
      });
    });
    return [...new Set(occupied.map((row) => row?.[columnIndex]).filter(Boolean))];
  }

  function addCalendarBlockedBadge(container, text) {
    let badge = container.querySelector(':scope > .rb-after-class-calendar-blocked-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'rb-after-class-calendar-blocked-badge';
      container.append(badge);
    }
    badge.textContent = `⚠ ${text}`;
  }

  function markCalendarBlockedView(view, period) {
    if (view === 'month') {
      document.querySelectorAll('#content .mday[data-goto]').forEach((dayButton) => {
        const reason = getCalendarBlockReason(dayButton.dataset.goto);
        if (!reason) return;
        dayButton.classList.add('rb-after-class-calendar-blocked-day');
        addCalendarBlockedBadge(dayButton, reason);
      });
      return;
    }

    const blockedDates = (period?.dates || [])
      .map((date) => ({ dateISO: iso(date), reason: getCalendarBlockReason(date) }))
      .filter((entry) => entry.reason);
    if (!blockedDates.length) return;

    if (view === 'week') {
      const table = document.querySelector('#content table.week');
      if (!table) return;
      blockedDates.forEach(({ dateISO, reason }) => {
        const columnIndex = getWeekColumnIndex(table, dateISO, period);
        if (columnIndex < 0) return;
        getWeekCellsAtColumn(table, columnIndex).forEach((cell) => {
          cell.classList.add('rb-after-class-calendar-blocked-column');
        });
        const header = table.querySelector('thead tr')?.children[columnIndex];
        if (header) addCalendarBlockedBadge(header, reason);
      });
      return;
    }

    if (view === 'day') {
      const content = document.querySelector('#content');
      const reason = blockedDates[0]?.reason;
      if (!content || !reason) return;
      content.classList.add('rb-after-class-calendar-blocked-day-view');
      const banner = document.createElement('div');
      banner.className = 'rb-after-class-calendar-blocked-banner';
      banner.textContent = `⚠ ${reason}`;
      content.prepend(banner);
    }
  }

  function findCurrentOwnedShiftElement(record) {
    return [...document.querySelectorAll('#content [data-rm][data-date][data-slot]')].find((element) => (
      element.dataset.date === record.dateISO && element.dataset.slot === record.start
    ));
  }

  function markInvalidOwnedShifts() {
    const view = getView();
    if (view !== 'week' && view !== 'day') return;

    officialShiftState.invalid.forEach((record) => {
      const element = findCurrentOwnedShiftElement(record);
      const cell = element?.closest('td, .day-block');
      if (!cell) return;

      cell.classList.add('rb-after-class-invalid-cell');
      if (!('rbInvalidTitle' in cell.dataset)) {
        cell.dataset.rbInvalidTitle = cell.getAttribute('title') || '';
        cell.title = `Turno inválido: ${record.reason}`;
      }

      if (view === 'week') {
        const row = cell.parentElement;
        const columnIndex = row ? [...row.children].indexOf(cell) : -1;
        const table = cell.closest('table.week');
        if (table && columnIndex >= 0) {
          table.querySelectorAll('tr').forEach((tableRow) => {
            tableRow.children[columnIndex]?.classList.add('rb-after-class-invalid-column');
          });
        }
      }

      let badge = cell.querySelector(':scope > .rb-after-class-invalid-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'rb-after-class-invalid-badge';
        if (cell.matches('.day-block')) {
          const spots = cell.querySelector('.spots');
          cell.insertBefore(badge, spots || null);
        } else {
          cell.prepend(badge);
        }
      }
      badge.textContent = `⚠ ${record.reason}`;
    });
  }

  function markAvailable(button, reason) {
    const container = button.closest('td') || button.closest('.day-block');
    if (!container) return;
    container.classList.add('rb-after-class-cell');
    let badge = container.querySelector(':scope > .rb-after-class-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'rb-after-class-badge';
      if (container.matches('.day-block')) {
        const spots = container.querySelector('.spots');
        container.insertBefore(badge, spots || null);
      } else {
        container.prepend(badge);
      }
    }
    badge.textContent = `Después de ${reason.className || 'clase'} (${reason.after})`;
  }

  function scanCurrentView() {
    if (!bubbleContainer || semesterScanActive || confirmationOpen || isSiteOverlayOpen()) return;
    const view = getView();
    const period = parsePeriodLabel();
    const active = getActiveSchedule();
    const availableButtons = getAvailableButtons();
    const signature = JSON.stringify({
      view,
      period: document.querySelector('#periodLabel')?.textContent || '',
      source: config.source,
      classLines: config.classLines,
      imported: config.importedSchedule?.classes || null,
      busyBlocks: config.customBusyBlocks || [],
      slots: getSlots(view).map((slot) => `${slot.start}-${slot.end}`),
      available: [...availableButtons.keys()].sort(),
      owned: [...officialShiftState.keys].sort(),
      invalid: officialShiftState.invalid.map((record) => record.key).sort(),
      databaseRevision: calendarDatabase?.revision || 0,
      databaseEvents: (calendarDatabase?.soyLeon?.events || []).map((event) => (
        `${event.id}|${event.dateISO}|${event.start}|${event.isAfi ? 1 : 0}|${event.isRegistered ? 1 : 0}|${event.title || ''}`
      )).sort(),
    });

    if (signature === lastSignature) return;
    lastSignature = signature;
    clearMarks();
    if (view === 'month') markOwnedMonthDays();
    markCalendarBlockedView(view, period);
    if (view === 'week' || view === 'day') markInvalidOwnedShifts();
    const visualSchedule = getRegistrationVisualSchedule(active.schedule);
    if (view === 'month') {
      markRegistrationMonthOccupancy(visualSchedule);
      markRegistrationAfiMonthMarkers(period);
    } else if ((view === 'week' || view === 'day') && period?.dates?.length) {
      const slots = getSlots(view);
      period.dates.forEach((date) => {
        const dateISO = iso(date);
        (slots.length ? slots : MODULE_SLOTS).forEach((slot) => {
          markRegistrationSlotOccupancy(dateISO, slot, visualSchedule);
        });
      });
      markRegistrationAfiPeriodMarkers(view, period);
    }

    if (active.errors.length || !period || !view) {
      updateControls();
      return;
    }

    const matches = getMatchesForView(period, active.schedule, availableButtons);
    matches.available.forEach((match) => markAvailable(availableButtons.get(match.key), match));
    updateControls();
  }

  function scheduleViewScan() {
    window.clearTimeout(viewScanTimer);
    viewScanTimer = window.setTimeout(scanCurrentView, VIEW_SCAN_DELAY_MS);
  }

  function observePage() {
    const observer = new MutationObserver(() => {
      scheduleViewScan();
      const siteName = getSiteUserName();
      if (siteName && !lastKnownSiteName) {
        lastKnownSiteName = siteName;
        if (pauseReason === 'name') {
          automationPaused = false;
          pauseReason = '';
          setAutomationStatus('Nombre detectado. Preparando el escaneo del semestre.');
          showToast(`¡Hola ${siteName}! Iniciando escaneo…`, 'success');
        }
        if (!nameScanPending) {
          nameScanPending = true;
          window.setTimeout(() => {
            nameScanPending = false;
            startSemesterScan('name-configured');
          }, 500);
        }
      } else if (siteName) {
        lastKnownSiteName = siteName;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', handleNavigationClick, true);
    window.addEventListener('hashchange', handleHistoryNavigation);
    window.addEventListener('popstate', handleHistoryNavigation);
    window.setInterval(() => {
      if (!semesterScanActive && !confirmationOpen && !candidateQueue.length) scheduleViewScan();
    }, 3000);
    semesterScanTimer = window.setInterval(() => startSemesterScan('periodic'), SCAN_INTERVAL_MS);
  }

  function handleNavigationClick(event) {
    if (!semesterScanActive || internalNavigation) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const navigation = target.closest('#prevBtn, #nextBtn, #todayBtn, #vDay, #vWeek, #vMonth, #content [data-goto]');
    if (!navigation) return;
    scanAbortRequested = true;
    scanAbortMessage = 'Detecté navegación manual; el escaneo se pausó y se restaurará la vista inicial.';
  }

  function handleHistoryNavigation() {
    if (!semesterScanActive || internalNavigation) return;
    scanAbortRequested = true;
    scanAbortMessage = 'Detecté navegación manual; el escaneo se pausó y se restaurará la vista inicial.';
  }

  function createBubbleMenu() {
    if (document.querySelector('#rb-bubble-menu-root')) return;
    if (!document.body && !document.documentElement) return;

    injectStyles();

    bubbleContainer = document.createElement('div');
    bubbleContainer.id = 'rb-bubble-menu-root';
    bubbleContainer.className = 'rb-bubble-container';

    // Lista de Píldoras Rápidas (Speed-Dial Pills)
    const pillList = document.createElement('div');
    pillList.className = 'rb-bubble-pill-list';

    // Píldora 1: Estado / Resumen con Dot
    const pillStatus = document.createElement('div');
    pillStatus.className = 'rb-bubble-pill rb-pill-status';
    pillStatusDot = document.createElement('span');
    pillStatusDot.id = 'rb-pill-dot';
    pillStatusDot.className = 'rb-pill-dot';
    pillStatusText = document.createElement('span');
    pillStatusText.id = 'rb-pill-status-text';
    pillStatusText.textContent = 'Listo para escanear el semestre.';
    pillStatus.appendChild(pillStatusDot);
    pillStatus.appendChild(pillStatusText);

    const pillLegend = document.createElement('div');
    pillLegend.className = 'rb-bubble-legend';
    pillLegend.setAttribute('aria-label', 'Leyenda de ocupación');
    pillLegend.innerHTML = `
      <span class="rb-bubble-legend-item rb-bubble-legend-university">Clase</span>
      <span class="rb-bubble-legend-item rb-bubble-legend-busy">No disponible</span>
      <span class="rb-bubble-legend-item rb-bubble-legend-service">Servicio</span>
      <span class="rb-bubble-legend-item rb-bubble-legend-afi">AFI</span>
      <span class="rb-bubble-legend-item rb-bubble-legend-afi-registered">AFI inscrito</span>
    `;

    // Píldora 2: Escanear ahora (Acción primaria)
    pillScanBtn = document.createElement('button');
    pillScanBtn.type = 'button';
    pillScanBtn.className = 'rb-bubble-pill rb-pill-action rb-pill-primary';
    pillScanBtn.innerHTML = `<span>⚡</span> <span id="rb-pill-scan-text">Escanear ahora</span>`;
    pillScanText = pillScanBtn.querySelector('#rb-pill-scan-text');
    pillScanBtn.addEventListener('click', () => {
      toggleBubbleMenu(false);
      if (automationPaused) {
        automationPaused = false;
        pauseReason = '';
      }
      startSemesterScan('manual');
    });

    // Píldora 3: Pausar / Reanudar escaneo
    pillPauseBtn = document.createElement('button');
    pillPauseBtn.type = 'button';
    pillPauseBtn.className = 'rb-bubble-pill rb-pill-action';
    pillPauseBtn.innerHTML = `<span id="rb-pill-pause-icon">⏸️</span> <span id="rb-pill-pause-text">Pausar escaneo</span>`;
    pillPauseText = pillPauseBtn.querySelector('#rb-pill-pause-text');
    pillPauseBtn.addEventListener('click', () => {
      toggleBubbleMenu(false);
      togglePause();
    });

    // Píldora 4: Exportar Google Calendar
    pillGcalBtn = document.createElement('button');
    pillGcalBtn.type = 'button';
    pillGcalBtn.className = 'rb-bubble-pill rb-pill-action';
    pillGcalBtn.innerHTML = `<span>📅</span> <span id="rb-pill-gcal-text">Exportar clases, turnos y AFIs</span>`;
    pillGcalText = pillGcalBtn.querySelector('#rb-pill-gcal-text');
    pillGcalBtn.addEventListener('click', () => {
      toggleBubbleMenu(false);
      exportToGoogleCalendar();
    });

    // Píldora 5: Ajustes ⚙
    const pillSettingsBtn = document.createElement('button');
    pillSettingsBtn.type = 'button';
    pillSettingsBtn.className = 'rb-bubble-pill rb-pill-action';
    pillSettingsBtn.innerHTML = `<span>⚙️</span> <span>Ajustes</span>`;
    pillSettingsBtn.addEventListener('click', () => {
      toggleBubbleMenu(false);
      openSettings();
    });

    pillList.appendChild(pillStatus);
    pillList.appendChild(pillLegend);
    pillList.appendChild(pillScanBtn);
    pillList.appendChild(pillPauseBtn);
    pillList.appendChild(pillGcalBtn);
    pillList.appendChild(pillSettingsBtn);

    // Botón Gatillo Flotante (Bubble Trigger)
    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.id = 'rb-bubble-trigger';
    triggerBtn.className = 'rb-bubble-trigger';
    triggerBtn.title = 'Servicio Becario · Menú';
    triggerBtn.setAttribute('aria-label', 'Alternar menú de turnos');
    triggerBtn.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="16" y1="2" x2="16" y2="6"></line>
        <line x1="8" y1="2" x2="8" y2="6"></line>
        <line x1="3" y1="10" x2="21" y2="10"></line>
        <path d="M9 16l2 2 4-4"></path>
      </svg>
    `;

    triggerBadge = document.createElement('span');
    triggerBadge.id = 'rb-trigger-badge';
    triggerBadge.className = 'rb-trigger-badge';
    triggerBadge.textContent = '0';
    triggerBtn.appendChild(triggerBadge);

    triggerBtn.addEventListener('click', () => {
      toggleBubbleMenu(!isMenuOpen);
    });

    bubbleContainer.appendChild(pillList);
    bubbleContainer.appendChild(triggerBtn);
    (document.body || document.documentElement).appendChild(bubbleContainer);

    // Elemento Toast Flotante
    toastElement = document.createElement('div');
    toastElement.id = 'rb-bubble-toast';
    toastElement.className = 'rb-bubble-toast';
    (document.body || document.documentElement).appendChild(toastElement);

    // Cerrar menú al hacer clic fuera
    document.addEventListener('click', (event) => {
      if (isMenuOpen && !bubbleContainer.contains(event.target) && !document.querySelector('#rb-after-class-dialog')?.contains(event.target)) {
        toggleBubbleMenu(false);
      }
    });

    updateControls();
  }

  function toggleBubbleMenu(open) {
    isMenuOpen = open;
    if (bubbleContainer) {
      bubbleContainer.classList.toggle('rb-menu-open', open);
    }
  }

  function showToast(message, type = 'info', duration = 3500) {
    if (!toastElement) return;
    window.clearTimeout(toastTimeout);
    toastElement.textContent = message;
    toastElement.className = `rb-bubble-toast visible ${type}`;
    toastTimeout = window.setTimeout(() => {
      if (toastElement) toastElement.className = 'rb-bubble-toast';
    }, duration);
  }

  function updateControls() {
    if (!pillScanBtn || !pillPauseBtn || !pillGcalBtn || !triggerBadge) return;
    const siteBusy = semesterScanActive || confirmationOpen || isSiteOverlayOpen();
    pillScanBtn.disabled = siteBusy || googleSyncActive;
    if (pillScanText) pillScanText.textContent = 'Escanear ahora';
    pillPauseBtn.disabled = googleSyncActive;
    if (pillPauseText) pillPauseText.textContent = automationPaused ? 'Reanudar escaneo' : 'Pausar escaneo';
    const pauseIcon = pillPauseBtn.querySelector('#rb-pill-pause-icon');
    if (pauseIcon) pauseIcon.textContent = automationPaused ? '▶️' : '⏸️';
    pillGcalBtn.disabled = siteBusy || googleSyncActive;
    if (pillGcalText) pillGcalText.textContent = googleSyncActive ? 'Sincronizando…' : 'Exportar clases, turnos y AFIs';

    // Actualización de Badge en Gatillo
    if (invalidShiftQueue.length > 0) {
      triggerBadge.textContent = String(invalidShiftQueue.length);
      triggerBadge.className = 'rb-trigger-badge visible danger';
      triggerBadge.title = `${invalidShiftQueue.length} turnos inválidos por revisar`;
    } else if (candidateQueue.length > 0) {
      triggerBadge.textContent = String(candidateQueue.length);
      triggerBadge.className = 'rb-trigger-badge visible';
      triggerBadge.title = `${candidateQueue.length} propuestas disponibles`;
    } else {
      triggerBadge.className = 'rb-trigger-badge';
    }

    // Actualización de Dot en Píldora de Estado
    if (pillStatusDot) {
      pillStatusDot.className = 'rb-pill-dot'
        + (invalidShiftQueue.length > 0 ? ' danger' : '')
        + (semesterScanActive || googleSyncActive ? ' warning' : '')
        + (officialShiftState.count >= getMaxRegisters() ? ' active' : '')
        + (automationPaused ? ' danger' : '');
    }
  }

  function setAutomationStatus(message, isError = false) {
    if (pillStatusText) pillStatusText.textContent = message || '';
    if (isError) {
      showToast(message, 'error', 4500);
    }
    updateControls();
  }

  function openSettings() {
    document.querySelector('#rb-after-class-dialog')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rb-after-class-dialog';
    overlay.innerHTML = `
      <div class="rb-after-class-modal" role="dialog" aria-modal="true" aria-labelledby="rb-after-class-title">
        <div class="rb-after-class-modal-header">
          <h2 id="rb-after-class-title">Configurar mis clases</h2>
          <button type="button" class="rb-after-class-close" aria-label="Cerrar">×</button>
        </div>
        <p>El horario importado usa el contrato de <code>horario.py</code>. La regla automática exige que el turno empiece exactamente cuando termina una clase.</p>
        <div class="rb-after-class-import-box">
          <strong>Importar JSON</strong>
          <p class="rb-after-class-example">Se valida antes de reemplazar la configuración activa; un archivo inválido no borra la anterior.</p>
          <input id="rb-after-class-file" type="file" accept="application/json,.json" class="rb-after-class-file">
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-import-trigger">Seleccionar JSON</button>
          <div id="rb-after-class-import-error" class="rb-after-class-error" role="alert"></div>
        </div>
        <label for="rb-after-class-input">Editor manual (fallback)</label>
        <textarea id="rb-after-class-input" rows="9" spellcheck="false" placeholder="Lun 08:30-10:00\nMar 12:00-13:30\nMié 14:00-15:30"></textarea>
        <p class="rb-after-class-example">Ejemplo: <code>Lun 08:30-10:00</code>. También acepta <code>lunes 08:30 a 10:00</code>.</p>
        <label class="rb-after-class-gap" for="rb-after-class-gap-input">Tolerancia guardada para compatibilidad (la automatización exige coincidencia exacta):
          <input id="rb-after-class-gap-input" type="number" min="0" max="180" step="30">
        </label>
        <div class="rb-after-class-import-box">
          <strong>Horas no disponibles (fuera de clases)</strong>
          <p class="rb-after-class-example">Marca los bloques del módulo en los que NO puedes tomar turno por compromisos fuera de la universidad (trabajo, gimnasio, etc.). El turno se propone justo después de que termine el último bloque marcado, igual que tras una clase.</p>
          <div class="rb-after-class-actions">
            <button type="button" class="rb-after-class-secondary" id="rb-after-class-busy-open">Configurar bloques de no disponible</button>
          </div>
        </div>
        <div class="rb-after-class-import-box rb-after-class-google-box">
          <strong>Google Calendar</strong>
          <p class="rb-after-class-example">Activa Google Calendar API y crea un OAuth Client ID de aplicación web. Autoriza como origen <code>https://registrobecariosre.netlify.app</code> y pega aquí solo el Client ID; no uses un Client Secret.</p>
          <label for="rb-after-class-google-client-id">OAuth Client ID</label>
          <input id="rb-after-class-google-client-id" type="text" autocomplete="off" spellcheck="false" placeholder="1234567890-abc.apps.googleusercontent.com">
          <div id="rb-after-class-google-error" class="rb-after-class-error" role="alert"></div>
          <div class="rb-after-class-actions">
            <button type="button" class="rb-after-class-secondary" id="rb-after-class-save-google">Guardar Client ID</button>
          </div>
        </div>
        <div id="rb-after-class-error" class="rb-after-class-error" role="alert"></div>
        <div class="rb-after-class-actions">
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-use-imported">Usar JSON importado</button>
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-cancel">Cerrar</button>
          <button type="button" class="rb-after-class-primary" id="rb-after-class-save">Guardar y usar editor manual</button>
        </div>
      </div>
    `;
    document.body.append(overlay);

    const input = overlay.querySelector('#rb-after-class-input');
    const gap = overlay.querySelector('#rb-after-class-gap-input');
    const error = overlay.querySelector('#rb-after-class-error');
    const googleError = overlay.querySelector('#rb-after-class-google-error');
    const importError = overlay.querySelector('#rb-after-class-import-error');
    const file = overlay.querySelector('#rb-after-class-file');
    const useImported = overlay.querySelector('#rb-after-class-use-imported');
    input.value = config.classLines;
    gap.value = String(config.maxGapMinutes);
    overlay.querySelector('#rb-after-class-google-client-id').value = config.googleCalendar.clientId;
    useImported.disabled = !config.importedSchedule;
    useImported.textContent = config.importedSchedule ? 'Usar JSON importado' : 'No hay JSON importado';

    overlay.querySelector('#rb-after-class-busy-open').addEventListener('click', () => openBusyBlocksDrawer());

    const close = () => overlay.remove();
    overlay.querySelector('.rb-after-class-close').addEventListener('click', close);
    overlay.querySelector('#rb-after-class-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector('#rb-after-class-save').addEventListener('click', () => {
      const parsed = parseSchedule(input.value);
      if (parsed.errors.length) {
        error.textContent = parsed.errors.join(' ');
        return;
      }
      const result = persistConfig({
        ...config,
        source: 'manual',
        classLines: input.value.trim(),
        maxGapMinutes: gap.value,
      });
      if (!result.ok) {
        error.textContent = result.error;
        return;
      }
      close();
      setAutomationStatus('Editor manual guardado.');
    });
    overlay.querySelector('#rb-after-class-save-google').addEventListener('click', () => {
      const clientIdInput = overlay.querySelector('#rb-after-class-google-client-id');
      const validation = validateGoogleClientId(clientIdInput.value);
      if (validation.error) {
        googleError.textContent = validation.error;
        googleError.className = 'rb-after-class-error';
        return;
      }
      const result = persistConfig({
        ...config,
        googleCalendar: {
          ...config.googleCalendar,
          clientId: validation.value,
        },
      });
      if (!result.ok) {
        googleError.textContent = result.error;
        googleError.className = 'rb-after-class-error';
        return;
      }
      googleError.textContent = validation.value
        ? 'Client ID guardado. La autorización se solicitará al exportar.'
        : 'Client ID eliminado.';
      googleError.className = 'rb-after-class-import-ok';
      setAutomationStatus(validation.value
        ? 'Client ID de Google guardado.'
        : 'Client ID de Google eliminado.');
    });
    useImported.addEventListener('click', () => {
      if (!config.importedSchedule) return;
      const result = persistConfig({ ...config, source: 'imported' });
      if (!result.ok) {
        error.textContent = result.error;
        return;
      }
      close();
      setAutomationStatus('JSON importado activado.');
    });
    overlay.querySelector('#rb-after-class-import-trigger').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      importError.textContent = '';
      try {
        const text = await readFileText(selected);
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (_) {
          throw new Error('El archivo no contiene JSON válido.');
        }
        const validation = validateImportedSchedule(raw);
        if (validation.errors.length) throw new Error(validation.errors.join(' '));
        const result = persistConfig({
          ...config,
          source: 'imported',
          importedSchedule: validation.value,
        });
        if (!result.ok) throw new Error(result.error);
        importError.className = 'rb-after-class-import-ok';
        importError.textContent = `JSON importado y activado: ${validation.value.classes.length} clases de ${validation.value.owner}.`;
        useImported.disabled = false;
        useImported.textContent = 'Usar JSON importado';
        setAutomationStatus('JSON importado y validado.');
      } catch (importFailure) {
        importError.className = 'rb-after-class-error';
        importError.textContent = importFailure.message || 'No se pudo importar el JSON.';
      } finally {
        file.value = '';
      }
    });
    input.focus();
  }

  function openBusyBlocksDrawer() {
    document.querySelector('#rb-busy-drawer-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'rb-busy-drawer-overlay';
    overlay.className = 'rb-busy-drawer-overlay';
    overlay.innerHTML = `
      <div class="rb-busy-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="rb-busy-drawer-title">
        <div class="rb-busy-drawer-header">
          <h2 id="rb-busy-drawer-title">Horas no disponibles</h2>
          <button type="button" class="rb-busy-drawer-close" aria-label="Cerrar">×</button>
        </div>
        <div class="rb-busy-drawer-body">
          <div class="rb-busy-mode-toggle" role="group" aria-label="Tipo de bloque">
            <button type="button" id="rb-busy-mode-weekday" aria-pressed="true">Recurrente (cada semana)</button>
            <button type="button" id="rb-busy-mode-date" aria-pressed="false">Fecha específica</button>
          </div>
          <div id="rb-busy-weekday-panel">
            <p class="rb-after-class-example">Haz clic en las celdas para marcar los bloques ocupados cada semana durante todo el semestre.</p>
            <div class="rb-busy-legend" aria-label="Leyenda de bloques">
              <span class="rb-busy-legend-item rb-busy-legend-university">Clase de universidad</span>
              <span class="rb-busy-legend-item rb-busy-legend-busy">No disponible elegido</span>
            </div>
            <div class="rb-busy-week-grid-wrap">
              <table class="rb-busy-week-grid" id="rb-busy-week-table"></table>
            </div>
          </div>
          <div id="rb-busy-date-panel" style="display:none">
            <p class="rb-after-class-example">Marca bloques ocupados solo para una fecha exacta; no se repiten otras semanas.</p>
            <div class="rb-busy-legend" aria-label="Leyenda de bloques">
              <span class="rb-busy-legend-item rb-busy-legend-university">Clase de universidad</span>
              <span class="rb-busy-legend-item rb-busy-legend-busy">No disponible elegido</span>
            </div>
            <label for="rb-busy-date-input">Fecha</label>
            <input type="date" id="rb-busy-date-input">
            <div class="rb-busy-block-grid" id="rb-busy-date-grid"></div>
          </div>
          <label for="rb-busy-label-input">Etiqueta (opcional, se aplica a los bloques nuevos)</label>
          <input type="text" id="rb-busy-label-input" maxlength="60" placeholder="Ej. Trabajo">
          <div id="rb-busy-drawer-error" class="rb-after-class-error" role="alert"></div>
          <p class="rb-after-class-example" style="margin-top:14px"><strong>Bloques configurados</strong></p>
          <div id="rb-busy-drawer-list" class="rb-busy-summary"></div>
        </div>
        <div class="rb-busy-drawer-footer">
          <button type="button" class="rb-after-class-primary" id="rb-busy-drawer-done">Listo</button>
        </div>
      </div>
    `;
    document.body.append(overlay);

    const weekTableEl = overlay.querySelector('#rb-busy-week-table');
    const dateInput = overlay.querySelector('#rb-busy-date-input');
    const dateGridEl = overlay.querySelector('#rb-busy-date-grid');
    const labelInput = overlay.querySelector('#rb-busy-label-input');
    const errorEl = overlay.querySelector('#rb-busy-drawer-error');
    const listEl = overlay.querySelector('#rb-busy-drawer-list');
    const modeWeekdayBtn = overlay.querySelector('#rb-busy-mode-weekday');
    const modeDateBtn = overlay.querySelector('#rb-busy-mode-date');
    const weekdayPanel = overlay.querySelector('#rb-busy-weekday-panel');
    const datePanel = overlay.querySelector('#rb-busy-date-panel');

    const sem = getActiveSemester();
    dateInput.min = sem.start;
    dateInput.max = sem.end;

    const DAY_LABELS_SHORT = { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie' };
    const DAY_LABELS_LONG = { 1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes' };
    const visualSchedule = getRegistrationVisualSchedule(getActiveSchedule().schedule);

    function renderWeekGrid() {
      const blocks = config.customBusyBlocks || [];
      const days = [1, 2, 3, 4, 5];
      let html = `<thead><tr><th>Hora</th>${days.map((d) => `<th>${DAY_LABELS_SHORT[d]}</th>`).join('')}</tr></thead><tbody>`;
      MODULE_SLOTS.forEach((slot) => {
        html += `<tr><th>${slot.start}</th>`;
        days.forEach((weekday) => {
          const active = blocks.some((block) => block.mode === 'weekday' && block.weekday === weekday && block.start === slot.start);
          const university = isUniversityClassSlot(visualSchedule, weekday, slot.start);
          const classes = ['rb-busy-cell'];
          if (university) classes.push('university');
          if (active) classes.push('active');
          const status = university && active
            ? 'Clase de universidad + no disponible elegido'
            : (university ? 'Clase de universidad' : (active ? 'No disponible elegido' : 'Disponible'));
          html += `<td><button type="button" class="${classes.join(' ')}" data-weekday="${weekday}" data-start="${slot.start}" aria-pressed="${active}" title="${DAY_LABELS_SHORT[weekday]} ${slot.start}–${slot.end}: ${status}"></button></td>`;
        });
        html += '</tr>';
      });
      html += '</tbody>';
      weekTableEl.innerHTML = html;
    }

    function renderDateGrid() {
      const dateISO = dateInput.value;
      if (!isISODate(dateISO)) {
        dateGridEl.innerHTML = '<p class="rb-after-class-example">Elige una fecha.</p>';
        return;
      }
      const weekday = fromISO(dateISO).getDay();
      if (weekday < 1 || weekday > 5) {
        dateGridEl.innerHTML = '<p class="rb-after-class-example">Elige un día de lunes a viernes.</p>';
        return;
      }
      const blocks = config.customBusyBlocks || [];
      dateGridEl.innerHTML = MODULE_SLOTS.map((slot) => {
        const active = blocks.some((block) => block.mode === 'date' && block.date === dateISO && block.start === slot.start);
        const university = isUniversityClassSlot(visualSchedule, weekday, slot.start);
        const classes = ['rb-busy-date-option'];
        if (university) classes.push('university');
        if (active) classes.push('active');
        return `<label class="${classes.join(' ')}"><input type="checkbox" data-date-slot="${slot.start}" ${active ? 'checked' : ''}> ${slot.start}–${slot.end}${university ? ' · Clase' : ''}</label>`;
      }).join('');
    }

    function renderList() {
      const blocks = [...(config.customBusyBlocks || [])].sort((a, b) => {
        if (a.mode !== b.mode) return a.mode === 'date' ? -1 : 1;
        if (a.mode === 'date') return a.date.localeCompare(b.date) || a.start.localeCompare(b.start);
        return a.weekday - b.weekday || a.start.localeCompare(b.start);
      });
      if (!blocks.length) {
        listEl.innerHTML = '<p class="rb-after-class-example">Sin bloques marcados todavía.</p>';
        return;
      }
      listEl.innerHTML = blocks.map((block) => {
        const end = MODULE_END_BY_START.get(block.start) || '';
        const labelText = block.label ? ` · ${escapeHTML(block.label)}` : '';
        const when = block.mode === 'date'
          ? escapeHTML(formatDateLong(block.date))
          : `Todos los ${DAY_LABELS_LONG[block.weekday]}`;
        const removeKey = block.mode === 'date' ? `date:${block.date}` : `weekday:${block.weekday}`;
        return `<span class="chip">${when} ${block.start}–${end}${labelText} <button type="button" data-busy-rm="${removeKey}|${block.start}" aria-label="Quitar bloque">✕</button></span>`;
      }).join('');
    }

    function refreshAll() {
      renderWeekGrid();
      renderDateGrid();
      renderList();
    }
    refreshAll();

    function setBusyMode(mode) {
      modeWeekdayBtn.setAttribute('aria-pressed', String(mode === 'weekday'));
      modeDateBtn.setAttribute('aria-pressed', String(mode === 'date'));
      weekdayPanel.style.display = mode === 'weekday' ? '' : 'none';
      datePanel.style.display = mode === 'date' ? '' : 'none';
    }
    modeWeekdayBtn.addEventListener('click', () => setBusyMode('weekday'));
    modeDateBtn.addEventListener('click', () => setBusyMode('date'));

    weekTableEl.addEventListener('click', (event) => {
      const cell = event.target.closest('.rb-busy-cell');
      if (!cell) return;
      const weekday = Number(cell.dataset.weekday);
      const start = cell.dataset.start;
      const existing = config.customBusyBlocks || [];
      const already = existing.some((block) => block.mode === 'weekday' && block.weekday === weekday && block.start === start);
      const next = already
        ? existing.filter((block) => !(block.mode === 'weekday' && block.weekday === weekday && block.start === start))
        : [...existing, { mode: 'weekday', weekday, start, label: labelInput.value.trim().slice(0, 60) }];
      const result = persistConfig({ ...config, customBusyBlocks: next });
      if (!result.ok) {
        errorEl.textContent = result.error;
        return;
      }
      errorEl.textContent = '';
      refreshAll();
      setAutomationStatus(already ? 'Bloque de "no disponible" eliminado.' : 'Bloque de "no disponible" agregado.');
    });

    dateInput.addEventListener('change', () => {
      errorEl.textContent = '';
      renderDateGrid();
    });

    dateGridEl.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-date-slot]');
      if (!checkbox) return;
      const dateISO = dateInput.value;
      if (!isISODate(dateISO)) {
        errorEl.textContent = 'Elige una fecha válida.';
        checkbox.checked = !checkbox.checked;
        return;
      }
      const start = checkbox.dataset.dateSlot;
      const existing = config.customBusyBlocks || [];
      const already = existing.some((block) => block.mode === 'date' && block.date === dateISO && block.start === start);
      const next = checkbox.checked
        ? (already ? existing : [...existing, { mode: 'date', date: dateISO, start, label: labelInput.value.trim().slice(0, 60) }])
        : existing.filter((block) => !(block.mode === 'date' && block.date === dateISO && block.start === start));
      const result = persistConfig({ ...config, customBusyBlocks: next });
      if (!result.ok) {
        errorEl.textContent = result.error;
        checkbox.checked = !checkbox.checked;
        return;
      }
      errorEl.textContent = '';
      renderList();
      renderDateGrid();
      setAutomationStatus(checkbox.checked ? 'Bloque de "no disponible" agregado.' : 'Bloque de "no disponible" eliminado.');
    });

    listEl.addEventListener('click', (event) => {
      const removeButton = event.target.closest('[data-busy-rm]');
      if (!removeButton) return;
      const [modeAndKey, start] = removeButton.dataset.busyRm.split('|');
      const [mode, keyValue] = modeAndKey.split(':');
      const next = (config.customBusyBlocks || []).filter((block) => {
        if (block.mode !== mode || block.start !== start) return true;
        return mode === 'date' ? block.date !== keyValue : block.weekday !== Number(keyValue);
      });
      const result = persistConfig({ ...config, customBusyBlocks: next });
      if (!result.ok) {
        errorEl.textContent = result.error;
        return;
      }
      errorEl.textContent = '';
      refreshAll();
      setAutomationStatus('Bloque de "no disponible" eliminado.');
    });

    const closeDrawer = () => {
      overlay.classList.remove('open');
      window.setTimeout(() => overlay.remove(), 220);
    };
    overlay.querySelector('.rb-busy-drawer-close').addEventListener('click', closeDrawer);
    overlay.querySelector('#rb-busy-drawer-done').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDrawer();
    });

    // Forzar reflow para que la transición de entrada se aplique
    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.readAsText(file);
    });
  }

  function validateGoogleClientId(raw) {
    const clientId = String(raw || '').trim();
    if (!clientId) return { value: '', error: '' };
    if (clientId.length > 200 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      return {
        value: '',
        error: 'El Client ID debe terminar en .apps.googleusercontent.com y no puede contener espacios.',
      };
    }
    return { value: clientId, error: '' };
  }

  function resetGoogleAccessToken() {
    googleAccessToken = '';
    googleAccessTokenExpiresAt = 0;
    googleTokenClient = null;
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
  }

  function hasGoogleIdentityServices() {
    return Boolean(getPageWindow().google?.accounts?.oauth2?.initTokenClient);
  }

  function loadGoogleIdentityServices() {
    if (hasGoogleIdentityServices()) return Promise.resolve();
    if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

    googleIdentityScriptPromise = new Promise((resolve, reject) => {
      const script = document.querySelector('script[data-rb-google-identity]') || document.createElement('script');
      let timeoutId = null;
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onLoad = () => {
        if (hasGoogleIdentityServices()) finish();
        else finish(new Error('La biblioteca oficial de Google no expuso el cliente OAuth.'));
      };
      const onError = () => finish(new Error('No se pudo cargar la biblioteca oficial de Google.'));

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      timeoutId = window.setTimeout(() => onError(), GOOGLE_API_TIMEOUT_MS);

      if (!script.parentElement) {
        script.async = true;
        script.defer = true;
        script.src = GOOGLE_IDENTITY_SCRIPT_URL;
        script.dataset.rbGoogleIdentity = '1';
        (document.head || document.documentElement).append(script);
      } else if (hasGoogleIdentityServices()) {
        finish();
      }
    }).catch((error) => {
      googleIdentityScriptPromise = null;
      throw error;
    });

    return googleIdentityScriptPromise;
  }

  function getGoogleAccessToken() {
    const validation = validateGoogleClientId(config.googleCalendar.clientId);
    if (validation.error || !validation.value) {
      const error = new Error(validation.error || 'Configura el Client ID de Google desde ⚙ antes de exportar.');
      error.code = 'GOOGLE_CLIENT_ID_MISSING';
      throw error;
    }
    if (googleAccessToken && Date.now() + 60000 < googleAccessTokenExpiresAt) {
      return Promise.resolve(googleAccessToken);
    }

    return loadGoogleIdentityServices().then(() => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message, code = 'GOOGLE_AUTH_FAILED') => {
        if (settled) return;
        settled = true;
        const error = new Error(message);
        error.code = code;
        reject(error);
      };

      try {
        googleTokenClient = getPageWindow().google.accounts.oauth2.initTokenClient({
          client_id: validation.value,
          scope: GOOGLE_CALENDAR_SCOPE,
          callback: (response) => {
            if (settled) return;
            if (!response || response.error || !response.access_token) {
              fail(response?.error === 'access_denied'
                ? 'Se rechazó el permiso de Google Calendar.'
                : 'Google no devolvió una autorización válida.');
              return;
            }
            settled = true;
            googleAccessToken = response.access_token;
            const expiresIn = Number(response.expires_in);
            const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 60
              ? expiresIn - 60
              : 300;
            googleAccessTokenExpiresAt = Date.now() + lifetimeSeconds * 1000;
            resolve(googleAccessToken);
          },
          error_callback: (error) => {
            const type = String(error?.type || '');
            fail(type === 'popup_failed_to_open'
              ? 'El navegador bloqueó la ventana de Google; permite ventanas emergentes y vuelve a intentarlo.'
              : 'No se pudo completar la autorización de Google.');
          },
        });
        googleTokenClient.requestAccessToken({ prompt: '' });
      } catch (_) {
        fail('No se pudo iniciar la autorización de Google.');
      }
    }));
  }

  async function googleApiRequest(path, options = {}, accessToken) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), GOOGLE_API_TIMEOUT_MS);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
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

    let response;
    let raw = '';
    try {
      response = await fetch(`${GOOGLE_CALENDAR_API_BASE}${path}`, request);
      raw = await response.text();
    } catch (failure) {
      const error = new Error(failure?.name === 'AbortError'
        ? 'Google Calendar tardó demasiado en responder.'
        : 'No se pudo conectar con Google Calendar.');
      error.code = failure?.name === 'AbortError' ? 'GOOGLE_TIMEOUT' : 'GOOGLE_NETWORK';
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }

    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        payload = null;
      }
    }
    if (!response.ok) {
      const error = new Error(response.status === 401
        ? 'La autorización de Google expiró; vuelve a pulsar Exportar.'
        : response.status === 403
          ? 'Google no autorizó cambios en el calendario principal.'
          : response.status === 429
            ? 'Google limitó temporalmente las solicitudes; espera un momento y reintenta.'
            : payload?.error?.message || `Google Calendar respondió con HTTP ${response.status}.`);
      error.code = response.status === 401 ? 'GOOGLE_AUTH_EXPIRED' : 'GOOGLE_API_ERROR';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function googleEventsPath(suffix = '') {
    const calendarId = encodeURIComponent(config.googleCalendar.calendarId || GOOGLE_CALENDAR_ID);
    return `/calendars/${calendarId}/events${suffix}`;
  }

  async function listManagedGoogleEvents(accessToken) {
    const events = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams();
      params.append('privateExtendedProperty', `${GOOGLE_MANAGED_PROPERTY}=1`);
      params.append('privateExtendedProperty', `${GOOGLE_SEMESTER_PROPERTY}=${getGoogleSemesterKey()}`);
      params.set('maxResults', '2500');
      params.set('showDeleted', 'false');
      if (pageToken) params.set('pageToken', pageToken);
      const payload = await googleApiRequest(googleEventsPath(`?${params.toString()}`), {}, accessToken);
      if (!payload || !Array.isArray(payload.items)) {
        const error = new Error('Google devolvió una lista de eventos inválida.');
        error.code = 'GOOGLE_INVALID_RESPONSE';
        throw error;
      }
      events.push(...payload.items.filter((event) => event && event.id));
      pageToken = String(payload.nextPageToken || '');
    } while (pageToken);
    return events;
  }

  function managedGoogleProperties(event) {
    return {
      ...(event?.extendedProperties?.private || {}),
      [GOOGLE_MANAGED_PROPERTY]: '1',
      [GOOGLE_SEMESTER_PROPERTY]: getGoogleSemesterKey(),
      [GOOGLE_KIND_PROPERTY]: event.kind,
      [GOOGLE_KEY_PROPERTY]: event.key,
    };
  }

  function googleDateTime(dateISO, time) {
    return `${dateISO}T${time}:00`;
  }

  function googleEventBody(event, existing = null) {
    return {
      summary: event.summary,
      description: event.description,
      start: {
        dateTime: googleDateTime(event.dateISO, event.start),
        timeZone: EXPECTED_TIMEZONE,
      },
      end: {
        dateTime: googleDateTime(event.dateISO, event.end),
        timeZone: EXPECTED_TIMEZONE,
      },
      reminders: { useDefault: true },
      extendedProperties: { private: managedGoogleProperties({
        ...event,
        extendedProperties: existing?.extendedProperties,
      }) },
    };
  }

  function normalizedGoogleDateTime(value) {
    return String(value || '').slice(0, 16);
  }

  function googleEventNeedsUpdate(existing, event) {
    const expected = googleEventBody(event, existing);
    const currentPrivate = existing?.extendedProperties?.private || {};
    const expectedPrivate = expected.extendedProperties.private;
    const privateMatches = [
      GOOGLE_MANAGED_PROPERTY,
      GOOGLE_SEMESTER_PROPERTY,
      GOOGLE_KIND_PROPERTY,
      GOOGLE_KEY_PROPERTY,
    ].every((key) => currentPrivate[key] === expectedPrivate[key]);
    return existing.summary !== expected.summary
      || existing.description !== expected.description
      || normalizedGoogleDateTime(existing.start?.dateTime) !== normalizedGoogleDateTime(expected.start.dateTime)
      || normalizedGoogleDateTime(existing.end?.dateTime) !== normalizedGoogleDateTime(expected.end.dateTime)
      || existing.start?.timeZone !== expected.start.timeZone
      || existing.end?.timeZone !== expected.end.timeZone
      || !privateMatches;
  }

  function calendarEventKey(event) {
    return String(event?.extendedProperties?.private?.[GOOGLE_KEY_PROPERTY] || '');
  }

  function createCalendarEventDescriptor(kind, dateISO, start, end, summary, description) {
    const key = kind === 'service'
      ? `service|${dateISO}|${start}`
      : `class|${dateISO}|${start}|${end}|${summary}`;
    return { kind, key, dateISO, start, end, summary, description };
  }

  function getClassAfterService(schedule, dateISO, start) {
    const startMin = toMinutes(start);
    const candidates = getClassesForDate(schedule, dateISO)
      .filter((entry) => entry.endMin === startMin)
      .sort((a, b) => a.startMin - b.startMin);
    return candidates.length ? candidates[candidates.length - 1].name : '';
  }

  function buildClassCalendarEvents(schedule) {
    const events = new Map();
    const sem = getActiveSemester();
    for (let date = fromISO(sem.start); iso(date) <= sem.end; date = addDays(date, 1)) {
      const dateISO = iso(date);
      if (getCalendarBlockReason(dateISO)) continue;
      getClassesForDate(schedule, dateISO).forEach((entry) => {
        const event = entry.isBusyBlock
          ? createCalendarEventDescriptor(
            'class',
            dateISO,
            entry.start,
            entry.end,
            `🚫 ${entry.name}`,
            `Bloque personal de "no disponible" configurado en Ajustes.\nFuente: ${GOOGLE_SOURCE_URL}`,
          )
          : createCalendarEventDescriptor(
            'class',
            dateISO,
            entry.start,
            entry.end,
            `📘 Clase · ${entry.name || 'Clase manual'}`,
            `Horario de clase sincronizado por el userscript.\nFuente: ${GOOGLE_SOURCE_URL}`,
          );
        events.set(event.key, event);
      });
    }
    return [...events.values()];
  }

  function buildServiceCalendarEvents(schedule, state) {
    const records = [...state.keys]
      .map((key) => createShiftRecord(key))
      .filter(Boolean)
      .sort(compareShiftRecords);
    const invalid = records.filter((record) => record.reason);
    if (invalid.length) {
      const details = invalid.slice(0, 2)
        .map((record) => `${formatDate(record.dateISO)} ${record.start} (${record.reason})`)
        .join('; ');
      const error = new Error(`Hay ${invalid.length} turno${invalid.length === 1 ? '' : 's'} oficial${invalid.length === 1 ? '' : 'es'} en fecha bloqueada; corrígelos individualmente antes de exportar${details ? `: ${details}` : '.'}`);
      error.code = 'INVALID_OFFICIAL_SHIFT';
      throw error;
    }
    return records.map((record) => {
      const afterClass = getClassAfterService(schedule, record.dateISO, record.start);
      const label = afterClass ? ` · Después de ${afterClass}` : '';
      return createCalendarEventDescriptor(
        'service',
        record.dateISO,
        record.start,
        record.end,
        `🟩 Servicio becario${label}`,
        `Turno oficial de servicio becario (${HOURS_PER_BLOCK} horas).\nFuente: Mis turnos en ${GOOGLE_SOURCE_URL}`,
      );
    });
  }

  function buildRegisteredAfiCalendarEvents(database = calendarDatabase) {
    const semester = getActiveSemester();
    return (Array.isArray(database?.soyLeon?.events) ? database.soyLeon.events : [])
      .map(normalizeDatabaseEvent)
      .filter((event) => event
        && event.isAfi
        && event.isRegistered
        && event.dateISO >= semester.start
        && event.dateISO <= semester.end)
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startMin - b.startMin || a.title.localeCompare(b.title))
      .map((event) => {
        const moduleEnd = MODULE_END_BY_START.get(event.start);
        const end = moduleEnd || clockFromMinutes(event.startMin + SOY_LEON_ESTIMATED_DURATION_MINUTES);
        const durationNote = moduleEnd
          ? `Horario estimado según el bloque ${event.start}–${moduleEnd}.`
          : `Duración estimada de ${SOY_LEON_ESTIMATED_DURATION_MINUTES / 60} horas; Soy León no expuso una hora final confiable.`;
        return {
          kind: 'afi',
          key: `afi|${event.id}`,
          dateISO: event.dateISO,
          start: event.start,
          end,
          summary: `🟣 AFI inscrito · ${event.title}`,
          description: [
            'AFI inscrito desde Soy León.',
            `Lugar: ${event.place || 'Por confirmar'}.`,
            durationNote,
            `Fuente: ${SOY_LEON_EVENTS_URL}`,
          ].join('\n'),
        };
      });
  }

  function buildDesiredCalendarEvents(schedule, state, database = calendarDatabase) {
    const events = [
      ...buildClassCalendarEvents(schedule),
      ...buildServiceCalendarEvents(schedule, state),
      ...buildRegisteredAfiCalendarEvents(database),
    ];
    return [...new Map(events.map((event) => [event.key, event])).values()]
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO)
        || a.start.localeCompare(b.start)
        || a.kind.localeCompare(b.kind)
        || a.key.localeCompare(b.key));
  }

  async function syncGoogleCalendarEvents(desired, accessToken) {
    const existing = (await listManagedGoogleEvents(accessToken))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const byKey = new Map();
    const duplicates = [];
    existing.forEach((event) => {
      const key = calendarEventKey(event);
      if (!key) {
        duplicates.push(event);
      } else if (byKey.has(key)) {
        duplicates.push(event);
      } else {
        byKey.set(key, event);
      }
    });

    const result = { created: 0, updated: 0, unchanged: 0, removed: 0 };
    for (const event of desired) {
      const current = byKey.get(event.key);
      if (!current) {
        await googleApiRequest(
          googleEventsPath('?sendUpdates=none'),
          { method: 'POST', body: googleEventBody(event) },
          accessToken,
        );
        result.created += 1;
      } else if (googleEventNeedsUpdate(current, event)) {
        await googleApiRequest(
          googleEventsPath(`/${encodeURIComponent(current.id)}?sendUpdates=none`),
          { method: 'PATCH', body: googleEventBody(event, current) },
          accessToken,
        );
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
    }

    const desiredKeys = new Set(desired.map((event) => event.key));
    const stale = existing.filter((event) => !desiredKeys.has(calendarEventKey(event)));
    const removals = [...new Map([...stale, ...duplicates].map((event) => [event.id, event])).values()];
    for (const event of removals) {
      await googleApiRequest(
        googleEventsPath(`/${encodeURIComponent(event.id)}?sendUpdates=none`),
        { method: 'DELETE' },
        accessToken,
      );
      result.removed += 1;
    }
    return result;
  }

  async function exportToGoogleCalendar() {
    if (googleSyncActive) return;
    if (semesterScanActive || confirmationOpen || isSiteOverlayOpen()) {
      setAutomationStatus('Espera a que termine el escaneo o cierra el overlay del sitio antes de exportar.', true);
      return;
    }

    const active = getActiveSchedule();
    if (active.errors.length) {
      setAutomationStatus(active.errors[0], true);
      return;
    }
    if (!Object.values(active.schedule).some((classes) => classes.length)) {
      setAutomationStatus('Configura tu horario o importa el JSON antes de exportar.', true);
      return;
    }
    const clientValidation = validateGoogleClientId(config.googleCalendar.clientId);
    if (clientValidation.error || !clientValidation.value) {
      setAutomationStatus(clientValidation.error || 'Configura el Client ID de Google desde ⚙ antes de exportar.', true);
      return;
    }

    googleSyncActive = true;
    updateControls();
    try {
      setAutomationStatus('Solicitando autorización de Google Calendar…');
      const accessToken = await getGoogleAccessToken();
      setAutomationStatus('Sincronizando tus turnos oficiales…');
      const state = await syncOfficialShifts();
      if (state.invalid.length) {
        const error = new Error('Hay turnos oficiales en fechas bloqueadas; corrígelos individualmente antes de exportar.');
        error.code = 'INVALID_OFFICIAL_SHIFT';
        throw error;
      }
      const storedDatabase = normalizeCalendarDatabase(await gmGetValue(CALENDAR_DB_KEY, calendarDatabase));
      if (storedDatabase) calendarDatabase = storedDatabase;
      const desired = buildDesiredCalendarEvents(active.schedule, state, calendarDatabase);
      const registeredAfiCount = desired.filter((event) => event.kind === 'afi').length;
      setAutomationStatus(`Sincronizando ${desired.length} eventos (${registeredAfiCount} AFI${registeredAfiCount === 1 ? '' : 's'} inscritos) con Google Calendar…`);
      const result = await syncGoogleCalendarEvents(desired, accessToken);
      setAutomationStatus(`Google Calendar actualizado: ${result.created} creados, ${result.updated} actualizados, ${result.removed} retirados y ${result.unchanged} sin cambios.`);
    } catch (failure) {
      if (failure?.code === 'GOOGLE_AUTH_EXPIRED') resetGoogleAccessToken();
      setAutomationStatus(failure?.message || 'No se pudo sincronizar Google Calendar.', true);
    } finally {
      googleSyncActive = false;
      updateControls();
      scheduleViewScan();
    }
  }

  function getSiteUserName() {
    const value = document.querySelector('#userName')?.textContent.trim() || '';
    if (!value || normalize(value) === 'identificate') return '';
    return value;
  }

  function isSiteOverlayOpen() {
    return [...document.querySelectorAll('.overlay.show')].some((element) => element.id !== 'rb-after-class-dialog');
  }

  function createShiftRecord(key) {
    const [dateISO, start] = String(key).split('|');
    const end = MODULE_END_BY_START.get(start);
    if (!isISODate(dateISO) || !end) return null;

    let reason = getCalendarBlockReason(dateISO);

    // REGLA 2: Marcar como inválido cualquier turno registrado en horario prohibido desde hoy hasta fin del semestre
    const todayISO = getTodayISO();
    const sem = getActiveSemester();
    if (!reason && dateISO >= todayISO && dateISO <= sem.end) {
      if (isSlotProhibited(dateISO, start)) {
        reason = `horario prohibido: ${formatDateLong(dateISO)} ${start}`;
      }
    }

    // Bloques personalizados de "no disponible": solo se corrigen desde hoy + 8 días en adelante
    // (no se toca lo ya registrado en la próxima semana), a diferencia de las prohibiciones duras.
    const minCandidateISO = getMinCandidateDateISO();
    if (!reason && dateISO >= minCandidateISO && dateISO <= sem.end) {
      if (isCustomBusySlot(dateISO, start)) {
        reason = `no disponible personalizado: ${formatDateLong(dateISO)} ${start}`;
      }
    }

    return {
      key: `${dateISO}|${start}`,
      dateISO,
      start,
      end,
      reason,
    };
  }

  function createShiftState(keys) {
    const uniqueKeys = new Set(keys);
    const byDate = new Map();
    const byWeek = new Map();
    const byWeekDays = new Map(); // Días asistidos por semana para política de balance

    uniqueKeys.forEach((key) => {
      const [dateISO] = key.split('|');
      const weekISO = weekStartForDateISO(dateISO);
      byDate.set(dateISO, (byDate.get(dateISO) || 0) + 1);
      byWeek.set(weekISO, (byWeek.get(weekISO) || 0) + 1);

      if (!byWeekDays.has(weekISO)) byWeekDays.set(weekISO, new Set());
      byWeekDays.get(weekISO).add(dateISO);
    });

    return {
      keys: uniqueKeys,
      count: uniqueKeys.size,
      byDate,
      byWeek,
      byWeekDays,
      invalid: [...uniqueKeys]
        .map(createShiftRecord)
        .filter((record) => record?.reason),
      syncedAt: Date.now(),
    };
  }

  function compareShiftRecords(a, b) {
    return a.dateISO.localeCompare(b.dateISO) || a.start.localeCompare(b.start);
  }

  function setInvalidShiftQueue(records = officialShiftState.invalid || []) {
    const unique = new Map();
    records.forEach((record) => {
      if (!record?.key || !record.reason || invalidShiftDecisions.has(record.key)) return;
      unique.set(record.key, record);
    });
    invalidShiftQueue = [...unique.values()].sort(compareShiftRecords);
    invalidShiftKeys = new Set(invalidShiftQueue.map((record) => record.key));
  }

  function clearInvalidShiftQueue() {
    invalidShiftQueue = [];
    invalidShiftKeys.clear();
  }

  function compareCalendarPositions(a, b) {
    const dateOrder = a.dateISO.localeCompare(b.dateISO);
    if (dateOrder) return dateOrder;
    const aStart = a.slot?.startMin ?? toMinutes(a.start);
    const bStart = b.slot?.startMin ?? toMinutes(b.start);
    return aStart - bStart;
  }

  function replacementKey(candidate, removeRecords) {
    const removeKeys = removeRecords.map((record) => record.key).sort().join(',');
    return `${removeKeys}->${candidate.key}`;
  }

  function canUseReplacement(candidate, removeRecord, state) {
    const maxRegisters = getMaxRegisters();
    if (state.count < maxRegisters) return false;
    if (state.keys.has(candidate.key) || state.byDate.has(candidate.dateISO)) return false;
    if (compareCalendarPositions(candidate, removeRecord) >= 0) return false;

    const afterRemoval = createShiftState([...state.keys].filter((key) => key !== removeRecord.key));
    if (afterRemoval.byDate.has(candidate.dateISO)) return false;

    const weekDaysAfterRemoval = afterRemoval.byWeekDays.get(candidate.weekStartISO);
    if (weekDaysAfterRemoval && [...weekDaysAfterRemoval].some((d) => isAdjacentDay(d, candidate.dateISO))) return false;

    const policy = getWeekPolicy(candidate.weekStartISO, afterRemoval);
    return policy.weekSessions < policy.cap;
  }

  function buildReplacementQueue(candidates, state) {
    const maxRegisters = getMaxRegisters();
    if (state.count < maxRegisters) return [];
    const removable = [...state.keys]
      .map(createShiftRecord)
      .filter((record) => record && !record.reason)
      .sort((a, b) => compareCalendarPositions(b, a));

    // La reubicación siempre swapea 1 turno por 1: los candidatos dobles se reducen a su primera casilla.
    const singleCandidates = candidates.map((candidate) => ({
      ...candidate,
      slot: (candidate.slots || [candidate.slot])[0],
      slots: [(candidate.slots || [candidate.slot])[0]],
      key: (candidate.keys || [candidate.key])[0],
      keys: [(candidate.keys || [candidate.key])[0]],
      isDouble: false,
      durationHours: HOURS_PER_BLOCK,
    }));

    for (const candidate of [...singleCandidates].sort(compareCandidates)) {
      const removeRecord = removable.find((record) => {
        const key = replacementKey(candidate, [record]);
        return !replacementDecisions.has(key) && canUseReplacement(candidate, record, state);
      });
      if (!removeRecord) continue;
      return [{
        ...candidate,
        removeRecords: [removeRecord],
        replacementKey: replacementKey(candidate, [removeRecord]),
      }];
    }
    return [];
  }

  function buildProactiveDoubleSwap(candidates, state) {
    // Si aparece un turno doble (3 h) disponible, se propone sustituir los 2 turnos sencillos
    // ya registrados con fecha más tardía por este doble, sin esperar a llegar al límite del
    // semestre: el total de registros/horas no cambia, solo se adelanta hacia septiembre/octubre.
    const removable = [...state.keys]
      .map(createShiftRecord)
      .filter((record) => record && !record.reason)
      .sort((a, b) => compareCalendarPositions(b, a)); // más tardío primero

    const doubleCandidates = candidates.filter((candidate) => candidate.isDouble && (candidate.slots || []).length === 2);

    for (const candidate of [...doubleCandidates].sort(compareCandidates)) {
      if (state.keys.has(candidate.key) || state.byDate.has(candidate.dateISO)) continue;

      const laterRemovable = removable.filter((record) => compareCalendarPositions(record, candidate) > 0);
      if (laterRemovable.length < 2) continue;
      const removeRecords = laterRemovable.slice(0, 2);
      const key = replacementKey(candidate, removeRecords);
      if (replacementDecisions.has(key)) continue;

      const removeKeySet = new Set(removeRecords.map((record) => record.key));
      const afterRemoval = createShiftState([...state.keys].filter((k) => !removeKeySet.has(k)));
      if (afterRemoval.byDate.has(candidate.dateISO)) continue;

      const weekDaysAfterRemoval = afterRemoval.byWeekDays.get(candidate.weekStartISO);
      if (weekDaysAfterRemoval && [...weekDaysAfterRemoval].some((d) => isAdjacentDay(d, candidate.dateISO))) continue;

      const policy = getWeekPolicy(candidate.weekStartISO, afterRemoval);
      if (policy.weekSessions >= policy.cap) continue;

      return [{
        ...candidate,
        removeRecords,
        replacementKey: key,
        isProactiveSwap: true,
      }];
    }
    return [];
  }

  function setReplacementQueue(replacements) {
    replacementQueue = [...replacements];
  }

  function clearReplacementQueue() {
    replacementQueue = [];
  }

  async function withMyShiftsOverlay(callback) {
    if (!getSiteUserName()) {
      const error = new Error('Configura tu nombre en el sitio: haz clic en «Identifícate» en la parte superior y guarda tu nombre.');
      error.code = 'NAME_NOT_CONFIGURED';
      throw error;
    }
    if (isSiteOverlayOpen() && !ownedMyShiftsOverlay) {
      const error = new Error('Cierra el overlay del sitio para sincronizar Mis turnos.');
      error.code = 'SITE_OVERLAY_OPEN';
      throw error;
    }

    const overlay = document.querySelector('#myShiftsOverlay');
    const body = document.querySelector('#myShiftsBody');
    const button = document.querySelector('#myShiftsBtn');
    if (!overlay || !body || !button) throw new Error('No encontré la interfaz oficial de Mis turnos.');

    let openedByUs = false;
    try {
      if (!overlay.classList.contains('show')) {
        ownedMyShiftsOverlay = true;
        openedByUs = true;
        button.click();
        const shown = await waitForCondition(() => overlay.classList.contains('show'), 5000);
        if (!shown) throw new Error('El sitio no abrió Mis turnos.');
      }

      const loaded = await waitForCondition(() => (
        body.innerHTML.trim()
        && !body.textContent.includes('Cargando tus turnos')
      ), 30000);
      if (!loaded) throw new Error('Mis turnos no terminó de cargar.');

      return await callback(overlay);
    } finally {
      if (openedByUs && overlay.classList.contains('show')) {
        const closeButton = document.querySelector('#myShiftsClose');
        if (closeButton) closeButton.click();
        else overlay.classList.remove('show');
        await waitForCondition(() => !overlay.classList.contains('show'), 3000);
      }
      ownedMyShiftsOverlay = false;
      updateControls();
    }
  }

  async function syncOfficialShifts() {
    const state = await withMyShiftsOverlay(async (overlay) => {
      const keys = [];
      overlay.querySelectorAll('[data-msrm][data-date][data-slot]').forEach((element) => {
        const dateISO = element.dataset.date;
        const start = element.dataset.slot;
        if (!isISODate(dateISO) || !MODULE_END_BY_START.has(start)) return;
        if (!inSemester(fromISO(dateISO))) return;
        keys.push(`${dateISO}|${start}`);
      });
      return createShiftState(keys);
    });
    officialShiftState = state;
    setInvalidShiftQueue(state.invalid);
    try {
      await recordBecarioShifts(state);
    } catch (error) {
      console.warn('[Registro Becario] No se pudo actualizar la base JSON de turnos.', error);
    }
    return state;
  }

  async function recordBecarioShifts(state) {
    const observedAt = Date.now();
    const officialShifts = [...state.keys]
      .map((key) => createShiftRecord(key))
      .filter(Boolean)
      .map((record) => ({
        key: record.key,
        dateISO: record.dateISO,
        start: record.start,
        end: record.end,
        status: record.reason ? 'invalid' : 'active',
        reason: record.reason || '',
        observedAt,
      }));
    const next = await updateCalendarDatabase((database) => ({
      ...database,
      becario: {
        ...database.becario,
        officialShifts,
        lastSeenAt: observedAt,
      },
    }), { source: DATABASE_SOURCE_REGISTRATION });
    calendarDatabase = next;
  }

  function findOfficialShiftElement(overlay, record) {
    return [...overlay.querySelectorAll('[data-msrm][data-date][data-slot]')].find((element) => (
      element.dataset.date === record.dateISO && element.dataset.slot === record.start
    ));
  }

  async function removeOfficialShift(record, confirmationOverlay, messageSelector) {
    if (!getSiteUserName()) {
      const error = new Error('Configura tu nombre en el sitio: haz clic en «Identifícate» arriba y guarda tu nombre.');
      error.code = 'NAME_NOT_CONFIGURED';
      throw error;
    }
    if (isSiteOverlayOpen()) {
      const error = new Error('Cierra el overlay del sitio antes de corregir el turno.');
      error.code = 'SITE_OVERLAY_OPEN';
      throw error;
    }

    await withMyShiftsOverlay(async (officialOverlay) => {
      const removeButton = findOfficialShiftElement(officialOverlay, record);
      if (!removeButton) {
        const error = new Error('El turno ya no aparece en Mis turnos; no se hizo ningún click.');
        error.code = 'RULE_CONFLICT';
        throw error;
      }
      const message = confirmationOverlay.querySelector(messageSelector);
      if (message) message.textContent = 'Registro localizado. Esperando la confirmación oficial…';
      removeButton.click();
      const removed = await waitForCondition(() => !findOfficialShiftElement(officialOverlay, record), 9000);
      if (!removed) {
        const error = new Error('El sitio no confirmó la eliminación del turno; quedó pausado y no se repetirá el click.');
        error.code = 'REMOVE_NOT_VERIFIED';
        throw error;
      }
    });

    officialShiftState = await syncOfficialShifts();
    if (officialShiftState.keys.has(record.key)) {
      const error = new Error('El turno todavía aparece en Mis turnos; no continuaré con otra corrección.');
      error.code = 'REMOVE_NOT_VERIFIED';
      throw error;
    }
  }

  async function cancelInvalidShift(record, confirmationOverlay) {
    await removeOfficialShift(record, confirmationOverlay, '#rb-after-class-invalid-message');
  }

  function getProjectedKeys(state = officialShiftState) {
    const keys = new Set(state.keys);
    sessionDecisions.forEach((decision, key) => {
      if (decision.status === 'confirmed') keys.add(key);
    });
    return keys;
  }

  function getWeekPolicy(weekISO, state = officialShiftState, extraKeys = []) {
    const keys = getProjectedKeys(state);
    extraKeys.forEach((key) => keys.add(key));
    const projected = createShiftState([...keys]);
    let deficitBefore = 0;
    getSemesterWeeks().forEach((candidateWeek) => {
      if (candidateWeek < weekISO) {
        const pastSessions = projected.byWeekDays.get(candidateWeek)?.size || 0;
        deficitBefore += Math.max(0, 2 - pastSessions);
      }
    });
    const currentSessions = projected.byWeekDays.get(weekISO)?.size || 0;
    return {
      weekISO,
      weekSessions: currentSessions,
      weekCount: projected.byWeek.get(weekISO) || 0,
      cap: deficitBefore > 0 ? 3 : 2,
      deficitBefore,
      total: projected.count,
    };
  }

  function rememberDecision(key, status) {
    sessionDecisions.delete(key);
    sessionDecisions.set(key, { status, at: Date.now() });
    while (sessionDecisions.size > MAX_SESSION_DECISIONS) sessionDecisions.delete(sessionDecisions.keys().next().value);
  }

  function buildProposalQueue(candidates, state) {
    const reserved = getProjectedKeys(state);
    const reservedDates = new Set([...reserved].map((key) => key.split('|')[0]));
    const counts = createShiftState([...reserved]);
    const selected = [];
    const ordered = [...candidates].sort(compareCandidates);
    const maxRegisters = getMaxRegisters();

    for (const candidate of ordered) {
      // Si alguna de las casillas ya fue rechazada en la sesión, omitir
      const isRejected = candidate.keys.some((k) => sessionDecisions.get(k)?.status === 'rejected');
      if (isRejected) continue;
      // Si ya tenemos registrada esa fecha o casilla
      if (candidate.keys.some((k) => reserved.has(k))) continue;
      if (reservedDates.has(candidate.dateISO)) continue;
      if (reserved.size >= maxRegisters) break;

      // Ningún día de la misma semana puede quedar en un día calendario consecutivo a otro ya reservado
      const weekDaysSoFar = counts.byWeekDays.get(candidate.weekStartISO);
      if (weekDaysSoFar && [...weekDaysSoFar].some((d) => isAdjacentDay(d, candidate.dateISO))) continue;

      const policy = getWeekPolicy(candidate.weekStartISO, counts);
      if (policy.weekSessions >= policy.cap) continue;

      // Si solo queda 1 casilla para alcanzar el tope de 20 (30 h), reducir bloque doble a 1 casilla
      const slotsToAdd = (candidate.isDouble && reserved.size + 2 > maxRegisters)
        ? [candidate.slots[0]]
        : candidate.slots;
      const keysToAdd = slotsToAdd.map((s) => `${candidate.dateISO}|${s.start}`);

      const proposal = {
        ...candidate,
        slots: slotsToAdd,
        keys: keysToAdd,
        slot: slotsToAdd[0],
        key: keysToAdd[0],
        isDouble: slotsToAdd.length > 1,
        durationHours: slotsToAdd.length * HOURS_PER_BLOCK,
        weekStartISO: candidate.weekStartISO,
        weekSessionsBefore: policy.weekSessions,
        weeklyCap: policy.cap,
      };

      selected.push(proposal);
      keysToAdd.forEach((k) => {
        reserved.add(k);
        counts.keys.add(k);
      });
      reservedDates.add(candidate.dateISO);
      counts.byWeek.set(candidate.weekStartISO, (counts.byWeek.get(candidate.weekStartISO) || 0) + keysToAdd.length);
      counts.byDate.set(candidate.dateISO, (counts.byDate.get(candidate.dateISO) || 0) + keysToAdd.length);
      if (!counts.byWeekDays.has(candidate.weekStartISO)) counts.byWeekDays.set(candidate.weekStartISO, new Set());
      counts.byWeekDays.get(candidate.weekStartISO).add(candidate.dateISO);
      counts.count += keysToAdd.length;
    }
    return selected;
  }

  function setCandidateQueue(candidates, state) {
    candidateQueue = buildProposalQueue(candidates, state);
    queueKeys = new Set(candidateQueue.map((candidate) => candidate.key));
    const maxRegisters = getMaxRegisters();
    if (state.count >= maxRegisters) {
      setAutomationStatus(`Límite alcanzado: ${maxRegisters} registros (${formatHours(state.count)}). No se harán más propuestas.`);
    } else if (candidateQueue.length) {
      setAutomationStatus(`${candidateQueue.length} propuesta${candidateQueue.length === 1 ? '' : 's'} en cola (preferencia por turnos dobles).`);
    } else {
      setAutomationStatus(`Escaneo completo. ${state.count}/${maxRegisters} registros oficiales; no hay propuestas elegibles.`);
    }
    updateControls();
  }

  function clearCandidateQueue() {
    candidateQueue = [];
    queueKeys.clear();
  }

  function updateQueueStatus() {
    if (confirmationOpen) return;
    if (invalidShiftQueue.length) {
      setAutomationStatus(`${invalidShiftQueue.length} turno${invalidShiftQueue.length === 1 ? '' : 's'} inválido${invalidShiftQueue.length === 1 ? '' : 's'} requiere${invalidShiftQueue.length === 1 ? '' : 'n'} revisión individual.`);
    } else if (replacementQueue.length) {
      setAutomationStatus(`${replacementQueue.length} reubicación${replacementQueue.length === 1 ? '' : 'es'} temprana${replacementQueue.length === 1 ? '' : 's'} pendiente${replacementQueue.length === 1 ? '' : 's'} de confirmación.`);
    } else if (candidateQueue.length) {
      setAutomationStatus(`${candidateQueue.length} propuesta${candidateQueue.length === 1 ? '' : 's'} pendiente${candidateQueue.length === 1 ? '' : 's'}.`);
    }
  }

  function startSemesterScan(trigger) {
    if (semesterScanActive) {
      if (trigger === 'manual') setAutomationStatus('Ya hay un escaneo activo.');
      return;
    }
    if (confirmationOpen) {
      if (trigger === 'manual') setAutomationStatus('Termina la confirmación actual antes de escanear.');
      return;
    }
    if (candidateQueue.length) {
      if (trigger === 'manual') setAutomationStatus('Hay una cola de propuestas pendiente; no inicio otro escaneo.');
      return;
    }
    if (invalidShiftQueue.length) {
      if (trigger === 'manual') setAutomationStatus('Hay turnos inválidos pendientes de revisión individual.');
      return;
    }
    if (replacementQueue.length) {
      if (trigger === 'manual') setAutomationStatus('Hay una reubicación pendiente de confirmación individual.');
      return;
    }
    if (automationPaused && trigger !== 'manual') return;
    const active = getActiveSchedule();
    if (!hasScheduleConfiguration()) {
      setAutomationStatus('Configura tus clases o importa un JSON antes de escanear.', true);
      return;
    }
    if (active.errors.length) {
      setAutomationStatus(active.errors[0], true);
      return;
    }
    if (!getSiteUserName()) {
      automationPaused = true;
      pauseReason = 'name';
      setAutomationStatus('Pausado: haz clic en «Identifícate» arriba, guarda tu nombre y luego pulsa Reanudar.', true);
      return;
    }
    if (isSiteOverlayOpen()) {
      if (trigger === 'manual') setAutomationStatus('Cierra el overlay del sitio para iniciar el escaneo.', true);
      return;
    }
    void runSemesterScan(active.schedule, trigger);
  }

  async function runSemesterScan(schedule, trigger = 'initial') {
    semesterScanActive = true;
    scanAbortRequested = false;
    scanAbortMessage = '';
    clearCandidateQueue();
    clearInvalidShiftQueue();
    clearReplacementQueue();
    if (trigger !== 'invalid-corrections') invalidShiftDecisions.clear();
    if (trigger === 'initial' || trigger === 'manual' || trigger === 'name-configured') replacementDecisions.clear();
    scanInitialState = captureNavigationState();
    let navigationRestored = false;
    const foundCandidates = [];
    const minCandidateISO = getMinCandidateDateISO();
    try {
      setAutomationStatus('Sincronizando Mis turnos…');
      officialShiftState = await syncOfficialShifts();
      assertScanCanContinue();
      if (invalidShiftQueue.length) {
        setAutomationStatus(`${invalidShiftQueue.length} turno${invalidShiftQueue.length === 1 ? '' : 's'} inválido${invalidShiftQueue.length === 1 ? '' : 's'} detectado${invalidShiftQueue.length === 1 ? '' : 's'}; revisaré uno por uno.`);
        return;
      }

      setAutomationStatus('Escaneando semanas del semestre…');
      const scanSemester = getActiveSemester();
      await navigateToWeek(scanSemester.start, true);
      for (const weekISO of getSemesterWeeks()) {
        assertScanCanContinue();
        await navigateToWeek(weekISO, true);
        assertScanCanContinue();
        const period = parsePeriodLabel();
        if (!period || period.view !== 'week' || period.weekStartISO !== weekISO) {
          throw new Error('El calendario no mostró la semana esperada.');
        }
        const available = getAvailableButtons();
        period.dates.forEach((date) => {
          const dateISO = iso(date);
          if (!inSemester(date) || dateISO === ANAHUAC_DAY || isCalendarBlocked(dateISO) || isWeekend(date)) return;

          // REGLA 1: No proponer fechas dentro de la ventana de hoy a hoy + 7 días
          if (dateISO < minCandidateISO) return;

          // REGLA 2: candidatos del día (con preferencia por turnos dobles contiguos) respetando bloques prohibidos
          const dayCandidates = findDailyCandidates(getClassesForDate(schedule, dateISO), MODULE_SLOTS, dateISO, available);
          if (!dayCandidates.length) return;

          const best = dayCandidates.find((candidate) => candidate.keys.every((key) => available.has(key)));
          if (!best) return;

          foundCandidates.push({
            ...best,
            date,
            dateISO,
            weekStartISO: weekISO,
          });
        });
        await delay(120);
      }

      if (scanInitialState) {
        await restoreNavigation(scanInitialState);
        navigationRestored = true;
      }
      assertScanCanContinue();
      setAutomationStatus('Verificando Mis turnos antes de proponer…');
      officialShiftState = await syncOfficialShifts();
      if (invalidShiftQueue.length) {
        clearCandidateQueue();
        setAutomationStatus(`${invalidShiftQueue.length} turno${invalidShiftQueue.length === 1 ? '' : 's'} inválido${invalidShiftQueue.length === 1 ? '' : 's'} detectado${invalidShiftQueue.length === 1 ? '' : 's'}; revisaré uno por uno.`);
        return;
      }
      const orderedCandidates = uniqueCandidates(foundCandidates);
      const proactiveSwaps = buildProactiveDoubleSwap(orderedCandidates, officialShiftState);
      const replacements = proactiveSwaps.length ? proactiveSwaps : buildReplacementQueue(orderedCandidates, officialShiftState);
      setReplacementQueue(replacements);
      if (replacementQueue.length) {
        setAutomationStatus(`${replacementQueue.length} opción${replacementQueue.length === 1 ? '' : 'es'} anterior${replacementQueue.length === 1 ? '' : 'es'} detectada${replacementQueue.length === 1 ? '' : 's'}; revisaré el reemplazo más tardío uno por uno.`);
      } else {
        setCandidateQueue(orderedCandidates, officialShiftState);
      }
    } catch (failure) {
      clearCandidateQueue();
      if (failure?.code === 'SCAN_ABORTED') {
        automationPaused = true;
        pauseReason = 'navigation';
        setAutomationStatus(scanAbortMessage || 'Escaneo pausado por navegación manual.', true);
      } else if (failure?.code === 'NAME_NOT_CONFIGURED') {
        automationPaused = true;
        pauseReason = 'name';
        setAutomationStatus(failure.message, true);
      } else {
        setAutomationStatus(failure.message || 'El escaneo no pudo terminar.', true);
      }
    } finally {
      if (!navigationRestored && scanInitialState) {
        try {
          await restoreNavigation(scanInitialState);
        } catch (_) {
          setAutomationStatus('El escaneo terminó, pero no pude restaurar la vista inicial. Cierra overlays y usa los controles del sitio.', true);
        }
      }
      scanInitialState = null;
      semesterScanActive = false;
      scanAbortRequested = false;
      updateControls();
      lastSignature = '';
      scheduleViewScan();
      if (!automationPaused) {
        if (invalidShiftQueue.length) processInvalidShiftQueue();
        else if (replacementQueue.length) processReplacementQueue();
        else if (candidateQueue.length) processCandidateQueue();
      }
    }
  }

  function uniqueCandidates(candidates) {
    const unique = new Map();
    candidates.forEach((candidate) => {
      if (!unique.has(candidate.key)) unique.set(candidate.key, candidate);
    });
    return [...unique.values()].sort(compareCandidates);
  }

  function assertScanCanContinue() {
    if (scanAbortRequested) {
      const error = new Error(scanAbortMessage || 'Escaneo pausado.');
      error.code = 'SCAN_ABORTED';
      throw error;
    }
    if (isSiteOverlayOpen() && !ownedMyShiftsOverlay) {
      scanAbortMessage = 'El sitio abrió un overlay durante el escaneo; lo pausé para no interferir.';
      const error = new Error(scanAbortMessage);
      error.code = 'SCAN_ABORTED';
      throw error;
    }
  }

  function captureNavigationState() {
    const view = getView() || 'week';
    const period = parsePeriodLabel();
    return {
      view,
      periodText: document.querySelector('#periodLabel')?.textContent.trim() || '',
      weekStartISO: period?.weekStartISO || getActiveSemester().start,
      dateISO: period?.dateISO || null,
      month: period?.view === 'month' ? period.month : null,
      year: period?.view === 'month' ? period.year : null,
    };
  }

  async function restoreNavigation(state) {
    if (!state) return;
    if (state.view === 'week') {
      await navigateToWeek(state.weekStartISO, false);
    } else if (state.view === 'day' && state.dateISO) {
      await navigateToDay(state.dateISO);
    } else if (state.view === 'month' && Number.isInteger(state.month) && Number.isInteger(state.year)) {
      await navigateToMonth(state.year, state.month);
    } else {
      await navigateToWeek(state.weekStartISO || getActiveSemester().start, false);
    }
  }

  async function ensureWeekView(abortable) {
    const abortCheck = abortable ? () => scanAbortRequested : null;
    if (getView() !== 'week' || !document.querySelector('#content table.week')) {
      await clickNavigation('#vWeek');
      const ready = await waitForCondition(
        () => getView() === 'week' && Boolean(document.querySelector('#content table.week')),
        10000,
        abortCheck,
      );
      if (!ready) throw new Error('La vista semanal no terminó de renderizar.');
    }
  }

  async function navigateToWeek(targetISO, abortable = false) {
    const target = fromISO(targetISO);
    const abortCheck = abortable ? () => scanAbortRequested : null;
    await ensureWeekView(abortable);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const currentISO = parsePeriodLabel()?.weekStartISO;
      if (currentISO === targetISO) {
        const ready = await waitForCondition(
          () => getView() === 'week' && parsePeriodLabel()?.weekStartISO === targetISO && Boolean(document.querySelector('#content table.week')),
          10000,
          abortCheck,
        );
        if (!ready) throw new Error('La semana objetivo no terminó de renderizar.');
        return;
      }
      if (!currentISO) throw new Error('No pude leer el periodo semanal del sitio.');
      const current = fromISO(currentISO);
      const selector = target < current ? '#prevBtn' : '#nextBtn';
      const previous = currentISO;
      await clickNavigation(selector);
      const changed = await waitForCondition(
        () => parsePeriodLabel()?.weekStartISO && parsePeriodLabel()?.weekStartISO !== previous,
        10000,
        abortCheck,
      );
      if (!changed) throw new Error('El sitio no cambió de semana.');
      await delay(100);
    }
    throw new Error('No pude llegar a la semana objetivo.');
  }

  async function navigateToDay(targetISO) {
    if (getView() !== 'day' || !document.querySelector('#content .day-list')) {
      await clickNavigation('#vDay');
      const ready = await waitForCondition(() => getView() === 'day' && Boolean(document.querySelector('#content .day-list')), 10000);
      if (!ready) throw new Error('La vista diaria no terminó de renderizar.');
    }
    for (let attempt = 0; attempt < 140; attempt += 1) {
      const currentISO = parsePeriodLabel()?.dateISO;
      if (currentISO === targetISO) return;
      if (!currentISO) throw new Error('No pude leer el día actual del sitio.');
      const selector = fromISO(targetISO) < fromISO(currentISO) ? '#prevBtn' : '#nextBtn';
      await clickNavigation(selector);
      const changed = await waitForCondition(() => parsePeriodLabel()?.dateISO && parsePeriodLabel()?.dateISO !== currentISO, 10000);
      if (!changed) throw new Error('El sitio no cambió de día.');
      await delay(70);
    }
    throw new Error('No pude restaurar el día inicial.');
  }

  async function navigateToMonth(targetYear, targetMonth) {
    if (getView() !== 'month' || !document.querySelector('#content .month-grid')) {
      await clickNavigation('#vMonth');
      const ready = await waitForCondition(() => getView() === 'month' && Boolean(document.querySelector('#content .month-grid')), 10000);
      if (!ready) throw new Error('La vista mensual no terminó de renderizar.');
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const period = parsePeriodLabel();
      if (period?.view === 'month' && period.year === targetYear && period.month === targetMonth) return;
      if (!period || period.view !== 'month') throw new Error('No pude leer el mes actual del sitio.');
      const currentIndex = period.year * 12 + period.month;
      const targetIndex = targetYear * 12 + targetMonth;
      const selector = targetIndex < currentIndex ? '#prevBtn' : '#nextBtn';
      await clickNavigation(selector);
      const changed = await waitForCondition(() => {
        const next = parsePeriodLabel();
        return next?.view === 'month' && (next.year * 12 + next.month) !== currentIndex;
      }, 10000);
      if (!changed) throw new Error('El sitio no cambió de mes.');
      await delay(100);
    }
    throw new Error('No pude restaurar el mes inicial.');
  }

  async function clickNavigation(selector) {
    const button = document.querySelector(selector);
    if (!button) throw new Error(`No encontré el control ${selector}.`);
    internalNavigation = true;
    try {
      button.click();
    } finally {
      internalNavigation = false;
    }
  }

  function waitForCondition(predicate, timeout = 8000, abortCheck = null) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let observer = null;
      let interval = null;
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        if (observer) observer.disconnect();
        if (interval) window.clearInterval(interval);
        callback(value);
      };
      const check = () => {
        if (abortCheck && abortCheck()) {
          const error = new Error('Escaneo abortado.');
          error.code = 'SCAN_ABORTED';
          finish(reject, error);
          return;
        }
        let result = false;
        try {
          result = Boolean(predicate());
        } catch (_) {
          result = false;
        }
        if (result) {
          finish(resolve, true);
        } else if (Date.now() - started >= timeout) {
          finish(resolve, false);
        }
      };
      if (document.body) {
        observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      interval = window.setInterval(check, 100);
      check();
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function continueAfterInvalidReview() {
    if (invalidShiftQueue.length) {
      processInvalidShiftQueue();
      return;
    }
    setAutomationStatus('Revisión de turnos inválidos terminada. Reescaneando el semestre…');
    startSemesterScan('invalid-corrections');
  }

  function processInvalidShiftQueue() {
    if (automationPaused || semesterScanActive || confirmationOpen) return;
    if (!invalidShiftQueue.length) {
      continueAfterInvalidReview();
      return;
    }
    const record = invalidShiftQueue.shift();
    invalidShiftKeys.delete(record.key);
    if (invalidShiftDecisions.has(record.key)) {
      processInvalidShiftQueue();
      return;
    }
    openInvalidShiftConfirmation(record);
  }

  function continueAfterReplacementReview() {
    if (replacementQueue.length) {
      processReplacementQueue();
      return;
    }
    setAutomationStatus('Revisión de reubicaciones terminada. Reescaneando el semestre…');
    startSemesterScan('replacement');
  }

  function processReplacementQueue() {
    if (automationPaused || semesterScanActive || confirmationOpen) return;
    if (!replacementQueue.length) {
      continueAfterReplacementReview();
      return;
    }
    const replacement = replacementQueue.shift();
    if (replacementDecisions.has(replacement.replacementKey)) {
      processReplacementQueue();
      return;
    }
    openReplacementConfirmation(replacement);
  }

  function openReplacementConfirmation(replacement) {
    if (confirmationOpen || automationPaused) return;
    confirmationOpen = true;
    const slots = replacement.slots || [replacement.slot];
    const removeRecords = replacement.removeRecords || (replacement.removeRecord ? [replacement.removeRecord] : []);
    const slotLabel = slots.length > 1
      ? `${slots[0].start}–${slots[slots.length - 1].end} (turno doble)`
      : `${slots[0].start}–${slots[0].end}`;
    const title = removeRecords.length > 1 ? '¿Reubicar 2 turnos por este turno doble?' : '¿Reubicar turno?';
    const removeLabel = removeRecords.length > 1 ? 'Turnos que se quitarán' : 'Turno que se quitará';
    const overlay = document.createElement('div');
    overlay.id = 'rb-after-class-replacement-confirmation';
    overlay.innerHTML = `
      <div class="rb-after-class-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="rb-after-class-replacement-title">
        <h2 id="rb-after-class-replacement-title">${title}</h2>
        <div class="rb-after-class-confirm-grid">
          <div><span>Turno nuevo</span><strong id="rb-after-class-replacement-new-date"></strong></div>
          <div><span>Intervalo nuevo</span><strong id="rb-after-class-replacement-new-slot"></strong></div>
        </div>
        <p class="rb-after-class-example">${removeLabel}:</p>
        <div class="rb-after-class-confirm-grid" id="rb-after-class-replacement-remove-grid"></div>
        <p id="rb-after-class-confirm-message" class="rb-after-class-confirm-message">Se quitarán únicamente los turnos listados y se intentará registrar el nuevo turno. Todo se revalida antes de actuar.</p>
        <div class="rb-after-class-actions">
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-replacement-omit">Omitir</button>
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-replacement-pause">Pausar</button>
          <button type="button" class="rb-after-class-primary rb-after-class-danger" id="rb-after-class-replacement-go">Reubicar</button>
        </div>
      </div>
    `;
    document.body.append(overlay);
    overlay.querySelector('#rb-after-class-replacement-new-date').textContent = formatDateLong(replacement.dateISO);
    overlay.querySelector('#rb-after-class-replacement-new-slot').textContent = slotLabel;
    overlay.querySelector('#rb-after-class-replacement-remove-grid').innerHTML = removeRecords.map((record) => (
      `<div><span>${escapeHTML(formatDateLong(record.dateISO))}</span><strong>${escapeHTML(record.start)}–${escapeHTML(record.end)}</strong></div>`
    )).join('');

    overlay.querySelector('#rb-after-class-replacement-omit').addEventListener('click', () => {
      replacementDecisions.set(replacement.replacementKey, 'omitted');
      closeConfirmation(overlay);
      setAutomationStatus(`No reubicado: ${formatDate(replacement.dateISO)} ${slots[0].start}.`);
      continueAfterReplacementReview();
    });
    overlay.querySelector('#rb-after-class-replacement-pause').addEventListener('click', () => {
      closeConfirmation(overlay);
      clearCandidateQueue();
      clearInvalidShiftQueue();
      clearReplacementQueue();
      automationPaused = true;
      pauseReason = 'user';
      setAutomationStatus('Pausado por el usuario. No se modificó el turno anterior.', true);
    });
    overlay.querySelector('#rb-after-class-replacement-go').addEventListener('click', async (event) => {
      if (confirmationBusy) return;
      confirmationBusy = true;
      event.currentTarget.disabled = true;
      overlay.querySelector('#rb-after-class-replacement-omit').disabled = true;
      overlay.querySelector('#rb-after-class-replacement-pause').disabled = true;
      overlay.querySelector('#rb-after-class-confirm-message').textContent = 'Revalidando los turnos involucrados…';
      try {
        await confirmReplacement(replacement, overlay);
        replacementDecisions.set(replacement.replacementKey, 'confirmed');
        closeConfirmation(overlay);
        setAutomationStatus(`Reubicado: ${formatDate(replacement.dateISO)} ${slotLabel}.`);
        continueAfterReplacementReview();
      } catch (failure) {
        overlay.querySelector('#rb-after-class-confirm-message').textContent = failure.message || 'No se pudo reubicar el turno.';
        overlay.querySelector('#rb-after-class-confirm-message').classList.add('rb-after-class-confirm-error');
        if (failure.code === 'RULE_CONFLICT') {
          replacementDecisions.set(replacement.replacementKey, 'stale');
          closeConfirmation(overlay);
          setAutomationStatus(failure.message, true);
          continueAfterReplacementReview();
        } else {
          closeConfirmation(overlay);
          clearCandidateQueue();
          clearInvalidShiftQueue();
          clearReplacementQueue();
          automationPaused = true;
          pauseReason = 'error';
          setAutomationStatus(`${failure.message || 'Falló la reubicación.'} No repetiré la cancelación; quedó pausado.`, true);
        }
      } finally {
        confirmationBusy = false;
        updateControls();
      }
    });
    updateControls();
  }

  function openInvalidShiftConfirmation(record) {
    if (confirmationOpen || automationPaused) return;
    confirmationOpen = true;
    const overlay = document.createElement('div');
    overlay.id = 'rb-after-class-invalid-confirmation';
    overlay.innerHTML = `
      <div class="rb-after-class-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="rb-after-class-invalid-title">
        <h2 id="rb-after-class-invalid-title">¿Corregir turno inválido?</h2>
        <div class="rb-after-class-confirm-grid">
          <div><span>Fecha</span><strong id="rb-after-class-invalid-date"></strong></div>
          <div><span>Intervalo</span><strong id="rb-after-class-invalid-slot"></strong></div>
          <div><span>Motivo</span><strong id="rb-after-class-invalid-reason"></strong></div>
          <div><span>Acción</span><strong>Cancelar únicamente este turno</strong></div>
        </div>
        <p id="rb-after-class-invalid-message" class="rb-after-class-confirm-message">La vista semanal y diaria lo marcará en morado. Solo se usará el botón oficial de quitar después de tu confirmación.</p>
        <div class="rb-after-class-actions">
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-invalid-omit">Omitir</button>
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-invalid-pause">Pausar</button>
          <button type="button" class="rb-after-class-primary rb-after-class-danger" id="rb-after-class-invalid-go">Cancelar turno</button>
        </div>
      </div>
    `;
    document.body.append(overlay);
    overlay.querySelector('#rb-after-class-invalid-date').textContent = formatDateLong(record.dateISO);
    overlay.querySelector('#rb-after-class-invalid-slot').textContent = `${record.start}–${record.end}`;
    overlay.querySelector('#rb-after-class-invalid-reason').textContent = record.reason;

    overlay.querySelector('#rb-after-class-invalid-omit').addEventListener('click', () => {
      invalidShiftDecisions.set(record.key, 'omitted');
      closeConfirmation(overlay);
      setAutomationStatus(`No corregido: ${formatDate(record.dateISO)} ${record.start}.`);
      continueAfterInvalidReview();
    });
    overlay.querySelector('#rb-after-class-invalid-pause').addEventListener('click', () => {
      closeConfirmation(overlay);
      clearCandidateQueue();
      clearInvalidShiftQueue();
      automationPaused = true;
      pauseReason = 'user';
      setAutomationStatus('Pausado por el usuario. Pulsa Reanudar para revisar los turnos inválidos.', true);
    });
    overlay.querySelector('#rb-after-class-invalid-go').addEventListener('click', async (event) => {
      if (confirmationBusy) return;
      confirmationBusy = true;
      event.currentTarget.disabled = true;
      overlay.querySelector('#rb-after-class-invalid-omit').disabled = true;
      overlay.querySelector('#rb-after-class-invalid-pause').disabled = true;
      overlay.querySelector('#rb-after-class-invalid-message').textContent = 'Revalidando el registro en Mis turnos…';
      try {
        await cancelInvalidShift(record, overlay);
        invalidShiftDecisions.set(record.key, 'cancelled');
        closeConfirmation(overlay);
        setAutomationStatus(`Corregido: se canceló ${formatDate(record.dateISO)} ${record.start}–${record.end}.`);
        continueAfterInvalidReview();
      } catch (failure) {
        overlay.querySelector('#rb-after-class-invalid-message').textContent = failure.message || 'No se pudo corregir el turno.';
        overlay.querySelector('#rb-after-class-invalid-message').classList.add('rb-after-class-confirm-error');
        if (failure.code === 'RULE_CONFLICT') {
          invalidShiftDecisions.set(record.key, 'gone');
          closeConfirmation(overlay);
          setAutomationStatus(failure.message, true);
          continueAfterInvalidReview();
        } else if (failure.code === 'NAME_NOT_CONFIGURED') {
          closeConfirmation(overlay);
          clearCandidateQueue();
          clearInvalidShiftQueue();
          automationPaused = true;
          pauseReason = 'name';
          setAutomationStatus(failure.message, true);
        } else {
          closeConfirmation(overlay);
          clearCandidateQueue();
          clearInvalidShiftQueue();
          automationPaused = true;
          pauseReason = 'error';
          setAutomationStatus(`${failure.message || 'Falló la corrección.'} No repetiré el click; quedó pausado.`, true);
        }
      } finally {
        confirmationBusy = false;
        updateControls();
      }
    });
    updateControls();
  }

  function processCandidateQueue() {
    if (automationPaused || semesterScanActive || confirmationOpen) return;
    if (invalidShiftQueue.length) {
      processInvalidShiftQueue();
      return;
    }
    if (replacementQueue.length) {
      processReplacementQueue();
      return;
    }
    if (!candidateQueue.length) {
      updateControls();
      return;
    }
    const candidate = candidateQueue.shift();
    queueKeys.delete(candidate.key);
    const candidateKeys = candidate.keys || [candidate.key];
    if (candidateKeys.some((key) => sessionDecisions.has(key) || officialShiftState.keys.has(key))) {
      processCandidateQueue();
      return;
    }
    updateQueueStatus();
    openConfirmation(candidate);
  }

  function openConfirmation(candidate) {
    if (confirmationOpen || automationPaused) return;
    confirmationOpen = true;
    const slots = candidate.slots || [candidate.slot];
    const keys = candidate.keys || [candidate.key];
    const maxRegisters = getMaxRegisters();
    const policy = getWeekPolicy(candidate.weekStartISO, officialShiftState);
    const currentTotal = getProjectedKeys(officialShiftState).size;
    const slotLabel = slots.length > 1
      ? `${slots[0].start}–${slots[slots.length - 1].end} (turno doble, ${slots.length} registros)`
      : `${slots[0].start}–${slots[0].end}`;
    const overlay = document.createElement('div');
    overlay.id = 'rb-after-class-confirmation';
    overlay.innerHTML = `
      <div class="rb-after-class-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="rb-after-class-confirm-title">
        <h2 id="rb-after-class-confirm-title">¿Confirmar inscripción?</h2>
        <div class="rb-after-class-confirm-grid">
          <div><span>Fecha</span><strong id="rb-after-class-confirm-date"></strong></div>
          <div><span>Intervalo</span><strong id="rb-after-class-confirm-slot"></strong></div>
          <div><span>Clase anterior</span><strong id="rb-after-class-confirm-class"></strong></div>
          <div><span>Total de registros</span><strong id="rb-after-class-confirm-total"></strong></div>
          <div><span>Horas</span><strong id="rb-after-class-confirm-hours"></strong></div>
          <div><span>Semana</span><strong id="rb-after-class-confirm-week"></strong></div>
        </div>
        <p id="rb-after-class-confirm-message" class="rb-after-class-confirm-message">El sitio oficial se comprobará nuevamente antes de hacer clic.</p>
        <div class="rb-after-class-actions">
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-confirm-omit">Omitir</button>
          <button type="button" class="rb-after-class-secondary" id="rb-after-class-confirm-pause">Pausar</button>
          <button type="button" class="rb-after-class-primary" id="rb-after-class-confirm-go">Confirmar</button>
        </div>
      </div>
    `;
    document.body.append(overlay);
    overlay.querySelector('#rb-after-class-confirm-date').textContent = formatDateLong(candidate.dateISO);
    overlay.querySelector('#rb-after-class-confirm-slot').textContent = slotLabel;
    overlay.querySelector('#rb-after-class-confirm-class').textContent = `${candidate.className} (termina ${candidate.after})`;
    overlay.querySelector('#rb-after-class-confirm-total').textContent = `${currentTotal} → ${currentTotal + keys.length} / ${maxRegisters}`;
    overlay.querySelector('#rb-after-class-confirm-hours').textContent = `${formatHours(currentTotal)} → ${formatHours(currentTotal + keys.length)}`;
    overlay.querySelector('#rb-after-class-confirm-week').textContent = `${policy.weekSessions} → ${policy.weekSessions + 1} / ${policy.cap}`;

    overlay.querySelector('#rb-after-class-confirm-omit').addEventListener('click', () => {
      keys.forEach((key) => rememberDecision(key, 'rejected'));
      closeConfirmation(overlay);
      setAutomationStatus(`Omitido: ${formatDate(candidate.dateISO)} ${slots[0].start}.`);
      processCandidateQueue();
    });
    overlay.querySelector('#rb-after-class-confirm-pause').addEventListener('click', () => {
      closeConfirmation(overlay);
      clearCandidateQueue();
      automationPaused = true;
      pauseReason = 'user';
      setAutomationStatus('Pausado por el usuario. Pulsa Reanudar para volver a escanear.', true);
    });
    overlay.querySelector('#rb-after-class-confirm-go').addEventListener('click', async (event) => {
      if (confirmationBusy) return;
      confirmationBusy = true;
      event.currentTarget.disabled = true;
      overlay.querySelector('#rb-after-class-confirm-omit').disabled = true;
      overlay.querySelector('#rb-after-class-confirm-pause').disabled = true;
      overlay.querySelector('#rb-after-class-confirm-message').textContent = 'Sincronizando Mis turnos y comprobando el turno libre…';
      try {
        await confirmCandidate(candidate, overlay);
        closeConfirmation(overlay);
        keys.forEach((key) => rememberDecision(key, 'confirmed'));
        setAutomationStatus(`Confirmado: ${formatDate(candidate.dateISO)} ${slotLabel}.`);
        processCandidateQueue();
      } catch (failure) {
        overlay.querySelector('#rb-after-class-confirm-message').textContent = failure.message || 'No se pudo confirmar.';
        overlay.querySelector('#rb-after-class-confirm-message').classList.add('rb-after-class-confirm-error');
        if (failure.code === 'NAME_NOT_CONFIGURED') {
          closeConfirmation(overlay);
          clearCandidateQueue();
          automationPaused = true;
          pauseReason = 'name';
          setAutomationStatus(failure.message, true);
        } else if (failure.code === 'LIMIT_REACHED' || failure.code === 'RULE_CONFLICT') {
          closeConfirmation(overlay);
          clearCandidateQueue();
          setAutomationStatus(failure.message, true);
          if (invalidShiftQueue.length) processInvalidShiftQueue();
        } else {
          closeConfirmation(overlay);
          clearCandidateQueue();
          automationPaused = true;
          pauseReason = 'error';
          setAutomationStatus(`${failure.message || 'Falló la verificación.'} No incrementé el contador; quedó pausado.`, true);
        }
      } finally {
        confirmationBusy = false;
        updateControls();
      }
    });
    updateControls();
  }

  function closeConfirmation(overlay) {
    overlay?.remove();
    confirmationOpen = false;
    confirmationBusy = false;
    updateControls();
  }

  async function confirmReplacement(replacement, overlay) {
    if (!getSiteUserName()) {
      const error = new Error('Configura tu nombre en el sitio: haz clic en «Identifícate» arriba y guarda tu nombre.');
      error.code = 'NAME_NOT_CONFIGURED';
      throw error;
    }
    if (isSiteOverlayOpen()) {
      const error = new Error('Cierra el overlay del sitio antes de reubicar el turno.');
      error.code = 'SITE_OVERLAY_OPEN';
      throw error;
    }

    const removeRecords = replacement.removeRecords || (replacement.removeRecord ? [replacement.removeRecord] : []);
    if (!removeRecords.length) {
      const error = new Error('No hay turnos que quitar para esta reubicación; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    officialShiftState = await syncOfficialShifts();
    if (invalidShiftQueue.length) {
      const error = new Error('Detecté un turno inválido pendiente de revisión; lo revisaré antes de reubicar otro.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    if (removeRecords.some((record) => !officialShiftState.keys.has(record.key))) {
      const error = new Error('Alguno de los turnos tardíos ya no existe; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    if (officialShiftState.byDate.has(replacement.dateISO)) {
      const error = new Error('El nuevo día ya tiene un turno o dejó de estar disponible; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    if (removeRecords.some((record) => compareCalendarPositions(replacement, record) >= 0)) {
      const error = new Error('El nuevo turno ya no es anterior a los turnos que se iban a quitar; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    const removeKeySet = new Set(removeRecords.map((record) => record.key));
    const afterRemoval = createShiftState([...officialShiftState.keys].filter((key) => !removeKeySet.has(key)));
    if (afterRemoval.byDate.has(replacement.dateISO)) {
      const error = new Error('El nuevo día ya tiene un turno o dejó de estar disponible; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    const weekDaysAfterRemoval = afterRemoval.byWeekDays.get(replacement.weekStartISO);
    if (weekDaysAfterRemoval && [...weekDaysAfterRemoval].some((d) => isAdjacentDay(d, replacement.dateISO))) {
      const error = new Error('El nuevo turno quedaría en un día consecutivo a otro ya registrado esa semana; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    const policy = getWeekPolicy(replacement.weekStartISO, afterRemoval);
    if (policy.weekSessions >= policy.cap) {
      const error = new Error('El reemplazo rompería el límite semanal; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    await navigateToWeek(replacement.weekStartISO, false);
    const newKeys = replacement.keys || [replacement.key];
    const availableNow = getAvailableButtons();
    if (newKeys.some((key) => { const b = availableNow.get(key); return !b || !b.isConnected; })) {
      const error = new Error('El nuevo turno ya no está libre; no se hizo ningún click.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    const removedSoFar = [];
    try {
      for (const record of removeRecords) {
        await removeOfficialShift(record, overlay, '#rb-after-class-confirm-message');
        removedSoFar.push(record);
      }
    } catch (failure) {
      const removedLabel = removedSoFar.map((r) => `${formatDate(r.dateISO)} ${r.start}`).join(', ');
      const error = new Error(`${removedSoFar.length ? `Se quitó ${removedLabel}, pero ` : ''}no pude terminar de liberar los turnos tardíos: ${failure.message || 'falló la verificación'}.`);
      error.code = removedSoFar.length ? 'PARTIAL_REGISTRATION' : (failure.code || 'REPLACEMENT_REMOVE_FAILED');
      throw error;
    }

    overlay.querySelector('#rb-after-class-confirm-message').textContent = 'Turno(s) tardío(s) quitado(s) y verificado(s). Intentando registrar el turno nuevo…';
    try {
      await confirmCandidate(replacement, overlay);
    } catch (failure) {
      const removedLabel = removeRecords.map((r) => `${formatDate(r.dateISO)} ${r.start}`).join(', ');
      const error = new Error(`Se quitó ${removedLabel}, pero no pude registrar el nuevo turno: ${failure.message || 'falló la verificación'}.`);
      error.code = 'PARTIAL_REGISTRATION';
      throw error;
    }
  }

  async function confirmCandidate(candidate, overlay) {
    if (!getSiteUserName()) {
      const error = new Error('Configura tu nombre en el sitio: haz clic en «Identifícate» arriba y guarda tu nombre.');
      error.code = 'NAME_NOT_CONFIGURED';
      throw error;
    }
    if (isSiteOverlayOpen()) {
      const error = new Error('Cierra el overlay del sitio antes de confirmar.');
      error.code = 'SITE_OVERLAY_OPEN';
      throw error;
    }

    // Validación de seguridad de fecha mínima (hoy + 8 días)
    const minCandidateISO = getMinCandidateDateISO();
    if (candidate.dateISO < minCandidateISO) {
      const error = new Error(`No se pueden registrar turnos en fechas anteriores al ${formatDateLong(minCandidateISO)}.`);
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    // Validación de seguridad de bloques prohibidos (ej. Miércoles 11:30–13:00)
    const todayISO = getTodayISO();
    const slots = candidate.slots || [candidate.slot];
    if (candidate.dateISO >= todayISO) {
      const prohibitedSlot = slots.find((slot) => isSlotProhibited(candidate.dateISO, slot.start));
      if (prohibitedSlot) {
        const error = new Error(`El bloque ${prohibitedSlot.start}–${prohibitedSlot.end} de ese día está prohibido.`);
        error.code = 'RULE_CONFLICT';
        throw error;
      }
    }

    const calendarBlockReason = getCalendarBlockReason(candidate.dateISO);
    if (calendarBlockReason) {
      const error = new Error(`El ${formatDateLong(candidate.dateISO)} está bloqueado por ${calendarBlockReason}; no haré el registro.`);
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    officialShiftState = await syncOfficialShifts();
    if (invalidShiftQueue.length) {
      const error = new Error('Detecté un turno existente en una fecha bloqueada; lo revisaré antes de hacer otra inscripción.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }
    const keys = candidate.keys || [candidate.key];
    const maxRegisters = getMaxRegisters();
    const projected = getProjectedKeys(officialShiftState);
    if (projected.size + keys.length > maxRegisters) {
      const error = new Error(`Ya alcanzaste (o excederías) el máximo de ${maxRegisters} registros (${formatHours(projected.size)}).`);
      error.code = 'LIMIT_REACHED';
      throw error;
    }
    if ([...projected].some((key) => key.split('|')[0] === candidate.dateISO)) {
      const error = new Error('Ya existe un turno del módulo en esa fecha; no haré un segundo registro.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    const weekDaysNow = officialShiftState.byWeekDays.get(candidate.weekStartISO);
    if (weekDaysNow && [...weekDaysNow].some((d) => isAdjacentDay(d, candidate.dateISO))) {
      const error = new Error('Esa fecha quedaría en un día consecutivo a otro turno ya registrado esa semana; no haré el registro.');
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    const policy = getWeekPolicy(candidate.weekStartISO, officialShiftState);
    if (policy.weekSessions >= policy.cap) {
      const error = new Error(`La semana ya alcanzó su tope determinista de ${policy.cap} días de servicio.`);
      error.code = 'RULE_CONFLICT';
      throw error;
    }

    await navigateToWeek(candidate.weekStartISO, false);

    const registeredKeys = [];
    try {
      for (const slot of slots) {
        const key = `${candidate.dateISO}|${slot.start}`;
        const button = getAvailableButtons().get(key);
        if (!button || !button.isConnected) {
          const error = new Error(`El turno ${slot.start}–${slot.end} ya no está libre; no se hizo ningún click adicional.`);
          error.code = 'RULE_CONFLICT';
          throw error;
        }
        overlay.querySelector('#rb-after-class-confirm-message').textContent = `Turno libre confirmado (${slot.start}). Haré un solo click en el botón oficial…`;
        button.click();

        const appeared = await waitForCondition(() => hasMineInCurrentDom(candidate.dateISO, slot.start), 9000);
        let verified = appeared;
        if (!verified) {
          overlay.querySelector('#rb-after-class-confirm-message').textContent = 'Esperando confirmación oficial en Mis turnos…';
          const refreshed = await syncOfficialShifts();
          officialShiftState = refreshed;
          verified = refreshed.keys.has(key);
        }
        if (!verified) {
          throw new Error(`El sitio no mostró tu registro de ${slot.start} ni lo confirmó en Mis turnos.`);
        }
        registeredKeys.push(key);
        officialShiftState = createShiftState([...officialShiftState.keys, key]);
      }
      if (registeredKeys.length) await recordBecarioShifts(officialShiftState);
    } catch (failure) {
      if (registeredKeys.length) {
        try {
          await recordBecarioShifts(officialShiftState);
        } catch (_) {}
        failure.code = 'PARTIAL_REGISTRATION';
        failure.message = `${failure.message || 'Falló el registro del turno doble.'} Ya se registró ${registeredKeys.join(', ')}; revisa Mis turnos antes de continuar.`;
      }
      throw failure;
    }
  }

  function hasMineInCurrentDom(dateISO, start) {
    return [...document.querySelectorAll('#content [data-rm][data-date][data-slot]')].some((element) => (
      element.dataset.date === dateISO && element.dataset.slot === start
    )) || [...document.querySelectorAll('#content .spot.mine')].some((element) => {
      const cell = element.closest('td, .day-block');
      return Boolean(cell?.querySelector(`[data-rm][data-date="${dateISO}"][data-slot="${start}"]`));
    });
  }

  function togglePause() {
    if (automationPaused) {
      if (!getSiteUserName()) {
        pauseReason = 'name';
        setAutomationStatus('Pausado: configura tu nombre en el sitio con «Identifícate».', true);
        return;
      }
      automationPaused = false;
      pauseReason = '';
      setAutomationStatus('Reanudado. Preparando un escaneo del semestre.');
      showToast('Automatización reanudada ✔', 'success');
      startSemesterScan('manual');
      return;
    }
    automationPaused = true;
    pauseReason = 'user';
    scanAbortRequested = true;
    scanAbortMessage = 'Pausado por el usuario.';
    clearCandidateQueue();
    clearInvalidShiftQueue();
    clearReplacementQueue();
    setAutomationStatus('Pausado por el usuario.', true);
    showToast('Automatización pausada.', 'info');
    updateControls();
  }

  function injectSoyLeonStyles() {
    if (document.querySelector(`#${SOY_LEON_STYLES_ID}`)) return;
    const style = document.createElement('style');
    style.id = SOY_LEON_STYLES_ID;
    style.textContent = `
      #${SOY_LEON_ROOT_ID} {
        --rb-sl-bg: var(--fl-slate-0, #ffffff);
        --rb-sl-bg-soft: var(--fl-slate-100, #f8fafc);
        --rb-sl-border: var(--fl-slate-200, #e5e7eb);
        --rb-sl-text: var(--fl-slate-900, #172033);
        --rb-sl-muted: var(--fl-slate-600, #64748b);
        --rb-sl-subtle: var(--fl-slate-400, #94a3b8);
        --rb-sl-accent: var(--fl-orange-500, var(--fl-primary, #ff5900));
        --rb-sl-accent-dark: var(--fl-orange-600, #e34e00);
        --rb-sl-radius: var(--fl-radius-md, 8px);
        --rb-sl-radius-lg: var(--fl-radius-lg, 12px);
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        color: var(--rb-sl-text);
        font-family: var(--fl-font-body, system-ui, -apple-system, "Segoe UI", sans-serif);
      }
      #${SOY_LEON_ROOT_ID} button {
        font: inherit;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-trigger {
        position: relative;
        width: 48px;
        height: 48px;
        padding: 0;
        border: 2px solid var(--rb-sl-accent);
        border-radius: 50%;
        background: var(--rb-sl-bg);
        color: var(--rb-sl-accent);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        box-shadow: var(--fl-shadow-lg, 0 8px 24px rgba(15, 23, 42, 0.18));
        transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-trigger:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-trigger:focus-visible {
        transform: translateY(-2px);
        background: var(--rb-sl-accent);
        color: #fff;
        outline: none;
      }
      #${SOY_LEON_ROOT_ID}.rb-sl-menu-open .rb-sl-trigger {
        background: var(--rb-sl-accent);
        color: #fff;
        transform: none;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-badge {
        position: absolute;
        top: -5px;
        right: -5px;
        min-width: 19px;
        height: 19px;
        padding: 0 5px;
        border: 2px solid var(--rb-sl-bg);
        border-radius: 999px;
        background: var(--rb-sl-accent);
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-speed-list {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(10px) scale(0.98);
        transform-origin: bottom right;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      #${SOY_LEON_ROOT_ID}.rb-sl-menu-open .rb-sl-speed-list {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-pill,
      #${SOY_LEON_ROOT_ID} .rb-sl-pill {
        min-height: 36px;
        padding: 8px 14px;
        border: 1px solid var(--rb-sl-border);
        border-radius: 999px;
        background: var(--rb-sl-bg);
        color: var(--rb-sl-text);
        box-shadow: var(--fl-shadow-md, 0 4px 14px rgba(15, 23, 42, 0.12));
        white-space: nowrap;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--rb-sl-muted);
        font-size: 12px;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-dot {
        width: 8px;
        height: 8px;
        flex: none;
        border-radius: 50%;
        background: var(--rb-sl-subtle);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-active { background: #2f8a5a; box-shadow: 0 0 0 3px rgba(47, 138, 90, 0.14); }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-warning { background: var(--rb-sl-accent); box-shadow: 0 0 0 3px rgba(255, 89, 0, 0.14); }
      #${SOY_LEON_ROOT_ID} .rb-sl-status-danger { background: #c0392b; box-shadow: 0 0 0 3px rgba(192, 57, 43, 0.14); }
      #${SOY_LEON_ROOT_ID} .rb-sl-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-pill:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-pill:focus-visible {
        transform: translateX(-3px);
        border-color: var(--rb-sl-accent);
        outline: none;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-pill-primary {
        border-color: var(--rb-sl-accent);
        background: var(--rb-sl-accent);
        color: #fff;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-pill-primary:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-pill-primary:focus-visible {
        background: var(--rb-sl-accent-dark);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-panel {
        position: fixed;
        top: max(72px, env(safe-area-inset-top));
        right: 16px;
        width: min(360px, calc(100vw - 32px));
        max-height: min(640px, calc(100vh - 88px));
        overflow: hidden;
        border: 1px solid var(--rb-sl-border);
        border-radius: var(--rb-sl-radius-lg);
        background: var(--rb-sl-bg);
        box-shadow: var(--fl-shadow-xl, 0 18px 46px rgba(15, 23, 42, 0.22));
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-panel-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 12px;
        border-bottom: 1px solid var(--rb-sl-border);
        background: var(--rb-sl-bg-soft);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-panel-header h2 {
        margin: 0;
        color: var(--rb-sl-text);
        font-size: 17px;
        line-height: 1.25;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-panel-header p {
        margin: 5px 0 0;
        color: var(--rb-sl-muted);
        font-size: 12px;
        line-height: 1.4;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-close {
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: var(--rb-sl-radius);
        background: transparent;
        color: var(--rb-sl-muted);
        cursor: pointer;
        font-size: 22px;
        line-height: 1;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-close:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-close:focus-visible {
        background: var(--rb-sl-border);
        color: var(--rb-sl-text);
        outline: none;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-panel-body {
        max-height: min(550px, calc(100vh - 168px));
        overflow-y: auto;
        padding: 10px;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 0 8px 8px;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend-item {
        padding: 3px 7px;
        border-radius: 999px;
        color: var(--rb-sl-text);
        font-size: 10px;
        font-weight: 700;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend-university { background: #f4d35e; color: #5c4700; }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend-busy { background: #c84b4b; color: #fff; }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend-service { background: #2f8a5a; color: #fff; }
      #${SOY_LEON_ROOT_ID} .rb-sl-legend-afi { background: var(--rb-sl-accent); color: #fff; }
      #${SOY_LEON_ROOT_ID} .rb-sl-section + .rb-sl-section {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--rb-sl-border);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-section h3 {
        margin: 4px 8px 6px;
        color: var(--rb-sl-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-section-conflict h3 {
        color: #b53b2f;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 12px;
        border: 1px solid transparent;
        border-radius: var(--rb-sl-radius);
        background: transparent;
        color: var(--rb-sl-text);
        cursor: pointer;
        text-align: left;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-result:focus-visible {
        border-color: var(--rb-sl-accent);
        background: var(--rb-sl-bg-soft);
        outline: none;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-conflict {
        border-color: #e6a39a;
        background: rgba(192, 57, 43, 0.06);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-conflict:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-result-conflict:focus-visible {
        border-color: #c0392b;
        background: rgba(192, 57, 43, 0.1);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-service {
        border-color: #9fd1b1;
        background: rgba(47, 138, 90, 0.06);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-service:hover,
      #${SOY_LEON_ROOT_ID} .rb-sl-result-service:focus-visible {
        border-color: #2f8a5a;
        background: rgba(47, 138, 90, 0.1);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-class {
        border-color: #e6cf77;
        background: rgba(244, 211, 94, 0.12);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-calendar {
        border-color: #cbd5e1;
        background: rgba(100, 116, 139, 0.08);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-afi {
        border-color: var(--rb-sl-border);
        background: var(--rb-sl-bg-soft);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result-date {
        color: var(--rb-sl-accent-dark);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result strong {
        font-size: 14px;
        line-height: 1.3;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-result span:last-child,
      #${SOY_LEON_ROOT_ID} .rb-sl-empty {
        color: var(--rb-sl-muted);
        font-size: 12px;
        line-height: 1.4;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-empty {
        margin: 8px;
        padding: 12px;
        border-radius: var(--rb-sl-radius);
        background: var(--rb-sl-bg-soft);
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-toast {
        position: absolute;
        right: calc(100% + 10px);
        bottom: 0;
        max-width: min(360px, calc(100vw - 32px));
        padding: 10px 14px;
        border: 1px solid var(--rb-sl-border);
        border-radius: var(--rb-sl-radius);
        background: var(--rb-sl-bg);
        color: var(--rb-sl-text);
        box-shadow: var(--fl-shadow-md, 0 4px 14px rgba(15, 23, 42, 0.14));
        font-size: 12px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      #${SOY_LEON_ROOT_ID} .rb-sl-toast-visible { opacity: 1; transform: translateY(0); }
      #${SOY_LEON_ROOT_ID} .rb-sl-toast-error { border-color: #e6a39a; color: #9d2f24; }
      #${SOY_LEON_ROOT_ID} .rb-sl-toast-success { border-color: #9fd1b1; color: #23683f; }
      .fl-event-card.rb-sl-compatible,
      .fl-agenda-event-card.rb-sl-compatible {
        outline: 2px solid var(--fl-orange-500, var(--fl-primary, #ff5900));
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(255, 89, 0, 0.12);
      }
      .fl-event-card.rb-sl-busy,
      .fl-agenda-event-card.rb-sl-busy {
        outline: 2px solid #c0392b;
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(192, 57, 43, 0.14);
      }
      .fl-event-card.rb-sl-service,
      .fl-agenda-event-card.rb-sl-service {
        outline: 2px solid #2f8a5a;
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(47, 138, 90, 0.14);
      }
      .fl-event-card.rb-sl-busy.rb-sl-service,
      .fl-agenda-event-card.rb-sl-busy.rb-sl-service {
        outline-color: #c0392b;
        box-shadow: 0 0 0 3px rgba(192, 57, 43, 0.14), inset 0 0 0 3px rgba(47, 138, 90, 0.55);
      }
      .fl-event-card.rb-sl-class,
      .fl-agenda-event-card.rb-sl-class {
        outline: 2px solid #c99700;
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(201, 151, 0, 0.14);
      }
      .fl-event-card.rb-sl-calendar,
      .fl-agenda-event-card.rb-sl-calendar {
        outline: 2px solid #64748b;
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.14);
      }
      .fl-event-card.rb-sl-registered,
      .fl-agenda-event-card.rb-sl-registered {
        outline: 2px solid #7b5fc0;
        outline-offset: 1px;
        box-shadow: 0 0 0 3px rgba(123, 95, 192, 0.16);
      }
      .fl-event-card-info.rb-sl-status-host,
      .fl-agenda-event-info.rb-sl-status-host {
        position: relative;
      }
      .rb-sl-status-badge {
        position: static;
        display: inline-flex;
        align-self: flex-start;
        grid-column: 1 / -1;
        box-sizing: border-box;
        max-width: 100%;
        margin: 0 0 8px;
        padding: 4px 7px;
        border-radius: 999px;
        background: var(--fl-orange-500, var(--fl-primary, #ff5900));
        color: #fff;
        font-family: var(--fl-font-body, system-ui, sans-serif);
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.18);
      }
      .rb-sl-compatible-badge { background: var(--fl-orange-500, var(--fl-primary, #ff5900)); }
      .rb-sl-busy-badge { background: #c0392b; }
      .rb-sl-service-badge { background: #2f8a5a; }
      .rb-sl-status-badge.rb-sl-busy-badge.rb-sl-service-badge { background: linear-gradient(135deg, #c0392b 0 50%, #2f8a5a 50% 100%); }
      .rb-sl-class-badge { background: #c99700; color: #232323; }
      .rb-sl-calendar-badge { background: #64748b; }
      .rb-sl-registered-badge { background: #7b5fc0; }
      .rb-sl-afi-badge { background: var(--fl-primary, #ff5900); }
      .rb-sl-conflict-badge {
        background: #c0392b;
      }
      .fl-event-card.rb-sl-focus,
      .fl-agenda-event-card.rb-sl-focus {
        animation: rb-sl-focus 1.1s ease-in-out 2;
      }
      @keyframes rb-sl-focus {
        50% { transform: translateY(-3px); box-shadow: 0 0 0 6px rgba(255, 89, 0, 0.18); }
      }
      body.rb-sl-panel-reserved {
        --rb-sl-dock-space: min(376px, calc(100vw - 16px));
      }
      @media (min-width: 900px) {
        body.rb-sl-panel-reserved .fl-events-container,
        body.rb-sl-panel-reserved .fl-agenda-container {
          width: calc(100% - var(--rb-sl-dock-space)) !important;
          max-width: none;
          transition: width 0.22s ease;
        }
        body.rb-sl-panel-reserved .fl-events-grid,
        body.rb-sl-panel-reserved .fl-agenda-events-list,
        body.rb-sl-panel-reserved #eventsCalendar {
          min-width: 0;
        }
      }
      @media (max-width: 899px) {
        #${SOY_LEON_ROOT_ID} { right: 16px; bottom: 16px; }
        body.rb-sl-panel-reserved .fl-events-container,
        body.rb-sl-panel-reserved .fl-agenda-container {
          width: auto !important;
        }
        #${SOY_LEON_ROOT_ID} .rb-sl-panel {
          top: auto;
          right: 12px;
          bottom: 76px;
          left: 12px;
          width: auto;
          max-height: min(64vh, 560px);
        }
        #${SOY_LEON_ROOT_ID} .rb-sl-panel-body { max-height: min(500px, calc(64vh - 86px)); }
        #${SOY_LEON_ROOT_ID} .rb-sl-toast { right: calc(100% + 8px); max-width: calc(100vw - 88px); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectStyles() {
    if (document.querySelector('#rb-after-class-styles')) return;
    const style = document.createElement('style');
    style.id = 'rb-after-class-styles';
    style.textContent = `
      /* Contenedor Flotante Bubble Menu (Zero-Obstruction UX) */
      .rb-bubble-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      }

      /* Botón Gatillo Flotante */
      .rb-bubble-trigger {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 2px solid #5f46a0;
        background: linear-gradient(135deg, #7b5fc0, #5f46a0);
        color: #ffffff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 20px rgba(95, 70, 160, 0.4);
        transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s, background 0.25s;
        position: relative;
        padding: 0;
      }
      .rb-bubble-trigger:hover {
        transform: scale(1.08);
        box-shadow: 0 8px 24px rgba(95, 70, 160, 0.55);
      }
      .rb-bubble-container.rb-menu-open .rb-bubble-trigger {
        transform: rotate(90deg);
        background: #e8622a;
        border-color: #cc4f1d;
        box-shadow: 0 6px 20px rgba(232, 98, 42, 0.45);
      }

      /* Badge de Contador / Alerta en Gatillo */
      .rb-trigger-badge {
        position: absolute;
        top: -3px;
        right: -3px;
        background: #e8622a;
        color: #ffffff;
        font-size: 11px;
        font-weight: 800;
        min-width: 19px;
        height: 19px;
        border-radius: 999px;
        display: none;
        align-items: center;
        justify-content: center;
        text-align: center;
        box-sizing: border-box;
        border: 2px solid #ffffff;
        line-height: 1;
        padding: 0 4px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      }
      .rb-trigger-badge.visible {
        display: flex;
      }
      .rb-trigger-badge.danger {
        background: #c84b4b;
        animation: rb-pulse 1.8s infinite;
      }
      @keyframes rb-pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.15); }
      }

      /* Lista de Píldoras Desplegables */
      .rb-bubble-pill-list {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(12px) scale(0.95);
        transform-origin: bottom right;
        transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .rb-bubble-container.rb-menu-open .rb-bubble-pill-list {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }

      /* Píldoras Rápidas (Pills) */
      .rb-bubble-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 16px;
        border-radius: 9999px;
        background: #ffffff;
        color: #232323;
        font-size: 13px;
        font-weight: 600;
        border: 1.5px solid #ede7f8;
        box-shadow: 0 4px 16px rgba(35, 35, 35, 0.12);
        cursor: pointer;
        transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.18s, border-color 0.18s, color 0.18s;
        white-space: nowrap;
        user-select: none;
      }
      .rb-bubble-pill:hover {
        transform: translateX(-4px) scale(1.02);
        border-color: #7b5fc0;
        background: #f8f5fd;
      }

      .rb-pill-status {
        cursor: default;
        background: #fdfaf7;
        font-size: 12px;
        color: #6b6560;
        border-color: #f2a46b;
      }
      .rb-pill-status:hover { transform: none; background: #fdfaf7; border-color: #f2a46b; }
      .rb-bubble-legend {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        max-width: 260px;
        padding: 4px 0;
      }
      .rb-bubble-legend-item {
        padding: 3px 7px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
      }
      .rb-bubble-legend-university { background: #f4d35e; color: #5c4700; }
      .rb-bubble-legend-busy { background: #c84b4b; color: #fff; }
      .rb-bubble-legend-service { background: #2f7d4f; color: #fff; }
      .rb-bubble-legend-afi { background: #e8622a; color: #fff; }
      .rb-bubble-legend-afi-registered { background: #7b5fc0; color: #fff; }
      .rb-pill-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #7b5fc0;
        flex: none;
      }
      .rb-pill-dot.active {
        background: #2f7d4f;
        box-shadow: 0 0 6px #2f7d4f;
      }
      .rb-pill-dot.danger {
        background: #c84b4b;
        box-shadow: 0 0 6px #c84b4b;
      }
      .rb-pill-dot.warning {
        background: #e8622a;
        box-shadow: 0 0 6px #e8622a;
      }

      .rb-pill-action.rb-pill-primary {
        background: linear-gradient(135deg, #7b5fc0, #5f46a0);
        color: #ffffff;
        border-color: #5f46a0;
      }
      .rb-pill-action.rb-pill-primary:hover {
        background: linear-gradient(135deg, #8c71d0, #6f54b0);
        color: #ffffff;
      }
      .rb-bubble-pill:disabled {
        opacity: 0.6;
        cursor: wait;
        transform: none !important;
      }

      /* Toasts flotantes transitorios */
      .rb-bubble-toast {
        position: fixed;
        bottom: 84px;
        right: 24px;
        z-index: 2147483646;
        padding: 9px 16px;
        border-radius: 9999px;
        background: #232323;
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
        opacity: 0;
        pointer-events: none;
        transform: translateY(10px);
        transition: opacity 0.25s ease, transform 0.25s ease;
        max-width: min(360px, calc(100vw - 48px));
        text-align: center;
      }
      .rb-bubble-toast.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .rb-bubble-toast.error {
        background: #a64d6d;
      }
      .rb-bubble-toast.success {
        background: #2f7d4f;
      }

      /* Resaltados de celdas en el calendario */
      .rb-after-class-cell {
        position: relative;
        outline: 3px solid #2f7d4f !important;
        outline-offset: -3px;
        background: #f0faef !important;
      }
      #content .rb-after-class-cell .spot-btn {
        border-color: #2f7d4f !important;
        background: #e1f3e2 !important;
        color: #24643e !important;
        font-weight: 700;
      }
      #content .rb-after-class-university-cell {
        outline: 3px solid #c99700 !important;
        outline-offset: -3px;
        background: #fff4c2 !important;
      }
      #content .rb-after-class-university-cell .spots,
      #content .rb-after-class-university-cell .spot {
        background: #fff4c2 !important;
      }
      #content .rb-after-class-university-cell .spot {
        border-color: #c99700 !important;
        color: #5c4700 !important;
      }
      #content .rb-after-class-busy-cell {
        outline: 3px solid #c84b4b !important;
        outline-offset: -3px;
        background: #ffe0e0 !important;
      }
      #content .rb-after-class-service-cell {
        outline: 3px solid #2f7d4f !important;
        outline-offset: -3px;
        background: #e8f7e9 !important;
      }
      #content .rb-after-class-afi-cell {
        outline: 3px solid #e8622a !important;
        outline-offset: -3px;
        background: #fff0e6 !important;
      }
      #content .rb-after-class-afi-registered-cell {
        outline: 3px solid #7b5fc0 !important;
        outline-offset: -3px;
        background: #ede7f8 !important;
      }
      #content .rb-after-class-university-cell.rb-after-class-afi-cell {
        background: linear-gradient(135deg, #fff4c2 0 70%, #fff0e6 70% 100%) !important;
      }
      #content .rb-after-class-university-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #fff4c2 0 50%, #ede7f8 50% 100%) !important;
      }
      #content .rb-after-class-university-cell.rb-after-class-afi-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #fff4c2 0 34%, #fff0e6 34% 67%, #ede7f8 67% 100%) !important;
      }
      #content .rb-after-class-university-cell.rb-after-class-busy-cell {
        background: linear-gradient(135deg, #fff4c2 0 50%, #ffe0e0 50% 100%) !important;
      }
      #content .rb-after-class-service-cell.rb-after-class-afi-cell {
        background: linear-gradient(135deg, #e8f7e9 0 70%, #fff0e6 70% 100%) !important;
      }
      #content .rb-after-class-busy-cell.rb-after-class-afi-cell {
        background: linear-gradient(135deg, #ffe0e0 0 70%, #fff0e6 70% 100%) !important;
      }
      #content .rb-after-class-service-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #e8f7e9 0 50%, #ede7f8 50% 100%) !important;
      }
      #content .rb-after-class-busy-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #ffe0e0 0 50%, #ede7f8 50% 100%) !important;
      }
      #content .rb-after-class-afi-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #fff0e6 0 50%, #ede7f8 50% 100%) !important;
      }
      #content .rb-after-class-service-cell.rb-after-class-afi-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #e8f7e9 0 34%, #fff0e6 34% 67%, #ede7f8 67% 100%) !important;
      }
      #content .rb-after-class-busy-cell.rb-after-class-afi-cell.rb-after-class-afi-registered-cell {
        background: linear-gradient(135deg, #ffe0e0 0 34%, #fff0e6 34% 67%, #ede7f8 67% 100%) !important;
      }
      .rb-after-class-occupancy-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin: 0 0 5px;
      }
      .rb-after-class-occupancy-badge {
        display: inline-block;
        padding: 3px 6px;
        border-radius: 6px;
        color: #232323;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
      }
      .rb-after-class-occupancy-badge-university { background: #f4d35e; }
      .rb-after-class-occupancy-badge-busy { background: #c84b4b; color: #fff; }
      .rb-after-class-occupancy-badge-service { background: #2f7d4f; color: #fff; }
      .rb-after-class-occupancy-badge-afi { background: #e8622a; color: #fff; }
      .rb-after-class-occupancy-badge-afi-registered { background: #7b5fc0; color: #fff; }
      .rb-after-class-occupancy-day-badge {
        display: block;
        margin: 3px 0 0;
        padding: 2px 5px;
        border-radius: 5px;
        background: #f4d35e;
        color: #5c4700;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
      }
      .rb-after-class-occupancy-day-badge-registered {
        background: #7b5fc0;
        color: #fff;
      }
      .rb-after-class-afi-day-badge {
        display: block;
        max-width: 100%;
        margin: 3px 0 0;
        padding: 2px 5px;
        border-radius: 5px;
        background: #e8622a;
        color: #fff;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rb-after-class-afi-day-badge-registered {
        background: #7b5fc0;
      }
      #content .mday.rb-after-class-university-day {
        border-color: #c99700 !important;
        background: #fff4c2 !important;
        box-shadow: inset 0 0 0 2px rgba(201, 151, 0, .22);
      }
      #content .mday.rb-after-class-busy-day {
        border-color: #c84b4b !important;
        background: #ffe0e0 !important;
        box-shadow: inset 0 0 0 2px rgba(200, 75, 75, .2);
      }
      #content .mday.rb-after-class-service-day {
        border-color: #2f7d4f !important;
        background: #e8f7e9 !important;
        box-shadow: inset 0 0 0 2px rgba(47, 125, 79, .18);
      }
      #content .mday.rb-after-class-afi-day {
        border-color: #e8622a !important;
        background: #fff0e6 !important;
      }
      #content .mday.rb-after-class-afi-registered-day {
        border-color: #7b5fc0 !important;
        background: #ede7f8 !important;
      }
      #content .mday.rb-after-class-afi-day.rb-after-class-afi-registered-day {
        background: linear-gradient(135deg, #fff0e6 0 50%, #ede7f8 50% 100%) !important;
      }
      #content table.week th.rb-after-class-afi-column {
        border-color: #e8622a !important;
        background: #fff0e6 !important;
        color: #7a3218 !important;
      }
      #content table.week th.rb-after-class-afi-registered-column {
        border-color: #7b5fc0 !important;
        background: #ede7f8 !important;
        color: #4d397d !important;
      }
      #content.rb-after-class-afi-day-view .rb-after-class-afi-banner {
        margin: 0 0 10px;
        padding: 8px 10px;
        border: 2px solid #e8622a;
        border-radius: 8px;
        background: #fff0e6;
        color: #7a3218;
        font-size: 12px;
        font-weight: 800;
      }
      #content.rb-after-class-afi-day-view .rb-after-class-afi-banner-registered {
        border-color: #7b5fc0;
        background: #ede7f8;
        color: #4d397d;
      }
      .rb-after-class-badge {
        margin: 0 0 5px;
        padding: 3px 6px;
        border-radius: 6px;
        background: #2f7d4f;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        text-align: center;
      }
      #content table.week .rb-after-class-invalid-column {
        background: #ede9fe !important;
        color: #5b21b6 !important;
      }
      #content table.week th.rb-after-class-invalid-column {
        background: #7c3aed !important;
        color: #fff !important;
      }
      #content .rb-after-class-invalid-cell {
        outline: 3px solid #7c3aed !important;
        outline-offset: -3px;
        background: #ede9fe !important;
      }
      .rb-after-class-invalid-badge {
        margin: 0 0 5px;
        padding: 3px 6px;
        border-radius: 6px;
        background: #7c3aed;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        text-align: center;
      }
      #content table.week .rb-after-class-calendar-blocked-column {
        background: #e2e8f0 !important;
        color: #475569 !important;
      }
      #content table.week th.rb-after-class-calendar-blocked-column {
        background: #64748b !important;
        color: #fff !important;
      }
      .rb-after-class-calendar-blocked-badge {
        display: block;
        margin: 3px 0 0;
        padding: 2px 5px;
        border-radius: 5px;
        background: #64748b;
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.2;
      }
      #content .mday.rb-after-class-calendar-blocked-day {
        border-color: #64748b !important;
        background: #e2e8f0 !important;
        box-shadow: inset 0 0 0 2px rgba(100, 116, 139, .2);
      }
      #content .mday.rb-after-class-calendar-blocked-day .num,
      #content .mday.rb-after-class-calendar-blocked-day .count {
        color: #475569 !important;
      }
      #content.rb-after-class-calendar-blocked-day-view {
        border: 3px solid #64748b !important;
        background: #f1f5f9 !important;
      }
      #content.rb-after-class-calendar-blocked-day-view .day-block {
        background: #e2e8f0 !important;
      }
      .rb-after-class-calendar-blocked-banner {
        margin: 6px;
        padding: 6px 9px;
        border-radius: 7px;
        background: #64748b;
        color: #fff;
        font-weight: 700;
        text-align: center;
      }
      #content .mday.rb-after-class-owned-day {
        border-color: #2f7d4f !important;
        background: #e8f7e9 !important;
        box-shadow: inset 0 0 0 2px rgba(47, 125, 79, .18);
      }
      #content .mday.rb-after-class-owned-day .num,
      #content .mday.rb-after-class-owned-day .count {
        color: #24643e !important;
      }
      .rb-after-class-owned-badge {
        align-self: flex-start;
        padding: 2px 6px;
        border-radius: 6px;
        background: #2f7d4f;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }

      /* Modales y Diálogos de Confirmación */
      #rb-after-class-dialog,
      #rb-after-class-confirmation,
      #rb-after-class-invalid-confirmation,
      #rb-after-class-replacement-confirmation {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 16px;
        background: rgba(35, 35, 35, .45);
        font: 14px/1.4 "Segoe UI", system-ui, sans-serif;
      }
      .rb-after-class-modal,
      .rb-after-class-confirm-modal {
        width: min(560px, 100%);
        max-height: calc(100vh - 32px);
        overflow: auto;
        padding: 18px;
        border-radius: 14px;
        background: #fff;
        color: #232323;
        box-shadow: 0 12px 40px rgba(0, 0, 0, .3);
      }
      .rb-after-class-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .rb-after-class-modal h2,
      .rb-after-class-confirm-modal h2 { margin: 0 0 8px; color: #5f46a0; font-size: 20px; }
      .rb-after-class-modal p { margin: 8px 0; }
      .rb-after-class-modal label { display: block; margin: 10px 0 4px; color: #5f46a0; font-weight: 700; }
      #rb-after-class-input {
        display: block;
        width: 100%;
        resize: vertical;
        padding: 9px;
        border: 1px solid #b7a3df;
        border-radius: 8px;
        font: 14px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .rb-after-class-example { color: #6b6560; font-size: 12px; }
      .rb-after-class-gap { display: flex !important; align-items: center; gap: 8px; }
      #rb-after-class-gap-input { width: 74px; padding: 6px; }
      .rb-after-class-import-box { margin: 12px 0; padding: 10px; border: 1px solid #b7a3df; border-radius: 9px; background: #f8f5fd; }
      .rb-after-class-import-box strong { color: #5f46a0; }
      .rb-busy-block-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; margin-bottom: 8px; }
      .rb-busy-block-grid label {
        display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 600; font-size: 12px; color: #232323;
        border: 1px solid #d9d7d5; border-radius: 8px; padding: 6px 8px; cursor: pointer;
      }
      .rb-busy-block-grid input { accent-color: #c84b4b; }
      .rb-busy-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .rb-busy-summary .chip {
        display: flex; align-items: center; gap: 6px; background: #ede7f8; color: #5f46a0;
        font-size: 12px; font-weight: 700; border-radius: 999px; padding: 5px 10px;
      }
      .rb-busy-summary .chip button { color: #5f46a0; font-weight: 800; }
      .rb-after-class-google-box { margin-bottom: 0; }
      .rb-busy-drawer-overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(35, 35, 35, 0);
        transition: background .25s ease;
      }
      .rb-busy-drawer-overlay.open { background: rgba(35, 35, 35, .45); }
      .rb-busy-drawer-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: min(420px, 100vw);
        background: #fff; color: #232323;
        box-shadow: -12px 0 40px rgba(0, 0, 0, .25);
        display: flex; flex-direction: column;
        transform: translateX(100%);
        transition: transform .25s ease;
        font: 14px/1.4 "Segoe UI", system-ui, sans-serif;
      }
      .rb-busy-drawer-overlay.open .rb-busy-drawer-panel { transform: translateX(0); }
      .rb-busy-drawer-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 16px 18px; border-bottom: 1px solid #ede7f8; flex: none;
      }
      .rb-busy-drawer-header h2 { margin: 0; color: #5f46a0; font-size: 18px; }
      .rb-busy-drawer-close { border: 0; background: transparent; font-size: 22px; line-height: 1; color: #6b6560; cursor: pointer; padding: 0 4px; }
      .rb-busy-drawer-body { flex: 1; overflow: auto; padding: 16px 18px; }
      .rb-busy-drawer-footer { padding: 14px 18px; border-top: 1px solid #ede7f8; display: flex; justify-content: flex-end; flex: none; }
      .rb-busy-mode-toggle { display: flex; gap: 6px; margin-bottom: 10px; }
      .rb-busy-mode-toggle button {
        flex: 1; border: 1px solid #b7a3df; border-radius: 999px; padding: 7px 10px;
        background: #fff; color: #5f46a0; font-size: 12px; font-weight: 700; cursor: pointer;
      }
      .rb-busy-mode-toggle button[aria-pressed="true"] { background: #7b5fc0; border-color: #5f46a0; color: #fff; }
      .rb-busy-legend { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 9px; }
      .rb-busy-legend-item { padding: 3px 7px; border-radius: 999px; font-size: 10px; font-weight: 800; }
      .rb-busy-legend-university { background: #f4d35e; color: #5c4700; }
      .rb-busy-legend-busy { background: #c84b4b; color: #fff; }
      .rb-busy-week-grid-wrap { overflow-x: auto; margin: 8px 0 12px; }
      .rb-busy-week-grid { border-collapse: collapse; width: 100%; min-width: 340px; }
      .rb-busy-week-grid th, .rb-busy-week-grid td { border: 1px solid #ede7f8; padding: 3px; text-align: center; }
      .rb-busy-week-grid thead th { background: #f8f5fd; color: #5f46a0; font-size: 11px; font-weight: 700; padding: 6px 4px; }
      .rb-busy-week-grid tbody th { background: #f8f5fd; color: #5f46a0; font-size: 11px; font-weight: 700; white-space: nowrap; padding: 4px 6px; }
      .rb-busy-cell { width: 100%; height: 26px; border: 0; border-radius: 5px; background: #f3f0ec; cursor: pointer; padding: 0; }
      .rb-busy-cell:hover { background: #ede7f8; }
      .rb-busy-cell.university { background: #fff4c2; box-shadow: inset 0 0 0 2px #c99700; }
      .rb-busy-cell.active { background: #c84b4b; box-shadow: inset 0 0 0 2px #a93333; }
      .rb-busy-cell.university.active { background: linear-gradient(135deg, #f4d35e 0 50%, #c84b4b 50% 100%); box-shadow: inset 0 0 0 2px #8f2d2d; }
      .rb-busy-date-option { border-color: #d9d7d5 !important; background: #f3f0ec !important; }
      .rb-busy-date-option.university { border-color: #c99700 !important; background: #fff4c2 !important; color: #5c4700 !important; }
      .rb-busy-date-option.active { border-color: #a93333 !important; background: #ffe0e0 !important; color: #8f2d2d !important; }
      .rb-busy-date-option.university.active { background: linear-gradient(135deg, #fff4c2 0 50%, #ffe0e0 50% 100%) !important; }
      #rb-busy-date-input,
      #rb-busy-label-input {
        display: block; width: 100%; box-sizing: border-box; padding: 8px; margin: 6px 0 10px;
        border: 1px solid #b7a3df; border-radius: 8px; font: 13px/1.4 "Segoe UI", system-ui, sans-serif;
      }
      #rb-after-class-google-client-id { display: block; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #b7a3df; border-radius: 8px; font: 12px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .rb-after-class-file { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .rb-after-class-error { min-height: 20px; margin-top: 8px; color: #a64d6d; font-weight: 600; }
      .rb-after-class-import-ok { min-height: 20px; margin-top: 8px; color: #2f7d4f; font-weight: 600; }
      .rb-after-class-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .rb-after-class-actions button,
      .rb-after-class-import-box button {
        border: 1px solid #d9d7d5;
        border-radius: 999px;
        padding: 7px 11px;
        background: #fff;
        color: #6b6560;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
      }
      .rb-after-class-primary { border-color: #5f46a0 !important; background: #7b5fc0 !important; color: #fff !important; }
      .rb-after-class-danger { border-color: #a93333 !important; background: #c84b4b !important; color: #fff !important; }
      .rb-after-class-actions button:disabled { cursor: wait; opacity: .6; }
      .rb-after-class-confirm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin: 14px 0; }
      .rb-after-class-confirm-grid div { padding: 9px; border: 1px solid #ede7f8; border-radius: 9px; background: #f8f5fd; }
      .rb-after-class-confirm-grid span { display: block; color: #6b6560; font-size: 11px; }
      .rb-after-class-confirm-grid strong { display: block; margin-top: 2px; color: #5f46a0; }
      .rb-after-class-confirm-message { min-height: 22px; margin: 8px 0; color: #6b6560; }
      .rb-after-class-confirm-error { color: #a64d6d; font-weight: 700; }
      .rb-after-class-close {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        padding: 0 3px;
      }
      @media (max-width: 600px) {
        .rb-bubble-container { right: 16px; bottom: 16px; }
        .rb-after-class-confirm-grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.append(style);
  }
})();

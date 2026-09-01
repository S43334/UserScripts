// ==UserScript==
// @name         SIU Anáhuac · Exportar horario a JSON
// @namespace    https://reg-prod.ban.anahuac.mx/
// @version      1.0.0
// @description  Extrae el horario de clases del SIU y descarga un JSON compatible con Registro Becario.
// @match        https://reg-prod.ban.anahuac.mx/StudentRegistrationSsb/ssb/classRegistration/classRegistration*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    panelId: 'anahuac-siu-json-exporter',
    styleId: 'anahuac-siu-json-exporter-styles',
    defaultOwner: 'Mi horario',
    timezone: 'America/Mexico_City',
    // El userscript de Registro Becario usa este rango para el semestre actual.
    // Si el SIU muestra otro semestre, el JSON conserva el rango real y avisa que
    // habrá que actualizarlo antes de importarlo.
    compatibleSemester: {
      start: '2026-08-10',
      end: '2026-12-04',
    },
  };

  const DAY_NAMES = {
    lun: 1,
    lunes: 1,
    mar: 2,
    martes: 2,
    mie: 3,
    miercoles: 3,
    mié: 3,
    miércoles: 3,
    jue: 4,
    jueves: 4,
    vie: 5,
    viernes: 5,
    sab: 6,
    sabado: 6,
    sáb: 6,
    sábado: 6,
    dom: 7,
    domingo: 7,
  };

  const DAY_LABELS = {
    1: 'Lun',
    2: 'Mar',
    3: 'Mié',
    4: 'Jue',
    5: 'Vie',
    6: 'Sáb',
    7: 'Dom',
  };

  const TIME_RANGE_PATTERN = /(\d{1,2}:\d{2})\s*(?:-|–|—|a)\s*(\d{1,2}:\d{2})/gi;
  const COURSE_MARKERS = /Inicio\s+de\s+la\s+clase\s*:/i;

  let panel = null;
  let lastExportText = '';

  function init() {
    if (!document.body || document.getElementById(CONFIG.panelId)) return;
    installStyles();
    panel = createPanel();
    document.body.appendChild(panel.root);
  }

  function installStyles() {
    if (document.getElementById(CONFIG.styleId)) return;

    const style = document.createElement('style');
    style.id = CONFIG.styleId;
    style.textContent = `
      #${CONFIG.panelId} {
        position: fixed;
        z-index: 2147483646;
        right: 18px;
        bottom: 18px;
        width: min(360px, calc(100vw - 36px));
        box-sizing: border-box;
        padding: 14px;
        border: 1px solid #8b5cc7;
        border-radius: 12px;
        background: #fffdfb;
        color: #263238;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .22);
        font: 14px/1.4 Arial, sans-serif;
      }
      #${CONFIG.panelId} h2 {
        margin: 0 0 6px;
        color: #6d3ca6;
        font-size: 16px;
      }
      #${CONFIG.panelId} p {
        margin: 6px 0 10px;
      }
      #${CONFIG.panelId} .siu-json-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${CONFIG.panelId} button {
        padding: 8px 11px;
        border: 0;
        border-radius: 8px;
        color: #fff;
        background: #6d3ca6;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      #${CONFIG.panelId} button.secondary {
        color: #5b3a76;
        background: #eee5f8;
      }
      #${CONFIG.panelId} button:disabled {
        cursor: default;
        opacity: .55;
      }
      #${CONFIG.panelId} .siu-json-status {
        color: #455a64;
      }
      #${CONFIG.panelId} .siu-json-status.error {
        color: #b3261e;
      }
      #${CONFIG.panelId} .siu-json-status.success {
        color: #1b6e3c;
      }
      #${CONFIG.panelId} details {
        margin-top: 9px;
      }
      #${CONFIG.panelId} summary {
        cursor: pointer;
        color: #6d3ca6;
        font-weight: 700;
      }
      #${CONFIG.panelId} pre {
        max-height: 180px;
        overflow: auto;
        margin: 7px 0 0;
        padding: 8px;
        border-radius: 6px;
        background: #f4f1f6;
        font-size: 11px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const root = document.createElement('aside');
    root.id = CONFIG.panelId;
    root.setAttribute('aria-label', 'Exportador de horario SIU');

    const title = document.createElement('h2');
    title.textContent = 'Horario SIU → JSON';

    const description = document.createElement('p');
    description.textContent = 'Lee las materias de esta página y genera un archivo para el userscript de Registro Becario.';

    const status = document.createElement('p');
    status.className = 'siu-json-status';
    status.textContent = 'Listo. No realiza inscripciones ni envía información a otro sitio.';

    const actions = document.createElement('div');
    actions.className = 'siu-json-actions';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = 'Escanear y descargar';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'secondary';
    copyButton.textContent = 'Copiar JSON';
    copyButton.disabled = true;

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Vista previa';
    const preview = document.createElement('pre');
    preview.hidden = true;
    details.append(summary, preview);

    actions.append(downloadButton, copyButton);
    root.append(title, description, status, actions, details);

    downloadButton.addEventListener('click', () => {
      downloadButton.disabled = true;
      copyButton.disabled = true;
      setStatus(status, 'Escaneando materias y horarios…');

      window.setTimeout(() => {
        try {
          const result = extractSchedule();
          if (!result.payload.courses.length) {
            throw new Error('No encontré bloques de materias. Verifica que estás en Horario y que las materias estén desplegadas.');
          }
          if (!result.payload.classes.length) {
            throw new Error('Encontré materias, pero no pude identificar sus días y horas activos. Despliega las materias y vuelve a intentar.');
          }

          lastExportText = JSON.stringify(result.payload, null, 2);
          preview.textContent = lastExportText;
          preview.hidden = false;
          copyButton.disabled = false;
          downloadJson(lastExportText, result.fileName);

          const warningText = result.warnings.length
            ? ` Avisos: ${result.warnings.join(' ')}`
            : '';
          setStatus(
            status,
            `Listo: ${result.payload.courses.length} materias y ${result.payload.classes.length} bloques exportados.${warningText}`,
            result.warnings.length ? 'success' : 'success',
          );
        } catch (error) {
          lastExportText = '';
          preview.textContent = '';
          preview.hidden = true;
          setStatus(status, error instanceof Error ? error.message : 'No se pudo extraer el horario.', 'error');
        } finally {
          downloadButton.disabled = false;
        }
      }, 0);
    });

    copyButton.addEventListener('click', async () => {
      if (!lastExportText) return;
      try {
        await navigator.clipboard.writeText(lastExportText);
        setStatus(status, 'JSON copiado al portapapeles.', 'success');
      } catch (error) {
        setStatus(status, 'El navegador no permitió copiarlo; usa la descarga o selecciona la vista previa.', 'error');
      }
    });

    return { root, status };
  }

  function setStatus(node, message, kind) {
    node.textContent = message;
    node.classList.remove('error', 'success');
    if (kind) node.classList.add(kind);
  }

  function extractSchedule() {
    const containers = findCourseContainers();
    const warnings = [];
    const courses = [];

    containers.forEach((container, index) => {
      const course = parseCourse(container, index);
      if (!course) return;
      courses.push(course);
      if (!course.sessions.length) {
        warnings.push(`No se pudo leer el horario de “${course.name || `materia ${index + 1}`}”.`);
      } else if (course.unresolvedRows) {
        warnings.push(`No se identificó el día activo en ${course.unresolvedRows} fila(s) de “${course.name}”.`);
      }
    });

    const allDates = courses.flatMap((course) => [course.startDate, course.endDate]).filter(Boolean).sort();
    const siuSemester = allDates.length
      ? { start: allDates[0], end: allDates[allDates.length - 1] }
      : { ...CONFIG.compatibleSemester };
    const semester = chooseImportSemester(siuSemester);

    const classes = deduplicateClasses(courses.flatMap((course) => (
      course.sessions.map((session) => ({
        weekday: session.weekday,
        start: session.normalizedStart,
        end: session.normalizedEnd,
        name: course.shortName,
        course: course.name,
        courseCode: course.courseCode,
        rawStart: session.start,
        rawEnd: session.end,
      }))
    )));

    if (semester.start !== siuSemester.start || semester.end !== siuSemester.end) {
      warnings.push(`El rango SIU es ${siuSemester.start} a ${siuSemester.end}; el campo compatible quedó en ${semester.start} a ${semester.end}.`);
    }
    if (containers.length && courses.length < containers.length) {
      warnings.push('Algunos bloques de materias no pudieron interpretarse.');
    }

    const payload = {
      version: 1,
      owner: inferOwner() || CONFIG.defaultOwner,
      timezone: CONFIG.timezone,
      semester,
      siuSemester,
      source: 'SIU Anáhuac · Inscripción de clases',
      sourceUrl: window.location.href,
      exportedAt: new Date().toISOString(),
      classes,
      courses,
    };

    return {
      payload,
      warnings: uniqueStrings(warnings),
      fileName: `horario_siu_anahuac_${todayForFileName()}.json`,
    };
  }

  function chooseImportSemester(siuSemester) {
    const isKnownCurrentSemester = siuSemester.start === CONFIG.compatibleSemester.start
      && (siuSemester.end === CONFIG.compatibleSemester.end || siuSemester.end === '2026-12-05');
    return isKnownCurrentSemester ? { ...CONFIG.compatibleSemester } : { ...siuSemester };
  }

  function findCourseContainers() {
    const elements = [document.body, ...document.body.querySelectorAll('*')];
    const candidates = elements.filter((element) => {
      if (!element || !element.textContent) return false;
      const text = normalizeText(element.textContent);
      return text.length >= 80
        && text.length <= 7000
        && COURSE_MARKERS.test(text)
        && /Fin\s+de\s+la\s+clase\s*:/i.test(text)
        && /\bNRC\s*:/i.test(text)
        && /\d{1,2}:\d{2}\s*(?:-|–|—|a)\s*\d{1,2}:\d{2}/i.test(text)
        && countMatches(text, /\bNRC\s*:/gi) === 1;
    });

    // Conserva el elemento más pequeño que contiene la ficha completa. Esto
    // evita duplicar el mismo curso por sus divs/padres anidados.
    const smallest = candidates
      .sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length)
      .filter((element, index, list) => !list.some((other, otherIndex) => (
        otherIndex !== index && element.contains(other)
      )));

    return smallest
      .sort((a, b) => compareDomOrder(a, b));
  }

  function parseCourse(container, index) {
    const text = normalizeText(container.textContent);
    const title = parseCourseTitle(text);
    const startDate = extractLabeledDate(text, 'Inicio\\s+de\\s+la\\s+clase');
    const endDate = extractLabeledDate(text, 'Fin\\s+de\\s+la\\s+clase');
    const courseLabel = title.courseLabel;
    const codeMatch = courseLabel.match(/^([A-ZÁÉÍÓÚÑ0-9]+)\s*-/i);
    const courseCode = codeMatch ? codeMatch[1].toUpperCase() : firstWord(courseLabel);
    const sectionMatch = courseLabel.match(/Secci[oó]n\s*([A-Za-z0-9-]+)/i);
    const status = /\bInscrito\b/i.test(text) ? 'Inscrito' : '';
    const sessionResult = extractSessions(container);
    const shortName = deriveShortName(title.courseName, courseLabel, courseCode);

    return {
      order: index + 1,
      name: title.courseName || title.courseLabel || `Materia ${index + 1}`,
      shortName,
      courseCode,
      courseLabel,
      section: sectionMatch ? sectionMatch[1] : '',
      nrc: firstCapture(text, /\bNRC\s*:\s*([A-Za-z0-9-]+)/i),
      status,
      startDate,
      endDate,
      instructor: cleanInstructor(extractField(text, 'Instructor', ['NRC'])),
      location: extractField(text, 'Ubicaci[oó]n', ['Edificio', 'Sal[oó]n', 'Instructor', 'NRC']),
      building: extractField(text, 'Edificio', ['Sal[oó]n', 'Instructor', 'NRC']),
      room: extractField(text, 'Sal[oó]n', ['Instructor', 'NRC']),
      unresolvedRows: sessionResult.unresolvedRows,
      sessions: sessionResult.sessions,
    };
  }

  function parseCourseTitle(text) {
    const markerIndex = text.search(/Inicio\s+de\s+la\s+clase\s*:/i);
    const prefix = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
    const parts = prefix.split('|').map(normalizeText).filter(Boolean);
    const courseName = (parts[0] || '').replace(/\bInscrito\b/gi, '').trim();
    const courseLabel = (parts[1] || '').replace(/\bInscrito\b/gi, '').trim();
    return { courseName, courseLabel };
  }

  function extractSessions(container) {
    const timeElements = collectTimeElements(container);
    const sessions = [];
    let unresolvedRows = 0;

    timeElements.forEach((timeElement) => {
      const ranges = extractTimeRanges(timeElement.textContent);
      if (!ranges.length) return;
      const range = ranges[0];
      const scope = findDayScope(timeElement, container);
      let dayNodes = collectDayNodes(scope);
      let selectedDays = selectActiveDays(dayNodes);

      if (!selectedDays.length && scope !== container) {
        dayNodes = collectDayNodes(container);
        selectedDays = selectActiveDays(dayNodes);
      }

      if (!selectedDays.length) {
        unresolvedRows += 1;
        return;
      }

      selectedDays.forEach((weekday) => {
        const normalized = normalizeSessionRange(range.start, range.end);
        sessions.push({
          weekday,
          day: DAY_LABELS[weekday],
          start: range.start,
          end: range.end,
          normalizedStart: normalized.start,
          normalizedEnd: normalized.end,
        });
      });
    });

    const uniqueSessions = deduplicateSessions(sessions);
    return { sessions: uniqueSessions, unresolvedRows };
  }

  function collectTimeElements(container) {
    const elements = [container, ...container.querySelectorAll('*')];
    const candidates = elements.filter((element) => {
      const text = normalizeText(element.textContent);
      return text.length > 0 && text.length <= 320 && extractTimeRanges(text).length === 1;
    });

    return candidates
      .sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length)
      .filter((element, index, list) => !list.some((other, otherIndex) => (
        otherIndex !== index && element.contains(other)
      )));
  }

  function findDayScope(timeElement, container) {
    let current = timeElement.parentElement;
    let fallback = container;
    while (current && current !== document.body) {
      if (collectDayNodes(current).length) return current;
      fallback = current;
      if (current === container) break;
      current = current.parentElement;
    }
    return fallback;
  }

  function collectDayNodes(scope) {
    if (!scope) return [];
    const elements = [...scope.querySelectorAll('*')];
    const exact = elements.filter((element) => {
      const text = normalizeText(element.textContent);
      return text.length <= 10 && dayNumber(text) && element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE';
    });

    return exact.filter((element, index, list) => !list.some((other, otherIndex) => (
      otherIndex !== index && element.contains(other)
    )));
  }

  function selectActiveDays(dayNodes) {
    if (!dayNodes.length) return [];

    const explicit = dayNodes
      .filter(isExplicitlySelected)
      .map((node) => dayNumber(node.textContent));
    if (explicit.length) return uniqueNumbers(explicit).sort((a, b) => a - b);

    const visual = dayNodes
      .filter((node) => isVisuallySelected(node, dayNodes))
      .map((node) => dayNumber(node.textContent));
    return uniqueNumbers(visual).sort((a, b) => a - b);
  }

  function isExplicitlySelected(node) {
    let current = node;
    for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
      const classText = typeof current.className === 'string'
        ? current.className
        : current.getAttribute('class') || '';
      const normalizedClass = normalizeKey(classText);
      if (/(^|[\s_-])(active|selected|checked|chosen|current)(?:$|[\s_-])/.test(normalizedClass)
        || /(active|selected)(?:day|date)/.test(normalizedClass)) {
        return true;
      }
      if (current.getAttribute('aria-selected') === 'true'
        || current.getAttribute('aria-pressed') === 'true'
        || current.getAttribute('data-selected') === 'true'
        || current.getAttribute('data-active') === 'true') {
        return true;
      }
    }
    return false;
  }

  function isVisuallySelected(node, dayNodes) {
    if (typeof window.getComputedStyle !== 'function') return false;
    const ownStyle = window.getComputedStyle(node);
    if (isWarmColor(ownStyle.backgroundColor) || isWarmColor(ownStyle.borderColor)) return true;

    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 2; depth += 1, parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (isWarmColor(style.backgroundColor) || isWarmColor(style.borderColor)) return true;
    }

    // Algunos controles no usan la clase active, pero sí cambian el fondo.
    // Solo se usa esta comparación si existe una diferencia clara entre hermanos.
    const signatures = dayNodes.map((item) => {
      const style = window.getComputedStyle(item);
      return `${style.backgroundColor}|${style.borderColor}|${style.color}`;
    });
    const ownSignature = signatures[dayNodes.indexOf(node)];
    const frequency = signatures.filter((signature) => signature === ownSignature).length;
    return frequency < Math.ceil(dayNodes.length / 2) && ownSignature !== 'rgba(0, 0, 0, 0)|rgba(0, 0, 0, 0)|rgb(0, 0, 0)';
  }

  function isWarmColor(value) {
    const match = String(value || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!match || match[4] === '0') return false;
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return red >= 150 && red > green * 1.18 && red > blue * 1.18;
  }

  function extractTimeRanges(value) {
    const text = String(value || '');
    return [...text.matchAll(TIME_RANGE_PATTERN)].map((match) => ({
      start: normalizeClock(match[1]),
      end: normalizeClock(match[2]),
    })).filter((range) => range.start && range.end && clockMinutes(range.end) > clockMinutes(range.start));
  }

  function normalizeSessionRange(start, end) {
    const startMinutes = clockMinutes(start);
    const endMinutes = clockMinutes(end);
    const normalizedStart = minutesToClock(Math.floor(startMinutes / 30) * 30);
    const normalizedEnd = minutesToClock(Math.ceil(endMinutes / 30) * 30);
    return {
      start: normalizedStart,
      end: normalizedEnd === normalizedStart
        ? minutesToClock(startMinutes + 30)
        : normalizedEnd,
    };
  }

  function normalizeClock(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function clockMinutes(value) {
    const normalized = normalizeClock(value);
    if (!normalized) return NaN;
    const [hour, minute] = normalized.split(':').map(Number);
    return hour * 60 + minute;
  }

  function minutesToClock(value) {
    const minutes = Math.max(0, Math.min(24 * 60, Number(value)));
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function dayNumber(value) {
    const key = normalizeKey(value);
    return DAY_NAMES[key] || 0;
  }

  function parseSiuDate(value) {
    const text = normalizeText(value);
    let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) return validISODate(Number(match[3]), Number(match[2]), Number(match[1]));
    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) return validISODate(Number(match[1]), Number(match[2]), Number(match[3]));
    return '';
  }

  function validISODate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function extractLabeledDate(text, labelPattern) {
    const expression = new RegExp(`${labelPattern}\\s*[:：]\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2})`, 'i');
    const match = text.match(expression);
    return match ? parseSiuDate(match[1]) : '';
  }

  function extractField(text, labelPattern, stopLabels) {
    const stops = stopLabels.length
      ? `(?=\\s+(?:${stopLabels.join('|')})\\s*:)`
      : '$';
    const expression = new RegExp(`${labelPattern}\\s*[:：]\\s*(.*?)${stops}`, 'i');
    const match = text.match(expression);
    return match ? normalizeText(match[1]).replace(/\s*\|\s*$/, '') : '';
  }

  function cleanInstructor(value) {
    return normalizeText(value).replace(/\s*\(Principal\)\s*/gi, '').trim();
  }

  function deriveShortName(courseName, courseLabel, courseCode) {
    const key = normalizeKey(`${courseName} ${courseLabel} ${courseCode}`);
    if (key.includes('habilidades para el emprendimiento') || key.includes('emprendimiento')) return 'EMP';
    if (key.includes('calculo multivariado') || key.includes(' mat-')) return 'MAT';
    if (key.includes('estatica') || key.includes(' fis-')) return 'FIS';
    if (key.includes('electronica digital') || key.includes(' sis-')) return 'SIS';
    if (key.includes('formacion universitaria') || key.includes(' cul-')) return 'CUL';
    if (key.includes('liderazgo') || key.includes(' ldr-')) return 'LDR';
    if (key.includes('inteligencia artificial')) return 'IA';
    if (courseCode) return courseCode.slice(0, 8).toUpperCase();
    return initials(courseName) || 'CLASE';
  }

  function initials(value) {
    return normalizeText(value)
      .split(/\s+/)
      .filter((word) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(word))
      .slice(0, 4)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }

  function inferOwner() {
    const text = normalizeText(document.body.textContent);
    const match = text.match(/(?:Nombre\s+del\s+(?:alumno|estudiante)|Alumno|Estudiante)\s*:\s*([^|\n]{3,80})/i);
    return match ? normalizeText(match[1]) : '';
  }

  function deduplicateSessions(sessions) {
    const seen = new Set();
    return sessions
      .filter((session) => {
        const key = `${session.weekday}|${session.start}|${session.end}|${session.normalizedStart}|${session.normalizedEnd}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.weekday - b.weekday || clockMinutes(a.start) - clockMinutes(b.start));
  }

  function deduplicateClasses(classes) {
    const seen = new Set();
    return classes
      .filter((entry) => {
        const key = `${entry.weekday}|${entry.start}|${entry.end}|${entry.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.weekday - b.weekday || clockMinutes(a.start) - clockMinutes(b.start));
  }

  function firstCapture(text, expression) {
    const match = text.match(expression);
    return match ? normalizeText(match[1]) : '';
  }

  function firstWord(value) {
    return normalizeText(value).split(/\s+/)[0] || '';
  }

  function countMatches(text, expression) {
    return [...text.matchAll(expression)].length;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeKey(value) {
    return normalizeText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function uniqueNumbers(values) {
    return [...new Set(values.filter((value) => Number.isInteger(value)))];
  }

  function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function compareDomOrder(a, b) {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function todayForFileName() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function downloadJson(text, fileName) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

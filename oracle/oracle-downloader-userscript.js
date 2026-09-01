// ==UserScript==
// @name         Oracle Academy - Course PDF Downloader
// @namespace    https://academy.oracle.com/
// @version      2.0.13
// @description  Escanea un curso Oracle Academy y descarga los PDFs bajo oracle/ con selección de secciones y lecciones.
// @match        https://academy.oracle.com/*
// @match        https://*.oracle.com/pls/r/oracle/oa-student-hub/*
// @run-at       document-idle
// @noframes
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        rootName: 'oracle',
        panelId: 'oracle-pdf-downloader-panel',
        dbName: 'oracle-pdf-downloader',
        dbVersion: 1,
        dbStore: 'folder-handles',
        folderHandleKeyPrefix: 'course:',
        sectionConcurrency: 2,
        lessonConcurrency: 3,
        downloadConcurrency: 3,
        downloadDelayMs: 250,
        pdfRetries: 3,
        retryDelayMs: 900,
        maxNameLength: 150,
    };

    const state = {
        running: false,
        abortController: null,
        parentHandle: null,
        oracleHandle: null,
        destinationKey: '',
        report: null,
        selectedLessonIds: new Set(),
        runSummary: {
            selectedLessons: 0,
            processedLessons: 0,
            includedPdfs: 0,
            existingPdfs: 0,
            skippedLessons: 0,
            failures: 0,
        },
        ui: null,
    };

    // ── Utilidades generales ───────────────────────────────────────────────────

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function getInputValue(doc, id) {
        const input = doc?.getElementById(id);
        return input ? cleanText(input.value || input.getAttribute('value')) : '';
    }

    function sanitizeName(value, fallback) {
        const safeFallback = fallback || 'Sin nombre';
        let result = String(value || '')
            .normalize('NFC')
            .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[. ]+$/g, '');

        if (!result) {
            result = safeFallback;
        }

        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) {
            result = '_' + result;
        }

        result = result.slice(0, CONFIG.maxNameLength).replace(/[. ]+$/g, '');
        return result || safeFallback;
    }

    function sanitizeFileName(value, fallback) {
        const raw = String(value || '').split(/[\\/]/).pop();
        return sanitizeName(raw, fallback || 'documento.pdf');
    }

    function ensurePdfExtension(value) {
        const name = sanitizeFileName(value, 'documento.pdf');
        return /\.pdf$/i.test(name) ? name : name + '.pdf';
    }

    function hasPdfHeader(buffer) {
        const bytes = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer || 0);
        return bytes.byteLength >= 5
            && bytes[0] === 0x25
            && bytes[1] === 0x50
            && bytes[2] === 0x44
            && bytes[3] === 0x46
            && bytes[4] === 0x2d;
    }

    async function fileHasPdfHeader(file) {
        if (!file || file.size < 5) {
            return false;
        }
        return hasPdfHeader(new Uint8Array(await file.slice(0, 5).arrayBuffer()));
    }

    function fileKey(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function safePathSegments(relativePath) {
        const rawPath = String(relativePath || '').replace(/\\/g, '/');
        if (!rawPath || rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
            throw new Error('Ruta relativa no válida.');
        }

        return rawPath.split('/').filter(Boolean).map((rawSegment) => {
            if (rawSegment === '.' || rawSegment === '..') {
                throw new Error('Ruta relativa no válida.');
            }
            const segment = sanitizeName(rawSegment, 'sin-nombre');
            if (!segment || segment === '.' || segment === '..') {
                throw new Error('Ruta relativa no válida.');
            }
            return segment;
        });
    }

    function resolveUrl(rawUrl, baseUrl) {
        if (!rawUrl || rawUrl === '#') {
            return '';
        }

        try {
            const url = new URL(rawUrl, baseUrl || window.location.href);
            if (url.origin !== window.location.origin) {
                return '';
            }
            return url.href;
        } catch (error) {
            return '';
        }
    }

    function getOracleRouteValue(rawUrl, itemName, baseUrl) {
        const resolved = resolveUrl(rawUrl, baseUrl);
        if (!resolved) {
            return '';
        }

        try {
            const route = new URL(resolved).searchParams.get('p') || '';
            const marker = '::::' + String(itemName || '').toUpperCase();
            const start = route.toUpperCase().indexOf(marker);
            if (start < 0) {
                return '';
            }
            const valueStart = route.indexOf(':', start + marker.length);
            if (valueStart < 0) {
                return '';
            }
            return route.slice(valueStart + 1).split(',')[0] || '';
        } catch (error) {
            return '';
        }
    }

    function routeKey(rawUrl, baseUrl) {
        const resolved = resolveUrl(rawUrl, baseUrl);
        if (!resolved) {
            return '';
        }

        try {
            const url = new URL(resolved);
            const route = url.searchParams.get('p') || url.pathname;
            return url.origin + url.pathname + '|' + route;
        } catch (error) {
            return resolved.replace(/[?&]cs=[^&]+$/i, '');
        }
    }

    function sleep(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    function isAbortError(error) {
        return Boolean(error && (
            error.name === 'AbortError'
            || /aborted|cancelled|canceled/i.test(error.message || '')
        ));
    }

    function filesystemError(error, stage) {
        const originalName = error?.name ? ' [' + error.name + ']' : '';
        const originalMessage = error?.message || String(error);
        const wrapped = new Error('FSA ' + stage + ': ' + originalMessage + originalName);
        wrapped.name = error?.name || 'Error';
        wrapped.cause = error;
        return wrapped;
    }

    async function mapWithConcurrency(items, limit, worker, onProgress) {
        const results = new Array(items.length);
        let cursor = 0;
        let completed = 0;

        async function runWorker() {
            while (true) {
                const index = cursor;
                cursor += 1;
                if (index >= items.length) {
                    return;
                }

                try {
                    results[index] = await worker(items[index], index);
                } catch (error) {
                    if (isAbortError(error)) {
                        throw error;
                    }
                    const input = items[index];
                    results[index] = {
                        ...(input && typeof input === 'object' ? input : {}),
                        error,
                    };
                }

                completed += 1;
                if (onProgress) {
                    onProgress(index, results[index], completed);
                }
            }
        }

        const workerCount = Math.min(
            Math.max(1, Number(limit) || 1),
            Math.max(1, items.length)
        );
        await Promise.all(Array.from({ length: workerCount }, runWorker));
        return results;
    }

    // ── Datos del curso y extracción HTML ──────────────────────────────────────

    function getCourseKey(doc = document) {
        return getInputValue(doc, 'P14_ID')
            || getInputValue(doc, 'P14_CLASS_COURSE_ID')
            || getInputValue(doc, 'P14_COURSE_ID')
            || cleanText(new URL(window.location.href).searchParams.get('p'))
            || window.location.pathname;
    }

    function extractCourseTitle(doc) {
        return getInputValue(doc, 'P14_CLASS_TITLE')
            || cleanText(doc.querySelector('#leadheader .t-BreadcrumbRegion-breadcrumb h2')?.textContent)
            || cleanText(doc.querySelector('#leadheader h2')?.textContent)
            || 'Oracle Academy Course';
    }

    function extractSectionNumber(title, fallback) {
        const match = cleanText(title).match(/\b(?:section|secci[oó]n)\s*(\d+)\b/i);
        return match ? Number.parseInt(match[1], 10) : fallback;
    }

    function extractSections(doc, baseUrl) {
        return Array.from(doc.querySelectorAll('#courseol .t-MediaList-item'))
            .map((item, index) => {
                const anchor = item.querySelector('a.t-MediaList-itemWrap[href]');
                const title = cleanText(item.querySelector('.t-MediaList-title')?.textContent);
                const url = resolveUrl(anchor?.getAttribute('href'), baseUrl);

                if (!anchor || !title || !url) {
                    return null;
                }

                return {
                    key: 'section-' + index,
                    order: index,
                    number: extractSectionNumber(title, index),
                    title,
                    url,
                };
            })
            .filter(Boolean);
    }

    function stripWizardState(value) {
        return cleanText(value).replace(/\s+\((?:completed|active|incomplete|locked)\)\s*$/i, '');
    }

    function hasPdfPageContent(doc) {
        return Boolean(
            doc.querySelector('a-file-upload[id*="PDF_FILE"]')
            || doc.querySelector('#pdf_region embed[type="application/pdf"]')
            || doc.querySelector('input[name="P15_PDF_FILE_FILENAME"]')
        );
    }

    function decodeEmbeddedUrl(value) {
        return String(value || '')
            .replace(/&amp;/gi, '&')
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003d/gi, '=')
            .replace(/\\u003f/gi, '?')
            .replace(/\\u002f/gi, '/');
    }

    function extractRawWizardLinks(html, doc, baseUrl, fallbackTitle) {
        const labels = Array.from(doc.querySelectorAll('li.t-WizardSteps-step'))
            .map((item) => stripWizardState(item.querySelector('.t-WizardSteps-label')?.textContent))
            .filter(Boolean);
        const rawUrls = String(html || '').match(/f\?p=63000:15[^"'<>\s]+/g) || [];
        const links = [];
        const seen = new Set();

        rawUrls.forEach((rawUrl) => {
            const href = decodeEmbeddedUrl(rawUrl).replace(/[),;]+$/g, '');
            const url = resolveUrl(href, baseUrl);
            if (!url) {
                return;
            }

            try {
                const route = new URL(url).searchParams.get('p') || '';
                // Los enlaces del wizard usan la ruta directa con cuatro ':'
                // antes de P15_ID. Se excluyen los redirects SAVE y timeout.
                if (!/::::P15_ID(?:,|%2C)P15_COURSE_ID:/i.test(route)) {
                    return;
                }
            } catch (error) {
                return;
            }

            const key = routeKey(url, baseUrl);
            if (!key || seen.has(key)) {
                return;
            }

            seen.add(key);
            links.push({
                order: links.length,
                title: labels[links.length] || fallbackTitle || 'Lección',
                url,
            });
        });

        return links;
    }

    function extractLessonLinks(doc, baseUrl, fallbackTitle, fallbackUrl, rawHtml) {
        const links = [];
        const seen = new Set();
        const wizardAnchors = Array.from(doc.querySelectorAll(
            '#navID a.t-WizardSteps-wrap[href], .t-Body-actions a.t-WizardSteps-wrap[href]'
        ));

        wizardAnchors.forEach((anchor, index) => {
            const url = resolveUrl(anchor.getAttribute('href'), baseUrl);
            const key = routeKey(url, baseUrl);
            if (!url || !key || seen.has(key)) {
                return;
            }

            seen.add(key);
            links.push({
                order: index,
                title: stripWizardState(anchor.querySelector('.t-WizardSteps-label')?.textContent)
                    || fallbackTitle
                    || 'Lección',
                url,
            });
        });

        if (!links.length) {
            extractRawWizardLinks(rawHtml, doc, baseUrl, fallbackTitle).forEach((link) => {
                const key = routeKey(link.url, baseUrl);
                if (key && !seen.has(key)) {
                    seen.add(key);
                    links.push(link);
                }
            });
        }

        if (!links.length && hasPdfPageContent(doc)) {
            const url = resolveUrl(fallbackUrl || baseUrl, baseUrl);
            if (url) {
                links.push({
                    order: 0,
                    title: getInputValue(doc, 'P15_NAME')
                        || getInputValue(doc, 'P15_TITLE')
                        || fallbackTitle
                        || 'Lección',
                    url,
                });
            }
        }

        return links;
    }

    function getUploadFileName(doc, upload) {
        const uploadId = upload?.id || '';
        return upload?.getAttribute('filename')
            || getInputValue(doc, uploadId + '_FILENAME')
            || (uploadId === 'P15_PDF_FILE' ? getInputValue(doc, 'P15_PDF_FILE_FILENAME') : '')
            || '';
    }

    function isPdfCandidate(upload, fileName, href) {
        const mimeType = (upload.getAttribute('mimetype') || '').toLowerCase();
        const uploadId = (upload.id || '').toLowerCase();
        return mimeType === 'application/pdf'
            || /\.pdf(?:[?#]|$)/i.test(fileName)
            || /\.pdf(?:[?#]|$)/i.test(href)
            || (!fileName && !mimeType && /pdf_file/.test(uploadId));
    }

    function extractPdfCandidates(doc, pageUrl) {
        const candidates = [];
        const seen = new Set();
        const uploads = Array.from(doc.querySelectorAll('a-file-upload'));
        const previewHref = getInputValue(doc, 'P15_PREVIEW_URL')
            || doc.querySelector('#pdf_region embed[type="application/pdf"][src]')?.getAttribute('src')
            || '';
        const previewUrl = resolveUrl(previewHref, pageUrl);

        uploads.forEach((upload) => {
            const downloadAnchor = upload.querySelector('a.a-FileDrop-download[href]');
            const anchorHref = downloadAnchor?.getAttribute('href') || '';
            const uploadHref = upload.getAttribute('link') || '';
            const href = anchorHref || uploadHref;
            const fileName = getUploadFileName(doc, upload);

            if (!href || !isPdfCandidate(upload, fileName, href)) {
                return;
            }

            const url = resolveUrl(href, pageUrl);
            if (!url || seen.has(url)) {
                return;
            }

            seen.add(url);
            const fallbackUrls = [uploadHref, previewUrl]
                .map((candidate) => resolveUrl(candidate, pageUrl))
                .filter((candidate) => candidate && candidate !== url && !seen.has(candidate));
            candidates.push({
                url,
                fileName: ensurePdfExtension(fileName || 'documento.pdf'),
                fallbackUrls,
            });
        });

        if (!candidates.length) {
            if (previewUrl) {
                const fileName = getInputValue(doc, 'P15_PDF_FILE_FILENAME')
                    || getInputValue(doc, 'P15_NAME')
                    || 'documento.pdf';
                const mimeType = getInputValue(doc, 'P15_PDF_FILE_MIMETYPE')
                    || uploads.find((upload) => upload.id === 'P15_PDF_FILE')?.getAttribute('mimetype')
                    || '';

                if (mimeType.toLowerCase() !== 'application/pdf'
                    && !/\.pdf$/i.test(fileName)) {
                    return candidates;
                }

                candidates.push({
                    url: previewUrl,
                    fileName: ensurePdfExtension(fileName),
                    fallbackUrls: [],
                });
            }
        }

        return candidates;
    }

    function extractLessonData(doc, pageUrl, descriptor) {
        const title = getInputValue(doc, 'P15_NAME')
            || getInputValue(doc, 'P15_TITLE')
            || descriptor.title
            || 'Lección';
        const lessonId = getInputValue(doc, 'P15_ID') || routeKey(descriptor.url, pageUrl);
        const primaryUpload = doc.querySelector('a-file-upload[id="P15_PDF_FILE"]');
        const sourceFileName = getInputValue(doc, 'P15_PDF_FILE_FILENAME')
            || getUploadFileName(doc, primaryUpload)
            || '';

        return {
            ...descriptor,
            title,
            lessonId,
            sourceFileName,
            pdfs: extractPdfCandidates(doc, pageUrl),
        };
    }

    async function fetchHtml(url, signal) {
        const response = await fetch(url, {
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            signal,
            headers: { Accept: 'text/html,application/xhtml+xml' },
        });

        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ' al abrir una página del curso');
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const hasStudentHubForm = Boolean(doc.querySelector('form#wwvFlowForm'));
        const hasExpectedPage = Boolean(
            doc.querySelector('#courseol')
            || doc.querySelector('#P15_ID')
            || doc.querySelector('meta[name="app-alias"][content="OA-STUDENT-HUB"]')
        );

        if (!hasStudentHubForm || !hasExpectedPage) {
            throw new Error('La respuesta no parece ser una página autenticada de Oracle Academy');
        }

        return { doc, html, url: response.url || url };
    }

    function createPdfDownloadError(message, status, url) {
        const error = new Error(message);
        error.status = status;
        error.url = url;
        return error;
    }

    async function fetchPdf(url, signal, requestWindow) {
        const fetcher = requestWindow && typeof requestWindow.fetch === 'function'
            ? requestWindow.fetch.bind(requestWindow)
            : fetch;
        const response = await fetcher(url, {
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            signal,
        });

        if (!response.ok) {
            throw createPdfDownloadError(
                'HTTP ' + response.status + ' al descargar el PDF',
                response.status,
                url
            );
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        // Normaliza el buffer al realm principal. Los ArrayBuffer devueltos por
        // fetch() dentro del iframe pueden ser rechazados por JSZip por ser de
        // otro contexto JavaScript.
        const buffer = new Uint8Array(await response.arrayBuffer());
        const pageLike = contentType.includes('text/html')
            || contentType.includes('application/json')
            || contentType.includes('text/plain');

        if (!buffer.byteLength || pageLike || !hasPdfHeader(buffer)) {
            throw createPdfDownloadError(
                'El servidor no devolvió un PDF válido',
                response.status,
                url
            );
        }

        return buffer;
    }

    async function fetchPdfWithRetry(url, signal, requestWindow) {
        let lastError;
        const attempts = Math.max(1, Number(CONFIG.pdfRetries) || 1);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await fetchPdf(url, signal, requestWindow);
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                lastError = error;
                const retryable = [408, 425, 429, 500, 502, 503, 504].includes(error.status);
                if (!retryable || attempt >= attempts) {
                    throw error;
                }
                appendLog('↻ Reintento ' + (attempt + 1) + '/' + attempts + ' para el PDF (' + error.status + ').');
                await sleep(CONFIG.retryDelayMs * attempt);
            }
        }

        throw lastError || new Error('No se pudo descargar el PDF');
    }

    async function fetchPdfWithFallbacks(asset, signal, requestWindow) {
        const urls = [asset.url, ...(asset.fallbackUrls || [])].filter(Boolean);
        let lastError = null;

        for (let index = 0; index < urls.length; index += 1) {
            try {
                if (index > 0) {
                    appendLog('↪ Probando ruta PDF alternativa: ' + asset.relativePath);
                }
                return await fetchPdfWithRetry(urls[index], signal, requestWindow);
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                lastError = error;
                if (index + 1 < urls.length) {
                    appendLog('↻ Ruta PDF primaria no disponible; se probará la vista previa.');
                }
            }
        }

        throw lastError || new Error('No se encontró una ruta PDF descargable');
    }

    // ── Descubrimiento de secciones y plan de archivos ─────────────────────────

    async function discoverSections(sections, signal, onProgress) {
        return mapWithConcurrency(
            sections,
            CONFIG.sectionConcurrency,
            async (section) => {
                const page = await fetchHtml(section.url, signal);
                const pageSectionTitle = cleanText(page.doc.querySelector('#navID h4')?.textContent);
                const lessonLinks = extractLessonLinks(
                    page.doc,
                    page.url,
                    pageSectionTitle || section.title,
                    page.url,
                    page.html
                );

                return {
                    section: { ...section, pageSectionTitle },
                    lessonLinks,
                    page,
                };
            },
            (index, result, completed) => {
                onProgress?.(
                    'Descubriendo secciones: ' + completed + '/' + sections.length,
                    completed,
                    sections.length,
                    result
                );
            }
        );
    }

    function flattenLessons(sectionResults) {
        const lessons = [];
        const seen = new Set();

        sectionResults.forEach((result) => {
            if (!result || result.error) {
                return;
            }

            result.lessonLinks.forEach((lessonLink, index) => {
                const key = routeKey(lessonLink.url, result.page.url);
                if (!key || seen.has(key)) {
                    return;
                }

                seen.add(key);
                lessons.push({
                    ...lessonLink,
                    section: result.section,
                    sectionLessonOrder: index,
                    selectionId: result.section.key + '::' + key,
                });
            });
        });

        return lessons;
    }

    function createSectionFolder(section) {
        const sectionNumber = Number.isFinite(section.number) ? section.number : section.order;
        return String(sectionNumber).padStart(2, '0') + ' - ' + sanitizeName(section.title, 'Sección');
    }

    function makeUniquePath(path, usedPaths) {
        if (!usedPaths.has(path)) {
            usedPaths.add(path);
            return path;
        }

        const dotIndex = path.toLowerCase().endsWith('.pdf') ? path.length - 4 : path.length;
        const stem = path.slice(0, dotIndex);
        const extension = path.slice(dotIndex);
        let suffix = 2;
        let candidate = stem + ' (' + suffix + ')' + extension;

        while (usedPaths.has(candidate)) {
            suffix += 1;
            candidate = stem + ' (' + suffix + ')' + extension;
        }

        usedPaths.add(candidate);
        return candidate;
    }

    function compactPdfFileName(fileName) {
        let stem = sanitizeFileName(fileName, 'documento.pdf')
            .replace(/\.pdf$/i, '')
            .replace(/\.zip$/i, '');
        const order = stem.match(/^(\d+(?:\.\d+)?)\s*-\s*/)?.[1] || '';
        stem = stem.replace(/^\d+(?:\.\d+)?\s*-\s*/, '');

        if (/^AiML_Course_Map$/i.test(stem)) {
            stem = 'Course_Map';
        } else if (/^AiML_Course_Objectives$/i.test(stem)) {
            stem = 'Course_Objectives';
        } else if (/^Java[_ ]Software[_ ]Requirements$/i.test(stem)) {
            stem = 'Java_Requirements';
        } else if (/^Quiz[_ ]AiML[_ -]*Sections[_ ]1[_ ]and[_ ]2$/i.test(stem)) {
            stem = 'S1_S2';
        } else if (/^Quiz[_ ]AiML[_ -]*Sections[_ ]3[_ ]and[_ ]4$/i.test(stem)) {
            stem = 'S3_S4';
        } else if (/^YesNoGameDemo$/i.test(stem)) {
            stem = 'YesNoDemo';
        } else {
            const studentGuide = stem.match(/^AiML_(\d+_\d+)_sg$/i);
            const lessonSlides = stem.match(/^AiML_(\d+_\d+)$/i);
            if (studentGuide) {
                stem = studentGuide[1] + '_sg';
            } else if (lessonSlides) {
                stem = lessonSlides[1];
            } else {
                stem = stem.replace(/^AiML_/i, '');
            }
        }

        stem = stem
            .replace(/\s+/g, '_')
            .replace(/[^A-Za-z0-9._-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[_ .]+|[_ .]+$/g, '')
            .slice(0, 48);

        if (!stem) {
            stem = 'documento';
        }

        return (order ? order + '_' : '') + stem + '.pdf';
    }

    function buildReport(courseKey, courseTitle, sections, sectionResults, lessons) {
        const sectionMap = new Map(sections.map((section) => [section.key, {
            ...section,
            folderName: createSectionFolder(section),
            lessons: [],
        }]));
        const errors = [];
        const reportLessons = [];

        sectionResults.forEach((result) => {
            if (result?.error) {
                errors.push({
                    location: result.section?.title || result.title || 'Sección',
                    message: result.error.message || String(result.error),
                });
            }
        });

        lessons.forEach((lesson, lessonIndex) => {
            const section = sectionMap.get(lesson.section?.key);
            if (!section) {
                errors.push({
                    location: lesson.title || 'Lección ' + (lessonIndex + 1),
                    message: 'No se pudo asociar la lección con una sección.',
                });
                return;
            }

            const reportLesson = {
                ...lesson,
                sectionKey: section.key,
                sectionTitle: section.title,
                sectionFolderName: section.folderName,
                selectionId: lesson.selectionId || (section.key + '::' + lesson.url),
            };
            section.lessons.push(reportLesson);
            reportLessons.push(reportLesson);
        });

        return {
            courseKey,
            courseTitle,
            courseFolder: sanitizeName(courseTitle, 'Oracle Academy Course'),
            sections: Array.from(sectionMap.values()),
            lessons: reportLessons,
            errors,
            scannedAt: new Date(),
        };
    }

    // ── Carpeta local oracle/ y persistencia del permiso ────────────────────────

    function supportsDirectFileSystem() {
        return typeof window.showDirectoryPicker === 'function';
    }

    function folderStorageKey(courseKey) {
        return CONFIG.folderHandleKeyPrefix + String(courseKey || '');
    }

    function openFolderHandleDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB no está disponible en este navegador.'));
                return;
            }

            const request = window.indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(CONFIG.dbStore)) {
                    database.createObjectStore(CONFIG.dbStore);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento local.'));
        });
    }

    async function saveStoredParentHandle(courseKey, handle) {
        const database = await openFolderHandleDb();
        try {
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(CONFIG.dbStore, 'readwrite');
                transaction.objectStore(CONFIG.dbStore).put(handle, folderStorageKey(courseKey));
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la carpeta.'));
            });
        } finally {
            database.close();
        }
    }

    async function loadStoredParentHandle(courseKey) {
        const database = await openFolderHandleDb();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction(CONFIG.dbStore, 'readonly');
                const request = transaction.objectStore(CONFIG.dbStore).get(folderStorageKey(courseKey));
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error('No se pudo leer la carpeta guardada.'));
            });
        } finally {
            database.close();
        }
    }

    async function hasReadWritePermission(handle, requestPermission) {
        if (!handle) {
            return false;
        }

        try {
            let permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission !== 'granted' && requestPermission) {
                permission = await handle.requestPermission({ mode: 'readwrite' });
            }
            return permission === 'granted';
        } catch (error) {
            return false;
        }
    }

    async function prepareOracleRoot(parentHandle) {
        if (!parentHandle || parentHandle.kind !== 'directory') {
            throw new Error('La selección no es una carpeta válida.');
        }

        const rootHandle = parentHandle.name.toLowerCase() === CONFIG.rootName
            ? parentHandle
            : await parentHandle.getDirectoryHandle(CONFIG.rootName, { create: true });

        state.parentHandle = parentHandle;
        state.oracleHandle = rootHandle;
        state.destinationKey = getCourseKey();
        updateDestinationLabel();
        return rootHandle;
    }

    function hasDestination() {
        return Boolean(
            state.oracleHandle
            && state.destinationKey
            && state.destinationKey === getCourseKey()
        );
    }

    async function pickDestination(forcePicker) {
        if (!supportsDirectFileSystem()) {
            throw new Error('Este navegador no soporta selección de carpetas. Se usará el ZIP de respaldo.');
        }

        if (!forcePicker && hasDestination()) {
            return state.oracleHandle;
        }

        // Debe ejecutarse antes de cualquier await para conservar el gesto del usuario.
        const parentHandle = await window.showDirectoryPicker({
            id: 'oracle-pdf-dl-dest',
            mode: 'readwrite',
            startIn: 'desktop',
        });

        await prepareOracleRoot(parentHandle);
        try {
            await saveStoredParentHandle(getCourseKey(), parentHandle);
        } catch (error) {
            console.warn('[Oracle PDF Downloader] No se pudo guardar el permiso de carpeta.', error);
        }

        return state.oracleHandle;
    }

    async function restoreStoredDestination() {
        if (!supportsDirectFileSystem() || hasDestination()) {
            return false;
        }

        try {
            const parentHandle = await loadStoredParentHandle(getCourseKey());
            if (!parentHandle || parentHandle.kind !== 'directory') {
                return false;
            }
            if (!await hasReadWritePermission(parentHandle, false)) {
                return false;
            }

            await prepareOracleRoot(parentHandle);
            return true;
        } catch (error) {
            return false;
        }
    }

    function getDestinationLabel() {
        if (!hasDestination()) {
            return '';
        }
        const parentName = state.parentHandle?.name || CONFIG.rootName;
        return parentName.toLowerCase() === CONFIG.rootName
            ? parentName
            : parentName + '/' + CONFIG.rootName;
    }

    async function getExistingDirectory(rootHandle, relativePath) {
        let directory = rootHandle;
        for (const segment of safePathSegments(relativePath)) {
            directory = await directory.getDirectoryHandle(segment);
        }
        return directory;
    }

    async function getOrCreateDirectory(rootHandle, relativePath) {
        let directory = rootHandle;
        for (const segment of safePathSegments(relativePath)) {
            try {
                directory = await directory.getDirectoryHandle(segment, { create: true });
            } catch (error) {
                throw filesystemError(
                    error,
                    'abrir/crear carpeta "' + segment + '" dentro de "' + relativePath + '"',
                );
            }
        }
        return directory;
    }

    async function readExistingFiles(relativePath) {
        if (!hasDestination()) {
            return null;
        }

        try {
            const directory = await getExistingDirectory(state.oracleHandle, relativePath);
            const files = new Set();
            for await (const [name, handle] of directory.entries()) {
                if (handle.kind === 'file') {
                    files.add(fileKey(name));
                }
            }
            return files;
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                return new Set();
            }
            return null;
        }
    }

    async function readExistingMap(folderPaths) {
        if (!hasDestination()) {
            return null;
        }

        const paths = Array.from(new Set(folderPaths));
        const results = await mapWithConcurrency(paths, CONFIG.downloadConcurrency, async (path) => ({
            path,
            files: await readExistingFiles(path),
        }));
        const map = new Map();

        for (const result of results) {
            if (!result || result.error || !result.files) {
                return null;
            }
            map.set(result.path, result.files);
        }

        return map;
    }

    async function writeBuffer(directory, fileName, buffer, requirePdf = true) {
        if (!buffer || !buffer.byteLength) {
            throw new Error('El archivo descargado está vacío.');
        }

        const validatePdf = requirePdf && !/\.txt$/i.test(fileName);

        let fileHandle;
        try {
            fileHandle = await directory.getFileHandle(fileName, { create: true });
        } catch (error) {
            throw filesystemError(error, 'abrir/crear archivo "' + fileName + '"');
        }

        let hadValidFile = false;
        try {
            const existingFile = await fileHandle.getFile();
            hadValidFile = validatePdf
                ? await fileHasPdfHeader(existingFile)
                : existingFile.size > 0;
        } catch (error) {
            if (error?.name !== 'NotFoundError') {
                throw filesystemError(error, 'consultar archivo "' + fileName + '"');
            }
        }

        let writable;
        let stage = 'crear escritura para "' + fileName + '"';
        try {
            writable = await fileHandle.createWritable();
            stage = 'escribir ' + buffer.byteLength + ' bytes en "' + fileName + '"';
            await writable.write(buffer);
            stage = 'cerrar escritura de "' + fileName + '"';
            await writable.close();

            stage = 'verificar tamaño de "' + fileName + '"';
            const writtenFile = await fileHandle.getFile();
            if (writtenFile.size !== buffer.byteLength) {
                throw new Error('El archivo quedó incompleto (' + writtenFile.size + '/' + buffer.byteLength + ' bytes).');
            }
            if (validatePdf && !await fileHasPdfHeader(writtenFile)) {
                throw new Error('El archivo guardado no contiene la cabecera de un PDF.');
            }
        } catch (error) {
            try {
                await writable?.abort();
            } catch (abortError) {
                // El error original contiene la causa útil para el usuario.
            }
            if (!hadValidFile) {
                try {
                    await directory.removeEntry(fileName);
                } catch (cleanupError) {
                    // Si la entrada ya no existe, el objetivo de limpieza ya se cumplió.
                }
            }
            throw filesystemError(error, stage);
        }
    }

    // ── Selección de lecciones ─────────────────────────────────────────────────

    function selectedLessons() {
        if (!state.report) {
            return [];
        }
        return state.report.lessons.filter((lesson) => state.selectedLessonIds.has(lesson.selectionId));
    }

    function sectionLessons(section) {
        return section.lessons || [];
    }

    function setSectionSelection(sectionKey, selected) {
        const section = state.report?.sections.find((item) => item.key === sectionKey);
        if (!section) {
            return;
        }
        sectionLessons(section).forEach((lesson) => {
            if (selected) {
                state.selectedLessonIds.add(lesson.selectionId);
            } else {
                state.selectedLessonIds.delete(lesson.selectionId);
            }
        });
        refreshSelectionUi();
    }

    function refreshSelectionUi() {
        if (!state.ui || !state.report) {
            return;
        }

        state.ui.tree.querySelectorAll('input[data-selection-role="lesson"]').forEach((checkbox) => {
            checkbox.checked = state.selectedLessonIds.has(checkbox.dataset.lessonId);
        });

        state.ui.tree.querySelectorAll('input[data-selection-role="section"]').forEach((checkbox) => {
            const section = state.report.sections.find((item) => item.key === checkbox.dataset.sectionKey);
            const lessons = section ? sectionLessons(section) : [];
            const selectedCount = lessons.filter((lesson) => state.selectedLessonIds.has(lesson.selectionId)).length;
            checkbox.disabled = !lessons.length || state.running;
            checkbox.checked = lessons.length > 0 && selectedCount === lessons.length;
            checkbox.indeterminate = selectedCount > 0 && selectedCount < lessons.length;
        });

        const selectedCount = selectedLessons().length;
        state.runSummary.selectedLessons = selectedCount;
        state.ui.selectionSummary.textContent = selectedCount
            + ' lección(es) seleccionada(s) · el PDF se resolverá al descargar';
        renderDiff();
        updateControls();
    }

    function renderSelectionTree() {
        if (!state.ui || !state.report) {
            return;
        }

        state.ui.tree.replaceChildren();
        if (!state.report.lessons.length) {
            const empty = document.createElement('div');
            empty.textContent = 'No se encontraron enlaces de lección seleccionables.';
            empty.style.color = '#6b7280';
            state.ui.tree.appendChild(empty);
            refreshSelectionUi();
            return;
        }

        state.report.sections.forEach((section) => {
            const lessonsList = sectionLessons(section);
            const sectionBlock = document.createElement('div');
            sectionBlock.style.cssText = 'border-bottom:1px solid #e5e7eb;padding:6px 0;';

            const sectionRow = document.createElement('label');
            sectionRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:700;cursor:pointer;';

            const sectionCheckbox = document.createElement('input');
            sectionCheckbox.type = 'checkbox';
            sectionCheckbox.dataset.selectionRole = 'section';
            sectionCheckbox.dataset.sectionKey = section.key;
            sectionCheckbox.addEventListener('change', () => {
                setSectionSelection(section.key, sectionCheckbox.checked);
            });

            const sectionLabel = document.createElement('span');
            sectionLabel.textContent = section.folderName + ' (' + lessonsList.length + ' lecciones)';
            sectionRow.append(sectionCheckbox, sectionLabel);
            sectionBlock.appendChild(sectionRow);

            const lessons = document.createElement('div');
            lessons.style.cssText = 'margin:4px 0 0 24px;display:flex;flex-direction:column;gap:3px;';

            if (!lessonsList.length) {
                const emptySection = document.createElement('span');
                emptySection.textContent = 'Sin enlaces de lección disponibles';
                emptySection.style.cssText = 'color:#9ca3af;font-size:11px;';
                lessons.appendChild(emptySection);
            } else {
                lessonsList.forEach((lesson) => {
                    const lessonRow = document.createElement('label');
                    lessonRow.style.cssText = 'display:flex;align-items:flex-start;gap:6px;font-weight:400;cursor:pointer;';

                    const lessonCheckbox = document.createElement('input');
                    lessonCheckbox.type = 'checkbox';
                    lessonCheckbox.dataset.selectionRole = 'lesson';
                    lessonCheckbox.dataset.lessonId = lesson.selectionId;
                    lessonCheckbox.addEventListener('change', () => {
                        if (lessonCheckbox.checked) {
                            state.selectedLessonIds.add(lesson.selectionId);
                        } else {
                            state.selectedLessonIds.delete(lesson.selectionId);
                        }
                        refreshSelectionUi();
                    });

                    const lessonLabel = document.createElement('span');
                    lessonLabel.textContent = String(lesson.sectionLessonOrder + 1).padStart(2, '0') + ' - ' + lesson.title;
                    lessonLabel.title = lesson.url;
                    lessonRow.append(lessonCheckbox, lessonLabel);
                    lessons.appendChild(lessonRow);
                });
            }

            sectionBlock.appendChild(lessons);
            state.ui.tree.appendChild(sectionBlock);
        });

        refreshSelectionUi();
    }

    function renderDiff() {
        if (!state.ui) {
            return;
        }

        state.ui.diff.replaceChildren();
        const line = document.createElement('div');
        line.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;font-size:11px;margin-bottom:5px;';

        const selected = document.createElement('strong');
        selected.textContent = '✓ ' + state.runSummary.selectedLessons + ' lecciones seleccionadas';
        selected.style.color = '#374151';
        const included = document.createElement('strong');
        included.textContent = '✔ ' + state.runSummary.includedPdfs + ' PDFs guardados';
        included.style.color = '#047857';
        const failures = document.createElement('strong');
        failures.textContent = '⚠ ' + state.runSummary.failures + ' fallos';
        failures.style.color = state.runSummary.failures ? '#b91c1c' : '#6b7280';
        line.append(selected, included, failures);
        state.ui.diff.appendChild(line);

        const note = document.createElement('div');
        note.textContent = state.runSummary.processedLessons
            ? 'Procesadas ' + state.runSummary.processedLessons + ' lección(es); los nombres y rutas se resolvieron durante la descarga.'
            : 'El escaneo solo encontró enlaces; cada PDF se resolverá abriendo nuevamente su lección.';
        note.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:4px;';
        state.ui.diff.appendChild(note);

        if (state.report?.errors.length) {
            const scanErrors = document.createElement('div');
            scanErrors.textContent = 'ℹ ' + state.report.errors.length + ' incidencia(s) al leer secciones.';
            scanErrors.style.cssText = 'font-size:10px;color:#92400e;margin-top:4px;';
            state.ui.diff.appendChild(scanErrors);
        }
    }

    // ── Descarga fresca por lección y ZIP de respaldo ───────────────────────────

    function createReadme(report, selectedLessonsList, included, skipped, errors, mode, existing = []) {
        const available = [...existing, ...included];
        const lines = [
            'Oracle Academy - PDFs del curso',
            '================================',
            '',
            'Curso: ' + report.courseTitle,
            'Raíz: ' + CONFIG.rootName + '/',
            'Modo: ' + mode,
            'Generado: ' + new Date().toLocaleString(),
            '',
            'Estructura: curso / sección numerada / PDF numerado.',
            'Lecciones seleccionadas: ' + selectedLessonsList.length + '.',
            '',
            'Archivos PDF disponibles en el árbol (' + available.length + '):',
        ];

        if (available.length) {
            available.forEach((asset) => lines.push('- ' + asset.relativePath));
        } else {
            lines.push('- Ninguno');
        }

        lines.push('', 'Lecciones sin PDF (' + skipped.length + '):');
        if (skipped.length) {
            skipped.forEach((item) => lines.push('- ' + item.sectionTitle + ' / ' + item.lessonTitle + ': ' + item.reason));
        } else {
            lines.push('- Ninguna');
        }

        lines.push('', 'Errores de esta ejecución (' + errors.length + '):');
        if (errors.length) {
            errors.forEach((item) => lines.push('- ' + item.location + ': ' + item.message));
        } else {
            lines.push('- Ninguno');
        }

        return lines.join('\r\n') + '\r\n';
    }

    function saveBlob(blob, fileName) {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = fileName;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw new DOMException('La operación fue cancelada.', 'AbortError');
        }
    }

    async function waitForFrameLoad(frame, signal, timeoutMs) {
        await new Promise((resolve, reject) => {
            let finished = false;
            const timer = window.setTimeout(() => {
                if (!finished) {
                    finished = true;
                    reject(new Error('La lección tardó demasiado en cargar.'));
                }
            }, timeoutMs);
            const onAbort = () => {
                if (!finished) {
                    finished = true;
                    window.clearTimeout(timer);
                    reject(new DOMException('La operación fue cancelada.', 'AbortError'));
                }
            };
            const onLoad = () => {
                if (!finished) {
                    finished = true;
                    window.clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }
            };
            frame.addEventListener('load', onLoad, { once: true });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
            }
        });
    }

    async function waitForLessonPdfState(doc, signal, timeoutMs, expectedLessonId, pageUrl) {
        const started = Date.now();
        const directGraceMs = 8_000;
        while (Date.now() - started < timeoutMs) {
            throwIfAborted(signal);
            const upload = doc.querySelector('a-file-upload[id*="PDF_FILE"]');
            const directLink = upload?.querySelector('a.a-FileDrop-download[href]')?.getAttribute('href')
                || upload?.getAttribute('link')
                || '';
            const previewLink = getInputValue(doc, 'P15_PREVIEW_URL')
                || doc.querySelector('#pdf_region embed[type="application/pdf"][src]')?.getAttribute('src')
                || '';

            const currentLessonId = getInputValue(doc, 'P15_ID');
            const lessonIdReady = !expectedLessonId || currentLessonId === expectedLessonId;
            const previewLessonId = getOracleRouteValue(previewLink, 'P16_REPORTID', pageUrl);
            const previewReady = Boolean(previewLink)
                && (!expectedLessonId || previewLessonId === expectedLessonId);
            const directReady = Boolean(directLink) && Date.now() - started > directGraceMs;

            if (upload && lessonIdReady && (previewReady || directReady)) {
                return;
            }
            await sleep(250);
        }
    }

    async function loadLessonInRuntimeFrame(url, signal) {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
        frame.src = url;
        document.body.appendChild(frame);

        try {
            await waitForFrameLoad(frame, signal, 30_000);
            const doc = frame.contentDocument;
            const requestWindow = frame.contentWindow;
            if (!doc || !requestWindow || requestWindow.location.origin !== window.location.origin) {
                throw new Error('La lección no pudo abrirse en un contexto autenticado del mismo origen.');
            }
            const expectedLessonId = getOracleRouteValue(url, 'P15_ID', url);
            await waitForLessonPdfState(doc, signal, 15_000, expectedLessonId, url);
            return {
                doc,
                url: requestWindow.location.href || url,
                requestWindow,
                cleanup: () => frame.remove(),
            };
        } catch (error) {
            frame.remove();
            throw error;
        }
    }

    function createFreshAsset(report, lesson, pdf, pdfIndex, pdfCount, usedPaths) {
        const section = report.sections.find((item) => item.key === lesson.sectionKey);
        if (!section) {
            throw new Error('No se encontró la sección de la lección.');
        }

        const folderPath = report.courseFolder + '/' + section.folderName;
        const lessonPrefix = String(lesson.sectionLessonOrder + 1).padStart(2, '0')
            + (pdfCount > 1 ? '.' + (pdfIndex + 1) : '');
        const rawPath = folderPath + '/' + lessonPrefix + ' - ' + ensurePdfExtension(pdf.fileName || lesson.title);
        const relativePath = makeUniquePath(rawPath, usedPaths);
        const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);

        return {
            id: relativePath,
            url: pdf.url,
            fallbackUrls: pdf.fallbackUrls || [],
            fileName,
            folderPath,
            relativePath,
            sectionKey: section.key,
            sectionTitle: section.title,
            lessonTitle: lesson.title,
            lessonId: lesson.lessonId,
            lessonOrder: lesson.sectionLessonOrder,
        };
    }

    async function loadFreshLessonAssets(report, lesson, usedPaths, signal) {
        const runtime = await loadLessonInRuntimeFrame(lesson.url, signal);
        try {
            const freshLesson = extractLessonData(runtime.doc, runtime.url, lesson);
            const assets = freshLesson.pdfs.map((pdf, index) => createFreshAsset(
                report,
                { ...lesson, title: freshLesson.title, lessonId: freshLesson.lessonId },
                pdf,
                index,
                freshLesson.pdfs.length,
                usedPaths
            ));
            return { ...runtime, freshLesson, assets };
        } catch (error) {
            runtime.cleanup();
            throw error;
        }
    }

    async function fileExists(relativeFolder, fileName) {
        try {
            const directory = await getExistingDirectory(state.oracleHandle, relativeFolder);
            const fileHandle = await directory.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            if (await fileHasPdfHeader(file)) {
                return true;
            }

            // Los intentos anteriores podían dejar un placeholder vacío o un
            // archivo no-PDF. Nunca deben bloquear "Solo faltantes".
            try {
                await directory.removeEntry(fileName);
            } catch (cleanupError) {
                // Se volverá a intentar escribir aunque no se pueda limpiar ahora.
            }
            return false;
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                return false;
            }
            throw error;
        }
    }

    async function removeInvalidPdfFiles(relativeFolder) {
        try {
            const directory = await getExistingDirectory(state.oracleHandle, relativeFolder);
            const removed = [];
            for await (const [name, handle] of directory.entries()) {
                if (handle.kind !== 'file' || !/\.pdf$/i.test(name)) {
                    continue;
                }
                const file = await handle.getFile();
                if (await fileHasPdfHeader(file)) {
                    continue;
                }
                try {
                    await directory.removeEntry(name);
                    removed.push(name);
                } catch (error) {
                    // La descarga volverá a intentarlo y dejará la incidencia
                    // visible si la entrada no puede eliminarse.
                }
            }
            return removed;
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                return [];
            }
            throw error;
        }
    }

    async function removeStaleLessonPdfAliases(report, lesson, freshLesson) {
        const folderPath = report.courseFolder + '/'
            + report.sections.find((section) => section.key === lesson.sectionKey)?.folderName;
        if (!folderPath || folderPath.endsWith('/undefined')) {
            return [];
        }

        const order = String(lesson.sectionLessonOrder + 1).padStart(2, '0');
        const sourceNames = [
            freshLesson.sourceFileName,
            freshLesson.title,
            lesson.title,
        ].filter(Boolean);
        const names = new Set();
        sourceNames.forEach((sourceName) => {
            const original = order + ' - ' + ensurePdfExtension(sourceName);
            names.add(original);
            names.add(compactPdfFileName(original));
        });

        try {
            const directory = await getExistingDirectory(state.oracleHandle, folderPath);
            const removed = [];
            for (const name of names) {
                try {
                    await directory.getFileHandle(name);
                    await directory.removeEntry(name);
                    removed.push(name);
                } catch (error) {
                    if (error?.name !== 'NotFoundError') {
                        // Un archivo que no puede eliminarse no debe ocultar el
                        // resultado de las demás lecciones.
                    }
                }
            }
            return removed;
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                return [];
            }
            return [];
        }
    }

    async function downloadDirectLessons(report, lessons, mode, signal) {
        const failures = [];
        const included = [];
        const existing = [];
        const skipped = [];
        const directoryCache = new Map();
        const usedPaths = new Set();
        const compactUsedPaths = new Set();
        const compactAssetCache = new Map();

        for (const section of report.sections) {
            const folderPath = report.courseFolder + '/' + section.folderName;
            try {
                const removed = await removeInvalidPdfFiles(folderPath);
                removed.forEach((name) => appendLog('🧹 Eliminado archivo no-PDF: ' + folderPath + '/' + name));
            } catch (error) {
                appendLog('⚠ No se pudo revisar ' + folderPath + ': ' + (error.message || String(error)));
            }
        }

        const getTargetDirectory = async (folderPath) => {
            if (!directoryCache.has(folderPath)) {
                directoryCache.set(folderPath, getOrCreateDirectory(state.oracleHandle, folderPath));
            }
            return directoryCache.get(folderPath);
        };

        const getCompactAsset = (asset) => {
            if (compactAssetCache.has(asset.id)) {
                return compactAssetCache.get(asset.id);
            }

            const compactFileName = compactPdfFileName(asset.fileName);
            const compactRawPath = asset.folderPath + '/' + compactFileName;
            if (compactRawPath === asset.relativePath) {
                compactAssetCache.set(asset.id, asset);
                return asset;
            }

            const compactRelativePath = makeUniquePath(compactRawPath, compactUsedPaths);
            const compact = {
                ...asset,
                id: compactRelativePath,
                fileName: compactRelativePath.slice(compactRelativePath.lastIndexOf('/') + 1),
                relativePath: compactRelativePath,
            };
            compactAssetCache.set(asset.id, compact);
            return compact;
        };

        const writeTargetBuffer = async (asset, buffer) => {
            const compact = getCompactAsset(asset);
            const candidates = compact === asset ? [asset] : [asset, compact];
            let lastError;
            for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
                const candidate = candidates[candidateIndex];
                for (let attempt = 1; attempt <= 2; attempt += 1) {
                    try {
                        if (attempt > 1) {
                            directoryCache.delete(candidate.folderPath);
                            appendLog('↻ Reintentando escritura de ' + candidate.relativePath);
                        }
                        const directory = await getTargetDirectory(candidate.folderPath);
                        await writeBuffer(directory, candidate.fileName, buffer);
                        return candidate;
                    } catch (error) {
                        lastError = error;
                        if (candidateIndex < candidates.length - 1 && error?.name === 'NotFoundError') {
                            directoryCache.delete(candidate.folderPath);
                            appendLog('↪ Ruta corta por límite de Windows: ' + candidate.relativePath);
                            break;
                        }
                        if (attempt < 2) {
                            appendLog('  ⚠ Intento ' + attempt + ' falló: ' + (error.message || String(error)));
                            await sleep(CONFIG.retryDelayMs);
                        }
                    }
                }
            }
            throw lastError || new Error('No se pudo escribir el archivo.');
        };

        for (let index = 0; index < lessons.length; index += 1) {
            const lesson = lessons[index];
            updateProgress('Lección ' + (index + 1) + '/' + lessons.length + ': ' + lesson.title, index, lessons.length);
            appendLog('[' + (index + 1) + '/' + lessons.length + '] Abriendo ' + lesson.title);

            try {
                const fresh = await loadFreshLessonAssets(report, lesson, usedPaths, signal);
                try {
                    if (!fresh.assets.length) {
                        skipped.push({
                            sectionTitle: lesson.sectionTitle,
                            lessonTitle: fresh.freshLesson.title,
                            reason: 'no contiene un enlace PDF disponible',
                        });
                        const removedAliases = await removeStaleLessonPdfAliases(report, lesson, fresh.freshLesson);
                        removedAliases.forEach((name) => appendLog('🧹 Eliminado residuo de lección sin PDF: ' + name));
                        appendLog('  ↷ Sin PDF disponible');
                    } else {
                        for (const asset of fresh.assets) {
                            try {
                                const compact = getCompactAsset(asset);
                                const targets = compact === asset ? [asset] : [asset, compact];
                                if (mode === 'missing') {
                                    let existingTarget = null;
                                    for (const target of targets) {
                                        if (await fileExists(target.folderPath, target.fileName)) {
                                            existingTarget = target;
                                            break;
                                        }
                                    }
                                    if (existingTarget) {
                                        existing.push(existingTarget);
                                        appendLog('  ↷ Ya existe: ' + existingTarget.relativePath);
                                        continue;
                                    }
                                }

                                const buffer = await fetchPdfWithFallbacks(asset, signal, fresh.requestWindow);
                                const savedTarget = await writeTargetBuffer(asset, buffer);
                                included.push(savedTarget);
                                appendLog('  ✓ Guardado: ' + savedTarget.relativePath);
                            } catch (error) {
                                if (isAbortError(error)) {
                                    throw error;
                                }
                                failures.push({
                                    location: asset.relativePath,
                                    message: error.message || String(error),
                                });
                                appendLog('  ✗ ' + asset.relativePath + ': ' + (error.message || String(error)));
                            }
                        }
                    }
                } finally {
                    fresh.cleanup();
                }
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                failures.push({
                    location: lesson.sectionTitle + ' / ' + lesson.title,
                    message: error.message || String(error),
                });
                appendLog('  ✗ Lección: ' + (error.message || String(error)));
            }
            state.runSummary.processedLessons = index + 1;
            state.runSummary.includedPdfs = included.length;
            state.runSummary.existingPdfs = existing.length;
            state.runSummary.skippedLessons = skipped.length;
            state.runSummary.failures = failures.length;
            refreshSelectionUi();
            await sleep(CONFIG.downloadDelayMs);
        }

        return { included, existing, skipped, failures };
    }

    async function downloadZipLessons(report, lessons, signal) {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip no está disponible para el modo de respaldo.');
        }

        const zip = new JSZip();
        const included = [];
        const skipped = [];
        const failures = [];
        const rootPrefix = CONFIG.rootName + '/';
        const usedPaths = new Set();

        for (let index = 0; index < lessons.length; index += 1) {
            const lesson = lessons[index];
            updateProgress('ZIP · lección ' + (index + 1) + '/' + lessons.length, index, lessons.length);
            appendLog('[' + (index + 1) + '/' + lessons.length + '] Abriendo ' + lesson.title);

            try {
                const fresh = await loadFreshLessonAssets(report, lesson, usedPaths, signal);
                try {
                    if (!fresh.assets.length) {
                        skipped.push({
                            sectionTitle: lesson.sectionTitle,
                            lessonTitle: fresh.freshLesson.title,
                            reason: 'no contiene un enlace PDF disponible',
                        });
                        appendLog('  ↷ Sin PDF disponible');
                    } else {
                        for (const asset of fresh.assets) {
                            try {
                                const buffer = await fetchPdfWithFallbacks(asset, signal, fresh.requestWindow);
                                zip.file(rootPrefix + asset.relativePath, buffer, { binary: true, compression: 'STORE' });
                                included.push(asset);
                                appendLog('  ✓ Añadido al ZIP: ' + asset.relativePath);
                            } catch (error) {
                                if (isAbortError(error)) {
                                    throw error;
                                }
                                failures.push({
                                    location: asset.relativePath,
                                    message: error.message || String(error),
                                });
                                appendLog('  ✗ ' + asset.relativePath + ': ' + (error.message || String(error)));
                            }
                        }
                    }
                } finally {
                    fresh.cleanup();
                }
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                failures.push({
                    location: lesson.sectionTitle + ' / ' + lesson.title,
                    message: error.message || String(error),
                });
                appendLog('  ✗ Lección: ' + (error.message || String(error)));
            }
            state.runSummary.processedLessons = index + 1;
            state.runSummary.includedPdfs = included.length;
            state.runSummary.skippedLessons = skipped.length;
            state.runSummary.failures = failures.length;
            refreshSelectionUi();
        }

        const errors = [...(report.errors || []), ...failures];
        const readme = createReadme(report, lessons, included, skipped, errors, 'ZIP de respaldo');
        zip.file(rootPrefix + report.courseFolder + '/README.txt', readme);
        if (errors.length) {
            zip.file(
                rootPrefix + report.courseFolder + '/ERRORS.txt',
                errors.map((item) => item.location + ': ' + item.message).join('\r\n') + '\r\n'
            );
        }

        updateProgress('Construyendo ZIP…', 1, 1);
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'STORE',
            mimeType: 'application/zip',
        }, (metadata) => {
            updateProgress('Construyendo ZIP… ' + Math.round(metadata.percent) + '%', metadata.percent, 100);
        });

        saveBlob(blob, 'oracle-' + sanitizeName(report.courseFolder, 'curso') + '.zip');
        return { included, skipped, failures, errors };
    }

    async function writeRunReports(report, selectedLessonsList, included, skipped, errors, mode, existing = []) {
        const courseDirectory = await getOrCreateDirectory(state.oracleHandle, report.courseFolder);
        const readme = createReadme(report, selectedLessonsList, included, skipped, errors, mode, existing);
        await writeBuffer(courseDirectory, 'README.txt', new TextEncoder().encode(readme), false);

        const errorText = errors.length
            ? errors.map((item) => item.location + ': ' + item.message).join('\r\n') + '\r\n'
            : 'No hubo errores en esta ejecución.\r\n';
        await writeBuffer(courseDirectory, 'ERRORS.txt', new TextEncoder().encode(errorText), false);
    }

    function updateProgress(message, value, max) {
        if (!state.ui) {
            return;
        }
        state.ui.status.textContent = message;
        state.ui.progress.max = max || 1;
        state.ui.progress.value = Math.min(value || 0, state.ui.progress.max);
    }

    function appendLog(message) {
        if (!state.ui) {
            return;
        }
        state.ui.log.textContent = state.ui.log.textContent
            ? state.ui.log.textContent + '\n' + message
            : message;
        state.ui.log.scrollTop = state.ui.log.scrollHeight;
    }

    function setStatus(message, kind) {
        if (!state.ui) {
            return;
        }
        state.ui.status.textContent = message;
        state.ui.status.dataset.state = kind || 'info';
    }

    // ── Acciones principales ────────────────────────────────────────────────────

    async function runScan() {
        if (state.running || !state.ui) {
            return;
        }

        state.running = true;
        state.abortController = new AbortController();
        setControlsBusy(true);
        state.ui.log.textContent = '';
        state.report = null;
        state.selectedLessonIds.clear();
        state.runSummary = {
            selectedLessons: 0,
            processedLessons: 0,
            includedPdfs: 0,
            existingPdfs: 0,
            skippedLessons: 0,
            failures: 0,
        };
        state.ui.tree.replaceChildren();
        state.ui.selectionSummary.textContent = '';
        state.ui.diff.replaceChildren();
        let pickingDestination = false;

        try {
            if (supportsDirectFileSystem() && !hasDestination()) {
                setStatus('Selecciona la carpeta padre para crear/reutilizar oracle/…');
                pickingDestination = true;
                await pickDestination(false);
                pickingDestination = false;
            }

            const courseKey = getCourseKey();
            const courseTitle = extractCourseTitle(document);
            const sections = extractSections(document, window.location.href);
            if (!sections.length) {
                throw new Error('No se encontraron secciones publicadas en Course Outline.');
            }

            updateProgress('Preparando ' + sections.length + ' secciones…', 0, sections.length);
            const sectionResults = await discoverSections(sections, state.abortController.signal, updateProgress);
            const lessons = flattenLessons(sectionResults);
            if (!lessons.length) {
                throw new Error('No se encontraron lecciones dentro de las secciones del curso.');
            }

            updateProgress('Se encontraron ' + lessons.length + ' enlaces de lección.', lessons.length, lessons.length);
            state.report = buildReport(courseKey, courseTitle, sections, sectionResults, lessons);
            state.selectedLessonIds = new Set(state.report.lessons.map((lesson) => lesson.selectionId));
            state.runSummary.selectedLessons = state.report.lessons.length;
            renderSelectionTree();
            appendLog('Escaneo terminado: se descargará cada lección con una página fresca.');

            if (state.report.errors.length) {
                appendLog('Incidencias de escaneo: ' + state.report.errors.length);
            }
            setStatus('Escaneo completo. Revisa la selección y descarga.', state.report.errors.length ? 'warning' : 'success');
        } catch (error) {
            if (pickingDestination && error?.name === 'AbortError') {
                setStatus('Selección de carpeta cancelada.', 'warning');
            } else if (isAbortError(error)) {
                setStatus('Escaneo cancelado.', 'warning');
            } else {
                console.error('[Oracle PDF Downloader]', error);
                setStatus('Error: ' + (error.message || String(error)), 'error');
                appendLog('✗ ' + (error.message || String(error)));
            }
        } finally {
            state.running = false;
            state.abortController = null;
            setControlsBusy(false);
            refreshSelectionUi();
        }
    }

    async function runDownload(mode) {
        if (state.running || !state.ui) {
            return;
        }
        if (!state.report) {
            setStatus('Primero pulsa "Escanear curso".', 'warning');
            return;
        }

        state.running = true;
        state.abortController = new AbortController();
        setControlsBusy(true);
        state.ui.log.textContent = '';
        let pickingDestination = false;

        try {
            if (mode !== 'zip' && supportsDirectFileSystem() && !hasDestination()) {
                pickingDestination = true;
                await pickDestination(false);
                pickingDestination = false;
            }

            const selected = selectedLessons();
            if (!selected.length) {
                throw new Error('No hay lecciones seleccionadas.');
            }

            state.runSummary = {
                selectedLessons: selected.length,
                processedLessons: 0,
                includedPdfs: 0,
                existingPdfs: 0,
                skippedLessons: 0,
                failures: 0,
            };
            refreshSelectionUi();
            appendLog('Lecciones seleccionadas: ' + selected.length);

            if (mode !== 'zip' && supportsDirectFileSystem()) {
                if (!hasDestination()) {
                    throw new Error('No hay una carpeta oracle/ autorizada.');
                }
            }

            let included;
            let existing = [];
            let skipped = [];
            let errors = [...(state.report.errors || [])];

            if (mode === 'zip' || !supportsDirectFileSystem()) {
                const result = await downloadZipLessons(state.report, selected, state.abortController.signal);
                included = result.included;
                skipped = result.skipped;
                errors = result.errors;
            } else {
                const result = await downloadDirectLessons(
                    state.report,
                    selected,
                    mode,
                    state.abortController.signal
                );
                included = result.included;
                existing = result.existing;
                skipped = result.skipped;
                errors = errors.concat(result.failures);
                await writeRunReports(
                    state.report,
                    selected,
                    included,
                    skipped,
                    errors,
                    mode === 'missing' ? 'Solo faltantes' : 'Descargar todo',
                    existing
                );
            }

            setStatus(
                'Listo: ' + included.length + ' PDF(s) guardados'
                    + (existing.length ? ' · ' + existing.length + ' ya existían' : '')
                    + (skipped.length ? ' · ' + skipped.length + ' sin PDF' : '')
                    + (errors.length ? ' · ' + errors.length + ' incidencia(s)' : '') + '.',
                errors.length ? 'warning' : 'success'
            );
        } catch (error) {
            if (pickingDestination && error?.name === 'AbortError') {
                setStatus('Selección de carpeta cancelada.', 'warning');
            } else if (isAbortError(error)) {
                setStatus('Descarga cancelada.', 'warning');
            } else {
                console.error('[Oracle PDF Downloader]', error);
                setStatus('Error: ' + (error.message || String(error)), 'error');
                appendLog('✗ ' + (error.message || String(error)));
                if (supportsDirectFileSystem() && state.ui) {
                    state.ui.zip.hidden = false;
                }
            }
        } finally {
            state.running = false;
            state.abortController = null;
            setControlsBusy(false);
            refreshSelectionUi();
        }
    }

    function cancelRun() {
        state.abortController?.abort();
    }

    // ── UI estilo Brightspace ───────────────────────────────────────────────────

    function updateDestinationLabel() {
        if (!state.ui) {
            return;
        }

        if (!supportsDirectFileSystem()) {
            state.ui.destinationLabel.textContent = 'API no disponible; se usará ZIP de respaldo.';
            state.ui.destinationLabel.style.color = '#6b7280';
            state.ui.pick.hidden = true;
            return;
        }

        state.ui.pick.hidden = false;
        if (hasDestination()) {
            state.ui.destinationLabel.textContent = '✔ ' + getDestinationLabel();
            state.ui.destinationLabel.style.color = '#047857';
            state.ui.pick.textContent = 'Cambiar carpeta padre';
        } else {
            state.ui.destinationLabel.textContent = 'Selecciona la carpeta padre; se creará oracle/ dentro.';
            state.ui.destinationLabel.style.color = '#b45309';
            state.ui.pick.textContent = 'Seleccionar carpeta padre';
        }
    }

    function updateControls() {
        if (!state.ui) {
            return;
        }

        const reportReady = Boolean(state.report);
        const selectedCount = selectedLessons().length;
        const direct = supportsDirectFileSystem();
        state.ui.scan.disabled = state.running;
        state.ui.selectAll.disabled = state.running || !reportReady;
        state.ui.clearAll.disabled = state.running || !reportReady;
        state.ui.missing.disabled = state.running || !reportReady || !direct || !selectedCount;
        state.ui.all.disabled = state.running || !reportReady || !selectedCount;
        state.ui.zip.disabled = state.running || !reportReady || !selectedCount;
        state.ui.cancel.hidden = !state.running;
        state.ui.progress.hidden = !state.running;
        state.ui.tree.style.opacity = state.running ? '0.65' : '1';
        state.ui.scan.style.cursor = state.running ? 'wait' : 'pointer';
        state.ui.all.textContent = direct ? 'Descargar todo seleccionado' : 'Descargar selección (ZIP)';
        state.ui.missing.textContent = 'Solo faltantes';
        state.ui.zip.textContent = direct ? 'ZIP alternativo' : 'Descargar ZIP';
    }

    function setControlsBusy(busy) {
        if (!state.ui) {
            return;
        }

        state.ui.pick.disabled = busy;
        state.ui.scan.disabled = busy;
        state.ui.selectAll.disabled = busy || !state.report;
        state.ui.clearAll.disabled = busy || !state.report;
        state.ui.all.disabled = busy || !state.report;
        state.ui.missing.disabled = busy || !state.report;
        state.ui.zip.disabled = busy || !state.report;
        state.ui.cancel.hidden = !busy;
        state.ui.progress.hidden = !busy;
        state.ui.panel.setAttribute('aria-busy', String(busy));

        state.ui.tree.querySelectorAll('input').forEach((input) => {
            if (input.dataset.selectionRole === 'section') {
                const section = state.report?.sections.find((item) => item.key === input.dataset.sectionKey);
                input.disabled = busy || !section?.lessons?.length;
            } else {
                input.disabled = busy;
            }
        });

        if (!busy) {
            refreshSelectionUi();
        }
    }

    function collapsePanel() {
        if (!state.ui) {
            return;
        }
        state.ui.content.hidden = true;
        state.ui.collapse.textContent = '＋';
        state.ui.collapse.setAttribute('aria-expanded', 'false');
    }

    function expandPanel() {
        if (!state.ui) {
            return;
        }
        state.ui.content.hidden = false;
        state.ui.collapse.textContent = '−';
        state.ui.collapse.setAttribute('aria-expanded', 'true');
    }

    function createPanel() {
        if (state.ui || !document.body) {
            return;
        }

        const panel = document.createElement('section');
        panel.id = CONFIG.panelId;
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Oracle PDF Downloader');
        panel.setAttribute('aria-busy', 'false');
        panel.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:20px',
            'width:410px',
            'max-width:calc(100vw - 40px)',
            'max-height:calc(100vh - 40px)',
            'overflow:auto',
            'z-index:999999',
            'background:#fff',
            'color:#111827',
            'border:2px solid #7c3aed',
            'border-radius:12px',
            'padding:14px',
            'box-shadow:0 14px 32px rgba(0,0,0,.22)',
            'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
            'font-size:13px',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;';
        const headingBox = document.createElement('div');
        const heading = document.createElement('h2');
        heading.textContent = 'Oracle PDF Downloader';
        heading.style.cssText = 'font-size:15px;font-weight:700;color:#6d28d9;margin:0;';
        const courseLabel = document.createElement('div');
        courseLabel.textContent = extractCourseTitle(document);
        courseLabel.style.cssText = 'font-size:11px;color:#6b7280;margin-top:2px;';
        headingBox.append(heading, courseLabel);

        const headerButtons = document.createElement('div');
        headerButtons.style.cssText = 'display:flex;gap:4px;';
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.textContent = '−';
        collapse.title = 'Minimizar';
        collapse.setAttribute('aria-label', 'Minimizar Oracle PDF Downloader');
        collapse.setAttribute('aria-expanded', 'true');
        collapse.style.cssText = 'border:0;background:none;color:#6b7280;font-size:18px;cursor:pointer;line-height:1;padding:0 5px;';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.title = 'Cerrar';
        close.setAttribute('aria-label', 'Cerrar Oracle PDF Downloader');
        close.style.cssText = 'border:0;background:none;color:#6b7280;font-size:20px;cursor:pointer;line-height:1;padding:0 5px;';
        headerButtons.append(collapse, close);
        header.append(headingBox, headerButtons);
        panel.appendChild(header);

        const content = document.createElement('div');
        content.id = CONFIG.panelId + '-content';

        const destinationBox = document.createElement('div');
        destinationBox.style.cssText = 'margin-bottom:8px;padding:8px 9px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;';
        const destinationHelp = document.createElement('div');
        destinationHelp.textContent = 'Carpeta destino: elige una carpeta padre y se creará/reutilizará oracle/ dentro.';
        destinationHelp.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:5px;';
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.style.cssText = 'width:100%;border:1px dashed #c4b5fd;background:#fff;color:#374151;font-size:11px;padding:7px 8px;border-radius:6px;cursor:pointer;text-align:left;';
        const destinationLabel = document.createElement('div');
        destinationLabel.setAttribute('role', 'status');
        destinationLabel.setAttribute('aria-live', 'polite');
        destinationLabel.style.cssText = 'font-size:10px;margin-top:4px;min-height:14px;';
        destinationBox.append(destinationHelp, pick, destinationLabel);
        content.appendChild(destinationBox);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;';
        const scan = document.createElement('button');
        scan.type = 'button';
        scan.textContent = 'Escanear curso';
        const selectAll = document.createElement('button');
        selectAll.type = 'button';
        selectAll.textContent = 'Seleccionar todo';
        const clearAll = document.createElement('button');
        clearAll.type = 'button';
        clearAll.textContent = 'Limpiar selección';
        [scan, selectAll, clearAll].forEach((button) => {
            button.style.cssText = 'flex:1;min-width:105px;border:0;color:white;font-weight:700;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:11px;';
        });
        scan.style.background = '#3b82f6';
        selectAll.style.background = '#10b981';
        clearAll.style.background = '#6b7280';
        actions.append(scan, selectAll, clearAll);
        content.appendChild(actions);

        const selectionSummary = document.createElement('div');
        selectionSummary.style.cssText = 'font-size:11px;color:#374151;margin-bottom:5px;min-height:15px;';
        content.appendChild(selectionSummary);

        const tree = document.createElement('div');
        tree.style.cssText = 'max-height:280px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;padding:6px;margin-bottom:8px;background:#fff;';
        const treePlaceholder = document.createElement('div');
        treePlaceholder.textContent = 'Pulsa "Escanear curso" para cargar los enlaces de lección.';
        treePlaceholder.style.color = '#6b7280';
        tree.appendChild(treePlaceholder);
        content.appendChild(tree);

        const downloadActions = document.createElement('div');
        downloadActions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
        const missing = document.createElement('button');
        missing.type = 'button';
        const all = document.createElement('button');
        all.type = 'button';
        const zip = document.createElement('button');
        zip.type = 'button';
        [missing, all, zip].forEach((button) => {
            button.style.cssText = 'flex:1;min-width:120px;border:0;color:white;font-weight:700;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:11px;';
        });
        missing.style.background = '#f97316';
        all.style.background = '#059669';
        zip.style.background = '#7c3aed';
        downloadActions.append(missing, all, zip);
        content.appendChild(downloadActions);

        const diff = document.createElement('div');
        diff.style.cssText = 'margin-bottom:6px;min-height:20px;';
        content.appendChild(diff);

        const status = document.createElement('div');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.setAttribute('aria-atomic', 'true');
        status.style.cssText = 'margin-bottom:6px;min-height:16px;font-size:11px;';
        content.appendChild(status);

        const progress = document.createElement('progress');
        progress.max = 1;
        progress.value = 0;
        progress.hidden = true;
        progress.style.cssText = 'width:100%;height:6px;margin-bottom:6px;';
        content.appendChild(progress);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancelar';
        cancel.style.cssText = 'width:100%;border:1px solid #fca5a5;background:#fff;color:#b91c1c;font-weight:700;padding:6px;border-radius:8px;cursor:pointer;margin-bottom:6px;';
        cancel.hidden = true;
        content.appendChild(cancel);

        const log = document.createElement('pre');
        log.setAttribute('role', 'log');
        log.style.cssText = 'margin:0;min-height:60px;max-height:120px;overflow:auto;overflow-wrap:anywhere;word-break:break-word;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px;font-size:10px;white-space:pre-wrap;';
        content.appendChild(log);

        panel.appendChild(content);
        document.body.appendChild(panel);

        state.ui = {
            panel,
            content,
            collapse,
            close,
            pick,
            destinationLabel,
            scan,
            selectAll,
            clearAll,
            tree,
            selectionSummary,
            missing,
            all,
            zip,
            diff,
            status,
            progress,
            cancel,
            log,
        };

        collapse.addEventListener('click', () => {
            if (content.hidden) {
                expandPanel();
            } else {
                collapsePanel();
            }
        });
        close.addEventListener('click', () => {
            if (state.running) {
                cancelRun();
            }
            panel.remove();
            state.ui = null;
        });
        pick.addEventListener('click', async () => {
            try {
                await pickDestination(true);
                setStatus('Carpeta oracle/ lista: ' + getDestinationLabel(), 'success');
                refreshSelectionUi();
            } catch (error) {
                if (error?.name === 'AbortError') {
                    setStatus('Selección de carpeta cancelada.', 'warning');
                } else {
                    setStatus('Error al seleccionar carpeta: ' + (error.message || String(error)), 'error');
                }
            }
        });
        scan.addEventListener('click', runScan);
        selectAll.addEventListener('click', () => {
            if (state.report) {
                state.selectedLessonIds = new Set(state.report.lessons.map((lesson) => lesson.selectionId));
                refreshSelectionUi();
            }
        });
        clearAll.addEventListener('click', () => {
            state.selectedLessonIds.clear();
            refreshSelectionUi();
        });
        missing.addEventListener('click', () => runDownload('missing'));
        all.addEventListener('click', () => runDownload('all'));
        zip.addEventListener('click', () => runDownload('zip'));
        cancel.addEventListener('click', cancelRun);

        updateDestinationLabel();
        setStatus('Pulsa "Escanear curso" para detectar los enlaces de lección.');
        updateControls();
        restoreStoredDestination().then((restored) => {
            if (restored) {
                updateDestinationLabel();
                setStatus('Carpeta oracle/ restaurada. Pulsa "Escanear curso".');
            }
        });
    }

    function initialize() {
        const isStudentHub = Boolean(
            document.querySelector('meta[name="app-alias"][content="OA-STUDENT-HUB"]')
            || document.documentElement.classList.contains('app-OA-STUDENT-HUB')
        );
        if (!isStudentHub) {
            return;
        }

        if (document.querySelector('#courseol')) {
            createPanel();
            return;
        }

        const observer = new MutationObserver(() => {
            if (document.querySelector('#courseol')) {
                observer.disconnect();
                createPanel();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 15_000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();

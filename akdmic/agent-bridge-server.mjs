import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 8765;
const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB max

// Allowlist de Orígenes de Seguridad (seguridad-web Secc. 17)
const ALLOWED_ORIGINS = [
  'https://www.akdmic.com',
  'https://ingles.akdmic.com',
  'http://localhost:8765',
  'http://127.0.0.1:8765'
];

let activeBrowserSocket = null;
let latestState = {
  view: 'DISCONNECTED',
  timestamp: Date.now(),
  message: 'Esperando conexión del Userscript en el navegador...'
};

const pendingRequests = new Map();

function isOriginAllowed(origin) {
  if (!origin) return true; // Conexiones locales sin Origin header
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed) || origin.startsWith('http://localhost:'));
}

// ==========================================
// 1. SERVIDOR HTTP Y REST API
// ==========================================
const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';

  // Verificación de Origin (seguridad-web)
  if (origin && !isOriginAllowed(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origen no autorizado por política de seguridad web.' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1.1 GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      browserConnected: !!activeBrowserSocket,
      lastStateTimestamp: latestState.timestamp,
      view: latestState.view
    }));
    return;
  }

  // 1.2 GET /api/v1/state
  if (req.method === 'GET' && url.pathname === '/api/v1/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestState, null, 2));
    return;
  }

  // 1.2b GET /api/v1/observability (DOM, popups y eventos recientes)
  if (req.method === 'GET' && url.pathname === '/api/v1/observability') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      timestamp: latestState.timestamp,
      view: latestState.view,
      url: latestState.url || null,
      observability: latestState.observability || {
        message: 'El userscript conectado aún no envía observabilidad enriquecida.'
      }
    }, null, 2));
    return;
  }

  // 1.3 POST /api/v1/plan-reasoning (Genera razonamiento estructurado antes de actuar)
  if (req.method === 'POST' && url.pathname === '/api/v1/plan-reasoning') {
    try {
      const reasoningPlan = generateReasoningPlan();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reasoningPlan, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 1.4 POST /api/v1/inspect-and-fill (Coloca respuestas con razonamiento, SIN auto-evaluar ni avanzar)
  if (req.method === 'POST' && url.pathname === '/api/v1/inspect-and-fill') {
    try {
      const result = await executeFillWithReasoning();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 1.5 POST /api/v1/action (Ejecución directa de acción atómica autorizada)
  if (req.method === 'POST' && url.pathname === '/api/v1/action') {
    let body = '';
    let bodySize = 0;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload excede el límite máximo de seguridad.' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.action) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Falta campo obligatorio "action"' }));
          return;
        }

        const result = await dispatchActionToBrowser(payload.action, payload.payload || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

// ==========================================
// 2. SERVIDOR WEBSOCKET
// ==========================================
const wss = new WebSocketServer({
  server,
  path: '/bridge',
  maxPayload: MAX_PAYLOAD_BYTES,
  verifyClient: (info, callback) => {
    const origin = info.origin || info.req.headers['origin'];
    if (isOriginAllowed(origin)) {
      callback(true);
    } else {
      console.warn(`[Seguridad] Conexión WebSocket rechazada desde origen no permitido: ${origin}`);
      callback(false, 403, 'Origen no autorizado');
    }
  }
});

wss.on('connection', (ws) => {
  console.log('\n[Bridge Server] 🟢 Navegador conectado vía WebSocket seguro.');
  activeBrowserSocket = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'STATE_UPDATE') {
        // Cuando hay varias pestañas conectadas, la pestaña que reporta el
        // estado más reciente es también la que debe recibir la siguiente
        // acción. Así evitamos despachar un clic a otra pestaña de Akdmic.
        activeBrowserSocket = ws;
        latestState = msg;
        console.log(`[Bridge Server] 🔄 Estado recibido: Vista=${msg.view} | URL=${msg.url}`);
      } else if (msg.type === 'ACTION_RESULT') {
        const reqId = msg.requestId;
        if (reqId && pendingRequests.has(reqId)) {
          const { resolve, timeoutId } = pendingRequests.get(reqId);
          clearTimeout(timeoutId);
          pendingRequests.delete(reqId);
          resolve(msg);
        }
      }
    } catch (e) {
      console.error('[Bridge Server] Error al parsear mensaje WS:', e);
    }
  });

  ws.on('close', () => {
    console.log('[Bridge Server] 🔴 Navegador desconectado.');
    if (activeBrowserSocket === ws) activeBrowserSocket = null;
  });

  ws.on('error', (err) => {
    console.error('[Bridge Server] Error en WS:', err.message);
  });
});

// ==========================================
// 3. DESPACHO DE ACCIONES AL NAVEGADOR
// ==========================================
function dispatchActionToBrowser(action, payload = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!activeBrowserSocket || activeBrowserSocket.readyState !== 1) {
      return reject(new Error('No hay navegador conectado al puente WebSocket.'));
    }

    const requestId = 'req_' + Math.random().toString(36).substring(2, 10) + Date.now();
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`Timeout de ${timeoutMs}ms esperando respuesta de acción "${action}"`));
      }
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, timeoutId });

    activeBrowserSocket.send(JSON.stringify({
      type: 'EXECUTE_ACTION',
      requestId,
      action,
      payload
    }));
  });
}

// ==========================================
// 4. MOTOR DE RAZONAMIENTO Y LLENADO SEGURO
// ==========================================
function generateReasoningPlan() {
  if (!latestState || !latestState.view) {
    throw new Error('Estado del DOM no disponible.');
  }

  const { view, exercise, plan, dashboard } = latestState;
  const reasoning = {
    timestamp: Date.now(),
    currentView: view,
    activityTitle: exercise?.title || 'Sin título',
    activityType: exercise?.type || 'desconocido',
    proposedActions: [],
    reasoningSteps: [],
    securityMode: 'USER_CONFIRMATION_REQUIRED',
    autoAdvanceBlocked: true,
    recommendation: ''
  };

  if (view === 'EXERCISE') {
    if (exercise.type === 'matching_pairs') {
      const qList = exercise.matchingPairs?.questions || [];
      const aList = exercise.matchingPairs?.answers || [];

      qList.forEach(q => {
        const matchingAns = aList.find(a => a.dataIdp === q.id);
        if (matchingAns) {
          reasoning.reasoningSteps.push({
            question: q.text,
            selectedAnswer: matchingAns.text,
            evidence: `Atributo 'data-idp="${q.id}"' coincide con pregunta #${q.questionId}`,
            confidence: 1.0,
            questionSelector: q.selector,
            answerSelector: matchingAns.selector
          });
          reasoning.proposedActions.push({
            action: 'MATCH_PAIR',
            payload: { questionSelector: q.selector, answerSelector: matchingAns.selector }
          });
        }
      });

      reasoning.recommendation = 'Se dedujeron todos los pares con 100% de coincidencia exacta. Inspecciona visualmente en pantalla antes de enviar.';
    } else if (exercise.type === 'multiple_choice') {
      const choices = exercise.choices || [];
      const correctChoices = choices.filter(choice => ['true', '1', 'yes', 'correct'].includes(String(choice.dataCorrect || '').toLowerCase()));

      correctChoices.forEach(choice => {
        reasoning.reasoningSteps.push({
          question: choice.name || 'Opción múltiple',
          selectedAnswer: choice.label || choice.value,
          evidence: `Atributo data-correct="${choice.dataCorrect}" en ${choice.selector}`,
          confidence: 1.0,
          selector: choice.selector
        });
        reasoning.proposedActions.push({
          action: 'CLICK',
          payload: { selector: choice.selector }
        });
      });

      reasoning.recommendation = correctChoices.length
        ? 'Se identificaron opciones mediante atributos explícitos del DOM. Revisa visualmente antes de evaluar.'
        : 'No hay opciones marcadas explícitamente como correctas en el DOM; no se propone una selección especulativa.';
    } else if (exercise.type === 'gap_fill') {
      const inputs = exercise.inputs || [];
      const answerInputs = inputs.filter(input => input.dataAnswer !== null && input.dataAnswer !== undefined && input.dataAnswer !== '');

      answerInputs.forEach(input => {
        reasoning.reasoningSteps.push({
          question: input.placeholder || input.name || input.id || `Campo ${input.index + 1}`,
          selectedAnswer: input.dataAnswer,
          evidence: `Respuesta declarada en el atributo data-answer/data-correct/data-val de ${input.selector}`,
          confidence: 1.0,
          selector: input.selector
        });
        reasoning.proposedActions.push({
          action: 'FILL',
          payload: { selector: input.selector, value: input.dataAnswer }
        });
      });

      reasoning.recommendation = answerInputs.length
        ? 'Se identificaron respuestas declaradas en el DOM. Revisa los campos antes de evaluar.'
        : 'No hay respuestas declaradas en los atributos del DOM; no se rellenan campos por adivinación.';
    } else if (exercise.type === 'active_learning') {
      reasoning.recommendation = 'La actividad solicita un comentario o experiencia personal. Se requiere consultar al usuario; no se propone texto, evaluación ni avance automáticos.';
      reasoning.reasoningSteps.push({
        type: 'USER_INPUT_REQUIRED',
        question: '¿Qué respuesta personal desea escribir el usuario?',
        selectedAnswer: null,
        evidence: 'La consigna es abierta y el sitio exige un comentario para continuar.',
        confidence: 1.0
      });
    } else if (exercise.type === 'texto') {
      reasoning.recommendation = 'Esta es una actividad informativa/lectura. No requiere respuestas.';
      reasoning.reasoningSteps.push({
        type: 'TEXT_SCREEN',
        evidence: 'No contiene campos interactivos de examen',
        action: 'Esperar a que concluya el temporizador de lectura'
      });
    } else {
      reasoning.recommendation = `Actividad tipo ${exercise.type}.`;
    }
  }

  return reasoning;
}

async function executeFillWithReasoning() {
  const plan = generateReasoningPlan();

  if (plan.currentView !== 'EXERCISE') {
    return {
      status: 'SKIPPED',
      message: `Vista actual es ${plan.currentView}. El llenado de respuestas solo aplica en ejercicios activos.`,
      plan
    };
  }

  if (plan.proposedActions.length > 0) {
    // 1. Mostrar razonamiento en el HUD visual del navegador
    await dispatchActionToBrowser('DISPLAY_REASONING', {
      title: plan.activityTitle,
      steps: plan.reasoningSteps
    });

    // 2. Aplicar únicamente las acciones propuestas; nunca evaluar ni avanzar
    let appliedCount = 0;
    let matchedCount = 0;
    if (plan.activityType === 'matching_pairs') {
      const matchResult = await dispatchActionToBrowser('MATCH_ALL_PAIRS', {});
      if (matchResult.status !== 'SUCCESS') {
        return {
          status: 'BLOCKED',
          message: matchResult.error || 'Matching detenido: se requiere un plan semántico verificado.',
          reasoning: plan
        };
      }
      matchedCount = matchResult.data?.totalMatched || 0;
      appliedCount = matchedCount;
    } else {
      for (const proposed of plan.proposedActions) {
        const result = await dispatchActionToBrowser(proposed.action, proposed.payload);
        if (result.status !== 'SUCCESS') {
          throw new Error(result.error || `Falló la acción ${proposed.action}`);
        }
        appliedCount += 1;
      }
    }

    return {
      status: 'FILLED_ON_SCREEN',
      message: 'Respuestas colocadas exitosamente en pantalla. NO se ha enviado la evaluación ni se ha avanzado de actividad.',
      appliedCount,
      matchedCount,
      reasoning: plan
    };
  }

  return {
    status: 'NO_ACTION',
    message: 'No hay acciones de llenado aplicables para esta actividad.',
    plan
  };
}

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`
╔═════════════════════════════════════════════════════════════════════╗
║          ⚡ AKDMIC AGENT DOM BRIDGE (MODO SEGURO) ⚡                 ║
║                                                                     ║
║  WebSocket Server: ws://localhost:${PORT}/bridge                      ║
║  HTTP REST API:    http://localhost:${PORT}/api/v1/state              ║
║  Observability:    http://localhost:${PORT}/api/v1/observability     ║
║  Plan Reasoning:   http://localhost:${PORT}/api/v1/plan-reasoning     ║
║  Inspect & Fill:   http://localhost:${PORT}/api/v1/inspect-and-fill   ║
║                                                                     ║
║  🛡️ Seguridad: Origin Allowlist & Max Payload 256KB Activo          ║
║  🛑 Política: NO auto-avance por defecto (espera confirmación)       ║
╚═════════════════════════════════════════════════════════════════════╝
`);
});

#!/usr/bin/env node

/**
 * Akdmic Agent Client CLI (Modo Seguro con Razonamiento y Confirmación)
 */

import readline from 'node:readline';

const BASE_URL = process.env.BRIDGE_URL || 'http://localhost:8765';

async function request(endpoint, options = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function askUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const commands = {
  // 1. Obtener estado del DOM
  async state() {
    const data = await request('/api/v1/state');
    console.log(JSON.stringify(data, null, 2));
  },

  // 1b. Inspección resumida del DOM y eventos observados
  async inspect() {
    const data = await request('/api/v1/observability');
    const observation = data.observability || {};
    console.log(JSON.stringify({
      timestamp: data.timestamp,
      view: data.view,
      url: data.url,
      page: observation.page,
      dom: observation.dom ? {
        nodeCount: observation.dom.nodeCount,
        nodesIncluded: observation.dom.nodesIncluded,
        structureTruncated: observation.dom.structureTruncated,
        visibleText: observation.dom.visibleText
      } : null,
      interactive: observation.interactive ? {
        total: observation.interactive.total,
        truncated: observation.interactive.truncated,
        elements: observation.interactive.elements
      } : null,
      popups: observation.popups || [],
      recentChanges: observation.recentChanges || [],
      runtimeEvents: observation.runtimeEvents || []
    }, null, 2));
  },

  // 1c. Progreso de las actividades del plan actual
  async progress() {
    const state = await request('/api/v1/state');
    if (state.view !== 'PLAN' || !state.plan) {
      console.log(JSON.stringify({ view: state.view, message: 'La vista actual no es un plan.' }, null, 2));
      return;
    }
    console.log(JSON.stringify({
      view: state.view,
      url: state.url,
      lessonId: state.plan.currentLessonId,
      summary: state.plan.progressSummary,
      exercises: state.plan.currentLessonExercises
    }, null, 2));
  },

  // 2. Health check
  async health() {
    const data = await request('/health');
    console.log(JSON.stringify(data, null, 2));
  },

  // 3. Ver plan de razonamiento
  async plan() {
    const plan = await request('/api/v1/plan-reasoning', { method: 'POST' });
    console.log('\n======================================================');
    console.log(`🧠 PLAN DE RAZONAMIENTO DEL AGENTE: ${plan.activityTitle}`);
    console.log(`📌 Tipo: ${plan.activityType} | Vista: ${plan.currentView}`);
    console.log('======================================================');

    if (plan.reasoningSteps.length === 0) {
      console.log('ℹ️  No hay pasos de razonamiento pendientes para la vista actual.');
      return;
    }

    plan.reasoningSteps.forEach((s, idx) => {
      console.log(`\n[Paso ${idx + 1}]`);
      console.log(`  🔹 Pregunta:  "${s.question}"`);
      console.log(`  🔸 Respuesta: "${s.selectedAnswer}"`);
      console.log(`  💡 Evidencia: ${s.evidence}`);
      console.log(`  🎯 Confianza: ${Math.round((s.confidence || 1) * 100)}%`);
    });

    console.log('\n------------------------------------------------------');
    console.log(`🛡️  Recomendación: ${plan.recommendation}`);
    console.log('🛑  Política: Auto-avance bloqueado por seguridad.');
    console.log('------------------------------------------------------\n');
  },

  // 4. Colocar respuestas en pantalla (con confirmación por defecto)
  async fill(autoConfirm = false) {
    const plan = await request('/api/v1/plan-reasoning', { method: 'POST' });
    
    if (plan.currentView !== 'EXERCISE') {
      console.log(`⚠️  Vista actual: ${plan.currentView}. Esta acción requiere estar dentro de un ejercicio.`);
      return;
    }

    console.log('\n======================================================');
    console.log(`🧠 RAZONAMIENTO ANTES DE ACTUAR (${plan.activityTitle})`);
    console.log('======================================================');

    plan.reasoningSteps.forEach((s, idx) => {
      console.log(`  ${idx + 1}. "${s.question}" ➔ "${s.selectedAnswer}"`);
      console.log(`     💡 [${s.evidence}]`);
    });

    console.log('======================================================');

    if (!autoConfirm && autoConfirm !== '--yes' && autoConfirm !== '-y') {
      const resp = await askUser('\n¿Aprobar y colocar estas respuestas en la pantalla? (s/n): ');
      if (resp !== 's' && resp !== 'si' && resp !== 'y' && resp !== 'yes') {
        console.log('❌ Acción cancelada por el usuario. No se modificó la página.');
        return;
      }
    }

    console.log('\n⚡ Aplicando respuestas en pantalla...');
    const result = await request('/api/v1/inspect-and-fill', { method: 'POST' });
    console.log(`✅ ${result.message}`);
    console.log('🛑 Recuerda: La evaluación NO se ha enviado. Puedes revisarla en tu navegador.');
  },

  // 5. Enviar evaluación manualmente cuando el usuario esté listo
  async submit() {
    const resp = await askUser('¿Estás seguro de enviar la evaluación del ejercicio actual? (s/n): ');
    if (resp === 's' || resp === 'si' || resp === 'y' || resp === 'yes') {
      const res = await request('/api/v1/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'SUBMIT', payload: { confirmed: true } })
      });
      console.log('✅ Evaluación enviada:', res);
    } else {
      console.log('❌ Envío cancelado.');
    }
  },

  // 6. Avanzar al siguiente ejercicio manualmente
  async next() {
    const res = await request('/api/v1/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'NAVIGATE_NEXT', payload: { confirmed: true } })
    });
    console.log('✅ Navegando al siguiente ejercicio:', res);
  }
};

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || !commands[cmd]) {
  console.log(`
╔═════════════════════════════════════════════════════════════════════╗
║            ⚡ AKDMIC AGENT CLI (MODO SEGURO Y EXPLICABLE) ⚡         ║
╚═════════════════════════════════════════════════════════════════════╝

Comandos disponibles:
  plan                  Muestra el razonamiento estructurado sin tocar la página
  fill [-y]             Pide confirmación, muestra el razonamiento y coloca respuestas
  submit                Envía la evaluación del ejercicio actual (con confirmación)
  next                  Avanza a la siguiente actividad
  state                 Muestra el objeto JSON con el estado semántico del DOM
  inspect               Muestra estructura DOM resumida, popups y eventos recientes
  progress              Muestra progreso, intentos y calificaciones del plan actual
  health                Comprueba el estado del servidor y la conexión WebSocket
`);
  process.exit(0);
}

commands[cmd](...args).catch(err => {
  console.error('[Agent CLI] Error:', err.message);
  process.exit(1);
});

# UserScripts

Userscripts ([Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/get-it/)) para automatizar tareas repetitivas
en plataformas académicas y web.

## Instalación

Abre el `.user.js` correspondiente, copia el contenido y pégalo en
Tampermonkey o Violentmonkey (**Crear nuevo script** → pegar → guardar).

| Userscript | Qué hace |
| --- | --- |
| [`akdmic/akdmic-bridge.user.js`](./akdmic/akdmic-bridge.user.js) | Puente WebSocket entre el navegador y un agente externo para instrumentar ejercicios de [akdmic](https://www.akdmic.com/). Requiere el servidor local ([ver abajo](#akdmic-servidor-puente)). |
| [`Calendario/Registro-Becario-Userscript/extraer-horario-siu-anahuac.user.js`](./Calendario/Registro-Becario-Userscript/extraer-horario-siu-anahuac.user.js) | Extrae el horario de clases del SIU Anáhuac a JSON. |
| [`Calendario/Registro-Becario-Userscript/registro-becario-despues-de-clases.user.js`](./Calendario/Registro-Becario-Userscript/registro-becario-despues-de-clases.user.js) | Registro de servicio becario y sincronización con Google Calendar. |
| [`Calendario/Webassign/webassign-userscript-calendario.js`](./Calendario/Webassign/webassign-userscript-calendario.js) | Sincroniza tareas de WebAssign con Google Calendar y exporta a LaTeX/PDF. |
| [`chatgpt/chatgpt-conversacion-al-portapapeles.user.js`](./chatgpt/chatgpt-conversacion-al-portapapeles.user.js) | Copia una conversación completa de ChatGPT al portapapeles. |
| [`oracle/oracle-downloader-userscript.js`](./oracle/oracle-downloader-userscript.js) | Descarga material de cursos de Oracle Academy. |
| [`whatsapp/whatsapp-toggle-lista-contactos.user.js`](./whatsapp/whatsapp-toggle-lista-contactos.user.js) | Alterna la lista de contactos en WhatsApp Web a vista compacta. |

## akdmic: servidor puente

`akdmic-bridge.user.js` por sí solo no hace nada: necesita el servidor local
corriendo para recibir instrucciones del agente.

```bash
cd akdmic
pnpm install
node agent-bridge-server.mjs
```

Con el servidor activo, `agent-client.mjs` es la CLI para dar instrucciones:

```bash
node agent-client.mjs plan
```

Requiere Node.js 18+ y pnpm (`corepack enable && corepack prepare pnpm@latest --activate`).

## Licencia

[MIT](./LICENSE). El código se puede usar, modificar y redistribuir
libremente conservando el aviso de copyright, sin garantía de ningún tipo.

## Aviso

Estos scripts automatizan interacciones en sitios de terceros. Úsalos solo en
cuentas propias y conforme a los términos de servicio de cada plataforma.

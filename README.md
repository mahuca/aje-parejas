# Aje-Parejas

Torneo de ajedrez por correspondencia en formato **knockout de parejas**.

- **En línea:** https://aje-parejas.onrender.com/parejas
- **Cuadro y sorteo:** `/parejas`
- **Lobby y clasificación:** `/corespon`
- **Día de inicio:** [CHECKLIST-INICIO.md](CHECKLIST-INICIO.md)

## Cómo funciona

- Se eligen los jugadores y se sortean **parejas y colores al azar**.
- Cada pareja juega **una partida por ronda**; el perdedor queda eliminado.
- Si hay **tablas**, se repite la partida con los colores cambiados hasta que haya ganador.
- Tras unas tablas, la siguiente partida puede jugarse **en vivo**: si **los dos** aceptan, se juega del tirón, sin plazo y con el tablero abierto a cualquiera que tenga el enlace (`?ver=1`). Si no hay acuerdo, sigue como correspondencia.
- Los ganadores se **re-emparejan al azar** en la ronda siguiente.
- Si el número de jugadores es impar, **pasa libre el mejor clasificado** (rating; desempate por victorias y nombre).
- El último que queda es el **campeón**.

Cada jugador entra con su nombre y una clave de 4–6 dígitos (se registra durante la ventana de alta que se abre al crear el torneo).

## Comandos

| Acción | Comando |
|---|---|
| Instalar dependencias | `npm install` |
| Arrancar | `npm start` |
| Desarrollo con recarga | `npm run dev` |
| Tests | `npm test` |
| Crear roster inicial | `npm run init-db` |

## Variables de entorno

`DATABASE_URL`, `PIN_PEPPER`, `ADMIN_TOKEN`, `BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TZ`, `NOTIFY_PROVIDER`.

Sin `DATABASE_URL` la app guarda en memoria y pierde todo al reiniciar.

## Despliegue

- Servicio Render `aje-parejas` (plan free, Oregón) desde `main`.
- Base de datos propia `aje_parejas` en Neon, separada de `neondb` (la de `aje-corespon`).
- `render.yaml` define el servicio y las variables.

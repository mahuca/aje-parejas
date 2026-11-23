# Aje-Parejas

Torneo de ajedrez por correspondencia en formato **knockout de parejas**.

- **En línea:** https://aje-parejas.onrender.com/parejas
- **Cuadro y sorteo:** `/parejas`
- **Lobby y clasificación:** `/corespon`
- **Día de inicio:** [CHECKLIST-INICIO.md](CHECKLIST-INICIO.md)

## Cómo funciona

- Se eligen los jugadores y se sortean **parejas y colores al azar**.
- Cada cruce son **dos partidas**: ida y vuelta, con los colores cambiados. La vuelta se crea sola al terminar la ida, en una sala nueva.
- Se suma **1 punto por victoria y 0,5 por tablas**. Pasa quien tenga más puntos; con **1–1** (una victoria cada uno o dos tablas) se juega un desempate.
- El **desempate nace en vivo**: sin plazo, del tirón y con el tablero abierto a cualquiera que tenga el enlace (`?ver=1`). Si no hay ganador en **24 h**, pasa a correspondencia con el plazo normal de 2 días. Si el desempate acaba en tablas, se juega otro.
- Los ganadores se **re-emparejan al azar** en la ronda siguiente.
- Si el número de jugadores es impar, **el bye se sortea al azar** entre los que quedan (como las parejas y los colores).
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

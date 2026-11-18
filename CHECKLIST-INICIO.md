# Checklist: día de inicio del torneo

Producción: https://aje-parejas.onrender.com
Cuadro: `/parejas` · Lobby: `/corespon`

## Antes de crear el torneo

- [ ] Confirmar la fecha y la lista definitiva de jugadores (2–16).
- [ ] **No crear el torneo antes de tiempo**: al crearlo se generan las salas y se abre el alta de claves **72 h**. El plazo de cada partida no corre hasta que entran los dos, pero las salas ya existen.
- [ ] Comprobar que producción está sana: `GET /healthz` → `storage: postgres`.

## Crear el torneo

- [ ] Abrir `/parejas`.
- [ ] Pegar los nombres en «Jugadores del sorteo, uno por línea» y crear el torneo.
- [ ] Verificar en el cuadro: una partida por pareja, con su código y enlace.

## Reparto de claves (alta)

- [ ] Enviar a cada jugador el enlace de **su** sala: `/corespon/<CÓDIGO>`.
- [ ] Cada jugador elige su nombre y una clave de **4–6 dígitos**. Se pide **una vez por dispositivo** y se guarda en el navegador.
- [ ] Si el alta ha caducado, reabrir 24 h:

  ```bash
  curl -X POST "https://aje-parejas.onrender.com/api/admin/enrollment" \
    -H "Content-Type: application/json" \
    -H "x-admin-token: $ADMIN_TOKEN" \
    -d '{"abrir": true, "horas": 24}'
  ```

- [ ] Comprobar que no queda nadie sin clave: `GET /api/admin/enrollment` → `sinClave: 0`.
- [ ] Cerrar el alta:

  ```bash
  curl -X POST "https://aje-parejas.onrender.com/api/admin/enrollment" \
    -H "Content-Type: application/json" \
    -H "x-admin-token: $ADMIN_TOKEN" \
    -d '{"abrir": false}'
  ```

> Si hay partidas en curso al activar las claves, ejecutar antes `POST /api/admin/rotate-seats` (cambia los tokens de las salas sin tocar FEN, PGN, plazos ni turno).

## Inicio y seguimiento

- [ ] El **plazo de 2 días** empieza cuando **los dos** jugadores han entrado en la sala.
- [ ] Telegram avisa del turno al jugador que debe mover y del fin de partida.
- [ ] «Partidas abiertas» ordena por plazo y agrupa: *Te toca mover*, *Esperando al rival* y *Otras partidas*.

## Tablas y desempate

- [ ] Al acabar en tablas se crea sola la sala de desempate con los **colores cambiados**.
- [ ] En esa sala aparece **«Jugar el desempate ahora»**. Si aceptan **los dos**, pasa a **🔴 En vivo**: sin plazo, sin prórroga y sin avisos de turno por Telegram.
- [ ] Si no aceptan los dos, el desempate sigue como correspondencia normal (2 días).
- [ ] Espectadores: cualquier persona con el enlace puede mirar con `?ver=1` (no puede mover).

## Comprobaciones rápidas

- [ ] `GET /healthz` → `{ "ok": true, "storage": "postgres" }`.
- [ ] `GET /api/parejas/torneos/actual` → torneo `en_curso` con las partidas.
- [ ] `GET /api/partidas` → salas abiertas con `ritmo` (`correspondencia` / `vivo`).
- [ ] `GET /api/parejas/jugador/<Nombre>` → partidas y enlaces de un jugador.

## Si algo se atasca

- **Sala atascada o de prueba**: `DELETE /api/partidas/<CÓDIGO>` con `x-admin-token` (no genera resultado ni afecta a la clasificación).
- **Cambiar o borrar la clave** de un jugador: `PATCH /api/tournament/players/<id>` con `{ "pin": "1234" }` o `{ "pin": null }`.
- **Dar de baja** sin borrar historial: `PATCH /api/tournament/players/<id>` con `{ "activa": false }`.
- **Reenviar enlaces**: `GET /api/parejas/jugador/<Nombre>`.

## Reglas de oro

- No tocar `neondb` (la base de `aje-corespon`) ni el servicio `aje-corespon`.
- Las salas no se vacían: se marcan `cancelada` o se borran de una en una con el endpoint admin.
- Tras cambiar una variable en Render: **Manual Deploy → Deploy latest commit**.

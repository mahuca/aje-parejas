# Plan: Torneo de Ajedrez por Correspondencia - Formato Knockout

## Formato de la competición

1. **Inscripción de jugadores**: Los jugadores se registran en el torneo proporcionando sus nombres
2. **Sorteo inicial**: Se emparejan aleatoriamente todos los jugadores inscritos
3. **Fase de parejas**: Cada pareja juega una primera partida con color aleatorio (blancas/negras)
   - **Ganador**: Avanza a la siguiente ronda
   - **Empate (tablas)**: Se juega una segunda partida con los colores **invertidos** (quien tenía blancas ahora tiene negras y viceversa)
   - El ganador de la segunda partida (o la primera si no hay empate) avanza
4. **Siguientes rondas**: Los ganadores de cada pareja se emparejan aleatoriamente para la siguiente ronda
5. **Semifinales**: Cuando queden 4 jugadores, se forman nuevas parejas y juegan
6. **Final**: Cuando quedan 2 jugadores, juegan el partido por el campeonato
   - Si empatan la primera, juegan una segunda con colores invertidos
   - El ganador es el campeón

## Estructura de la base de datos (SQLite)

Se añaden/modifican las siguientes tablas en `src/db.js`:

### `torneos`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `nombre` TEXT NOT NULL
- `estado` TEXT DEFAULT 'inscripciones' ('inscripciones', 'en_curso', 'finalizado')
- `creado_en` TEXT DEFAULT(datetime('now'))
- `jugador_champion` TEXT (ganador final)

### `inscripciones_torneo`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `torneo_id` INTEGER REFERENCES torneos(id)
- `usuario_id` INTEGER REFERENCES usuarios(id)
- `orden_sorteo` INTEGER (para el sorteo aleatorio)
- `activo` INTEGER DEFAULT 1

### `partidas_torneo`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `torneo_id` INTEGER REFERENCES torneos(id)
- `ronda` INTEGER
- `jugador_blanco` INTEGER REFERENCES usuarios(id)
- `jugador_negro` INTEGER REFERENCES usuarios(id)
- `color_sorteado` TEXT ('blanco', 'negro') - color del jugador que inició
- `estado` TEXT DEFAULT 'pendiente' ('pendiente', 'en_curso', 'gano_blanco', 'gano_negro', 'tablas', 'abandonado')
- `resultado_final` TEXT ('1-0', '0-1', '1/2-1/2')
- `gano_con_blancas` INTEGER DEFAULT 0 (1 si quien ganó tenía blancas en el desempate)
- `creada_en` TEXT DEFAULT(datetime('now'))
- `finalizada_en` TEXT

### `movimientos_torneo`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `partida_torneo_id` INTEGER REFERENCES partidas_torneo(id)
- `numero` INTEGER
- `san` TEXT (notación algebraica)
- `from_a` TEXT (origen)
- `to_a` TEXT (destino)
- `jugado_en` TEXT DEFAULT(datetime('now'))

## Lógica del torneo

### 1. Crear torneo
- Recibir lista de nombres de jugadores
- Asignar orden aleatorio `orden_sorteo`
- Generar parejas: emparejar jugadores consecutivos (1-2, 3-4, 5-6, ...) o sorteo completo
- Para cada pareja, crear primera partida con color aleatorio

### 2. Flujo de una partida de pareja
1. Se crea la partida con color aleatorio (¿quién tiene blancas?)
2. Se juega la partida hasta mate, tiempo, o acuerdo
3. **Si hay ganador**: El jugador ganador avanza a la siguiente ronda
4. **Si hay tablas**: Se juega una segunda partida con colores invertidos
   - El que tenía blancas ahora tiene negras
   - El que tenía negras ahora tiene blancas
   - El ganador de la segunda partida avanza
5. Los resultados se guardan en `partidas_torneo`

### 3. Siguiente ronda
- Los ganadores de todas las parejas se reúnen
- Se vuelven a emparejar aleatoriamente
- Se repite el proceso
- Si hay un número impar de jugadores, el "bye" (jugador que pasa automáticamente) se sortea

### 4. Final
- Cuando quedan 2 jugadores, juegan el partido por el campeonato
- Formato: misma regla que las parejas (primera partida, desempate si es necesario)
- El ganador es el campeón y se guarda en `torneos.jugador_champion`

## API Endpoints

### Inscripciones
- `POST /api/torneo/inscribir` - Inscribirse en un torneo (body: { nombre })
- `GET /api/torneo/inscripciones` - Ver inscripciones actuales
- `DELETE /api/torneo/retirarse` - Retirarse del torneo

### Torneo
- `POST /api/torneo/crear` - Crear nuevo torneo (body: { nombres: ["Jugador1", "Jugador2", ...] })
- `GET /api/torneo/estado` - Ver estado actual del torneo
- `GET /api/torneo/proxima-partida` - Ver la próxima partida que hay que jugar
- `POST /api/torneo/hacer-movimiento` - Hacer una jugada en la partida actual
- `POST /api/torneo/aceptar-empate` - Aceptar tablas en la partida actual

### Resultados
- `GET /api/torneo/resultados` - Ver resultados y clasificación
- `POST /api/torneo/registrar-resultado` - Registrar el resultado de una partida

## Flujo de trabajo técnico

1. **Cliente**: El usuario entra al torneo, se inscribe y espera su partida
2. **Servidor**: Administra el estado del torneo, las parejas y los plazos
3. **Motor de ajedrez**: Valida las jugadas usando el motor existente (`shared/engine.js`)
4. **Persistencia**: Guarda los estados de las partidas, historiales y resultados en SQLite

## Modificaciones necesarias

### `src/db.js`
- Añadir tablas `torneos`, `inscripciones_torneo`, `partidas_torneo`, `movimientos_torneo`
- Mantener tablas existentes `usuarios` y `partidas` (modo local)

### `src/rutas/partidas.js`
- Añadir lógica para detectar modo torneo vs modo local
- Enrutar llamadas a la lógica correcta según el contexto

### `public/app.js`
- Nuevo modo "torneo" en la interfaz
- Ver emparejamientos, jugar partidas, ver bracket

### `src/rutas/usuarios.js`
- Ya tiene `async` para operaciones bcrypt (verificado)

## Decisiones clave

1. **Formato knockout**: Eliminación directa, a diferencia del round-robin existente
2. **Desempate con colores invertidos**: Si la primera partida termina en tablas, la segunda juega con colores cambiados
3. **Máximo 16 jugadores**: Limitación práctica para la interfaz y UX
4. **Orden aleatorio de sorteo**: Cada torneo tiene un nuevo sorteo aleatorio
5. **Integración con sistema existente**: Aprovecha el motor de ajedrez, la base de datos SQLite y la UI ya presentes

## Próximos pasos

1. Modificar `src/db.js` para añadir las nuevas tablas del torneo
2. Crear/actualizar `src/rutas/torneo.js` con la lógica del torneo knockout
3. Actualizar `public/app.js` con el modo torneo en la interfaz
4. Probar el flujo completo: inscribir jugadores, crear torneo, jugar partidas
5. Verificar que el desempate con colores invertidos funcione correctamente

## Diferencias con el formato round-robin existente

El proyecto `aje-parejas` ya tiene un formato round-robin (todos contra todos, 2 partidas por pareja). Este nuevo plan implementa un formato knockout (eliminación directa), que es:

- **Más rápido**: Menos partidas en total (log2(n) rondas vs n*(n-1)/2 * 2)
- **Más emocionante**: Cada partida cuenta, un solo error elimina
- **Formato de campeonato**: Similar a torneos reales de ajedrez
- **Menos partidas por jugador**: Cada jugador juega aproximadamente 2-3 partidas vs n-1 oponentes en round-robin
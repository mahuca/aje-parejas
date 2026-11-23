'use strict';

/*
 * Torneo de ajedrez por correspondencia de PAREJAS (formato knockout).
 *
 * Reglas:
 *  - Sorteo aleatorio de parejas y de colores.
 *  - Cada pareja juega dos partidas: ida y vuelta, con los colores cambiados.
 *    La vuelta se crea al terminar la ida.
 *  - Puntos: victoria 1, tablas 0,5. Si el marcador queda igualado después de
 *    las dos (una victoria cada uno, o dos tablas), se juega un desempate.
 *  - El desempate nace en vivo: sin plazo, del tirón, y se repite si vuelve a
 *    haber tablas. Si no hay ganador en 24 h, sigue como correspondencia.
 *  - Los ganadores de la ronda se vuelven a sortear (parejas y colores) para
 *    la ronda siguiente.
 *  - Con un número impar de jugadores, uno pasa libre (bye) al azar.
 *  - Cuando queda un único jugador, es el campeón.
 *
 * El estado completo del torneo se guarda como JSON en `corespon_ajustes`
 * (la misma tabla clave/valor que usa el resto de la aplicación), así que
 * funciona igual con Postgres y con el almacén en memoria.
 */

const crypto = require('crypto');

const CLAVE_ACTUAL = 'parejas_torneo_actual';
const CLAVE_LISTA = 'parejas_torneo_lista';
const claveTorneo = (id) => 'parejas_torneo:' + id;

const MIN_JUGADORES = 2;
const MAX_JUGADORES = 16;
const MAX_NOMBRE = 40;
const ALTA_DEFAULT_HORAS = 72;
// Tope del desempate en vivo: pasado este tiempo sin ganador, sigue como
// correspondencia con el plazo normal.
const DESEMPATE_VIVO_HORAS = 24;

function idJugador(nombre) {
  return String(nombre || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, MAX_NOMBRE);
}

function mismoNombre(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function shuffle(lista, rng = Math.random) {
  const copia = lista.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function nuevoId(prefijo) {
  return prefijo + crypto.randomBytes(4).toString('hex');
}

function limpiarNombres(nombres) {
  const vistos = new Set();
  const limpios = [];
  for (const bruto of nombres || []) {
    const nombre = String(bruto || '').trim().replace(/\s+/g, ' ');
    if (!nombre) continue;
    if (nombre.length > MAX_NOMBRE) {
      throw new Error('Nombre demasiado largo (máximo ' + MAX_NOMBRE + ')');
    }
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    limpios.push(nombre);
  }
  return limpios;
}

/*
 * Empareja una lista de nombres al azar. Si es impar, uno pasa libre: el
 * último del sorteo. No se elige por clasificación (en la primera ronda todos
 * parten con 1500 y 0 victorias).
 * Devuelve { parejas, bye }.
 */
function sortearParejas(nombres, rng = Math.random) {
  const resto = shuffle(nombres, rng);
  const parejas = [];
  let bye = null;

  if (resto.length % 2 === 1) bye = resto.pop();

  for (let i = 0; i + 1 < resto.length; i += 2) {
    parejas.push([resto[i], resto[i + 1]]);
  }
  return { parejas, bye, orden: resto.concat(bye ? [bye] : []) };
}

/*
 * Estado de un cruce a partir de sus partidas: ida, vuelta y desempate(s).
 * Puntos: victoria 1, tablas 0,5. Un desempate decidido cierra el cruce; si
 * no lo hay, el marcador de ida y vuelta decide (e igualado pide desempate).
 *
 * `idaVuelta` es false en los torneos antiguos (una sola partida por cruce):
 * allí gana el primero que decida una partida.
 *
 * Devuelve { decidido, ganador, puntos, fase }.
 */
function resultadoCruce(juegos, idaVuelta = true) {
  const orden = (juegos || []).slice().sort((a, b) => (a.juego || 1) - (b.juego || 1));
  const ida = orden.find((p) => (p.juego || 1) === 1) || null;
  const vuelta = orden.find((p) => p.juego === 2) || null;
  const desempates = orden.filter((p) => (p.juego || 1) >= 3);

  const puntos = {};
  const sumar = (p) => {
    if (p.estado === 'ganada' && p.ganador) {
      puntos[p.ganador] = (puntos[p.ganador] || 0) + 1;
    } else if (p.estado === 'tablas') {
      puntos[p.blanco] = (puntos[p.blanco] || 0) + 0.5;
      puntos[p.negro] = (puntos[p.negro] || 0) + 0.5;
    }
  };
  orden.forEach(sumar);
  // El marcador siempre existe, aunque la ida esté pendiente (0–0).
  if (ida) {
    puntos[ida.blanco] = puntos[ida.blanco] || 0;
    puntos[ida.negro] = puntos[ida.negro] || 0;
  }

  // Formato antiguo: la primera partida con ganador cierra el cruce.
  if (!idaVuelta) {
    const ganada = orden.filter((p) => p.estado === 'ganada' && p.ganador).pop();
    return {
      decidido: !!ganada,
      ganador: ganada ? ganada.ganador : null,
      puntos,
      fase: ganada ? (ganada.juego >= 3 ? 'desempate' : 'ida') : 'ida'
    };
  }

  const decisivo = desempates.filter((p) => p.estado === 'ganada' && p.ganador).pop();
  if (decisivo) {
    return { decidido: true, ganador: decisivo.ganador, puntos, fase: 'desempate' };
  }

  const dosJugadas = !!(ida && vuelta && ida.estado !== 'pendiente' && vuelta.estado !== 'pendiente');
  if (dosJugadas) {
    const a = ida.blanco;
    const b = ida.negro;
    const pa = puntos[a] || 0;
    const pb = puntos[b] || 0;
    if (pa !== pb) {
      return { decidido: true, ganador: pa > pb ? a : b, puntos, fase: 'vuelta' };
    }
    return { decidido: false, ganador: null, puntos, fase: 'desempate' };
  }

  return {
    decidido: false,
    ganador: null,
    puntos,
    fase: desempates.length ? 'desempate' : (ida && ida.estado !== 'pendiente' ? 'vuelta' : 'ida')
  };
}

/*
 * Proyección pública del torneo para la API y la interfaz.
 */
function publico(torneo) {
  if (!torneo) return null;

  const partidas = (torneo.partidas || []).map((p) => ({
    id: p.id,
    matchId: p.matchId,
    ronda: p.ronda,
    juego: p.juego,
    blanco: p.blanco,
    negro: p.negro,
    estado: p.estado,
    ritmo: p.ritmo || 'correspondencia',
    desempate: !!p.desempate,
    resultado: p.resultado || null,
    ganador: p.ganador || null,
    roomCode: p.roomCode,
    enlace: '/corespon/' + p.roomCode,
    creadaEn: p.creadaEn,
    finalizadaEn: p.finalizadaEn || null
  }));

  const rondas = {};
  for (const p of partidas) {
    (rondas[p.ronda] = rondas[p.ronda] || []).push(p);
  }

  // Marcador y ganador de cada cruce, para pintar el cuadro.
  const idaVuelta = torneo.formato === 'ida-vuelta';
  const porCruce = new Map();
  for (const p of partidas) {
    if (!porCruce.has(p.matchId)) porCruce.set(p.matchId, []);
    porCruce.get(p.matchId).push(p);
  }
  const cruces = {};
  for (const [matchId, juegos] of porCruce) {
    cruces[matchId] = resultadoCruce(juegos, idaVuelta);
  }

  return {
    id: torneo.id,
    nombre: torneo.nombre,
    formato: torneo.formato || 'partida-unica',
    estado: torneo.estado,
    ronda: torneo.ronda,
    creadoEn: torneo.creadoEn,
    jugadores: (torneo.jugadores || []).map((j) => ({ ...j })),
    byes: (torneo.byes || []).map((b) => ({ ...b })),
    campeon: torneo.campeon || null,
    partidas,
    rondas,
    cruces,
    partidasPendientes: partidas.filter((p) => p.estado === 'pendiente').length
  };
}

function crearTorneoManager(options = {}) {
  const { store, crearSala, abrirAlta, log = () => {} } = options;
  if (!store) throw new Error('torneo: falta el store');
  if (typeof crearSala !== 'function') throw new Error('torneo: falta crearSala');
  if (typeof abrirAlta !== 'function') throw new Error('torneo: falta abrirAlta');

  let actual = null;
  let cargado = false;

  // Serializa las escrituras: dos finales simultáneos no deben pisarse.
  let cola = Promise.resolve();
  function conBloqueo(fn) {
    const ejecucion = cola.then(fn, fn);
    cola = ejecucion.then(() => undefined, () => undefined);
    return ejecucion;
  }

  async function guardar(torneo) {
    await store.setAjuste(claveTorneo(torneo.id), JSON.stringify(torneo));
    await store.setAjuste(CLAVE_ACTUAL, torneo.id);

    const lista = (await store.getAjuste(CLAVE_LISTA)) || '';
    const ids = new Set(lista ? lista.split(',').filter(Boolean) : []);
    ids.add(torneo.id);
    await store.setAjuste(CLAVE_LISTA, [...ids].join(','));
    return torneo;
  }

  async function cargar() {
    if (cargado) return actual;
    const id = await store.getAjuste(CLAVE_ACTUAL);
    if (id) {
      const bruto = await store.getAjuste(claveTorneo(id));
      if (bruto) {
        try {
          actual = JSON.parse(bruto);
        } catch (error) {
          log('Torneo ilegible en la base de datos:', error.message);
          actual = null;
        }
      }
    }
    cargado = true;
    return actual;
  }

  async function resolverJugador(nombre) {
    const limpio = String(nombre || '').trim();
    if (!limpio) return null;
    const jugadores = await store.getPlayers();
    const existente = jugadores.find((p) => mismoNombre(p.nombre, limpio));
    if (existente) return existente;

    const id = idJugador(limpio);
    const nuevo = { id, nombre: limpio, activa: true, admin: false, telegram: null };
    await store.savePlayer(nuevo);
    return nuevo;
  }

  /*
   * Crea una partida nueva (sala real) y la añade al torneo.
   * La ida y los desempates sortean color; la vuelta llega con los colores
   * ya cambiados por quien llama.
   */
  async function crearPartida(torneo, { ronda, matchId, juego, a, b, ritmo, desempate, parentCode }) {
    let blanco = a;
    let negro = b;
    const numero = juego || 1;
    if (numero === 1 || numero >= 3) {
      if (Math.random() < 0.5) {
        blanco = b;
        negro = a;
      }
    }

    const sala = await crearSala({
      blanco,
      negro,
      ronda,
      juego: juego || 1,
      matchId,
      torneoId: torneo.id,
      ritmo: ritmo || 'correspondencia',
      desempate: !!desempate,
      parentCode: parentCode || null
    });

    const partida = {
      id: nuevoId('p_'),
      matchId,
      ronda,
      juego: juego || 1,
      blanco,
      negro,
      roomCode: sala.code,
      ritmo: ritmo === 'vivo' ? 'vivo' : 'correspondencia',
      desempate: !!desempate,
      estado: 'pendiente',
      resultado: null,
      ganador: null,
      creadaEn: new Date().toISOString(),
      finalizadaEn: null
    };
    torneo.partidas.push(partida);
    return partida;
  }

  /*
   * Arranca una ronda con la lista de clasificados. Si quedan dos, es la
   * final; si queda uno, ya hay campeón.
   */
  async function iniciarRonda(torneo, clasificados, ronda) {
    torneo.ronda = ronda;

    if (clasificados.length <= 1) {
      torneo.estado = 'finalizado';
      torneo.campeon = clasificados[0] || torneo.campeon || null;
      if (torneo.campeon) {
        torneo.finalizadoEn = new Date().toISOString();
      }
      return [];
    }

    // Con número impar, el bye también entra en el sorteo: no depende de la
    // clasificación (en la primera ronda todos parten con 1500 y 0 victorias).
    const { parejas, bye } = sortearParejas(clasificados);
    if (bye) {
      torneo.byes.push({ ronda, nombre: bye, motivo: 'sorteo' });
    }

    const creadas = [];
    for (let i = 0; i < parejas.length; i++) {
      const [a, b] = parejas[i];
      const matchId = 'r' + ronda + 'm' + (i + 1);
      const partida = await crearPartida(torneo, { ronda, matchId, juego: 1, a, b });
      creadas.push(partida);
    }
    return creadas;
  }

  async function crearTorneo({ nombre, nombres, horasAlta, forzar } = {}) {
    return conBloqueo(async () => {
      await cargar();

      if (actual && actual.estado === 'en_curso' && !forzar) {
        const error = new Error('Ya hay un torneo en curso. Termínalo o crea el nuevo con forzar=true.');
        error.code = 'torneo_en_curso';
        throw error;
      }
      if (actual && actual.estado === 'en_curso' && forzar) {
        actual.estado = 'cancelado';
        actual.finalizadoEn = new Date().toISOString();
        await guardar(actual);
      }

      const limpios = limpiarNombres(nombres);
      if (limpios.length < MIN_JUGADORES) {
        const error = new Error('Hacen falta al menos ' + MIN_JUGADORES + ' jugadores');
        error.code = 'pocos_jugadores';
        throw error;
      }
      if (limpios.length > MAX_JUGADORES) {
        const error = new Error('Máximo ' + MAX_JUGADORES + ' jugadores por torneo');
        error.code = 'demasiados_jugadores';
        throw error;
      }

      // Registra a los jugadores para que puedan entrar a sus salas.
      for (const nombreJugador of limpios) {
        await resolverJugador(nombreJugador);
      }

      const torneo = {
        id: nuevoId('t_'),
        nombre: String(nombre || 'Torneo de parejas').trim().slice(0, 60) || 'Torneo de parejas',
        formato: 'ida-vuelta',
        estado: 'en_curso',
        ronda: 1,
        creadoEn: new Date().toISOString(),
        finalizadoEn: null,
        jugadores: limpios.map((nombreJugador) => ({
          id: idJugador(nombreJugador),
          nombre: nombreJugador,
          eliminado: false
        })),
        byes: [],
        partidas: [],
        campeon: null
      };

      await iniciarRonda(torneo, limpios, 1);
      await guardar(torneo);
      actual = torneo;

      // Abre el alta de claves para que cada jugador registre su PIN.
      const horas = horasAlta === undefined ? ALTA_DEFAULT_HORAS : Number(horasAlta);
      if (Number.isFinite(horas) && horas > 0) {
        await abrirAlta(horas).catch((error) => log('No se pudo abrir el alta:', error.message));
      } else {
        await abrirAlta(0).catch(() => {});
      }

      return publico(torneo);
    });
  }

  /*
   * Desempate del cruce. Nace en vivo (sin plazo) y se repite si vuelve a
   * haber tablas. Pasadas las primeras 24 h del desempate, los siguientes
   * juegos van por correspondencia con el plazo normal.
   */
  async function crearDesempate(torneo, partida, juegos) {
    const desempates = (juegos || []).filter((p) => (p.juego || 1) >= 3);
    const inicio = desempates.length
      ? Math.min(...desempates.map((p) => new Date(p.creadaEn).getTime()))
      : Date.now();
    const vivo = Date.now() - inicio < DESEMPATE_VIVO_HORAS * 3600 * 1000;
    const siguienteJuego = Math.max(2, ...(juegos || []).map((p) => p.juego || 1)) + 1;

    return crearPartida(torneo, {
      ronda: partida.ronda,
      matchId: partida.matchId,
      juego: siguienteJuego,
      a: partida.blanco,
      b: partida.negro,
      ritmo: vivo ? 'vivo' : 'correspondencia',
      desempate: true,
      parentCode: partida.roomCode
    });
  }

  /*
   * Registra el final de una sala. Devuelve { gestionada: true } cuando la
   * sala pertenece al torneo (para que el servidor no cree la vuelta
   * automática del modo 1v1).
   */
  async function alTerminar(room) {
    return conBloqueo(async () => {
      await cargar();
      const torneo = actual;
      if (!torneo) return { gestionada: false };

      const partida = torneo.partidas.find((p) => p.roomCode === room.code);
      if (!partida) return { gestionada: false };

      // Idempotente: si ya se registró, no se toca otra vez.
      if (partida.estado !== 'pendiente') {
        return { gestionada: true, repetida: true, torneo: publico(torneo) };
      }

      const resultado = room.status.winner === 'white' ? 'blancas'
        : room.status.winner === 'black' ? 'negras'
        : 'tablas';

      partida.finalizadaEn = new Date().toISOString();
      partida.resultado = resultado;
      if (resultado === 'tablas') {
        partida.estado = 'tablas';
      } else {
        partida.estado = 'ganada';
        partida.ganador = resultado === 'blancas' ? partida.blanco : partida.negro;
      }

      const delCruce = () => torneo.partidas.filter(
        (p) => p.ronda === partida.ronda && p.matchId === partida.matchId);

      // 1. La ida siempre da paso a la vuelta, con los colores cambiados.
      if ((partida.juego || 1) === 1) {
        const vuelta = await crearPartida(torneo, {
          ronda: partida.ronda,
          matchId: partida.matchId,
          juego: 2,
          a: partida.negro,
          b: partida.blanco,
          parentCode: room.code
        });
        await guardar(torneo);
        return {
          gestionada: true,
          tipo: 'vuelta',
          torneo: publico(torneo),
          nuevaPartida: vuelta.id,
          nuevaSala: vuelta.roomCode,
          cruce: resultadoCruce(delCruce())
        };
      }

      // 2. Marcador igualado (o desempate en tablas): hace falta otro juego.
      const cruce = resultadoCruce(delCruce());
      const desempatePendiente = delCruce()
        .some((p) => (p.juego || 1) >= 3 && p.estado === 'pendiente');

      if (!cruce.decidido && !desempatePendiente) {
        const desempate = await crearDesempate(torneo, partida, delCruce());
        await guardar(torneo);
        return {
          gestionada: true,
          tipo: 'desempate',
          vivo: desempate.ritmo === 'vivo',
          torneo: publico(torneo),
          nuevaPartida: desempate.id,
          nuevaSala: desempate.roomCode
        };
      }

      if (!cruce.decidido) {
        // Desempate aún en juego: el cruce no se puede cerrar.
        await guardar(torneo);
        return { gestionada: true, tipo: 'resultado', torneo: publico(torneo) };
      }

      // 3. ¿Ha terminado la ronda entera?
      const deLaRonda = torneo.partidas.filter((p) => p.ronda === partida.ronda);
      const matches = new Map();
      for (const p of deLaRonda) {
        if (!matches.has(p.matchId)) matches.set(p.matchId, []);
        matches.get(p.matchId).push(p);
      }

      let rondaCompleta = true;
      const clasificados = [];
      for (const [, juegos] of matches) {
        const resuelto = resultadoCruce(juegos);
        if (!resuelto.decidido) {
          rondaCompleta = false;
          break;
        }
        clasificados.push(resuelto.ganador);
      }

      // Los byes de esta ronda también pasan.
      for (const bye of torneo.byes.filter((b) => b.ronda === partida.ronda)) {
        if (!clasificados.some((n) => mismoNombre(n, bye.nombre))) {
          clasificados.push(bye.nombre);
        }
      }

      if (!rondaCompleta) {
        await guardar(torneo);
        return { gestionada: true, tipo: 'resultado', torneo: publico(torneo) };
      }

      // Ronda cerrada: se eliminan los no clasificados y se sortea la siguiente.
      for (const jugador of torneo.jugadores) {
        if (!clasificados.some((n) => mismoNombre(n, jugador.nombre))) {
          jugador.eliminado = true;
        }
      }

      if (clasificados.length <= 1) {
        torneo.estado = 'finalizado';
        torneo.campeon = clasificados[0] || null;
        torneo.finalizadoEn = new Date().toISOString();
        await guardar(torneo);
        return { gestionada: true, tipo: 'campeon', campeon: torneo.campeon, torneo: publico(torneo) };
      }

      const nuevas = await iniciarRonda(torneo, clasificados, partida.ronda + 1);
      await guardar(torneo);
      return {
        gestionada: true,
        tipo: 'nueva-ronda',
        ronda: torneo.ronda,
        partidas: nuevas.length,
        torneo: publico(torneo)
      };
    });
  }

  async function esSalaDeTorneo(roomCode) {
    await cargar();
    if (!actual) return false;
    return actual.partidas.some((p) => p.roomCode === roomCode);
  }

  async function obtenerActual() {
    await cargar();
    return publico(actual);
  }

  async function obtener(id) {
    await cargar();
    if (actual && actual.id === id) return publico(actual);
    const bruto = await store.getAjuste(claveTorneo(id));
    if (!bruto) return null;
    try {
      return publico(JSON.parse(bruto));
    } catch (error) {
      return null;
    }
  }

  async function listar() {
    await cargar();
    const lista = (await store.getAjuste(CLAVE_LISTA)) || '';
    const ids = lista.split(',').filter(Boolean).reverse();
    const torneos = [];
    for (const id of ids) {
      const torneo = await obtener(id);
      if (torneo) {
        torneos.push({
          id: torneo.id,
          nombre: torneo.nombre,
          estado: torneo.estado,
          ronda: torneo.ronda,
          campeon: torneo.campeon,
          creadoEn: torneo.creadoEn,
          jugadores: torneo.jugadores.length
        });
      }
    }
    return torneos;
  }

  async function partidasDeJugador(nombre) {
    await cargar();
    if (!actual) return [];
    return publico(actual).partidas.filter(
      (p) => mismoNombre(p.blanco, nombre) || mismoNombre(p.negro, nombre)
    );
  }

  /*
   * Desempates en vivo que llevan más de las horas indicadas sin ganador.
   * Marca las partidas como correspondencia y devuelve las salas que el
   * servidor debe convertir (plazo normal de 2 días).
   */
  async function desempatesVencidos(horas = DESEMPATE_VIVO_HORAS, now = Date.now()) {
    return conBloqueo(async () => {
      await cargar();
      if (!actual || actual.estado !== 'en_curso') return [];

      const limite = horas * 3600 * 1000;
      const cruces = new Map();
      for (const p of actual.partidas) {
        if ((p.juego || 1) < 3) continue;
        const clave = p.ronda + ':' + p.matchId;
        if (!cruces.has(clave)) cruces.set(clave, []);
        cruces.get(clave).push(p);
      }

      const vencidos = [];
      for (const [, juegos] of cruces) {
        const inicio = Math.min(...juegos.map((p) => new Date(p.creadaEn).getTime()));
        if (!Number.isFinite(inicio) || now - inicio < limite) continue;
        for (const p of juegos) {
          if (p.estado !== 'pendiente' || p.ritmo !== 'vivo') continue;
          p.ritmo = 'correspondencia';
          vencidos.push({ roomCode: p.roomCode, matchId: p.matchId, ronda: p.ronda });
        }
      }

      if (vencidos.length) await guardar(actual);
      return vencidos;
    });
  }

  return {
    cargar,
    crearTorneo,
    alTerminar,
    desempatesVencidos,
    esSalaDeTorneo,
    obtenerActual,
    obtener,
    listar,
    partidasDeJugador,
    publico
  };
}

module.exports = {
  crearTorneoManager,
  sortearParejas,
  resultadoCruce,
  limpiarNombres,
  publico,
  idJugador,
  MIN_JUGADORES,
  MAX_JUGADORES,
  ALTA_DEFAULT_HORAS,
  DESEMPATE_VIVO_HORAS
};

'use strict';

/*
 * Torneo de ajedrez por correspondencia de PAREJAS (formato knockout).
 *
 * Reglas:
 *  - Sorteo aleatorio de parejas y de colores.
 *  - Cada pareja juega una partida. Gana quien da mate, rinde al rival o le
 *    gana al tiempo.
 *  - Si hay tablas, se repite la partida con los colores cambiados. Si vuelve
 *    a haber tablas, se sigue alternando el color hasta que alguien gane.
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
 * Empareja una lista de nombres. Si es impar, uno pasa libre. Se puede indicar
 * qué jugador debe pasar libre (por ejemplo, el mejor clasificado); si no se
 * indica o no está en la lista, se elige al azar.
 * Devuelve { parejas, bye }.
 */
function sortearParejas(nombres, rng = Math.random, byePreferido = null) {
  const resto = shuffle(nombres, rng);
  const parejas = [];
  let bye = null;

  if (resto.length % 2 === 1) {
    if (byePreferido) {
      const indice = resto.findIndex((nombre) => mismoNombre(nombre, byePreferido));
      if (indice >= 0) {
        bye = resto[indice];
        resto.splice(indice, 1);
      }
    }
    if (!bye) bye = resto.pop();
  }

  for (let i = 0; i + 1 < resto.length; i += 2) {
    parejas.push([resto[i], resto[i + 1]]);
  }
  return { parejas, bye, orden: resto.concat(bye ? [bye] : []) };
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

  return {
    id: torneo.id,
    nombre: torneo.nombre,
    estado: torneo.estado,
    ronda: torneo.ronda,
    creadoEn: torneo.creadoEn,
    jugadores: (torneo.jugadores || []).map((j) => ({ ...j })),
    byes: (torneo.byes || []).map((b) => ({ ...b })),
    campeon: torneo.campeon || null,
    partidas,
    rondas,
    partidasPendientes: partidas.filter((p) => p.estado === 'pendiente').length
  };
}

function crearTorneoManager(options = {}) {
  const { store, crearSala, abrirAlta, elegirBye, log = () => {} } = options;
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
   * `colores` decide quién lleva blancas; si no se indica, se sortea.
   */
  async function crearPartida(torneo, { ronda, matchId, juego, a, b, ritmo, desempate, parentCode }) {
    let blanco = a;
    let negro = b;
    // La primera partida de cada pareja sortea color. Los desempates llegan
    // ya con los colores cambiados por quien llama.
    if (!juego || juego === 1) {
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

    const byeElegido = (clasificados.length % 2 === 1 && typeof elegirBye === 'function')
      ? await elegirBye(clasificados)
      : null;

    const { parejas, bye } = sortearParejas(clasificados, Math.random, byeElegido);
    if (bye) {
      torneo.byes.push({ ronda, nombre: bye, motivo: 'mejor-clasificado' });
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
        // Desempate con colores cambiados; si vuelve a empatar, otra vez.
        const siguiente = await crearPartida(torneo, {
          ronda: partida.ronda,
          matchId: partida.matchId,
          juego: partida.juego + 1,
          a: partida.negro,
          b: partida.blanco,
          desempate: true,
          parentCode: room.code
        });
        siguiente.juego = partida.juego + 1;
        await guardar(torneo);
        return {
          gestionada: true,
          tipo: 'desempate',
          torneo: publico(torneo),
          nuevaPartida: siguiente.id,
          nuevaSala: siguiente.roomCode
        };
      }

      partida.estado = 'ganada';
      partida.ganador = resultado === 'blancas' ? partida.blanco : partida.negro;

      // ¿Ha terminado la ronda entera?
      const deLaRonda = torneo.partidas.filter((p) => p.ronda === partida.ronda);
      const matches = new Map();
      for (const p of deLaRonda) {
        if (!matches.has(p.matchId)) matches.set(p.matchId, []);
        matches.get(p.matchId).push(p);
      }

      let rondaCompleta = true;
      const clasificados = [];
      for (const [, juegos] of matches) {
        const decidido = juegos.find((j) => j.ganador);
        if (!decidido) {
          rondaCompleta = false;
          break;
        }
        clasificados.push(decidido.ganador);
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
   * Marca la partida del torneo como «en vivo» cuando los dos jugadores
   * aceptan jugar el desempate del tirón. Solo cambia la etiqueta pública.
   */
  async function marcarVivo(roomCode) {
    return conBloqueo(async () => {
      await cargar();
      if (!actual) return null;
      const partida = actual.partidas.find((p) => p.roomCode === roomCode);
      if (!partida || partida.ritmo === 'vivo') return publico(actual);
      partida.ritmo = 'vivo';
      await guardar(actual);
      return publico(actual);
    });
  }

  return {
    cargar,
    crearTorneo,
    alTerminar,
    marcarVivo,
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
  limpiarNombres,
  publico,
  idJugador,
  MIN_JUGADORES,
  MAX_JUGADORES,
  ALTA_DEFAULT_HORAS
};

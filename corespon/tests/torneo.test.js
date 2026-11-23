'use strict';

/*
 * Pruebas del torneo de parejas (knockout, ida y vuelta):
 *  - sorteo, limpieza de nombres y bye aleatorio;
 *  - marcador del cruce (victoria 1, tablas 0,5);
 *  - ida, vuelta y desempate en vivo (con tope de 24 h);
 *  - avance de ronda y campeón;
 *  - creación del torneo por la API y flujo real por socket.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  crearTorneoManager, sortearParejas, limpiarNombres, resultadoCruce
} = require('../server/torneo');
const { createMemoryStore } = require('../server/db');
const { createServer } = require('../server/server');
const { io } = require('socket.io-client');

const TEST_PIN = '4321';
const sockets = [];

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function request(socket, event, payload, timeout = 5000) {
  const datos = event === 'corespon:join' && payload && payload.pin === undefined
    ? { ...payload, pin: TEST_PIN }
    : payload;

  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, datos, (error, response) => {
      resolve(error ? { ok: false, error: 'timeout' } : response);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function esperar(comprobacion, timeout = 5000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    const valor = await comprobacion();
    if (valor) return valor;
    await wait(100);
  }
  return null;
}

async function bootServer() {
  const store = createMemoryStore();
  await store.setAjuste('alta_claves_hasta', new Date(Date.now() + 3600000).toISOString());
  const instance = createServer({ quiet: true, store });
  const port = await instance.start(0);
  return { instance, store, port, base: `http://127.0.0.1:${port}` };
}

async function cerrar(instance) {
  for (const socket of sockets.splice(0)) {
    if (socket.connected) socket.close();
  }
  await wait(20);
  await instance.close();
}

async function crearTorneoApi(base, nombres) {
  const res = await fetch(base + '/api/parejas/torneos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres })
  });
  const datos = await res.json();
  return { res, datos };
}

async function unirse(port, code, nombre) {
  const socket = await connect(port);
  const joined = await request(socket, 'corespon:join', { code, name: nombre });
  return { socket, joined };
}

function crearManager() {
  const store = createMemoryStore();
  const creadas = [];
  const manager = crearTorneoManager({
    store,
    crearSala: async ({ blanco, negro, ronda, juego }) => {
      const code = 'T' + String(creadas.length + 1).padStart(4, '0');
      creadas.push({ code, blanco, negro, ronda, juego });
      return { code };
    },
    abrirAlta: async () => ({ hasta: Date.now() + 1000 })
  });
  return { manager, creadas };
}

function finalizar(manager, partida, winner) {
  return manager.alTerminar({ code: partida.roomCode, status: { winner } });
}

function juego(torneo, matchId, numero) {
  return torneo.partidas.find((p) => p.matchId === matchId && p.juego === numero);
}

async function cerrarCruce(manager, ida, ganadorIda, ganadorVuelta) {
  await finalizar(manager, ida, ganadorIda);
  const torneo = await manager.obtenerActual();
  const vuelta = juego(torneo, ida.matchId, 2);
  assert.ok(vuelta, 'falta la vuelta del cruce');
  return finalizar(manager, vuelta, ganadorVuelta);
}

test('sorteo: limpia duplicados y pasa libre con número impar', () => {
  assert.deepEqual(limpiarNombres(['Ana', ' ana ', '', 'Luis', 'Luis']), ['Ana', 'Luis']);

  const { parejas, bye } = sortearParejas(['A', 'B', 'C']);
  assert.equal(parejas.length, 1);
  assert.equal(bye !== null, true);
  const nombres = [...parejas[0], bye].sort();
  assert.deepEqual(nombres, ['A', 'B', 'C']);
});

test('cruce: puntos de ida y vuelta, desempate y formato antiguo', () => {
  const ida = { matchId: 'r1m1', juego: 1, blanco: 'Ana', negro: 'Luis', estado: 'ganada', ganador: 'Ana' };
  const vuelta = { ...ida, juego: 2, blanco: 'Luis', negro: 'Ana' };
  const tablas = (p) => ({ ...p, estado: 'tablas', ganador: null });

  let resuelto = resultadoCruce([ida, tablas(vuelta)]);
  assert.equal(resuelto.decidido, true);
  assert.equal(resuelto.ganador, 'Ana');
  assert.equal(resuelto.puntos.Ana, 1.5);
  assert.equal(resuelto.puntos.Luis, 0.5);

  const ganaLuis = { ...vuelta, estado: 'ganada', ganador: 'Luis' };
  resuelto = resultadoCruce([ida, ganaLuis]);
  assert.equal(resuelto.decidido, false);
  assert.equal(resuelto.fase, 'desempate');
  assert.equal(resuelto.puntos.Ana, 1);
  assert.equal(resuelto.puntos.Luis, 1);

  resuelto = resultadoCruce([tablas(ida), tablas(vuelta)]);
  assert.equal(resuelto.decidido, false);
  assert.equal(resuelto.puntos.Ana, 1);
  assert.equal(resuelto.puntos.Luis, 1);

  const desempate = { ...ida, juego: 3, estado: 'ganada', ganador: 'Luis' };
  resuelto = resultadoCruce([ida, ganaLuis, desempate]);
  assert.equal(resuelto.decidido, true);
  assert.equal(resuelto.ganador, 'Luis');

  // Los torneos antiguos (una partida) siguen cerrando con el primer ganador.
  resuelto = resultadoCruce([ida], false);
  assert.equal(resuelto.decidido, true);
  assert.equal(resuelto.ganador, 'Ana');
});

test('ida y vuelta: la ida crea la vuelta con colores cambiados y decide el campeón', async () => {
  const { manager, creadas } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis'] });

  let torneo = await manager.obtenerActual();
  assert.equal(torneo.formato, 'ida-vuelta');
  assert.equal(torneo.partidas.length, 1);
  const ida = torneo.partidas[0];

  const finIda = await finalizar(manager, ida, 'white');
  assert.equal(finIda.tipo, 'vuelta');
  torneo = finIda.torneo;
  assert.equal(torneo.partidas.length, 2);
  const vuelta = juego(torneo, ida.matchId, 2);
  assert.equal(vuelta.blanco, ida.negro);
  assert.equal(vuelta.negro, ida.blanco);
  assert.equal(vuelta.desempate, false);
  assert.equal(vuelta.ritmo, 'correspondencia');
  assert.notEqual(vuelta.roomCode, ida.roomCode);

  // El mismo jugador vuelve a ganar (ahora con negras): 2-0.
  const cierre = await finalizar(manager, vuelta, 'black');
  assert.equal(cierre.tipo, 'campeon');
  assert.equal(cierre.campeon, ida.blanco);
  assert.equal(creadas.length, 2);
});

test('ida y vuelta: una victoria y unas tablas clasifican sin desempate', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis'] });

  const ida = (await manager.obtenerActual()).partidas[0];
  await finalizar(manager, ida, 'white');
  const torneo = await manager.obtenerActual();
  const vuelta = juego(torneo, ida.matchId, 2);

  const cierre = await finalizar(manager, vuelta, null);
  assert.equal(cierre.tipo, 'campeon');
  assert.equal(cierre.campeon, ida.blanco);
  assert.equal(cierre.torneo.partidas.length, 2, 'no debe crear desempate');
});

test('cruce igualado: crea el desempate en vivo con colores sorteados', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis'] });

  const ida = (await manager.obtenerActual()).partidas[0];
  await finalizar(manager, ida, 'white');
  const vuelta = juego(await manager.obtenerActual(), ida.matchId, 2);

  // Gana cada uno: 1-1.
  const igualado = await finalizar(manager, vuelta, 'white');
  assert.equal(igualado.tipo, 'desempate');
  assert.equal(igualado.vivo, true);
  const desempate = juego(igualado.torneo, ida.matchId, 3);
  assert.ok(desempate, 'falta el desempate');
  assert.equal(desempate.desempate, true);
  assert.equal(desempate.ritmo, 'vivo');
  assert.deepEqual([desempate.blanco, desempate.negro].sort(), [ida.blanco, ida.negro].sort());

  const cierre = await finalizar(manager, desempate, 'white');
  assert.equal(cierre.tipo, 'campeon');
  assert.equal(cierre.campeon, desempate.blanco);
});

test('desempate: tablas repiten otra partida en vivo hasta que haya ganador', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis'] });

  const ida = (await manager.obtenerActual()).partidas[0];
  await finalizar(manager, ida, null);
  const vuelta = juego(await manager.obtenerActual(), ida.matchId, 2);
  const igualado = await finalizar(manager, vuelta, null);
  assert.equal(igualado.tipo, 'desempate');

  const tercero = juego(igualado.torneo, ida.matchId, 3);
  const otraVez = await finalizar(manager, tercero, null);
  assert.equal(otraVez.tipo, 'desempate');
  const cuarto = juego(otraVez.torneo, ida.matchId, 4);
  assert.ok(cuarto, 'las tablas en el desempate deben crear otro');
  assert.equal(cuarto.ritmo, 'vivo');
  assert.equal(cuarto.desempate, true);

  const cierre = await finalizar(manager, cuarto, 'black');
  assert.equal(cierre.tipo, 'campeon');
  assert.equal(cierre.campeon, cuarto.negro);
});

test('desempate en vivo: pasa a correspondencia pasadas 24 h', async () => {
  const store = createMemoryStore();
  const manager = crearTorneoManager({
    store,
    crearSala: async () => ({ code: 'D1' }),
    abrirAlta: async () => ({})
  });

  const ahora = Date.now();
  const antiguo = new Date(ahora - 25 * 3600 * 1000).toISOString();
  const base = {
    matchId: 'r1m1', ronda: 1, blanco: 'Ana', negro: 'Luis',
    creadaEn: antiguo, finalizadaEn: antiguo, desempate: false,
    estado: 'ganada', resultado: 'blancas'
  };
  const torneo = {
    id: 't_prueba', nombre: 'Prueba', formato: 'ida-vuelta', estado: 'en_curso', ronda: 1,
    creadoEn: antiguo, finalizadoEn: null, campeon: null, byes: [],
    jugadores: [
      { id: 'ana', nombre: 'Ana', eliminado: false },
      { id: 'luis', nombre: 'Luis', eliminado: false }
    ],
    partidas: [
      { ...base, id: 'p1', juego: 1, roomCode: 'A1', ganador: 'Ana', ritmo: 'correspondencia' },
      { ...base, id: 'p2', juego: 2, roomCode: 'A2', blanco: 'Luis', negro: 'Ana', ganador: 'Luis', ritmo: 'correspondencia' },
      {
        ...base, id: 'p3', juego: 3, roomCode: 'V1', ritmo: 'vivo', desempate: true,
        estado: 'pendiente', resultado: null, ganador: null, finalizadaEn: null
      }
    ]
  };
  await store.setAjuste('parejas_torneo_actual', torneo.id);
  await store.setAjuste('parejas_torneo:' + torneo.id, JSON.stringify(torneo));

  const recientes = await manager.desempatesVencidos(24, ahora - 24 * 3600 * 1000);
  assert.equal(recientes.length, 0);

  const vencidos = await manager.desempatesVencidos(24, ahora);
  assert.equal(vencidos.length, 1);
  assert.equal(vencidos[0].roomCode, 'V1');
  const actual = await manager.obtenerActual();
  assert.equal(juego(actual, 'r1m1', 3).ritmo, 'correspondencia');
});

test('sala en vivo: no caduca, y al pasar a correspondencia recibe plazo', () => {
  const { RoomManager } = require('../server/rooms');
  const manager = new RoomManager();
  const viva = manager.createRoom('Ana', 'Luis', { ritmo: 'vivo', desempate: true });

  viva.plazos.plazoHasta = Date.now() - 60000;
  viva.plazos.graciaHasta = Date.now() - 30000;

  assert.equal(manager.checkDeadlines().length, 0);
  assert.equal(viva.status.over, false);
  assert.equal(viva.canExtend(), false);
  assert.equal(viva.ritmo, 'vivo');
  assert.equal(viva.desempate, true);

  const ahora = Date.now();
  viva.pasarACorrespondencia(ahora);
  assert.equal(viva.ritmo, 'correspondencia');
  assert.equal(viva.plazos.plazoHasta, ahora + viva.plazos.plazoMs);
  assert.equal(viva.canExtend(ahora), true);

  const normal = manager.createRoom('Ana', 'Luis');
  normal.plazos.plazoHasta = Date.now() - 60000;
  normal.plazos.graciaHasta = Date.now() - 30000;
  assert.equal(manager.checkDeadlines().length, 1);
});

test('rondas: los ganadores se vuelven a emparejar hasta el campeón', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis', 'Marta', 'Pablo'] });

  let torneo = await manager.obtenerActual();
  assert.equal(torneo.partidas.length, 2, 'solo las idas');
  assert.equal(torneo.ronda, 1);

  for (const ida of [...torneo.partidas]) {
    await cerrarCruce(manager, ida, 'white', 'black');
  }

  torneo = await manager.obtenerActual();
  assert.equal(torneo.ronda, 2);
  const idaFinal = torneo.partidas.find((p) => p.ronda === 2);
  assert.ok(idaFinal);
  const final = await cerrarCruce(manager, idaFinal, 'white', 'black');
  assert.equal(final.tipo, 'campeon');
  assert.equal(final.torneo.estado, 'finalizado');
  assert.ok(final.torneo.campeon);
});

test('bye: con impares uno pasa libre y se une a la ronda siguiente', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis', 'Marta'] });

  let torneo = await manager.obtenerActual();
  assert.equal(torneo.ronda, 1);
  assert.equal(torneo.partidas.length, 1);
  assert.equal(torneo.byes.length, 1);
  assert.equal(torneo.byes[0].motivo, 'sorteo');

  const ida = torneo.partidas[0];
  torneo = (await cerrarCruce(manager, ida, 'white', 'black')).torneo;
  assert.equal(torneo.ronda, 2);
  const idaFinal = torneo.partidas.find((p) => p.ronda === 2);
  assert.ok(idaFinal);
  assert.ok([idaFinal.blanco, idaFinal.negro].includes(torneo.byes[0].nombre));
});

test('bye: el jugador que pasa libre se sortea entre los que quedan', async () => {
  const store = createMemoryStore();
  let n = 0;
  const manager = crearTorneoManager({
    store,
    crearSala: async () => ({ code: 'C' + (++n) }),
    abrirAlta: async () => ({})
  });

  const nombres = ['Ana', 'Luis', 'Marta'];
  await manager.crearTorneo({ nombres });
  const torneo = await manager.obtenerActual();

  assert.equal(torneo.byes.length, 1);
  assert.equal(torneo.byes[0].motivo, 'sorteo');
  const bye = torneo.byes[0].nombre;
  assert.ok(nombres.includes(bye));

  assert.equal(torneo.partidas.length, 1);
  const { blanco, negro } = torneo.partidas[0];
  assert.equal([blanco, negro].includes(bye), false);
  assert.deepEqual([blanco, negro, bye].sort(), nombres.slice().sort());
});

test('API: con impares el bye se sortea y los otros dos juegan', async (t) => {
  const store = createMemoryStore();
  await store.setAjuste('alta_claves_hasta', new Date(Date.now() + 3600000).toISOString());

  const instance = createServer({ quiet: true, store });
  t.after(() => instance.close());
  const port = await instance.start(0);
  const base = 'http://127.0.0.1:' + port;

  const nombres = ['Luis', 'Marta', 'Ana'];
  const res = await fetch(base + '/api/parejas/torneos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres })
  });
  const datos = await res.json();

  assert.equal(res.status, 201);
  assert.equal(datos.torneo.formato, 'ida-vuelta');
  assert.equal(datos.torneo.byes.length, 1);
  assert.equal(datos.torneo.byes[0].motivo, 'sorteo');
  const bye = datos.torneo.byes[0].nombre;
  assert.ok(nombres.includes(bye));

  assert.equal(datos.torneo.partidas.length, 1);
  const { blanco, negro } = datos.torneo.partidas[0];
  assert.equal([blanco, negro].includes(bye), false);
  assert.deepEqual([blanco, negro, bye].sort(), nombres.slice().sort());
});

test('API: crea el torneo y publica el marcador del cruce', async (t) => {
  const store = createMemoryStore();
  await store.setAjuste('alta_claves_hasta', new Date(Date.now() + 3600000).toISOString());

  const instance = createServer({ quiet: true, store });
  t.after(() => instance.close());
  const port = await instance.start(0);
  const base = 'http://127.0.0.1:' + port;

  const res = await fetch(base + '/api/parejas/torneos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres: ['Ana', 'Luis'], nombre: 'Prueba' })
  });
  const datos = await res.json();

  assert.equal(res.status, 201);
  assert.equal(datos.ok, true);
  assert.equal(datos.torneo.nombre, 'Prueba');
  assert.equal(datos.torneo.formato, 'ida-vuelta');
  assert.equal(datos.torneo.partidas.length, 1);
  assert.match(datos.torneo.partidas[0].enlace, /^\/corespon\/[A-Z0-9]+$/);

  const cruce = datos.torneo.cruces[datos.torneo.partidas[0].matchId];
  assert.ok(cruce);
  assert.equal(cruce.decidido, false);
  assert.equal(cruce.fase, 'ida');
  assert.equal(cruce.puntos[datos.torneo.partidas[0].blanco], 0);

  const lista = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
  assert.equal(lista.ok, true);
  assert.equal(lista.torneo.id, datos.torneo.id);
});

test('flujo real: la ida crea la vuelta en sala nueva y no genera la vuelta 1v1', async (t) => {
  const { instance, port, base } = await bootServer();
  t.after(() => cerrar(instance));

  const { datos } = await crearTorneoApi(base, ['Ana', 'Luis']);
  const ida = datos.torneo.partidas[0];
  const { socket: uno, joined: j1 } = await unirse(port, ida.roomCode, ida.blanco);
  const { socket: dos } = await unirse(port, ida.roomCode, ida.negro);
  assert.equal(j1.ok, true);
  const blanco = j1.color === 'white' ? uno : dos;

  const rendicion = await request(blanco, 'corespon:resign', { code: ida.roomCode });
  assert.equal(rendicion.ok, true);

  const torneo = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.partidas.length === 2 ? actual.torneo : null;
  });
  assert.ok(torneo, 'la ida debe crear la vuelta');
  const vuelta = torneo.partidas.find((p) => p.juego === 2);
  assert.equal(vuelta.blanco, ida.negro);
  assert.equal(vuelta.negro, ida.blanco);
  assert.equal(vuelta.desempate, false);
  assert.equal(torneo.estado, 'en_curso');

  const abiertas = await fetch(base + '/api/partidas').then((r) => r.json());
  assert.equal(abiertas.partidas.length, 1);
  assert.equal(abiertas.partidas[0].roomCode, vuelta.roomCode);
});

test('flujo real: el cruce se cierra en la vuelta y da el campeón', async (t) => {
  const { instance, port, base } = await bootServer();
  t.after(() => cerrar(instance));

  const { datos } = await crearTorneoApi(base, ['Ana', 'Luis']);
  const ida = datos.torneo.partidas[0];
  const { socket: uno, joined: j1 } = await unirse(port, ida.roomCode, ida.blanco);
  const { socket: dos } = await unirse(port, ida.roomCode, ida.negro);
  const perdedorIda = j1.color === 'white' ? dos : uno;
  assert.equal((await request(perdedorIda, 'corespon:resign', { code: ida.roomCode })).ok, true);

  const torneo = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.partidas.length === 2 ? actual.torneo : null;
  });
  const vuelta = torneo.partidas.find((p) => p.juego === 2);

  // En la vuelta el ganador de la ida juega de negras: renuncia el blanco.
  const { socket: tres } = await unirse(port, vuelta.roomCode, vuelta.blanco);
  assert.equal((await request(tres, 'corespon:resign', { code: vuelta.roomCode })).ok, true);

  const final = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.estado === 'finalizado' ? actual.torneo : null;
  });
  assert.ok(final, 'el torneo debería quedar finalizado');
  assert.equal(final.campeon, ida.blanco);
});

test('flujo real: tablas en ida y vuelta crean un desempate en vivo', async (t) => {
  const { instance, port, base } = await bootServer();
  t.after(() => cerrar(instance));

  const { datos } = await crearTorneoApi(base, ['Ana', 'Luis']);
  const ida = datos.torneo.partidas[0];

  const { socket: uno, joined: j1 } = await unirse(port, ida.roomCode, ida.blanco);
  const { socket: dos } = await unirse(port, ida.roomCode, ida.negro);
  assert.equal(j1.ok, true);
  const blancoIda = j1.color === 'white' ? uno : dos;
  const negroIda = j1.color === 'white' ? dos : uno;

  let siguiente = null;
  blancoIda.on('corespon:room:update', (payload) => {
    if (payload && payload.code === ida.roomCode && payload.siguienteSala) {
      siguiente = payload.siguienteSala;
    }
  });

  await request(blancoIda, 'corespon:draw', { code: ida.roomCode });
  await request(negroIda, 'corespon:draw:accept', { code: ida.roomCode });

  const aviso = await esperar(() => siguiente);
  assert.ok(aviso, 'la ida debe ofrecer la sala de la vuelta');

  let torneo = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.partidas.length === 2 ? actual.torneo : null;
  });
  const vuelta = torneo.partidas.find((p) => p.juego === 2);
  assert.equal(vuelta.roomCode, aviso);
  assert.equal(vuelta.desempate, false);
  assert.equal(vuelta.ritmo, 'correspondencia');

  const { socket: tres, joined: j3 } = await unirse(port, vuelta.roomCode, vuelta.blanco);
  const { socket: cuatro } = await unirse(port, vuelta.roomCode, vuelta.negro);
  const blancoVuelta = j3.color === 'white' ? tres : cuatro;
  const negroVuelta = j3.color === 'white' ? cuatro : tres;
  await request(blancoVuelta, 'corespon:draw', { code: vuelta.roomCode });
  await request(negroVuelta, 'corespon:draw:accept', { code: vuelta.roomCode });

  torneo = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.partidas.length === 3 ? actual.torneo : null;
  });
  assert.ok(torneo, 'el cruce igualado debe crear el desempate');
  const desempate = torneo.partidas.find((p) => p.juego === 3);
  assert.equal(desempate.desempate, true);
  assert.equal(desempate.ritmo, 'vivo');

  const abiertas = await fetch(base + '/api/partidas').then((r) => r.json());
  const viva = abiertas.partidas.find((p) => p.roomCode === desempate.roomCode);
  assert.ok(viva);
  assert.equal(viva.ritmo, 'vivo');

  // Cualquiera con el enlace puede mirarla, pero no mover.
  const espectador = await connect(port);
  const visto = await request(espectador, 'corespon:watch', { code: desempate.roomCode });
  assert.equal(visto.ok, true);
  assert.equal(visto.room.ritmo, 'vivo');
  assert.equal(visto.room.desempate, true);
  const intento = await request(espectador, 'corespon:move', {
    code: desempate.roomCode, from: { row: 6, col: 4 }, to: { row: 4, col: 4 }
  });
  assert.equal(intento.ok, false);
  assert.equal(intento.error, 'not_in_room');
});

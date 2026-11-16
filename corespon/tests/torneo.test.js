'use strict';

/*
 * Pruebas del torneo de parejas (knockout):
 *  - sorteo y limpieza de nombres;
 *  - desempate con colores cambiados;
 *  - avance de ronda y campeón;
 *  - creación del torneo por la API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  crearTorneoManager, sortearParejas, limpiarNombres
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

test('sorteo: limpia duplicados y pasa libre con número impar', () => {
  assert.deepEqual(limpiarNombres(['Ana', ' ana ', '', 'Luis', 'Luis']), ['Ana', 'Luis']);

  const { parejas, bye } = sortearParejas(['A', 'B', 'C']);
  assert.equal(parejas.length, 1);
  assert.equal(bye !== null, true);
  const nombres = [...parejas[0], bye].sort();
  assert.deepEqual(nombres, ['A', 'B', 'C']);
});

test('desempate: tablas repite la partida con los colores cambiados', async () => {
  const { manager, creadas } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis'] });

  const inicial = await manager.obtenerActual();
  assert.equal(inicial.partidas.length, 1);
  const primera = inicial.partidas[0];

  const tablas = await manager.alTerminar({ code: primera.roomCode, status: { winner: null } });
  assert.equal(tablas.tipo, 'desempate');

  const trasTablas = await manager.obtenerActual();
  assert.equal(trasTablas.partidas.length, 2);
  const segunda = trasTablas.partidas[1];
  assert.equal(segunda.blanco, primera.negro);
  assert.equal(segunda.negro, primera.blanco);
  assert.equal(segunda.juego, 2);

  const fin = await manager.alTerminar({ code: segunda.roomCode, status: { winner: 'white' } });
  assert.equal(fin.tipo, 'campeon');
  assert.equal(fin.campeon, segunda.blanco);

  const final = await manager.obtenerActual();
  assert.equal(final.estado, 'finalizado');
  assert.equal(final.campeon, segunda.blanco);
  assert.equal(creadas.length, 2);
});

test('rondas: los ganadores se vuelven a emparejar hasta el campeón', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis', 'Marta', 'Pablo'] });

  let torneo = await manager.obtenerActual();
  assert.equal(torneo.partidas.length, 2);
  assert.equal(torneo.ronda, 1);

  // Ganan las blancas de cada pareja.
  for (const partida of torneo.partidas) {
    await manager.alTerminar({ code: partida.roomCode, status: { winner: 'white' } });
  }

  torneo = await manager.obtenerActual();
  assert.equal(torneo.ronda, 2);
  assert.equal(torneo.partidas.filter((p) => p.ronda === 2).length, 1);

  const final = torneo.partidas.find((p) => p.ronda === 2);
  const cierre = await manager.alTerminar({ code: final.roomCode, status: { winner: 'black' } });
  assert.equal(cierre.tipo, 'campeon');
  assert.equal(cierre.campeon, final.negro);
});

test('bye: con impares uno pasa libre y se une a la ronda siguiente', async () => {
  const { manager } = crearManager();
  await manager.crearTorneo({ nombres: ['Ana', 'Luis', 'Marta'] });

  let torneo = await manager.obtenerActual();
  assert.equal(torneo.ronda, 1);
  assert.equal(torneo.partidas.length, 1);
  assert.equal(torneo.byes.length, 1);

  const partida = torneo.partidas[0];
  await manager.alTerminar({ code: partida.roomCode, status: { winner: 'white' } });

  torneo = await manager.obtenerActual();
  assert.equal(torneo.ronda, 2);
  const final = torneo.partidas.find((p) => p.ronda === 2);
  assert.ok(final);
  assert.ok([final.blanco, final.negro].includes(torneo.byes[0].nombre));
});

test('bye: pasa libre el jugador que decida el criterio, no el azar', async () => {
  const store = createMemoryStore();
  let n = 0;
  const manager = crearTorneoManager({
    store,
    crearSala: async () => ({ code: 'C' + (++n) }),
    abrirAlta: async () => ({}),
    elegirBye: async () => 'Marta'
  });

  await manager.crearTorneo({ nombres: ['Ana', 'Luis', 'Marta'] });
  const torneo = await manager.obtenerActual();

  assert.equal(torneo.byes.length, 1);
  assert.equal(torneo.byes[0].nombre, 'Marta');
  assert.equal(torneo.byes[0].motivo, 'mejor-clasificado');
  assert.equal(torneo.partidas.length, 1);
  assert.ok(![torneo.partidas[0].blanco, torneo.partidas[0].negro]
    .some((nombre) => nombre === 'Marta'));
});

test('API: con impares pasa libre el mejor clasificado', async (t) => {
  const store = createMemoryStore();
  await store.setAjuste('alta_claves_hasta', new Date(Date.now() + 3600000).toISOString());

  const instance = createServer({ quiet: true, store });
  t.after(() => instance.close());
  const port = await instance.start(0);
  const base = 'http://127.0.0.1:' + port;

  // Todos empiezan con 1500 y 0 victorias: desempata el nombre.
  const res = await fetch(base + '/api/parejas/torneos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres: ['Luis', 'Marta', 'Ana'] })
  });
  const datos = await res.json();

  assert.equal(res.status, 201);
  assert.equal(datos.torneo.byes.length, 1);
  assert.equal(datos.torneo.byes[0].nombre, 'Ana');
  assert.equal(datos.torneo.partidas.length, 1);
});

test('API: crea el torneo y devuelve las salas con enlace', async (t) => {
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
  assert.equal(datos.torneo.partidas.length, 1);
  assert.match(datos.torneo.partidas[0].enlace, /^\/corespon\/[A-Z0-9]+$/);

  const lista = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
  assert.equal(lista.ok, true);
  assert.equal(lista.torneo.id, datos.torneo.id);
});

test('flujo real: rendirse cierra la final y da el campeón sin vuelta 1v1', async (t) => {
  const { instance, port, base } = await bootServer();
  t.after(() => cerrar(instance));

  const { datos } = await crearTorneoApi(base, ['Ana', 'Luis']);
  const code = datos.torneo.partidas[0].roomCode;

  const { socket: uno, joined: j1 } = await unirse(port, code, datos.torneo.partidas[0].blanco);
  const { socket: dos } = await unirse(port, code, datos.torneo.partidas[0].negro);
  assert.equal(j1.ok, true);

  const blanco = j1.color === 'white' ? uno : dos;
  const negro = j1.color === 'white' ? dos : uno;
  const nombreNegro = j1.color === 'white'
    ? datos.torneo.partidas[0].negro
    : datos.torneo.partidas[0].blanco;

  const rendicion = await request(blanco, 'corespon:resign', { code });
  assert.equal(rendicion.ok, true);

  const final = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.estado === 'finalizado' ? actual.torneo : null;
  });
  assert.ok(final, 'el torneo debería quedar finalizado');
  assert.equal(final.campeon, nombreNegro);

  // La sala terminada no genera la revancha del modo 1v1.
  const abiertas = await fetch(base + '/api/partidas').then((r) => r.json());
  assert.equal(abiertas.partidas.length, 0);
  assert.equal(negro.connected, true);
});

test('flujo real: tablas repiten la partida con los colores cambiados', async (t) => {
  const { instance, port, base } = await bootServer();
  t.after(() => cerrar(instance));

  const { datos } = await crearTorneoApi(base, ['Ana', 'Luis']);
  const primera = datos.torneo.partidas[0];

  const { socket: uno, joined: j1 } = await unirse(port, primera.roomCode, primera.blanco);
  const { socket: dos, joined: j2 } = await unirse(port, primera.roomCode, primera.negro);
  const blanco = j1.color === 'white' ? uno : dos;
  const negro = j1.color === 'white' ? dos : uno;
  assert.equal(j2.ok, true);

  const propuesta = await request(blanco, 'corespon:draw', { code: primera.roomCode });
  assert.equal(propuesta.ok, true);
  const aceptada = await request(negro, 'corespon:draw:accept', { code: primera.roomCode });
  assert.equal(aceptada.ok, true);

  const torneo = await esperar(async () => {
    const actual = await fetch(base + '/api/parejas/torneos/actual').then((r) => r.json());
    return actual.torneo && actual.torneo.partidas.length === 2 ? actual.torneo : null;
  });
  assert.ok(torneo, 'debería haberse creado el desempate');

  const segunda = torneo.partidas.find((p) => p.juego === 2);
  assert.ok(segunda, 'falta la segunda partida');
  assert.equal(segunda.blanco, primera.negro);
  assert.equal(segunda.negro, primera.blanco);
  assert.equal(segunda.roomCode !== primera.roomCode, true);

  // Solo queda abierta la sala del desempate.
  const abiertas = await fetch(base + '/api/partidas').then((r) => r.json());
  assert.equal(abiertas.partidas.length, 1);
  assert.equal(torneo.estado, 'en_curso');
  assert.equal(torneo.campeon, null);
});

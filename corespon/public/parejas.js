'use strict';

/*
 * Panel del torneo de parejas (knockout).
 * Habla con /api/parejas/* y pinta el cuadro por rondas.
 */

const $ = (id) => document.getElementById(id);

const CLAVE_TOKEN = 'parejas.adminToken';
$('adminToken').value = localStorage.getItem(CLAVE_TOKEN) || '';

let torneoActual = null;

function esc(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Texto del bye: los torneos nuevos lo sortean; los antiguos lo daban al
// mejor clasificado.
function textoBye(bye) {
  return bye && bye.motivo === 'mejor-clasificado'
    ? 'pasa libre por mejor clasificación'
    : 'pasa libre por sorteo';
}

function aviso(texto, tipo) {
  const caja = $('aviso');
  caja.textContent = texto;
  caja.className = 'aviso ' + (tipo || 'ok');
}

function limpiarAviso() {
  const caja = $('aviso');
  caja.textContent = '';
  caja.className = 'aviso';
}

async function api(ruta, opciones = {}) {
  const headers = { ...(opciones.headers || {}) };
  if (opciones.body) headers['Content-Type'] = 'application/json';
  const token = $('adminToken').value.trim();
  if (token) headers['x-admin-token'] = token;

  const res = await fetch(ruta, { ...opciones, headers });
  let datos = null;
  try { datos = await res.json(); } catch (error) { datos = null; }
  return { status: res.status, datos: datos || {} };
}

function nombreRonda(n, total) {
  const restantes = Number(total) - Number(n) + 1;
  if (restantes === 1) return 'Final';
  if (restantes === 2) return 'Semifinal';
  if (restantes === 3) return 'Cuartos de final';
  return 'Ronda ' + n;
}

function agruparPorMatch(partidas) {
  const mapa = new Map();
  for (const p of partidas) {
    if (!mapa.has(p.matchId)) mapa.set(p.matchId, []);
    mapa.get(p.matchId).push(p);
  }
  // La partida visible es la última: si hubo tablas, el desempate.
  const grupos = [];
  for (const [matchId, juegos] of mapa) {
    juegos.sort((a, b) => (a.juego || 1) - (b.juego || 1));
    grupos.push({ matchId, juegos, actual: juegos[juegos.length - 1] });
  }
  return grupos;
}

function puntosTexto(valor) {
  return Number.isInteger(valor) ? String(valor) : String(valor).replace('.', ',');
}

function nombreJuego(juego) {
  if (juego >= 3) return 'Desempate ' + (juego - 2);
  return juego === 2 ? 'Vuelta' : 'Ida';
}

function tarjetaPartida(grupo, torneo) {
  const cruce = ((torneo && torneo.cruces) || {})[grupo.matchId] || {};
  const primera = grupo.juegos[0];
  const a = primera.blanco;
  const b = primera.negro;
  const puntos = cruce.puntos || {};
  const ganador = cruce.decidido ? cruce.ganador : null;

  const filas = grupo.juegos.map((p) => {
    const vivo = p.ritmo === 'vivo'
      ? ' <span class="badge-vivo">🔴 En vivo</span>' : '';
    const estado = p.estado === 'pendiente' ? 'pendiente'
      : p.estado === 'tablas' ? 'tablas'
        : 'ganó ' + (p.ganador || '');
    const enlace = p.estado === 'pendiente'
      ? `<a href="${esc(p.enlace)}">jugar →</a>`
      : `<a class="ver" href="${esc(p.enlace)}?ver=1">ver</a>`;
    return `<div class="fila">
      <span>${nombreJuego(p.juego)} · ${esc(p.blanco)} vs ${esc(p.negro)}</span>
      <span>${esc(estado)}${vivo} ${enlace}</span>
    </div>`;
  }).join('');

  const estadoCruce = ganador
    ? 'Gana ' + ganador
    : cruce.fase === 'desempate' ? 'Desempate' : 'En juego';

  return `
    <article class="partida">
      <div class="jugador ${ganador === a ? 'ganador' : ''}">
        <span>${esc(a)}</span><span class="marcador">${puntosTexto(puntos[a] || 0)}</span>
      </div>
      <div class="jugador ${ganador === b ? 'ganador' : ''}">
        <span>${esc(b)}</span><span class="marcador">${puntosTexto(puntos[b] || 0)}</span>
      </div>
      <div class="juegos">${filas}</div>
      <div class="pie">
        <span class="estado-p ${ganador ? 'ganada' : ''}">${esc(estadoCruce)}</span>
      </div>
    </article>`;
}

function pintarCuadro(torneo) {
  const contenedor = $('cuadro');
  if (!torneo) {
    contenedor.innerHTML = '<p class="vacío">Todavía no hay ningún torneo. Crea uno para empezar.</p>';
    return;
  }

  const rondas = Object.keys(torneo.rondas || {}).map(Number).sort((a, b) => a - b);
  if (!rondas.length) {
    contenedor.innerHTML = '<p class="vacío">El torneo aún no tiene partidas.</p>';
    return;
  }

  const totalRondas = rondas[rondas.length - 1];
  let html = '';

  for (const ronda of rondas) {
    const grupos = agruparPorMatch(torneo.rondas[ronda] || []);
    const byes = (torneo.byes || []).filter((b) => Number(b.ronda) === ronda);

    html += `<div class="ronda"><h3>${esc(nombreRonda(ronda, totalRondas))}</h3>`;
    if (grupos.length) {
      html += '<div class="partidas">'
        + grupos.map((g) => tarjetaPartida(g, torneo)).join('') + '</div>';
    }
    for (const bye of byes) {
      html += `<p class="bye">Sin rival (número impar): ${esc(bye.nombre)} ${textoBye(bye)}.</p>`;
    }
    if (!grupos.length && !byes.length) {
      html += '<p class="vacío">Sin partidas en esta ronda.</p>';
    }
    html += '</div>';
  }

  if (torneo.estado === 'finalizado' && torneo.campeon) {
    html += `<div class="campeon">🏆 Campeón del torneo<strong>${esc(torneo.campeon)}</strong></div>`;
  }

  contenedor.innerHTML = html;
}

function pintarCabecera(torneo) {
  const chip = $('estadoTorneo');
  if (!torneo) {
    chip.textContent = 'Sin torneo';
    chip.className = 'chip';
    $('campeon').innerHTML = '';
    return;
  }

  if (torneo.estado === 'finalizado') {
    chip.textContent = 'Finalizado · ' + (torneo.campeon || 'sin campeón');
    chip.className = 'chip final';
  } else if (torneo.estado === 'cancelado') {
    chip.textContent = 'Cancelado';
    chip.className = 'chip';
  } else {
    chip.textContent = 'En curso · ronda ' + torneo.ronda +
      ' · ' + torneo.partidasPendientes + ' partida(s) pendiente(s)';
    chip.className = 'chip activo';
  }

  const jugadores = (torneo.jugadores || []).length;
  $('campeon').innerHTML = torneo.estado === 'finalizado' && torneo.campeon
    ? `<div class="campeon">🏆 Campeón<strong>${esc(torneo.campeon)}</strong></div>`
    : `<p class="suave" style="margin-top:12px">${jugadores} jugadores · creado el ${esc(new Date(torneo.creadoEn).toLocaleDateString('es-ES'))}</p>`;
}

function aplicar(torneo) {
  torneoActual = torneo;
  pintarCabecera(torneo);
  pintarSorteo(torneo);
  pintarCuadro(torneo);
}

/*
 * Resumen explícito del sorteo de la ronda en curso: parejas y quién lleva
 * blancas. Se actualiza al terminar cada partida y al empezar una ronda.
 */
function pintarSorteo(torneo) {
  const caja = $('sorteo');
  if (!torneo || torneo.estado === 'cancelado') {
    caja.innerHTML = '';
    return;
  }

  const ronda = torneo.ronda;
  const partidas = (torneo.rondas[ronda] || []);
  const byes = (torneo.byes || []).filter((b) => Number(b.ronda) === ronda);
  if (!partidas.length && !byes.length) {
    caja.innerHTML = '';
    return;
  }

  // Un bloque por cruce: ida, vuelta y desempates en orden.
  const filas = agruparPorMatch(partidas).flatMap((grupo) => grupo.juegos).map((p) => `
    <div class="emparejamiento">
      <span>${nombreJuego(p.juego)} · ${esc(p.blanco)} <span class="vs">vs</span> ${esc(p.negro)}</span>
      <span class="color">${esc(p.blanco)} lleva blancas${p.ritmo === 'vivo' ? ' · 🔴 en vivo' : ''}</span>
    </div>`).join('');

  const libres = byes.map((b) => `
    <div class="emparejamiento">
      <span>${esc(b.nombre)}</span>
      <span class="color">sin rival (impar) · ${textoBye(b)}</span>
    </div>`).join('');

  caja.innerHTML = `<p class="sorteo-titulo">🎲 Sorteo de la ronda ${ronda}</p>
    <div class="sorteo-lista">${filas}${libres}</div>`;
}

/*
 * Rellena los jugadores disponibles a partir de /api/players (los mismos que
 * ya usa la app) para poder sortear sin escribir nada.
 */
async function cargarJugadores() {
  const contenedor = $('rosterJugadores');
  try {
    const { datos } = await api('/api/players');
    const jugadores = ((datos && datos.players) || []).filter((p) => p.activa !== false);
    if (!jugadores.length) {
      contenedor.innerHTML = '<span class="suave">No hay jugadores dados de alta.</span>';
      return;
    }
    contenedor.innerHTML = jugadores.map((p) => `
      <label class="jugador-chip">
        <input type="checkbox" value="${esc(p.nombre)}" checked>
        <span>${esc(p.nombre)}</span>
      </label>`).join('');

    contenedor.querySelectorAll('input[type="checkbox"]').forEach((caja) => {
      caja.addEventListener('change', sincronizarNombres);
    });
    sincronizarNombres();
  } catch (error) {
    contenedor.innerHTML = '<span class="suave">No se pudo cargar la lista de jugadores.</span>';
  }
}

function sincronizarNombres() {
  const seleccionados = [...document.querySelectorAll('#rosterJugadores input[type="checkbox"]:checked')]
    .map((caja) => caja.value);
  $('nombres').value = seleccionados.join('\n');
}

function marcarTodos(valor) {
  document.querySelectorAll('#rosterJugadores input[type="checkbox"]').forEach((caja) => {
    caja.checked = valor;
  });
  sincronizarNombres();
}

async function cargarActual() {
  try {
    const { datos } = await api('/api/parejas/torneos/actual');
    if (datos && datos.ok) aplicar(datos.torneo);
  } catch (error) {
    // Sin conexión: se conserva lo que hubiera.
  }
}

async function crearTorneo() {
  limpiarAviso();
  const nombres = $('nombres').value
    .split(/[\n,;]+/)
    .map((n) => n.trim())
    .filter(Boolean);

  if (nombres.length < 2) {
    aviso('Escribe al menos dos jugadores.', 'error');
    return;
  }

  const boton = $('crearBtn');
  boton.disabled = true;
  boton.textContent = 'Sorteando…';

  try {
    const token = $('adminToken').value.trim();
    if (token) localStorage.setItem(CLAVE_TOKEN, token);
    else localStorage.removeItem(CLAVE_TOKEN);

    const { status, datos } = await api('/api/parejas/torneos', {
      method: 'POST',
      body: JSON.stringify({
        nombre: $('nombreTorneo').value.trim() || undefined,
        nombres
      })
    });

    if (status === 401) {
      aviso('Token de administración incorrecto.', 'error');
      return;
    }
    if (!datos.ok) {
      aviso(datos.error || 'No se pudo crear el torneo.', 'error');
      return;
    }

    aplicar(datos.torneo);
    aviso('Torneo creado. Cada jugador ya tiene su sala asignada.', 'ok');
    $('nombres').value = '';
    $('nombreTorneo').value = '';
  } catch (error) {
    aviso('Error de conexión al crear el torneo.', 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Sortear parejas y empezar';
  }
}

async function buscarJugador() {
  const nombre = $('buscarNombre').value.trim();
  const contenedor = $('misPartidas');
  if (!nombre) {
    contenedor.innerHTML = '<p class="vacío">Escribe tu nombre.</p>';
    return;
  }

  try {
    const { datos } = await api('/api/parejas/jugador/' + encodeURIComponent(nombre));
    const partidas = (datos && datos.partidas) || [];
    if (!partidas.length) {
      contenedor.innerHTML = '<p class="vacío">No hay partidas para ' + esc(nombre) + ' en el torneo actual.</p>';
      return;
    }

    contenedor.innerHTML = partidas.map((p) => {
      const rival = p.blanco.toLowerCase() === nombre.toLowerCase() ? p.negro : p.blanco;
      const color = p.blanco.toLowerCase() === nombre.toLowerCase() ? 'blancas' : 'negras';
      let estado = 'Pendiente';
      if (p.ganador) {
        estado = p.ganador.toLowerCase() === nombre.toLowerCase() ? 'Ganada' : 'Perdida';
      } else if (p.estado === 'tablas') {
        estado = p.juego >= 3 ? 'Tablas · sigue el desempate' : 'Tablas';
      }
      return `<div class="fila-juego">
        <span>Ronda ${p.ronda} · ${nombreJuego(p.juego)} · contra <strong>${esc(rival)}</strong> con ${color}</span>
        <span>${esc(estado)}${p.ganador ? '' : ' · <a href="' + esc(p.enlace) + '">jugar →</a>'} · <a href="${esc(p.enlace)}?ver=1">ver</a></span>
      </div>`;
    }).join('');
  } catch (error) {
    contenedor.innerHTML = '<p class="vacío">Error de conexión.</p>';
  }
}

$('crearBtn').addEventListener('click', crearTorneo);
$('buscarBtn').addEventListener('click', buscarJugador);
$('todosBtn').addEventListener('click', () => marcarTodos(true));
$('ningunoBtn').addEventListener('click', () => marcarTodos(false));
$('buscarNombre').addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter') buscarJugador();
});

cargarJugadores();
cargarActual();
setInterval(cargarActual, 10000);

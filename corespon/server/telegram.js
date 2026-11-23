'use strict';

/*
 * Canal de notificaciones por Telegram.
 *
 *   telegram     Bot de Telegram (único canal)
 *     Requiere: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (grupo o chat).
 *     Opcional: TELEGRAM_CHAT_<JUGADOR> para enviar a un chat privado
 *     (p. ej. TELEGRAM_CHAT_MANUEL=-100123...). Si no existe, usa el grupo.
 *
 * El mensaje se envía asíncronamente. Cada intento se registra en la base de
 * datos (corespon_notificaciones) con el texto ya renderizado, para auditoría
 * y reintentos.
 */

const { createStore } = require('./db');

const PROVIDERS = {
  telegram: telegramProvider
};

// Mensajes predeterminados. ${jugador} identifica al destinatario, útil cuando
// las notificaciones llegan a un grupo de Telegram.
const MESSAGES = {
  invitacion:
    '♟ *Nueva partida de ajedrez*\n\n${rival} ha invitado a ${jugador} a una ' +
    'partida de correspondencia. Tienes 2 días por jugada (ampliables). ' +
    'Entra en ${host}/corespon y usa el código *${code}* ' +
    '(o copia el enlace).',

  turno:
    '♟ *Te toca mover, ${jugador}*\n\nEs tu turno en la partida ${code}. ' +
    'Tu jugada caduca en *${tiempo}*.\n\nEntra a jugar: ' +
    '${host}/corespon/${code}',

  recordatorio:
    '⏰ *Recordatorio para ${jugador}*\n\nTe queda poco tiempo para mover en ' +
    'la partida ${code}: *${tiempo}*.\n\nEntra a jugar: ' +
    '${host}/corespon/${code}',

  prorroga:
    '♟ *Prórroga de ${jugador}*\n\nLa partida ${code} se ha ampliado. ' +
    'Tienes hasta ${fecha} para mover.',

  tiempo:
    '☠ *Tiempo agotado*\n\n${jugador} ha perdido por tiempo la partida ${code}.',

  fin:
    '♟ *Partida terminada*\n\n${resultado} en la partida ${code}.${ratingLine}',

  vuelta:
    '♟ *Partida de vuelta, ${jugador}*\n\nJuegas con ${color} contra ${rival} ' +
    'en la partida ${code}. Se han cambiado los colores y el tablero ya está ' +
    'listo.\n\nEntra a jugar: ${host}/corespon/${code}',

  parejas:
    '♟ *Torneo de parejas, ${jugador}*\n\nTe toca jugar ${etapa} de la ronda ${ronda} ' +
    'contra ${rival}, con ${color}, en la partida ${code}.\n\n' +
    'Entra a jugar: ${host}/corespon/${code}',

  desempate:
    '⏳ *Desempate por correspondencia, ${jugador}*\n\nEl desempate de la ' +
    'partida ${code} no se ha jugado en vivo en 24 h. Sigue como ' +
    'correspondencia: 2 días por jugada.\n\nEntra a jugar: ' +
    '${host}/corespon/${code}'
};

// ============================ TELEGRAM ============================

function envKeyForPlayer(nombre) {
  const limpio = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return 'TELEGRAM_CHAT_' + limpio;
}

/*
 * Chat de Telegram para un jugador: TELEGRAM_CHAT_<JUGADOR> si existe y, si no,
 * el chat común TELEGRAM_CHAT_ID (normalmente un grupo).
 */
function telegramChatFor(nombre) {
  if (nombre) {
    const key = envKeyForPlayer(nombre);
    if (key !== 'TELEGRAM_CHAT_' && process.env[key]) return process.env[key];
  }
  return process.env.TELEGRAM_CHAT_ID || null;
}

function telegramHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function plainText(text) {
  return String(text).replace(/\*/g, '');
}

async function telegramProvider(text, destino) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram: TELEGRAM_BOT_TOKEN no configurado');

  const chatId = telegramChatFor(destino && destino.nombre);
  if (!chatId) throw new Error('Telegram: TELEGRAM_CHAT_ID no configurado');

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;

  async function call(useHtml) {
    const body = {
      chat_id: chatId,
      text: useHtml ? telegramHtml(text) : plainText(text),
      disable_web_page_preview: true
    };
    if (useHtml) body.parse_mode = 'HTML';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  let { res, data } = await call(true);

  // Si el HTML no es válido, reintentar en texto plano antes de fallar.
  if ((!res.ok || data.ok === false) && /parse entities/i.test(String(data.description || ''))) {
    ({ res, data } = await call(false));
  }

  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram error ${res.status}: ${data.description || 'sin detalle'}`);
  }

  return { id: data.result && data.result.message_id, meta: data };
}

// ============================ FORMATO ============================

async function formatMessage(template, vars, host) {
  let text = MESSAGES[template] || MESSAGES.invitacion;
  text = text.replace(/\$\{(\w+)\}/g, (m, key) => {
    if (key === 'host') return host || 'http://localhost:3001';
    return String((vars && vars[key]) ?? '');
  });
  return text;
}

function normalizeDestino(destino) {
  if (!destino) return { nombre: null, telegram: null };
  if (typeof destino === 'string') return { nombre: destino, telegram: null };
  // Los asientos de una sala usan `name`; los destinos ad-hoc, `nombre`.
  return {
    nombre: destino.nombre || destino.name || null,
    telegram: destino.telegram || null
  };
}

// ============================ GATEWAY ============================

class TelegramGateway {
  constructor(options = {}) {
    const configured = (options.providerName
      || process.env.NOTIFY_PROVIDER
      || 'telegram').toLowerCase();

    if (typeof options.provider === 'function') {
      // Proveedor inyectado (pruebas)
      this.providerName = configured;
      this.provider = options.provider;
    } else {
      this.providerName = ((options.provider && String(options.provider)) || configured).toLowerCase();
      this.provider = PROVIDERS[this.providerName];
    }

    if (!this.provider) {
      throw new Error(`Proveedor de notificaciones desconocido: ${this.providerName}`);
    }

    this.store = options.store || createStore();
    this.debug = !!options.debug;

    // Reintentos: espera tras el 1.er y 2.º fallo; al agotarlos queda 'fallido'.
    this.retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs
      : [60 * 1000, 5 * 60 * 1000];
    this.maxIntentos = options.maxIntentos || this.retryDelaysMs.length + 1;

    if (this.providerName === 'telegram' && !this.ready && this.debug) {
      console.warn('[notificaciones] Telegram sin configurar: define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID');
    }
  }

  /*
   * Un canal está listo si tiene credenciales. Sin Telegram configurado no se
   * encolan mensajes (evita una cola que crece sin poder enviarse nunca).
   */
  get ready() {
    if (this.providerName !== 'telegram') return true;
    if (!process.env.TELEGRAM_BOT_TOKEN) return false;
    if (process.env.TELEGRAM_CHAT_ID) return true;
    return Object.keys(process.env).some(key => key.startsWith('TELEGRAM_CHAT_'));
  }

  async enqueue(roomCode, tipo, destino, vars, host) {
    const target = normalizeDestino(destino);

    if (!this.ready) return null;

    // Los constructores de mensajes devuelven { tipo, vars }; se acepta tanto
    // ese objeto como el mapa de variables ya extraído.
    const datos = vars && vars.vars ? vars.vars : vars;
    const texto = await formatMessage(tipo, datos, host);
    const notif = {
      roomCode,
      tipo,
      destinatario: target.telegram || target.nombre || null,
      jugador: target.nombre,
      texto,
      estado: 'pendiente',
      enviadoEn: null,
      error: null
    };

    try {
      await this.store.addNotificacion(notif);
      return notif;
    } catch (error) {
      if (this.debug) console.error('[notificaciones] error al encolar:', error.message);
      return null;
    }
  }

  // Envía un mensaje inmediato (sin registro)
  async send(tipo, destino, vars, host) {
    const target = normalizeDestino(destino);
    // Los constructores de mensajes devuelven { tipo, vars }; se acepta tanto
    // ese objeto como el mapa de variables ya extraído.
    const datos = vars && vars.vars ? vars.vars : vars;
    const texto = await formatMessage(tipo, datos, host);
    return this._sendText(texto, target);
  }

  async _sendText(text, destino) {
    const target = normalizeDestino(destino);
    const start = Date.now();
    try {
      const res = await this.provider(text, target);
      if (this.debug) {
        console.log(`[${this.providerName}] enviado a ${target.telegram || target.nombre || 'grupo'} (${Date.now() - start}ms)`);
      }
      return { ok: true, timeMs: Date.now() - start, provider: this.providerName, externalId: res && res.id };
    } catch (error) {
      if (this.debug) console.error(`[${this.providerName}] error:`, error.message);
      return { ok: false, error: error.message, timeMs: Date.now() - start, provider: this.providerName };
    }
  }

  // Procesa todas las notificaciones pendientes (llamado por el scheduler)
  async processQueue(limit = 50) {
    const pending = await this.store.getNotificacionesPendientes(limit);
    if (!pending.length) return { processed: 0 };

    const results = [];
    for (const n of pending) {
      if (!n.texto) {
        await this.store.marcaNotificacionComoEnviada(n.id, 'sin_texto');
        results.push({ ...n, ok: false, error: 'sin_texto' });
        continue;
      }
      const res = await this._sendText(n.texto, { nombre: n.jugador, telegram: n.destinatario });

      // Backoff: un fallo no descarta el mensaje, pero tampoco se reintenta en
      // cada pasada de la cola. Tras `maxIntentos` queda como fallido.
      let proximoIntento = null;
      if (!res.ok) {
        const intentos = (n.intentos || 0) + 1;
        if (intentos < this.maxIntentos) {
          const idx = Math.min(intentos - 1, this.retryDelaysMs.length - 1);
          const espera = this.retryDelaysMs[idx] || 0;
          proximoIntento = new Date(Date.now() + espera).toISOString();
        }
      }

      // Un fallo al persistir el estado no debe tumbar el servidor ni impedir
      // que se procesen las demás notificaciones. Si el mensaje ya salió, se
      // reintentará en la siguiente pasada (puede duplicarse).
      try {
        await this.store.marcaNotificacionComoEnviada(n.id, res.error || null, proximoIntento);
      } catch (error) {
        if (this.debug) {
          console.error('[notificaciones] no se pudo guardar el estado:', error.message);
        }
      }
      results.push({ ...n, ...res, proximoIntento, estado: res.ok ? 'enviado' : (proximoIntento ? 'pendiente' : 'fallido') });
    }
    return { processed: results.length, results };
  }

  static isSendable(now, lastSent) {
    // mínimo 3 segundos entre mensajes al mismo destinatario
    return !lastSent || (now - lastSent) > 3000;
  }
}

// Singleton global (por proceso). El servidor crea el suyo propio.
let _gateway = null;
function getGateway(options) {
  if (!_gateway) _gateway = new TelegramGateway(options);
  return _gateway;
}

// ============================ MENSAJES DE PARTIDA ============================

function jugadorDe(room, color) {
  return room.players[color] ? room.players[color].name : '';
}

function rivalDe(room, color) {
  return color === 'white' ? jugadorDe(room, 'black') : jugadorDe(room, 'white');
}

function invitacionMsg(room, color, host) {
  return {
    tipo: 'invitacion',
    vars: {
      rival: rivalDe(room, color),
      jugador: jugadorDe(room, color),
      code: room.code,
      host
    }
  };
}

function turnoMsg(room, color, host) {
  return {
    tipo: 'turno',
    vars: {
      jugador: jugadorDe(room, color),
      rival: rivalDe(room, color),
      code: room.code,
      tiempo: room.plazoInfo().texto,
      host
    }
  };
}

function recordatorioMsg(room, color, host) {
  return {
    tipo: 'recordatorio',
    vars: {
      jugador: jugadorDe(room, color),
      code: room.code,
      tiempo: room.plazoInfo().texto,
      host
    }
  };
}

function prorrogaMsg(room, color, host) {
  const limite = new Date(room.plazos.plazoHasta);
  const pad = (n) => String(n).padStart(2, '0');
  const fecha = `${pad(limite.getDate())}/${pad(limite.getMonth() + 1)}, `
    + `${pad(limite.getHours())}:${pad(limite.getMinutes())}`;
  return {
    tipo: 'prorroga',
    vars: {
      jugador: jugadorDe(room, color),
      code: room.code,
      fecha,
      host
    }
  };
}

function tiempoMsg(room, perdedor, host) {
  return {
    tipo: 'tiempo',
    vars: {
      jugador: jugadorDe(room, perdedor),
      rival: rivalDe(room, perdedor),
      code: room.code,
      host
    }
  };
}

function finMsg(room, host, extra = {}) {
  const ganador = room.status.winner === 'white' ? room.players.white.name
    : room.status.winner === 'black' ? room.players.black.name : null;
  const perdedor = room.status.winner === 'white' ? room.players.black.name
    : room.status.winner === 'black' ? room.players.white.name : null;
  const resultado = ganador ? `${ganador} gana` : 'Tablas';

  // Línea opcional con el rating: "Manuel 1525 · Fernan 1475".
  const ratings = extra.ratings || '';
  const ratingLine = ratings ? `\n\nRating: ${ratings}` : '';

  return {
    tipo: 'fin',
    vars: {
      code: room.code,
      ganador: ganador || '',
      perdedor: perdedor || '',
      resultado,
      ratings,
      ratingLine,
      host
    }
  };
}

/*
 * Aviso de la vuelta: cada jugador recibe el color que le toca en la partida
 * nueva. Se manda después de reiniciar la sala, cuando los colores ya están
 * intercambiados.
 */
function vueltaMsg(room, color, host) {
  return {
    tipo: 'vuelta',
    vars: {
      jugador: jugadorDe(room, color),
      rival: rivalDe(room, color),
      color: color === 'white' ? 'blancas' : 'negras',
      code: room.code,
      host
    }
  };
}

/*
 * Aviso de partida de torneo de parejas: ronda, color, rival y enlace.
 */
function parejasMsg(room, color, host, extra = {}) {
  return {
    tipo: 'parejas',
    vars: {
      jugador: jugadorDe(room, color),
      rival: rivalDe(room, color),
      color: color === 'white' ? 'blancas' : 'negras',
      code: room.code,
      ronda: extra.ronda || 1,
      etapa: extra.etapa || 'la partida',
      host
    }
  };
}

/*
 * Aviso de que el desempate en vivo no arrancó: sigue por correspondencia.
 */
function desempateMsg(room, color, host) {
  return {
    tipo: 'desempate',
    vars: {
      jugador: jugadorDe(room, color),
      rival: rivalDe(room, color),
      code: room.code,
      host
    }
  };
}

module.exports = {
  TelegramGateway,
  NotificationGateway: TelegramGateway,
  getGateway,
  formatMessage,
  MESSAGES,
  telegramProvider,
  telegramChatFor,
  telegramHtml,
  INVITACION: 'invitacion',
  TURNO: 'turno',
  RECORDATORIO: 'recordatorio',
  PRORROGA: 'prorroga',
  TIEMPO: 'tiempo',
  FIN: 'fin',
  VUELTA: 'vuelta',
  PAREJAS: 'parejas',
  DESEMPATE: 'desempate',
  invitacionMsg,
  turnoMsg,
  recordatorioMsg,
  prorrogaMsg,
  tiempoMsg,
  finMsg,
  vueltaMsg,
  parejasMsg,
  desempateMsg
};

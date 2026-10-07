'use strict';

const HTTPParser = require('http-string-parser');
const { Stanza } = require('node-xmpp-client');
const { IVTClient } = require('./bosch-xmpp');

const CONNECT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;
const ATTEMPTS_PER_REQUEST = 2;

function decodeBody(client, response) {
  const text = client.decrypt(response.body).replace(/\0*$/g, '');
  return text ? JSON.parse(text) : undefined;
}

// Reply ids sometimes include the request's query (`...?interval=2026-10-05`)
// and sometimes not, so compare the path and the separate `interval` field.
function isReplyFor(data, uri) {
  if (data?.id === undefined) return true;
  const [path, query = ''] = uri.split('?');
  if (data.id.split('?')[0] !== path) return false;
  const interval = /(?:^|&)interval=([^&]*)/.exec(query)?.[1];
  return !interval || data.interval === undefined || data.interval === interval;
}

function sendAndWait(client, message, isReplyToThis) {
  return new Promise((resolve, reject) => {
    const xmpp = client.client;
    const handlers = {};
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      xmpp.removeListener('stanza', handlers.stanza);
      xmpp.removeListener('error', handlers.error);
    };

    handlers.error = (err) => {
      cleanup();
      reject(err);
    };

    handlers.stanza = (stanza) => {
      if (!stanza.is('message') || stanza.attrs.to !== client.jid) return;
      if (stanza.attrs.type === 'error') {
        cleanup();
        const error = new Error('ERROR_RESPONSE');
        error.data = stanza.root();
        reject(error);
        return;
      }
      let response;
      try {
        response = HTTPParser.parseResponse(stanza.root().getChild('body').getText().replace(/\n/g, '\r\n'));
      } catch (err) {
        cleanup();
        reject(new Error('RESPONSE_PARSE_ERROR'));
        return;
      }
      if (!isReplyToThis(response)) return;
      cleanup();
      resolve(response);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('REQUEST_TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);

    xmpp.on('stanza', handlers.stanza);
    xmpp.on('error', handlers.error);
    xmpp.send(message);
  });
}

// The Bosch server periodically sends iq queries (seen: jabber:iq:version).
// XMPP requires every iq "get" to be answered; the official clients do.
function answerServerQuery(client, stanza) {
  if (!stanza.is('iq') || stanza.attrs.type !== 'get') return;

  const reply = new Stanza('iq', { type: 'result', id: stanza.attrs.id, to: stanza.attrs.from });
  const query = stanza.getChild('query');
  if (query?.attrs.xmlns === 'jabber:iq:version') {
    reply
      .c('query', { xmlns: 'jabber:iq:version' })
      .c('name')
      .t(client.USERAGENT)
      .up()
      .c('version')
      .t('1.0');
  } else if (!stanza.getChild('ping', 'urn:xmpp:ping')) {
    reply.attrs.type = 'error';
    reply
      .c('error', { type: 'cancel' })
      .c('service-unavailable', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' });
  }
  client.client.send(reply);
}

// Wraps the bosch-xmpp IVTClient (a submodule we don't edit) with stricter
// request/response matching. The library resolves a request with whichever
// reply arrives next, so a reply that shows up after its request timed out is
// handed to the following request. Here every GET reply must belong to the
// endpoint that was asked for (see isReplyFor), and anything else is ignored.
async function createGatewayClient(settings, { onError }) {
  const client = IVTClient({
    serialNumber: settings.serial,
    accessKey: settings.key,
    password: settings.password,
  });

  client.on('stanza', (stanza) => answerServerQuery(client, stanza));

  client.request = function request(message, isReplyToThis) {
    return this.queue.add(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await sendAndWait(this, message, isReplyToThis);
        } catch (err) {
          if (err.message !== 'REQUEST_TIMEOUT' || attempt >= ATTEMPTS_PER_REQUEST) throw err;
        }
      }
    });
  };

  client.get = function get(uri) {
    const message = this.buildMessage([
      `GET ${uri} HTTP/1.1`,
      `User-Agent: ${this.USERAGENT}`,
      `Seq-No: ${this.seqno++}`,
      '\n\n',
    ].join(this.LINE_SEPARATOR));

    return this.request(message, (response) => {
      if (response.statusCode === '204') return false; // a late PUT acknowledgement
      if (response.statusCode !== '200') return true;
      try {
        response.data = decodeBody(this, response);
      } catch (err) {
        response.decodeError = err; // e.g. wrong password: body decrypts to garbage
        return true;
      }
      return isReplyFor(response.data, uri);
    }).then((response) => {
      if (response.statusCode !== '200') {
        const error = new Error(`HTTP_${response.statusMessage.toUpperCase().replace(/\s+/g, '_')}`);
        error.response = response;
        throw error;
      }
      if (response.decodeError) throw response.decodeError;
      return response.data;
    });
  };

  // The IVT gateway expects blank lines between headers, like GET requests do.
  client.put = function put(uri, data) {
    const encrypted = this.encrypt(typeof data === 'string' ? data : JSON.stringify(data));
    const message = this.buildMessage([
      `PUT ${uri} HTTP/1.1`,
      `User-Agent: ${this.USERAGENT}`,
      'Content-Type: application/json',
      `Content-Length: ${encrypted.length}`,
      `Seq-No: ${this.seqno++}`,
      '',
      encrypted,
    ].join(this.LINE_SEPARATOR));

    return this.request(message, (response) => {
      if (response.statusCode !== '200') return true;
      try {
        return decodeBody(this, response)?.id === undefined; // a late GET reply carries an id
      } catch (err) {
        return true;
      }
    }).then((response) => {
      if (Number(response.statusCode || 500) >= 300) {
        const error = new Error('INVALID_RESPONSE');
        error.response = response;
        throw error;
      }
      return { status: 'ok' };
    });
  };

  let timer;
  try {
    await Promise.race([
      client.connect(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Connection timed out')), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    client.end();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // connect() strips all 'error' listeners once online, so attach ours afterwards;
  // an 'error' event without a listener would crash the app.
  client.on('error', onError);
  return client;
}

module.exports = { createGatewayClient };

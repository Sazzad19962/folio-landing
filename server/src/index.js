'use strict';

const config = require('./config');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.port, function () {
  console.log('[folio] listening on http://localhost:' + server.address().port);
});

// Large uploads on slow connections need more than the default timeouts.
server.requestTimeout = 15 * 60 * 1000;

function shutdown() {
  console.log('[folio] shutting down');
  app.locals.store.close();
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    service: 'geocoder-api',
    message: 'Geocoder API listening',
    port: config.port
  }));
});

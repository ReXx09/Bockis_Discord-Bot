const convict = require('convict');

const config = convict({
  environment: {
    doc: 'Application environment',
    format: ['production', 'development', 'test'],
    default: 'development',
    env: 'NODE_ENV'
  },
  webPort: {
    doc: 'Webserver port',
    format: 'port',
    default: 3000,
    env: 'WEB_PORT'
  },
  database: {
    dialect: {
      default: 'sqlite',
      env: 'DB_DIALECT'
    },
    storage: {
      doc: 'Database storage path',
      default: './data/status.db',
      env: 'DB_STORAGE'
    }
  }
});

config.validate({ allowed: 'strict' });

module.exports = config;

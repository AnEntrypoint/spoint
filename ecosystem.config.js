module.exports = {
  apps: [{
    name: 'spawnpoint',
    script: 'server.js',
    interpreter: 'node',
    instances: 1,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};

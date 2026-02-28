module.exports = {
  apps: [
    {
      name: 'spoint',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      ignore_watch: [
        'node_modules',
        '.git',
        'apps/maps/.glb-cache',
        'apps/props/.glb-cache',
        '.pm2'
      ],
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}

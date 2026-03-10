module.exports = {
  apps: [
    {
      name: 'spoint',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      watch_delay: 1000,
      windowsHide: true,
      ignore_watch: [
        'node_modules',
        '.git',
        'apps/maps/.glb-cache',
        'apps/props/.glb-cache',
        '.pm2',
        '*.log'
      ],
      watch_options: {
        followSymlinks: false,
        usePolling: false
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}

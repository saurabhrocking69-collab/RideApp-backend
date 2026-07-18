module.exports = {
  apps: [{
    name: 'sppero',
    script: 'server.js',
    instances: 'max',          // one worker per vCPU
    exec_mode: 'cluster',
    max_memory_restart: '900M',
    node_args: '--max-old-space-size=850',
    env: { NODE_ENV: 'production' },
    // Graceful shutdown: let in-flight requests finish before killing
    kill_timeout: 10000,
    wait_ready: false,
    listen_timeout: 15000,
  }],
};

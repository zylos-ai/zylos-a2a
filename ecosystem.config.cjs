const os = require('node:os');
const path = require('node:path');

module.exports = {
  apps: [{
    name: 'zylos-a2a',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/a2a'),
    env: { NODE_ENV: 'production' },
    autorestart: true,
    stop_exit_codes: [0],
    max_restarts: 10,
    restart_delay: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/a2a/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/a2a/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};

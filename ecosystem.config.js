// تشغيل DOLAB على السيرفر بـ pm2:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: "dolab",
      cwd: __dirname,
      script: "server/src/index.js",
      interpreter: `${process.env.HOME}/node22/bin/node`,
      node_args: "--env-file=.env",
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};

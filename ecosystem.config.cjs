// pm2 on the VM. Node 22 is what the Strands SDK needs and what nvm installed; pm2 itself runs on the system node.
const node = "/home/ubuntu/.nvm/versions/node/v22.23.2/bin/node";
module.exports = {
  apps: [
    { name: "warden", cwd: __dirname, script: "node_modules/next/dist/bin/next", args: "start -p 3200", interpreter: node, env: { NODE_ENV: "production" }, max_memory_restart: "700M" },
    // The watch itself. Every ten minutes, with nobody present: ask every probe, open an incident
    // when something has failed twice, and hand it straight to the agent. This is the difference
    // between an operator and a button.
    { name: "warden-sweep", cwd: __dirname, script: "node_modules/tsx/dist/cli.mjs", args: "--env-file=.env scripts/sweep.ts", interpreter: node, cron_restart: "*/10 * * * *", autorestart: false },
  ],
};

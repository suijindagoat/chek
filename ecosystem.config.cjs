const path = require("path");

module.exports = {
  apps: [
    {
      name: "clipkey-flag",
      cwd: __dirname,
      script: path.join(__dirname, "index.js"),
      interpreter: "node",
      // Don't relaunch when you close the browser window (index.js exits cleanly).
      autorestart: false,
      watch: false,
      windowsHide: true,
      kill_timeout: 5000,
    },
    {
      name: "clipkey-updater",
      cwd: __dirname,
      script: path.join(__dirname, "updater.js"),
      interpreter: "node",
      autorestart: true,
      watch: false,
      windowsHide: true,
      kill_timeout: 5000,
    },
  ],
};

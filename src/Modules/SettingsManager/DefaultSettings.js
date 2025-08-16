const DefaultSettings = [
  // {
  //     Group: "UI",
  //     Key: "UI_DISPLAY_TIMERS_IN_TABLE",
  //     Title: "List View",
  //     Description: "Displays timers in a table instead of a grid.",
  //     Type: "BOOLEAN",
  //     DefaultValue: false,
  // },

  {
    Group: 'System',
    Key: 'SYSTEM_PREVENT_DISPLAY_SLEEP',
    Title: 'Prevent Display Sleep',
    Description: 'Prevents the display from going to sleep while ShowTrak is running.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    Title: 'Stop Accidental Shutdowns (Reboot Required)',
    Description: 'Requires confirmation before shutting down ShowTrak when pressing Alt+F4.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'System',
    Key: 'SYSTEM_AUTO_UPDATE',
    Title: 'Automatic Updates (Reboot Required)',
    Description: 'Automatically update ShowTrak to the latest stable version.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  // OSC
  {
    Group: 'OSC',
    Key: 'OSC_ENABLE',
    Title: 'Enable OSC Server',
    Description: 'Enables the OSC UDP server for remote control.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'OSC:Restart',
  },
  {
    Group: 'OSC',
    Key: 'OSC_PORT',
    Title: 'OSC Port',
    Description: 'UDP port to listen for OSC commands.',
    Type: 'INTEGER',
    DefaultValue: 3333,
    OnUpdateEvent: 'OSC:Restart',
    RequiresSave: true,
    Validate: async (val, setting) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) return [false, 'Port must be 1-65535.'];
      // If unchanged, skip port-in-use check
      if (Number(setting && setting.Value) === n) return [true, null];
      try {
        const dgram = require('dgram');
        await new Promise((resolve, reject) => {
          const sock = dgram.createSocket('udp4');
          let done = false;
          sock.once('error', (err) => {
            if (!done) {
              done = true;
              try {
                sock.close();
              } catch (_e2) {
                // ignore
              }
              reject(err);
            }
          });
          sock.bind({ address: '0.0.0.0', port: n, exclusive: true }, () => {
            if (!done) {
              done = true;
              try {
                sock.close(() => resolve());
              } catch (_e3) {
                resolve();
              }
            }
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              try {
                sock.close(() => resolve());
              } catch (_e4) {
                resolve();
              }
            }
          }, 150);
        });
      } catch (_e) {
        // Port appears to be in use or cannot be pre-bound
        return [false, `Port ${n} appears to be in use.`];
      }
      return [true, null];
    },
  },
  {
    Group: 'OSC',
    Key: 'OSC_BIND',
    Title: 'OSC Bind Address',
    Description: 'IP address to bind the OSC server to.',
    Type: 'TEXT',
    DefaultValue: '0.0.0.0',
    OnUpdateEvent: 'OSC:Restart',
    RequiresSave: true,
    Validate: async (val) => {
      const v = String(val || '').trim();
      const ipv4 =
        /^(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
      const okFormat = v === '0.0.0.0' || ipv4.test(v);
      if (!okFormat) return [false, 'Invalid IPv4 address.'];
      if (v === '0.0.0.0') return [true, null];
      // Preflight bind on UDP to detect EADDRNOTAVAIL
      try {
        const dgram = require('dgram');
        await new Promise((resolve, reject) => {
          const sock = dgram.createSocket('udp4');
          let done = false;
          sock.once('error', (err) => {
            if (!done) {
              done = true;
              try {
                sock.close();
              } catch (_e5) {
                // ignore
              }
              reject(err);
            }
          });
          sock.bind({ address: v, port: 0, exclusive: true }, () => {
            if (!done) {
              done = true;
              try {
                sock.close(() => resolve());
              } catch (_e6) {
                resolve();
              }
            }
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              try {
                sock.close(() => resolve());
              } catch (_e7) {
                resolve();
              }
            }
          }, 150);
        });
        return [true, null];
      } catch (e) {
        if (e && e.code === 'EADDRNOTAVAIL')
          return [false, `Bind address ${v} is not available on this machine.`];
        return [false, `Unable to bind to ${v}.`];
      }
    },
  },
  // Web Dashboard (read-only timers monitor)
  {
    Group: 'Web',
    Key: 'WEB_ENABLE_DASHBOARD',
    Title: 'Enable Web Dashboard',
    Description: 'Serves a read-only timers dashboard over the local network.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'WebDashboard:Restart',
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_PORT',
    Title: 'Web Dashboard Port',
    Description: 'TCP port to host the read-only timers dashboard.',
    Type: 'INTEGER',
    DefaultValue: 4300,
    OnUpdateEvent: 'WebDashboard:Restart',
    RequiresSave: true,
    Validate: async (val, setting) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) return [false, 'Port must be 1-65535.'];
      if (Number(setting && setting.Value) === n) return [true, null];
      try {
        const net = require('net');
        await new Promise((resolve, reject) => {
          const srv = net.createServer();
          let done = false;
          srv.once('error', (err) => {
            if (!done) {
              done = true;
              try {
                srv.close();
              } catch (_e8) {
                // ignore
              }
              reject(err);
            }
          });
          srv.listen({ host: '0.0.0.0', port: n, exclusive: true }, () => {
            if (!done) {
              done = true;
              try {
                srv.close(() => resolve());
              } catch (_e9) {
                resolve();
              }
            }
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              try {
                srv.close(() => resolve());
              } catch (_e10) {
                resolve();
              }
            }
          }, 150);
        });
      } catch (_e) {
        // Port appears to be in use or cannot be pre-bound
        return [false, `Port ${n} appears to be in use.`];
      }
      return [true, null];
    },
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_BIND',
    Title: 'Web Dashboard Bind Address',
    Description: 'IP address to bind the dashboard server (0.0.0.0 for all interfaces).',
    Type: 'TEXT',
    DefaultValue: '0.0.0.0',
    OnUpdateEvent: 'WebDashboard:Restart',
    RequiresSave: true,
    Validate: async (val) => {
      const v = String(val || '').trim();
      const ipv4 =
        /^(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
      const okFormat = v === '0.0.0.0' || ipv4.test(v);
      if (!okFormat) return [false, 'Invalid IPv4 address.'];
      if (v === '0.0.0.0') return [true, null];
      // Preflight bind on TCP to detect EADDRNOTAVAIL
      try {
        const net = require('net');
        await new Promise((resolve, reject) => {
          const srv = net.createServer();
          let done = false;
          srv.once('error', (err) => {
            if (!done) {
              done = true;
              try {
                srv.close();
              } catch (_e11) {
                // ignore
              }
              reject(err);
            }
          });
          srv.listen({ host: v, port: 0, exclusive: true }, () => {
            if (!done) {
              done = true;
              try {
                srv.close(() => resolve());
              } catch (_e12) {
                resolve();
              }
            }
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              try {
                srv.close(() => resolve());
              } catch (_e13) {
                resolve();
              }
            }
          }, 150);
        });
        return [true, null];
      } catch (e) {
        if (e && e.code === 'EADDRNOTAVAIL')
          return [false, `Bind address ${v} is not available on this machine.`];
        return [false, `Unable to bind to ${v}.`];
      }
    },
  },
];

const Groups = [
  // { Name: "UI", Title: "UI" },
  { Name: 'System', Title: 'System Settings' },
  { Name: 'Web', Title: 'Web Dashboard' },
  { Name: 'OSC', Title: 'OSC' },
];

module.exports = {
  DefaultSettings,
  Groups,
};

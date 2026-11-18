const Package = require('../../../package.json') as { version?: string; productName?: string };

const Version = Package.version || '0.0.0';

export const Config = {
  Application: {
    Version,
    Name: 'ShowTrak Timers',
  },
};

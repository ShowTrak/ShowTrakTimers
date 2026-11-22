// electron-squirrel-startup ships no types. It exports one boolean: whether this
// run is one of Squirrel.Windows' install, update, uninstall or obsolete events
// (which it has already handled; the app is quitting).
declare module 'electron-squirrel-startup' {
  const IsSquirrelEvent: boolean;
  export = IsSquirrelEvent;
}

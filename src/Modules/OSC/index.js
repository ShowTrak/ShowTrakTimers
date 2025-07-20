const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require("node-osc");

var OSCServer = new Server(3333, "0.0.0.0", () => {
	console.log("OSC Server is listening");
});

let Routes = [];

const OSC = {};


OSCServer.on("message", async function (Route) {
    let ValidRoutes = [];

    Main: for (const PRoute of Routes) {
        let PRouteParts = PRoute.Path.split('/');
        let RouteParts = Route[0].split('/');
        if (PRouteParts.length !== RouteParts.length) continue Main;
        Sub: for (let i = 0; i < PRouteParts.length; i++) {
            if (PRouteParts[i] === RouteParts[i] || PRouteParts[i].startsWith(':')) continue Sub;
            continue Main;
        }
        ValidRoutes.push(PRoute);
    }

    if (!ValidRoutes || ValidRoutes.length == 0) return Logger.error(`Invalid OSC Route: ${Route[0]}`);

    for (const ValidRoute of ValidRoutes) {
        Logger.log(`Executing route: ${ValidRoute.Path}`);

        let Req = {};

        let PRouteParts = ValidRoute.Path.split('/');
        let RouteParts = Route[0].split('/');

        for (let i = 0; i < PRouteParts.length; i++) {
            if (PRouteParts[i].startsWith(':')) {
                Req[PRouteParts[i].substring(1)] = RouteParts[i];
            }
        }

        let RequestComplete = await ValidRoute.Callback(Req);
        if (RequestComplete === false) continue;
        return Logger.success(`OSC Complete: ${Route[0]}`);
    }
    return Logger.warn(`OSC Incomplete but has matching path: ${Route[0]}`);
});

OSC.GetRoutes = () => {
    return Routes
}

OSC.CreateRoute = (Path, Callback, Title = "Default OSC Route") => {
    Routes.push({
        Title: Title,
        Path: Path,
        Callback: Callback
    })
    return;
};

// Other

OSC.CreateRoute('/ShowTrak/Shutdown', async (_Req) => {
    return false;
}, 'Close the ShowTrak Timers Application');

// Client
OSC.CreateRoute('/ShowTrak/Timer/:TimerID/Start', async (_Req) => {
    return false;
}, 'Plays a timer with the given ID');

OSC.CreateRoute('/ShowTrak/Timer/:TimerID/Stop', async (_Req) => {
    return false;
}, 'Stop & Reset a timer with the given ID');

OSC.CreateRoute('/ShowTrak/Timer/:TimerID/Pause', async (_Req) => {
    return false;
}, 'Pause a timer with the given ID');

OSC.CreateRoute('/ShowTrak/Timer/:TimerID/Unpause', async (_Req) => {
    return false;
}, 'Unpauses a timer with the given ID');

OSC.CreateRoute('/ShowTrak/Timer/:TimerID/JumpToTime/:TimeInMS', async (_Req) => {
    return false;
}, 'Jump to a specific time (MS) in a timer with the given ID');

// All
OSC.CreateRoute('/ShowTrak/All/Start', async (_Req) => {
    return false;
}, 'Start all timers');

OSC.CreateRoute('/ShowTrak/All/Stop', async (_Req) => {
    return false;
}, 'Stop & Reset all timers');

OSC.CreateRoute('/ShowTrak/All/Pause', async (_Req) => {
    return false;
}, 'Pause all timers');

OSC.CreateRoute('/ShowTrak/All/Unpause', async (_Req) => {
    return false;
}, 'Unpause all timers');

module.exports = { OSC };

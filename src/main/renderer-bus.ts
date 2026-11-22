// The renderer push bus (@showtrak/protocol/electron-main's, shared with
// ShowTrak Server): every main-process push goes through PushToRenderers to
// each registered sink, here the desktop window (main.ts).
//
// Typed by @showtrak/protocol/timers' PushMap, the same map the preload's
// subscribe() hands to the page: a channel can only be pushed with the
// arguments its subscribers are declared to receive.
import { CreateRendererBus } from '@showtrak/protocol/electron-main';
import type { PushMap } from '@showtrak/protocol/timers';

export const { RegisterRendererSink, PushToRenderers } = CreateRendererBus<PushMap>();

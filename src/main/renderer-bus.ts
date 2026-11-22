// Central renderer push bus.
//
// Fans out main-process push events to every registered "renderer sink". A sink
// is any surface that renders the ShowTrak UI: the Electron desktop window and
// (once wired) each authed Web UI socket. Routing every push through this bus
// guarantees the desktop and web surfaces receive identical events and cannot
// drift apart, which is the root cause the Web UI historically fell behind.
//
// Sinks decide for themselves which channels they care about (e.g. the web sink
// applies an allowlist + per-channel serialization); the bus is a dumb fan-out.
//
// Pushes are typed by @showtrak/protocol/timers' PushMap, the same map the
// preload's subscribe() hands to the page: a channel can only be pushed with
// the arguments its subscribers are declared to receive.
import type { PushChannel, PushMap, Unsubscribe } from '@showtrak/protocol/timers';

type RendererSink = <C extends PushChannel>(channel: C, ...args: PushMap[C]) => void;

const Sinks = new Set<RendererSink>();

// Register a sink. Returns an unsubscribe handle.
function RegisterRendererSink(sink: RendererSink): Unsubscribe {
  Sinks.add(sink);
  return () => {
    Sinks.delete(sink);
  };
}

// Push a channel + payload to every registered sink. A throwing sink is isolated
// so one misbehaving surface can never break delivery to the others.
function PushToRenderers<C extends PushChannel>(channel: C, ...args: PushMap[C]): void {
  for (const sink of Sinks) {
    try {
      sink(channel, ...args);
    } catch {
      // Intentionally swallow: renderer delivery is best-effort per surface.
    }
  }
}

export { RegisterRendererSink, PushToRenderers };
export type { RendererSink };

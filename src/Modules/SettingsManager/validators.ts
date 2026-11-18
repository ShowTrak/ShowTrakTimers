// Validation for the network settings: is the port free, and does the bind
// address exist on this machine? Both are checked by briefly binding a socket,
// which is the only reliable test (and the one the real listener will face).
import net from 'net';
import dgram from 'dgram';
import type { SettingValue } from './DefaultSettings';

export type Transport = 'tcp' | 'udp';

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function IsIPv4(Value: unknown): boolean {
  return IPV4.test(String(Value ?? '').trim());
}

// Bind (and release) a socket on host:port. Resolves when the bind succeeded,
// rejects with the socket error when it did not.
export function ProbeBind(Transport: Transport, Host: string, Port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (Transport === 'tcp') {
      const Server = net.createServer();
      Server.once('error', (Err) => reject(Err));
      Server.listen({ host: Host, port: Port, exclusive: true }, () => {
        Server.close(() => resolve());
      });
      return;
    }
    const Socket = dgram.createSocket('udp4');
    Socket.once('error', (Err) => {
      try {
        Socket.close();
      } catch {
        /* already closed */
      }
      reject(Err);
    });
    Socket.bind({ address: Host, port: Port, exclusive: true }, () => {
      Socket.close(() => resolve());
    });
  });
}

export async function ValidatePort(
  Transport: Transport,
  Value: SettingValue,
  Current: SettingValue
): Promise<string | null> {
  const Port = Number(Value);
  if (!Number.isInteger(Port) || Port < 1 || Port > 65535) return 'Port must be 1-65535.';
  // Unchanged: our own listener is the thing holding it.
  if (Number(Current) === Port) return null;
  try {
    await ProbeBind(Transport, '0.0.0.0', Port);
    return null;
  } catch (Err) {
    const Code = (Err as NodeJS.ErrnoException | null)?.code;
    if (Code === 'EACCES') return `Port ${Port} needs administrator rights on this machine.`;
    return `Port ${Port} is already in use.`;
  }
}

export async function ValidateBindAddress(
  Transport: Transport,
  Value: SettingValue
): Promise<string | null> {
  const Address = String(Value ?? '').trim();
  if (Address === '0.0.0.0') return null;
  if (!IsIPv4(Address)) return 'Enter an IPv4 address, or 0.0.0.0 for every interface.';
  try {
    // Port 0: any free port, so only the address itself is being tested.
    await ProbeBind(Transport, Address, 0);
    return null;
  } catch (Err) {
    const Code = (Err as NodeJS.ErrnoException | null)?.code;
    if (Code === 'EADDRNOTAVAIL') return `${Address} is not an address of this machine.`;
    return `Unable to listen on ${Address}.`;
  }
}

// The Web Dashboard passcode: four digits, as ShowTrak Server's Web UI passcode,
// or empty for none.
export function ValidatePasscode(Value: SettingValue): string | null {
  const Text = String(Value ?? '').trim();
  return Text === '' || /^\d{4}$/.test(Text) ? null : 'The passcode must be exactly 4 digits.';
}

// EA backend recon capture listener.
// AoT connects to 127.0.0.1:18131 (its hardcoded EA FESL/login port). We listen
// across the EA port range so we also catch whatever theater/matchmaking port it
// hits next. Goal: record the first bytes to identify the protocol.
//   ProtoSSL/TLS  -> starts 16 03 00 / 16 03 01
//   plaintext FESL -> ASCII tags like "FSYS"/"acct"/"pnow"
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORTS = [13505];
for (let p = 18100; p <= 18210; p++) PORTS.push(p);

const BIND_ADDRESS = process.env.AOT_CAPTURE_BIND_ADDRESS || '127.0.0.1';
if (!net.isIP(BIND_ADDRESS)) {
  throw new Error('AOT_CAPTURE_BIND_ADDRESS must be a numeric IP');
}
if (
  BIND_ADDRESS !== '127.0.0.1' &&
  BIND_ADDRESS !== '::1' &&
  process.env.AOT_CAPTURE_ALLOW_NON_LOOPBACK !== 'true'
) {
  throw new Error(
    'non-loopback capture bind requires AOT_CAPTURE_ALLOW_NON_LOOPBACK=true',
  );
}

const LOG = path.resolve(
  process.env.AOT_CAPTURE_LOG || path.join(__dirname, 'ea_capture.log'),
);
fs.writeFileSync(
  LOG,
  `=== EA capture started ${new Date().toISOString()} ===\n`,
);
function log(msg) {
  const line = `[${new Date().toISOString().substr(11, 12)}] ${msg}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
}

let listening = 0;
for (const port of PORTS) {
  const server = net.createServer((sock) => {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    log(`CONNECT  :${port}  <- ${peer}`);
    sock.on('data', (d) => {
      const hex = d
        .toString('hex')
        .match(/.{1,2}/g)
        .join(' ');
      const ascii = d.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      log(`DATA     :${port}  ${d.length} bytes`);
      log(`  HEX   : ${hex.substr(0, 300)}${hex.length > 300 ? ' ...' : ''}`);
      log(`  ASCII : ${ascii.substr(0, 150)}`);
    });
    sock.on('error', (e) => log(`ERROR    :${port}  ${e.message}`));
    sock.on('close', () => log(`CLOSE    :${port}  <- ${peer}`));
  });
  server.on('error', (e) => log(`LISTEN-ERR :${port}  ${e.message}`));
  server.listen(port, BIND_ADDRESS, () => {
    if (++listening === PORTS.length) {
      log(
        `ready - listening on ${BIND_ADDRESS}, ${PORTS.length} ports ` +
          '(13505, 18100-18210)',
      );
    }
  });
}

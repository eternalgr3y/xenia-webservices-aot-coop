// Drives the FESL responder through Hello -> (MemCheck) -> NuXBL360Login and
// prints every server->client packet, to verify the login handler before AoT runs.
const net = require('net');
const selfTestPort = Number.parseInt(
  process.env.AOT_FESL_SELFTEST_PORT || '18131',
  10,
);
if (
  !Number.isInteger(selfTestPort) ||
  selfTestPort < 1 ||
  selfTestPort > 65535
) {
  throw new Error('AOT_FESL_SELFTEST_PORT must be a valid TCP port');
}
const build = (c, t, n, p) => {
  const pb = Buffer.from(p, 'latin1');
  const h = Buffer.alloc(12);
  h.write(c, 0, 'latin1');
  h.writeUInt32BE((((t & 0xff) << 24) | (n & 0xffffff)) >>> 0, 4);
  h.writeUInt32BE(pb.length + 12, 8);
  return Buffer.concat([h, pb]);
};
const s = net.connect(selfTestPort, '127.0.0.1', () => {
  s.write(
    build(
      'fsys',
      0xc0,
      1,
      'TXN=Hello\nclientString=ao3-360\nclientPlatform=XBOX360\n\0',
    ),
  );
});
let sentLogin = false;
let observedLoginReply = false;
s.on('data', (d) => {
  let off = 0;
  while (off + 12 <= d.length) {
    const size = d.readUInt32BE(off + 8);
    if (size < 12 || off + size > d.length) break;
    const comp = d.toString('latin1', off, off + 4);
    const pl = d
      .toString('latin1', off + 12, off + size)
      .replace(/\0/g, '')
      .replace(/\n/g, ' | ');
    console.log(`<= [${comp}] ${pl}`);
    if (pl.includes('TXN=NuXBL360Login')) observedLoginReply = true;
    off += size;
  }
  if (!sentLogin) {
    sentLogin = true;
    setTimeout(() => {
      console.log('=> NuXBL360Login');
      s.write(
        build(
          'acct',
          0xc0,
          2,
          'TXN=NuXBL360Login\nxuid=0000000000000001\ngamertag=host-test\nmacAddr=$001122334455\nconsoleId=000000001\n\0',
        ),
      );
    }, 150);
  }
});
s.on('error', (e) => {
  console.error('ERR ' + e.message);
  process.exitCode = 1;
});
setTimeout(() => process.exit(observedLoginReply ? 0 : 1), 1500);

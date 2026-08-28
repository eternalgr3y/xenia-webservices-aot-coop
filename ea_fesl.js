// Minimal EA FESL responder for Army of Two: The 40th Day (Xbox 360).
// AoT speaks PLAINTEXT FESL on 127.0.0.1:18131. This answers the Hello handshake
// and logs every subsequent packet (login, matchmaking, theater) so we add
// handlers incrementally. The implementation is based on observed AoT traffic;
// its wire framing was cross-checked against public FESL community notes:
//   header[12] = component[4] | (type<<24|packetNum) BE | totalSize BE
//   type 0xC0 = client req, 0x80 = server reply ; payload = key=value\n... \0
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORTS = [
  ...new Set(
    (process.env.AOT_FESL_PORTS || '13505,18131,18275')
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10)),
  ),
];
if (PORTS.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
  throw new Error('AOT_FESL_PORTS must be a comma-separated list of TCP ports');
}
const BIND_ADDRESS = process.env.AOT_FESL_BIND_ADDRESS || '127.0.0.1';
if (!net.isIP(BIND_ADDRESS))
  throw new Error('AOT_FESL_BIND_ADDRESS must be a numeric IP');
if (
  BIND_ADDRESS !== '127.0.0.1' &&
  BIND_ADDRESS !== '::1' &&
  process.env.AOT_FESL_ALLOW_NON_LOOPBACK !== 'true'
) {
  throw new Error(
    'non-loopback FESL bind requires AOT_FESL_ALLOW_NON_LOOPBACK=true',
  );
}

const LOG = path.resolve(
  process.env.AOT_FESL_LOG || path.join(__dirname, 'ea_capture.log'),
);
fs.appendFileSync(
  LOG,
  `\n=== FESL responder (re)started ${new Date().toISOString()} ===\n`,
);
const log = (m) => {
  const l = `[${new Date().toISOString().substr(11, 12)}] ${m}\n`;
  fs.appendFileSync(LOG, l);
  process.stdout.write(l);
};

const parseKV = (s) => {
  const m = {};
  for (const line of s.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/\0/g, '');
  }
  return m;
};
const build = (component, type, num, map) => {
  const pl =
    Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n\0';
  const pb = Buffer.from(pl, 'latin1');
  const h = Buffer.alloc(12);
  h.write(component, 0, 'latin1');
  h.writeUInt32BE((((type & 0xff) << 24) | (num & 0xffffff)) >>> 0, 4);
  h.writeUInt32BE(pb.length + 12, 8);
  return Buffer.concat([h, pb]);
};
const send = (sock, port, component, type, num, map) => {
  const b = build(component, type, num, map);
  log(
    `SEND  :${port} [${component}] type=0x${type.toString(16)} num=${num} TXN=${map.TXN} (${b.length}b)`,
  );
  sock.write(b);
};

const sessions = {}; // lkey -> { gamertag, pid, xuid } from NuXBL360Login, used by theater USER
let nextGid = 1;
const games = {}; // gid -> created-game info from CGAM, for joiners (GLST/GDAT/EGAM) later
let nextPid = 100;
let nextSrvTid = 10000; // server-initiated theater transaction ids (kept clear of client tids)
const srvTid = () => nextSrvTid++;
function xnaddrIp(b64) {
  // decode the IPv4 from the first 4 bytes of a base64 XNADDR
  try {
    const b = Buffer.from(b64 || '', 'base64');
    if (b.length >= 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  } catch (e) {}
  return '127.0.0.1';
}

// ROBUST DETERMINISTIC PAIRING (2026-06-27): the configured host is canonical,
// and the joiner always joins that host regardless of CGAM order. The joiner
// cannot self-host unless the explicit fallback is enabled; its CGAM is held
// until the canonical host game exists, then routed into it.
// Identify the host by configured gamertag, with optional configured pid
// fallbacks. Machine/profile identifiers must stay outside source control.
const csvSet = (value) =>
  new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
const HOST_GTAGS = csvSet(process.env.AOT_HOST_GTAGS || 'host');
const HOST_PIDS = csvSet(process.env.AOT_HOST_PIDS || '');
const PARTICIPANT_NAMES = new Map(
  (process.env.AOT_FESL_PARTICIPANTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(':');
      if (separator < 1)
        throw new Error('AOT_FESL_PARTICIPANTS entries must be pid:name');
      return [item.slice(0, separator), item.slice(separator + 1) || 'player'];
    }),
);
const isHostPlayer = (sock) => {
  const s = sock._fesl || {};
  return HOST_GTAGS.has(s.gamertag) || HOST_PIDS.has(String(s.pid));
};
const findHostGame = () => {
  const gids = Object.keys(games).sort((a, b) => Number(b) - Number(a));
  for (const eg of gids) {
    const g = games[eg];
    if (g.isHostGame && g.hostSock && !g.hostSock.destroyed) return eg;
  }
  return null;
};
let pendingJoiner = null; // a joiner CGAM held until the host game exists
function mkGame(map, sock, isHostGame) {
  const gid = nextGid++;
  games[gid] = {
    lid: map.LID,
    name: map.NAME,
    intIp: map['INT-IP'],
    intPort: map['INT-PORT'],
    port: map.PORT,
    max: map['MAX-PLAYERS'],
    raw: map,
    hostSock: sock,
    hostUid: (sock._fesl || {}).pid || '0',
    ekey: 'AIBSgPFqRDg0TfdXW1zUyQ==',
    ugid: map.UGID && map.UGID.length ? map.UGID : 'AO3-' + gid,
    ticket: String(Math.floor(1000000000 + Math.random() * 9000000000)),
    players: [],
    pending: {},
    isHostGame: !!isHostGame,
  };
  return gid;
}
const cgamHostReply = (sock, port, num, map, gid) =>
  send(sock, port, 'CGAM', 0x00, num, {
    TID: map.TID || '0',
    'MAX-PLAYERS': map['MAX-PLAYERS'] || '2',
    EKEY: 'AIBSgPFqRDg0TfdXW1zUyQ==',
    UGID: map.UGID || 'AO3-' + gid,
    JOIN: 'O',
    SECRET: map.SECRET || 'S' + gid + 'ECRET',
    LID: map.LID || '257',
    J: '0',
    GID: String(gid),
  });
const cgamJoinReply = (sock, port, num, map, gid) => {
  const g = games[gid];
  send(sock, port, 'CGAM', 0x00, num, {
    TID: map.TID || '0',
    'MAX-PLAYERS': g.max || '2',
    EKEY: g.ekey,
    UGID: g.ugid,
    JOIN: 'O',
    SECRET: (g.raw && g.raw.SECRET) || 'S' + gid + 'ECRET',
    LID: map.LID || '257',
    J: '0',
    GID: String(gid),
  });
};

function handle(sock, port, component, type, num, map) {
  // Theater (matchmaking, :18200) messages are keyed by COMPONENT, not a TXN field.
  // Theater client packets use type 0x40; server replies use 0x00 (the 0x40
  // "from-client" bit cleared), echoing the transaction id TID.
  if (component === 'CONN') {
    // theater initial connect handshake
    // BUILD #10 RUN FIX (2026-06-12): activityTimeoutSecs=240 was SELF-INFLICTED
    // -- with zero theater traffic during the co-op level load, the client
    // honored exactly that and closed both EA connections at +240s, then threw
    // the in-game "lost your connection to the EA Servers" once the level
    // finished loading. One day instead.
    send(sock, port, 'CONN', 0x00, num, {
      TID: map.TID || '1',
      activityTimeoutSecs: '86400',
      PROT: map.PROT || '2',
      TIME: String(Math.floor(Date.now() / 1000)),
    });
    return;
  }
  if (component === 'USER') {
    // theater auth using the lkey issued at NuXBL360Login
    const sess = sessions[map.LKEY] || {};
    sock._fesl = sess; // remember who this theater connection belongs to
    send(sock, port, 'USER', 0x00, num, {
      NAME: sess.gamertag || map.NAME || 'player',
      TID: map.TID || '0',
    });
    return;
  }
  if (component === 'LLST') {
    // theater lobby list -> return one lobby to host games in
    send(sock, port, 'LLST', 0x00, num, {
      TID: map.TID || '0',
      'NUM-LOBBIES': '1',
    });
    send(sock, port, 'LDAT', 0x00, num, {
      TID: map.TID || '0',
      LID: '257',
      PASSING: '0',
      NAME: 'ao3lobby',
      LOCALE: 'en_US',
      MAXSIZE: '10000',
      FAVORITE: '0',
      'NUM-GAMES': '0',
    });
    return;
  }
  if (component === 'GLST') {
    // game list -> return active hosted games so a joiner can find them
    const list = Object.entries(games).filter(
      ([g, v]) => v.hostSock && !v.hostSock.destroyed,
    );
    log(`  >> GAME LIST request -> ${list.length} active game(s)`);
    send(sock, port, 'GLST', 0x00, num, {
      TID: map.TID || '0',
      LID: map.LID || '257',
      'LOBBY-NUM-GAMES': String(list.length),
      'NUM-GAMES': String(list.length),
    });
    for (const [gid, g] of list) {
      const attrs = {};
      for (const k in g.raw) {
        if (k.indexOf('B-') === 0) attrs[k] = g.raw[k];
      }
      send(
        sock,
        port,
        'GDAT',
        0x00,
        num,
        Object.assign(
          {
            TID: map.TID || '0',
            LID: map.LID || '257',
            GID: gid,
            HN: g.name || 'host',
            HU: g.hostUid || '0',
            N: g.name || 'host',
            I: g.intIp || '127.0.0.1',
            P: g.intPort || g.port || '1000',
            'INT-IP': g.intIp || '127.0.0.1',
            'INT-PORT': g.intPort || g.port || '1000',
            // Relay the host's Xbox-360 session id (and routing token) so the joiner can
            // XSessionJoinRemote the host's REAL session. Without XB360SESS the game looks
            // up bogus session id 0x7f -> 404 -> never joins -> host stays 1-member -> REASON=2.
            XB360SESS: (g.raw && g.raw['XB360SESS']) || '',
            RT: (g.raw && g.raw['RT']) || '',
            J: 'O',
            JP: '0',
            AP: '1',
            MP: g.max || '2',
            QP: '0',
            PL: 'XBOX360',
            TYPE: 'G',
            F: '0',
            NAT: '1',
          },
          attrs,
        ),
      );
    }
    return;
  }
  if (component === 'CGAM') {
    // create-game -> DETERMINISTIC role assignment (see helpers above)
    const who =
      (sock._fesl || {}).gamertag || 'pid' + ((sock._fesl || {}).pid || '?');
    if (isHostPlayer(sock)) {
      // The configured player is canonical. Drop its stale game, then create fresh.
      for (const eg of Object.keys(games)) {
        if (games[eg].hostSock === sock) {
          log(
            `  >> CGAM: dropping stale host game gid=${eg} (${who} re-hosting)`,
          );
          delete games[eg];
        }
      }
      const gid = mkGame(map, sock, true);
      log(
        `  >> CREATED canonical HOST game gid=${gid} host=${who} ${map['INT-IP']}:${map['INT-PORT']} map=${map['B-U-Map']}`,
      );
      for (const k of Object.keys(map)) {
        if (
          /SESS|XNKID|XNKEY|XNADDR|XUID|HKEY|RESERVE|HKEEP|SECRET|UGID|^JOIN$|^RT$|^J$/i.test(
            k,
          )
        )
          log(`     CGAM ${k}=${map[k]}`);
      }
      cgamHostReply(sock, port, num, map, gid);
      // If a joiner was holding, route it into this game now.
      if (
        pendingJoiner &&
        pendingJoiner.sock &&
        !pendingJoiner.sock.destroyed
      ) {
        const pj = pendingJoiner;
        pendingJoiner = null;
        log(`  >> fulfilling DEFERRED joiner ${pj.who} -> host gid=${gid}`);
        cgamJoinReply(pj.sock, pj.port, pj.num, pj.map, gid);
      }
      return;
    }
    // A joiner never self-hosts by default. Route it into the canonical game.
    const hostGid = findHostGame();
    if (hostGid) {
      log(
        `  >> MATCHMAKE: ${who} (joiner) -> canonical HOST gid=${hostGid} (no self-host)`,
      );
      cgamJoinReply(sock, port, num, map, hostGid);
      return;
    }
    // The host game is not up yet: hold this CGAM until the host creates it.
    log(`  >> ${who} (joiner) CGAM but NO host game yet -> DEFERRING reply`);
    pendingJoiner = { sock, port, num, map, who, t: Date.now() };
    if (process.env.AOT_ALLOW_JOINER_SELF_HOST === '1') {
      setTimeout(() => {
        if (pendingJoiner && pendingJoiner.sock === sock && !sock.destroyed) {
          pendingJoiner = null;
          const gid = mkGame(map, sock, false);
          log(`  >> joiner-DEFER TIMEOUT (30s) -> opt-in self-host gid=${gid}`);
          cgamHostReply(sock, port, num, map, gid);
        }
      }, 30000);
    }
    return;
  }
  if (component === 'ECNL') {
    // exit channel/game -> acknowledge
    send(sock, port, 'ECNL', 0x00, num, {
      TID: map.TID || '0',
      LID: map.LID || '0',
      GID: map.GID || '0',
    });
    return;
  }
  if (component === 'EGAM') {
    // enter game: host enters its own game, OR a joiner joins
    const gid = map.GID || '0';
    const g = games[gid];
    const isHost = !g || g.hostSock === sock;
    const myXnaddr = map['R-XNADDR'] || '';
    const myIp = xnaddrIp(myXnaddr);
    const myPort = map.PORT || '1000';
    if (g) g.players = g.players || [];
    if (isHost) {
      if (g)
        g.players[0] = {
          xnaddr: myXnaddr,
          ip: myIp,
          port: myPort,
          uid: (sock._fesl || {}).pid || '0',
          name: (sock._fesl || {}).gamertag || 'host',
          sock,
        };
      log(`  >> HOST entered gid=${gid} (${myIp}:${myPort})`);
      send(sock, port, 'EGAM', 0x00, num, {
        TID: map.TID || '0',
        LID: map.LID || '257',
        GID: gid,
        QPOS: '0',
        QLEN: '0',
      });
    } else {
      // JOINER: queue the player, send EGRQ to the host, and WAIT. Do NOT ack the
      // joiner or send EGEG yet -- those are deferred until the host's EGRS (matches
      // Arcadia/AoT theater flow; acking early made AoT discard the notice and bail).
      const pid = nextPid++;
      g.pending = g.pending || {};
      const joinerName = (sock._fesl || {}).gamertag || 'player';
      const joinerUid = (sock._fesl || {}).pid || '0';
      g.pending[pid] = {
        sock,
        egamTid: map.TID || '0',
        xnaddr: myXnaddr,
        ip: myIp,
        port: myPort,
        name: joinerName,
        uid: joinerUid,
      };
      g.players[1] = g.pending[pid];
      log(
        `  >> JOIN-REQ gid=${gid}: ${joinerName} (${myIp}:${myPort}) queued pid=${pid}; EGRQ->host, awaiting host EGRS`,
      );
      if (g.hostSock && !g.hostSock.destroyed) {
        const egrq = {
          'R-INT-IP': myIp,
          'R-INT-PORT': myPort,
          PORT: myPort,
          IP: myIp,
          'R-XNADDR': myXnaddr,
          NAME: joinerName,
          PTYPE: map.PTYPE || 'P',
          // AOT MEMBER-ID FIX (cont.114 addendum-34): this EGRQ (fesl->HOST) is the message the host
          // registrar 0x82333220 reads for its self-confirm id-compare (0x82333334). Build-B proved the
          // HOST-PENT was NOT that message (changing its UID left msgid=joinerUid); the EGRQ is the only
          // remaining host-directed msg carrying joinerUid, and its UID is what the host compares against its
          // OWN member id. So UID must be the host's own id; the joiner is still
          // identified by the R-* fields (R-XNADDR/R-XUID/R-UID) + PID, so the EGRS validation is intact.
          TICKET: g.ticket,
          PID: String(pid),
          UID: g.hostUid || '0',
          LID: map.LID || '257',
          GID: gid,
        };
        // Forward the joiner's R-U-* attributes (ChangeList/DLC/Mode/MaxPlayers/NAT/Private/XUID/
        // JOINASHOST...) so the host can validate compatibility. Without them the host denies the
        // join with EGRS ALLOWED=0 REASON=2.
        for (const k in map) {
          if (
            k.indexOf('R-') === 0 &&
            k !== 'R-INT-IP' &&
            k !== 'R-INT-PORT' &&
            k !== 'R-XNADDR'
          )
            egrq[k] = map[k];
        }
        // 360 host validates the joiner's Xbox identity: R-XUID/R-UID/R-USER (the theater
        // field table near REASON lists these). Arcadia (PC) never sends them -> AoT denies REASON=2.
        const jx = (sock._fesl || {}).xuid || map['R-U-XUID'] || joinerUid;
        egrq['R-XUID'] = jx;
        egrq['R-UID'] = joinerUid;
        egrq['R-USER'] = joinerName;
        log(
          `     EGRQ +R-XUID=${jx} R-USER=${joinerName}; attrs: ${Object.keys(
            egrq,
          )
            .filter((k) => k.indexOf('R-U-') === 0)
            .join(',')}`,
        );
        send(g.hostSock, port, 'EGRQ', 0x00, 0, egrq);
      }
    }
    return;
  }
  if (component === 'EGRS') {
    // host's response to our EGRQ -> NOW finish the join for the joiner
    const gid = map.GID || '0';
    const g = games[gid];
    // EXPERIMENT (EGRS-flip / soft-vs-hard-deny test): force ALLOWED=1 to the JOINER regardless
    // of the host's verdict, so the joiner PROCEEDS past the theater deny (REASON=2) into the P2P
    // stage instead of self-hosting. Reveals whether the host's deny is soft (still accepts a peer)
    // or hard. Revert -> const allowed = map.ALLOWED || '1';
    const hostVerdict = map.ALLOWED || '1';
    const allowed = '1';
    let pid = map.PID,
      j = null;
    if (g && g.pending) {
      if (pid && g.pending[pid]) j = g.pending[pid];
      else {
        const k = Object.keys(g.pending)[0];
        if (k) {
          pid = k;
          j = g.pending[k];
        }
      }
    }
    if (!g || !j) {
      log(`  >> EGRS gid=${gid} allowed=${allowed} but no pending joiner`);
      return;
    }
    const host = g.players[0] || {};
    log(
      `  >> [EGRS-FLIP] host verdict ALLOWED=${hostVerdict} REASON=${map.REASON || '-'} -> relaying ALLOWED=1 to ${j.name} (pid=${pid}, egamTid=${j.egamTid}); proceeding to EGEG`,
    );
    // 1) deferred EGAM response to the JOINER, using its ORIGINAL EGAM TID
    send(j.sock, port, 'EGAM', 0x00, 0, {
      TID: j.egamTid,
      LID: map.LID || '257',
      GID: gid,
      ALLOWED: allowed,
    });
    // 1b) AOT-JOIN-EGRQ-EARLY (gated AOT_JOIN_EGRQ=1): protocol-ordered registrar trigger.
    // cont.114 addendum-13 (Fable design, byte-verified): send the joiner's EGRQ BETWEEN the EGAM
    // ack above (which writes the matcher keys OUTER+0xc4/+0xc8 via EGAM-resp handler 0x8232cb68 —
    // verified: stw LID->+0xbc, GID->+0xc0, state=2->+0x14) and the EGEG below (which drives the
    // dial/connect-complete that advances the phase enum conn+0xb0 from 1 to 3/4 via wire-sync
    // 0x8232d4c0). At THIS point the keys already exist (matcher 0x82329d58 hits) AND the phase is
    // still 1 (ctor 0x8232ba30 init, no UDP roundtrip yet) -> registrar 0x82333220 takes the
    // WCHAIN2 (0x82333cd0) r5=1 "wire" road -> builder 0x82337878 -> CBINST 0x82338418 installs the
    // framer with the descriptor id, mirroring the HOST's proven mint-before-connect-complete order.
    // The OLD +2000ms timer send (now behind AOT_JOIN_EGRQ_LATE) landed AFTER connect-complete
    // (phase 3/4) -> registrar skipped WCHAIN2 (run 38: WCHAIN2/CBINST=0 on the joiner). No timer now: TCP
    // ordering + the guest's sequential theater pump guarantee EGAM-ack -> EGRQ -> EGEG order.
    if (process.env.AOT_JOIN_EGRQ === '1' && j.sock && !j.sock.destroyed) {
      send(j.sock, port, 'EGRQ', 0x00, 0, {
        'R-INT-IP': host.ip || g.intIp || '',
        'R-INT-PORT': host.port || g.intPort || '1000',
        PORT: host.port || g.intPort || '1000',
        IP: host.ip || g.intIp || '',
        'R-XNADDR': host.xnaddr || '',
        NAME: host.name || 'host',
        PTYPE: 'P',
        TICKET: g.ticket,
        PID: '1',
        UID: j.uid || '0', // MIRROR (addendum-52): joiner's own uid so its self-confirm equalizer 0x82333334 matches (mirror of the winning host EGRQ fix). Was host.uid.
        LID: map.LID || '257',
        GID: gid,
        'R-XUID': host.uid || g.hostUid || '0',
        'R-UID': host.uid || g.hostUid || '0',
        'R-USER': host.name || 'host',
      });
      log(
        `  >> [AOT-JOIN-EGRQ-EARLY] joiner EGRQ pushed to ${j.name} BEFORE EGEG: peer=host pid=1 gid=${gid} (protocol-ordered phase-1 window)`,
      );
    }
    // 2) EGEG (EnterGameNotice) to the JOINER: host address + shared ticket + ekey/ugid (no TID)
    send(j.sock, port, 'EGEG', 0x00, 0, {
      PL: 'XBOX360',
      TICKET: g.ticket,
      PID: String(pid),
      P: host.port || g.intPort || '1000',
      HUID: host.uid || g.hostUid || '0',
      'INT-PORT': host.port || g.intPort || '1000',
      EKEY: g.ekey,
      'INT-IP': host.ip || g.intIp || '127.0.0.1',
      UGID: g.ugid,
      I: host.ip || g.intIp || '127.0.0.1',
      'R-XNADDR': host.xnaddr || '',
      // host's real Xbox-360 session id so the joiner joins the host's session (not 0x7f)
      XB360SESS: (g.raw && g.raw['XB360SESS']) || '',
      LID: map.LID || '257',
      GID: gid,
    });
    log(
      `  >> EGEG relayed XB360SESS=${(g.raw && g.raw['XB360SESS']) || '(none)'} to ${j.name}`,
    );
    // HOST-PENT: push a server-initiated PENT to the host so its game code fires
    // the GM type-4 "player joined" dispatch (0x823455A8 -> member-ctor 0x82344f70),
    // populates its GM member list with the joiner, runs the establish state machine
    // (0x82345098 -> XNetXnAddrToInAddr -> XNetConnect toward the joiner), and
    // constructs the commudp accept module (container+0x2C4). Without this push
    // the host never calls member-ctor and conn+0x3d0 stays DEADBEEF, so every
    // incoming COd from the joiner is silently dropped.
    // Modeled on the EGRQ server-push (line 201): type=0x00, server-generated TID, no
    // client request. Fields mirror those already present in EGRQ + EGEG.
    // Gated AOT_HOST_PENT=1: cont.104 found the double
    // push (HOST-PENT + HOST-EGEG) mints TWO connect arcs/framers on the host;
    // the second arc's op-cancel then destroys the good framer (LINKID/proceed
    // teardown). Single push (HOST-EGEG only) = one arc, no dup.
    if (
      process.env.AOT_HOST_PENT === '1' &&
      g.hostSock &&
      !g.hostSock.destroyed
    ) {
      const pent = {
        GID: gid,
        LID: map.LID || '257',
        PID: String(pid),
        'R-XNADDR': j.xnaddr || '',
        'INT-IP': j.ip || '',
        'INT-PORT': j.port || '1000',
        IP: j.ip || '',
        PORT: j.port || '1000',
        NAME: j.name || '',
        // AOT MEMBER-ID FIX (2026-07-04, cont.114 addendum-32, byte-proven root): the game reads the
        // non-R- UID as the RECIPIENT's OWN identity (self-confirm), NOT the entering peer's. The host
        // registrar 0x82333220 compares this UID (msg +0x10) against the host's own GM local-member id
        // (game+0x30 = HOST pid) at 0x82333334; if they mismatch it SKIPS the F1==F2 write (+0x174/
        // +0x17c), the ripener 0x8232eb18 never advances state 4->7, and the host disconnects the joiner.
        // Measured mismatch: msgid(joiner uid) != memberid(host pid). So UID here must
        // be the HOST's own pid; the entering peer still rides R-XNADDR (=j.xnaddr) below.
        UID: host.uid || g.hostUid || '0',
        TICKET: g.ticket,
        PTYPE: 'P',
      };
      send(g.hostSock, port, 'PENT', 0x00, 0, pent);
      log(
        `  >> HOST-PENT pushed to ${host.name || 'host'}: joiner=${j.name} pid=${pid} xnaddr=${j.xnaddr} ip=${j.ip} [UID=host self-id ${host.uid || g.hostUid}]`,
      );
    }
    // EXPERIMENT (gated AOT_HOST_EGEG=1; OFF by default so it cannot disrupt the proven
    // pairing baseline): push a HOST-directed EGEG carrying the JOINER's address, mirroring
    // the joiner's EGEG (which carries the HOST's address and makes the joiner XNetConnect
    // it). Hypothesis (converged on by 2 independent RE agents 2026-06-22): this makes
    // the host's own connapi create+register a peer conn for the joiner, whose inbound COd then reaches
    // CCALL 0x82329F90 -> CCMPL 0x8232CEB8 -> type-4 -> member-ctor 0x82344F70 -> MADD. LOW
    // confidence (~15-20%) but cheap + the only untested theater push + no guest rebuild.
    if (
      process.env.AOT_HOST_EGEG === '1' &&
      g.hostSock &&
      !g.hostSock.destroyed
    ) {
      send(g.hostSock, port, 'EGEG', 0x00, 0, {
        PL: 'XBOX360',
        TICKET: g.ticket,
        PID: String(pid),
        P: j.port || '1000',
        HUID: j.uid || '0',
        'INT-PORT': j.port || '1000',
        EKEY: g.ekey,
        'INT-IP': j.ip || '',
        UGID: g.ugid,
        I: j.ip || '',
        'R-XNADDR': j.xnaddr || '',
        XB360SESS: (g.raw && g.raw['XB360SESS']) || '',
        LID: map.LID || '257',
        GID: gid,
      });
      log(
        `  >> [AOT-HOST-EGEG] host-directed EGEG pushed to ${host.name || 'host'}: peer=${j.name} xnaddr=${j.xnaddr} ip=${j.ip}`,
      );
    }
    // AOT-JOIN-PENT (gated AOT_JOIN_PENT=1): push a server-initiated
    // PENT to the JOINER describing the HOST — the joiner-side mirror of the HOST-PENT above.
    // Real EA theater sent a joining client a PENT for every player already in the game
    // (including the host). Root-caused 2026-07-02: without a peer-entered notification the
    // joiner NEVER runs its peer-channel registrar (fesl push -> PLVT txn -> named event
    // 0x82329e30 -> registrar 0x82333220 -> routing descriptor minted into mgr+0x18c), so
    // every inbound GM hello from the host arrives unattributed (msg[0]=-1) and is dropped
    // (null-member validator) -> the member ladder never starts -> no lobby. The HOST's
    // identical chain was live-measured end-to-end this session (NEVREG -> NEVMATCH ->
    // POOLPOP -> CBINST -> attributed RXHELLO -> MADD). The descriptor id == the peer's
    // theater PID (measured: pid 111/112 -> framer id 0x6F/0x70), so the host gets a stable
    // local pid of '1' (never collides with joiner pids ~111+).
    if (process.env.AOT_JOIN_PENT === '1' && j.sock && !j.sock.destroyed) {
      send(j.sock, port, 'PENT', 0x00, 0, {
        GID: gid,
        LID: map.LID || '257',
        PID: '1',
        'R-XNADDR': host.xnaddr || '',
        'INT-IP': host.ip || g.intIp || '',
        'INT-PORT': host.port || g.intPort || '1000',
        IP: host.ip || g.intIp || '',
        PORT: host.port || g.intPort || '1000',
        NAME: host.name || 'host',
        UID: host.uid || g.hostUid || '0',
        TICKET: g.ticket,
        PTYPE: 'P',
      });
      log(
        `  >> [AOT-JOIN-PENT] joiner-directed PENT pushed to ${j.name}: host pid=1 xnaddr=${host.xnaddr} ip=${host.ip || g.intIp}`,
      );
    }
    // AOT-JOIN-EGEG2 (gated AOT_JOIN_EGEG2=1): DELAYED second EGEG to
    // the JOINER carrying the HOST's address — the joiner-side mirror of AOT-HOST-EGEG above.
    // Root-caused 2026-07-02 (live, both rigs): an EGEG received while ALREADY in-session takes
    // the game's peer-entered road (starts a PLVT txn about the peer; the backend's PLVT ack
    // completion posts the named event 0x82329e30 -> peer-channel registrar 0x82333220 ->
    // routing descriptor). The joiner's ORIGINAL EGEG arrives pre-session and is consumed by
    // the join/dial road instead, so the registrar never runs on the joiner. Delay ~4s so the
    // joiner's dial/CCMPL has completed and it is in-session (mirrors the host's situation
    // when AOT-HOST-EGEG arrives). PID='1' = the host's stable local pid (see JOIN-PENT note).
    if (process.env.AOT_JOIN_EGEG2 === '1') {
      const egeg2 = {
        PL: 'XBOX360',
        TICKET: g.ticket,
        PID: '1',
        P: host.port || g.intPort || '1000',
        HUID: host.uid || g.hostUid || '0',
        'INT-PORT': host.port || g.intPort || '1000',
        EKEY: g.ekey,
        'INT-IP': host.ip || g.intIp || '',
        UGID: g.ugid,
        I: host.ip || g.intIp || '',
        'R-XNADDR': host.xnaddr || '',
        XB360SESS: (g.raw && g.raw['XB360SESS']) || '',
        LID: map.LID || '257',
        GID: gid,
      };
      setTimeout(() => {
        try {
          if (j.sock && !j.sock.destroyed) {
            send(j.sock, port, 'EGEG', 0x00, 0, egeg2);
            log(
              `  >> [AOT-JOIN-EGEG2] delayed joiner-directed EGEG pushed to ${j.name}: peer=host pid=1 ip=${host.ip || g.intIp}`,
            );
          }
        } catch (e) {
          log(`  >> [AOT-JOIN-EGEG2] send failed: ${e.message}`);
        }
      }, 4000);
    }
    // AOT-JOIN-EGRQ late fallback (gated AOT_JOIN_EGRQ_LATE=1): the DECISIVE joiner-side
    // descriptor-mint lever. cont.114 decode (3-agent workflow, live-verified in both processes):
    // the routing descriptor is minted ONLY by the theater FourCC 'EGRQ', whose client handler
    // 0x82329e30 -> matcher 0x82329d58 -> registrar 0x82333220 -> pool-pop 0x823474b0; the mint is
    // hostflag(mgr+0xba)-INDEPENDENT (the channel-BUILDER 0x82337528 is host-only, but the
    // registrar road is not). The backend currently sends EGRQ ONLY to the host (line ~211), which
    // is exactly why the joiner's registrar road is 100% dormant (run-31:
    // joiner NEVREG/NEVMATCH/POOLPOP all 0; host all 1). Fix: send the joiner
    // its own EGRQ describing the host as the entering peer. The matcher
    // keys on {LID (inert constant '257'), GID (the real shared session id)} compared against the joiner's
    // OWN conn cache (+0xc4/+0xc8), so GID MUST equal the shared gid AND this push MUST land AFTER
    // joiner's dial conn + GID cache exist (after its EGEG/EGEG2) -> delay > EGEG2's 4s. PID='1' = the
    // host's stable local pid (mirrors JOIN-PENT/EGEG2). The minted descriptor's id derives from
    // this event. Measure on the joiner: [AOT-NEVREG] (EGRQ reached the stub),
    // [AOT-FINDER]/[AOT-NEVMATCH] (matcher matched its conn on GID),
    // [AOT-POOLPOP] (descriptor minted), gob+0x18c head != 0,
    // [AOT-MLOOKUP] searchedId, [AOT-RXHELLO] r5 != 0.
    // DISABLED BY DEFAULT (cont.114 addendum-13): the late/timer EGRQ is superseded by the EARLY
    // protocol-ordered send at 1b) above. Kept behind AOT_JOIN_EGRQ_LATE=1 as a one-flip rollback to
    // the run-35 baseline. Do NOT run both: the pool-pop mint (0x823332a8) fires before the phase
    // dispatch, so a second EGRQ re-mints a same-key descriptor into gob+0x18c that nothing consumes
    // -> MLOOKUP can hijack to a null-transport duplicate -> the exact RXHELLO drop we are fixing.
    if (process.env.AOT_JOIN_EGRQ_LATE === '1' && j.sock && !j.sock.destroyed) {
      const jegrq = {
        'R-INT-IP': host.ip || g.intIp || '',
        'R-INT-PORT': host.port || g.intPort || '1000',
        PORT: host.port || g.intPort || '1000',
        IP: host.ip || g.intIp || '',
        'R-XNADDR': host.xnaddr || '',
        NAME: host.name || 'host',
        PTYPE: 'P',
        TICKET: g.ticket,
        PID: '1',
        UID: host.uid || g.hostUid || '0',
        LID: map.LID || '257',
        GID: gid,
        'R-XUID': host.uid || g.hostUid || '0',
        'R-UID': host.uid || g.hostUid || '0',
        'R-USER': host.name || 'host',
      };
      const egrqMs = parseInt(process.env.AOT_JOIN_EGRQ_MS || '5000', 10);
      setTimeout(() => {
        try {
          if (j.sock && !j.sock.destroyed) {
            send(j.sock, port, 'EGRQ', 0x00, 0, jegrq);
            log(
              `  >> [AOT-JOIN-EGRQ] joiner-directed EGRQ pushed to ${j.name}: peer=host pid=1 gid=${gid} ip=${host.ip || g.intIp} xnaddr=${host.xnaddr}`,
            );
          }
        } catch (e) {
          log(`  >> [AOT-JOIN-EGRQ] send failed: ${e.message}`);
        }
      }, egrqMs);
    }
    delete g.pending[pid];
    return;
  }
  if (component === 'PENT') {
    // player entered the game -> ack with the PID
    send(sock, port, 'PENT', 0x00, num, {
      PID: map.PID || '0',
      TID: map.TID || '0',
    });
    return;
  }
  if (component === 'PLVT') {
    // player-leave-vote / post-enter status txn. The game
    // fires this right after EGEG and waits ~10s for a reply; UNHANDLED -> the
    // joiner times out -> ECNL -> "lost connection to the EA Servers". ACK it
    // (echo TID + the game/player ids) so the transaction completes.
    log(
      `  >> PLVT gid=${map.GID} pid=${map.PID} tid=${map.TID} -- ACK (was UNHANDLED -> ~10s timeout)`,
    );
    send(sock, port, 'PLVT', 0x00, num, {
      TID: map.TID || '0',
      LID: map.LID || '257',
      GID: map.GID || '0',
      PID: map.PID || '0',
    });
    return;
  }
  if (component === 'RGAM') {
    // remove game -> acknowledge (and drop it from the store)
    if (map.GID && games[map.GID]) delete games[map.GID];
    send(sock, port, 'RGAM', 0x00, num, {
      TID: map.TID || '0',
      LID: map.LID || '0',
      GID: map.GID || '0',
    });
    return;
  }
  // --- HOST-OPEN announce handlers (paired with the game-side ctor patch v4) ---
  // Once the host's game opens (field_0xB0=1), AoT announces it to theater via
  // UBRA(bracket)/UGAM(update game)/UGDE(details). These were UNHANDLED -> no ACK
  // -> the host could stall. ACK them (echo TID), and mark the game joinable.
  if (component === 'UBRA') {
    // UpdateBracket: host batches game updates
    log(
      `  >> HOST UBRA START=${map.START} TID=${map.TID} -- host updating its game`,
    );
    send(sock, port, 'UBRA', 0x00, num, { TID: map.TID || '0' });
    return;
  }
  if (component === 'UGAM' || component === 'UGDE') {
    // the host-OPEN signal
    const g = games[map.GID];
    if (g) {
      g.canJoin = true;
      for (const k in map) {
        if (k.indexOf('B-') === 0 || k === 'JOIN') g.raw[k] = map[k];
      }
    }
    log(
      `  >> HOST ${component} gid=${map.GID} JOIN=${map.JOIN} -- GAME OPENED (host announced)`,
    );
    send(sock, port, component, 0x00, num, { TID: map.TID || '0' });
    return;
  }
  if (component === 'UGID' || component === 'QENT' || component === 'GDET') {
    // ack + log
    log(`  >> HOST ${component} keys: ${Object.keys(map).join(',')}`);
    send(sock, port, component, 0x00, num, { TID: map.TID || '0' });
    return;
  }
  if (map.TXN === 'Hello') {
    send(sock, port, component, 0x80, num, {
      TXN: 'Hello',
      'domainPartition.domain': 'eagames',
      'domainPartition.subDomain': 'ao3-360',
      curTime: '"Jun-06-2026 12%3a00%3a00 UTC"',
      // 2026-07-01: same SELF-INFLICTED activityTimeoutSecs bug as the Theater
      // CONN handler above (fixed 2026-06-12) -- this FESL Hello response was
      // never given the matching fix. '0' is read by the client as unspecified
      // and it falls back to a hardcoded ~240s idle-close, closing BOTH the
      // FESL and Theater sockets together once the player sits idle (e.g. at
      // CONNECTING) past that window -- confirmed live: the host connection
      // (port 18131/18200 pair) closed at exactly +240s despite the Theater
      // side already advertising 86400. Match the Theater fix here too.
      activityTimeoutSecs: '86400',
      messengerIp: '127.0.0.1',
      messengerPort: '13505',
      theaterIp: '127.0.0.1',
      theaterPort: '18200',
      addrType: '0',
    });
    // FESL server pushes a MemCheck (anti-cheat) right after Hello; the client
    // replies with a result and then proceeds to GetPingSites / login.
    const salt = Math.floor(Math.random() * 9000000000) + 1000000000;
    send(sock, port, 'fsys', 0x80, 0, {
      TXN: 'MemCheck',
      'memcheck.[]': '0',
      type: '0',
      salt: String(salt),
    });
  } else if (map.TXN === 'MemCheck') {
    log('  (client MemCheck result accepted - no reply needed)');
  } else if (map.TXN === 'GetPingSites') {
    // No ping sites required; minPingSitesToPing=0 lets the client skip pinging.
    send(sock, port, component, 0x80, num, {
      TXN: 'GetPingSites',
      'pingSite.[]': '0',
      minPingSitesToPing: '0',
    });
  } else if (map.TXN === 'NuXBL360Login') {
    // Xbox 360 Live login: identity-only (xuid/gamertag/mac), no password/ticket to validate.
    // Derive a stable, per-player numeric id from the xuid so two co-op players differ.
    const digits = (map.xuid || '').replace(/\D/g, '') || '1';
    let pid = '1000001';
    try {
      pid = (BigInt(digits) % 1000000000n).toString();
    } catch (e) {}
    const lkey = (pid + 'XBLLKEYabcdefghijklmnopqrstuvwxyz').slice(0, 27);
    sessions[lkey] = {
      gamertag: map.gamertag || 'player',
      pid: pid,
      xuid: digits,
    };
    send(sock, port, component, 0x80, num, {
      TXN: 'NuXBL360Login',
      lkey: lkey,
      profileId: pid,
      userId: pid,
      displayName: map.gamertag || 'player',
    });
  } else if (map.TXN === 'GetAssociations') {
    // Buddy/block lists (asso component) — return an empty list so AoT proceeds.
    // EXPERIMENT (associations-gate test): for RecentPartners, return the OTHER same-PC
    // co-op player as a mutual recent partner — the host's co-op admission (EGRS REASON=2)
    // may require the joiner to be a known associate. PlasmaBlock (block list) stays empty.
    // Revert -> set 'associations.[]':'0' unconditionally.
    const _ownerId = map['owner.id'] || '0';
    const _reqType = map.type || 'PlasmaBlock';
    const _r = {
      TXN: 'GetAssociations',
      'domainPartition.domain': map['domainPartition.domain'] || 'eagames',
      'domainPartition.subDomain':
        map['domainPartition.subDomain'] || 'ao3-360',
      'domainPartition.key': map['domainPartition.key'] || '',
      maxListSize: '100',
      type: _reqType,
      'owner.id': _ownerId,
      'owner.name': PARTICIPANT_NAMES.get(_ownerId) || 'player',
      'owner.type': map['owner.type'] || '1',
    };
    const _partnerId =
      _reqType === 'RecentPartners'
        ? [...PARTICIPANT_NAMES.keys()].find((id) => id !== _ownerId)
        : null;
    if (_partnerId) {
      _r['associations.[]'] = '1';
      _r['associations.0.id'] = _partnerId;
      _r['associations.0.type'] = '1';
      _r['associations.0.name'] = PARTICIPANT_NAMES.get(_partnerId) || 'player';
      _r['associations.0.created'] = '1262304000';
      _r['associations.0.modified'] = '1262304000';
      _r['associations.0.mutual'] = '1';
    } else {
      _r['associations.[]'] = '0';
    }
    send(sock, port, component, 0x80, num, _r);
  } else if (map.TXN === 'NuLookupUserInfo') {
    // Look up another player (acct) — return generic info so AoT proceeds.
    const lookXuid = map['userInfo.0.xuid'] || '0';
    let lid = '1000002';
    try {
      lid = (
        BigInt((lookXuid.match(/\d+/) || ['1'])[0]) % 1000000000n
      ).toString();
    } catch (e) {}
    send(sock, port, component, 0x80, num, {
      TXN: 'NuLookupUserInfo',
      'userInfo.[]': '1',
      'userInfo.0.userName': 'player' + lid,
      'userInfo.0.userId': lid,
      'userInfo.0.masterUserId': lid,
      'userInfo.0.xuid': lookXuid,
      'userInfo.0.namespace': 'ao3-360',
    });
  } else if (map.TXN === 'GetTelemetryToken') {
    send(sock, port, component, 0x80, num, {
      TXN: 'GetTelemetryToken',
      telemetryToken: 'AABBCCDDEEFF',
    });
  } else if (map.TXN === 'GetLockerURL') {
    send(sock, port, component, 0x80, num, {
      TXN: 'GetLockerURL',
      URL: 'http://127.0.0.1:36000/locker',
    });
  } else if (map.TXN === 'NuGetEntitlements') {
    // Online Pass / entitlement check — return empty for now (non-error); revisit if it blocks.
    // EXPERIMENT (entitlement-gate test): answer the EA Online Pass check (OFB-AO3X:18553)
    // as ACTIVE instead of empty, to test whether the host's co-op admission (EGRS REASON=2)
    // requires the Online Pass. Revert -> single reply { 'entitlements.[]': '0' }.
    const _pid = map.productId || 'OFB-AO3X:18553';
    send(sock, port, component, 0x80, num, {
      TXN: 'NuGetEntitlements',
      'entitlements.[]': '1',
      'entitlements.0.grantDate': '2010-01-01T00:00Z',
      'entitlements.0.terminationDate': '',
      'entitlements.0.groupName': 'AO3360',
      'entitlements.0.entitlementTag': 'ONLINE_ACCESS',
      'entitlements.0.entitlementId': '1',
      'entitlements.0.productId': _pid,
      'entitlements.0.status': 'ACTIVE',
      'entitlements.0.statusReasonCode': '',
      'entitlements.0.userId': '1000002',
      'entitlements.0.version': '0',
    });
  } else if (map.TXN === 'NuGrantEntitlement') {
    send(sock, port, component, 0x80, num, { TXN: 'NuGrantEntitlement' });
  } else if (map.TXN === 'PresenceSubscribe') {
    // Presence (pres) subscription — acknowledge.
    send(sock, port, component, 0x80, num, {
      TXN: 'PresenceSubscribe',
      'requests.[]': map['requests.[]'] || '0',
    });
  } else if (map.TXN === 'SetPresenceStatus') {
    send(sock, port, component, 0x80, num, { TXN: 'SetPresenceStatus' });
  } else if (map.TXN === 'Goodbye') {
    log('  (client sent Goodbye - gave up; see reason/ErrCode above)');
  } else {
    log(
      `  >> UNHANDLED [${component}] TXN=${map.TXN} -- capture & add handler next`,
    );
  }
}

for (const port of PORTS) {
  net
    .createServer((sock) => {
      const peer = `${sock.remoteAddress}:${sock.remotePort}`;
      log(`CONNECT :${port} <- ${peer}`);
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 12) {
          const size = buf.readUInt32BE(8);
          if (size < 12 || size > 200000) {
            log(
              `  bad size ${size} :${port} raw=${buf.slice(0, 16).toString('hex')}`,
            );
            buf = Buffer.alloc(0);
            break;
          }
          if (buf.length < size) break;
          const pkt = buf.slice(0, size);
          buf = buf.slice(size);
          const component = pkt.toString('latin1', 0, 4);
          const tn = pkt.readUInt32BE(4);
          const type = (tn >>> 24) & 0xff;
          const num = tn & 0xffffff;
          const payload = pkt.toString('latin1', 12, size);
          const map = parseKV(payload);
          log(
            `RECV  :${port} [${component}] type=0x${type.toString(16)} num=${num} TXN=${map.TXN || '?'}`,
          );
          log(
            `  payload: ${payload.replace(/\0/g, '').replace(/\n/g, ' | ').slice(0, 400)}`,
          );
          try {
            handle(sock, port, component, type, num, map);
          } catch (e) {
            log(`  handler err: ${e.message}`);
          }
        }
      });
      sock.on('error', (e) => log(`ERR  :${port} ${e.message}`));
      sock.on('close', () => log(`CLOSE :${port} <- ${peer}`));
    })
    .listen(port, BIND_ADDRESS, () => {})
    .on('error', (e) => log(`LISTEN-ERR :${port} ${e.message}`));
}
log(`ready - FESL responder on ${BIND_ADDRESS} ports ${PORTS.join(',')}`);

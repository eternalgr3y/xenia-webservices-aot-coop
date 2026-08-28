![hero](hero.jpg)

# Xenia Web Services

This is a Web API designed to support the Xenia Xbox 360 emulator in providing Online and Multiplayer functionality. A fork [Xenia Canary Netplay](https://github.com/AdrianCassar/xenia-canary) has been created for use with this Web API.
It has been designed and developed specifically for Xenia, and does not represent or resemble any first-party Xbox API.

If you'd like to help improve this project, you may report issues or contribute by submitting PRs.

## Army of Two: The 40th Day experimental compatibility fork

This branch adds title-scoped, same-PC compatibility work for _Army of Two:
The 40th Day_ (`454108D8`). It is a source alpha intended for local research
and testing with two Xenia instances. It is not a hosted replacement for Xbox
Live or EA services, and it is not a standalone player kit.

The fork adds:

- loopback-only XWS and local FESL binding by default, with explicit opt-in
  required for any non-loopback listener;
- title server, service, and port metadata for `454108D8`;
- player lookup by XUID, MAC address, or synthetic host address;
- an AoT-scoped session-search compatibility fallback and an explicit helper
  for clearing only stale `454108D8` sessions; and
- a minimal FESL/Theater compatibility responder implemented from observed
  traffic. Its 12-byte frame layout was cross-checked against the public
  [Open Heroes FESL protocol notes](https://pkg.go.dev/github.com/abarichello/bfheroesFesl#readme-fesl-protocol).

Keep this fork local unless you deliberately configure otherwise. Diagnostic
and capture logs may contain gamertags, XUIDs, synthetic addresses, session
identifiers, and protocol payloads; do not publish those logs. The
`clear_aot_sessions.js` helper deletes AoT sessions from the database selected
by `MONGO_URI`, so run it only against the intended local database and only
when no game is using those sessions.

This source alpha is not hardened for internet deployment. Review the current
dependency audit and application threat model before enabling any non-loopback
listener; the explicit opt-in flags are safeguards, not a security guarantee.

The matching launcher, setup checks, and exact component pins live in
[aot-40th-day-same-pc-coop](https://github.com/eternalgr3y/aot-40th-day-same-pc-coop).

Players must provide their own legally obtained game dump. This repository
contains no game executable, game assets, console keys, EA credentials, or EA
server source code. The compatibility work is independent and is not
affiliated with or endorsed by Electronic Arts, Visceral Games, Microsoft, or
the upstream Xenia project.

This fork is based on
[AdrianCassar/Xenia-WebServices](https://github.com/AdrianCassar/Xenia-WebServices),
which is itself a fork of DelxHQ/Xenia-WebServices. The upstream copyright and
MIT license are retained in `LICENSE`; the AoT compatibility additions were
developed by eternalgr3y and contributors under the same license.

## Project architecture

This project uses [NestJS](https://nestjs.com/) a Node.js framework using Typescript which follows the [CQRS](https://docs.nestjs.com/recipes/cqrs) model. In addition, [MongoDB](https://www.mongodb.com/) a document-oriented database (NoSQL database).

## Project Setup

1. Install [NodeJS](https://nodejs.org/).

2. Install MongoDB Community Server locally, details below. Compass is
   optional.

3. Copy the provided [.env.template](/.env.template) and rename it to `.env`.

4. Configure the `.env` file if needed.

5. Install from the committed lockfile with `npm ci`, then build with
   `npm run build`.

6. Start it through the matching AoT launcher, or use `npm start` for isolated
   backend development, and verify the frontend only at
   http://127.0.0.1:36000/.

### MongoDB

Install [MongoDB Community Server](https://www.mongodb.com/try/download/community)
as a local Windows service and keep it bound to loopback. MongoDB Compass may
be used as a local management UI, but it is not required by the service.

Do not point this alpha at MongoDB Atlas or another remote database. The
supported same-PC configuration is a loopback-only XWS listener and a
loopback-only MongoDB listener.

## Deployment boundary

The AoT compatibility fork is supported only as a local loopback service. The
upstream project's public-hosting suggestions do not apply to this alpha. Do
not expose its HTTP, FESL, Theater, or MongoDB listeners to the internet.

## Adding Title Support

<details>
  <summary>Expand for details</summary>

If you would like to add a title to this API, check out the `titles` folder for examples!

Titles can provide a 'title server' address, which is basically an IP address the game will try to connect to and use as a game-server. Not all games use the 'title server' system.

Titles can also provide 'port mappings', wherein you can reroute game ports for title servers or player communication. We recommend using ports 3600X for players and 3601X for title servers. If a title uses a random port, this can be captured as port 0, and mapped accordingly.

Port mappings are not a requirement it's an optional feature. It may be useful to map ports which conflict with Windows or Linux. Some titles may fail to work if ports are changed for example Source Engine games.

To find the ports the title opens you can use [cports](https://www.nirsoft.net/utils/cports.html) and filter by process or you can search through `xenia.log` with `logging = true`.

Titles must provide leaderboard configuration to push statistics to the API. This is more complicated and takes trial and error. I'd recommend self-hosting the API to debug this.

Finally, you can also throw any title-specific netplay related patches in the `patches` folder!

</details>

import Player from '../aggregates/Player';
import IpAddress from '../value-objects/IpAddress';
import Xuid from '../value-objects/Xuid';
import Gamertag from 'src/domain/value-objects/Gamertag';
import MacAddress from '../value-objects/MacAddress';

export default interface IPlayerRepository {
  findByXuid: (xuid: Xuid) => Promise<Player | undefined>;
  findByXuids: (xuid: Xuid[]) => Promise<Player[] | undefined>;
  findByAddress: (hostAddress: IpAddress) => Promise<Player | undefined>;
  findByMac: (mac: MacAddress) => Promise<Player | undefined>;
  findByGamertag: (gamertag: Gamertag) => Promise<Player | undefined>;
  save: (player: Player) => Promise<Player>;
  DeleteAllMyProfilesByAddress: (hostAddress: IpAddress) => Promise<Player[]>;
}

export const IPlayerRepositorySymbol = Symbol('IPlayerRepository');

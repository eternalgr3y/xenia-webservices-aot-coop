import IpAddress from 'src/domain/value-objects/IpAddress';
import MacAddress from 'src/domain/value-objects/MacAddress';
import Xuid from 'src/domain/value-objects/Xuid';

export class FindPlayerQuery {
  constructor(
    public readonly hostAddress?: IpAddress,
    public readonly macAddress?: MacAddress,
    public readonly xuid?: Xuid,
  ) {}
}

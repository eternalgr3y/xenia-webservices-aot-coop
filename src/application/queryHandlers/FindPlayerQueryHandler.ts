import { Inject } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import IPlayerRepository, {
  IPlayerRepositorySymbol,
} from 'src/domain/repositories/IPlayerRepository';
import { FindPlayerQuery } from '../queries/FindPlayerQuery';

@QueryHandler(FindPlayerQuery)
export class FindPlayerQueryHandler implements IQueryHandler<FindPlayerQuery> {
  constructor(
    @Inject(IPlayerRepositorySymbol)
    private repository: IPlayerRepository,
  ) {}

  async execute(query: FindPlayerQuery) {
    if (query.xuid) {
      return this.repository.findByXuid(query.xuid);
    }
    if (query.macAddress) {
      return this.repository.findByMac(query.macAddress);
    }
    return this.repository.findByAddress(query.hostAddress);
  }
}

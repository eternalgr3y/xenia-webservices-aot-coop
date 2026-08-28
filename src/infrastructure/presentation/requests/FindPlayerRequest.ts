import { ApiProperty } from '@nestjs/swagger';

export class FindPlayerRequest {
  @ApiProperty()
  hostAddress?: string;
  @ApiProperty()
  macAddress?: string;
  @ApiProperty()
  xuid?: string;
}

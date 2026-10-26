import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status: 'ok';

  @ApiProperty({ example: 'development' })
  environment: string;

  @ApiProperty({ example: 1234, description: 'Seconds since the process started' })
  uptimeSeconds: number;

  @ApiProperty({ example: '2026-10-18T09:30:00.000Z' })
  timestamp: string;
}

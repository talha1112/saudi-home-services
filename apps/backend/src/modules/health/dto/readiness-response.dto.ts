import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type DependencyState = 'up' | 'down';

export class ReadinessChecksDto {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database: DependencyState;

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  redis: DependencyState;
}

export class ReadinessResponseDto {
  @ApiProperty({ enum: ['ok', 'degraded'], example: 'ok' })
  status: 'ok' | 'degraded';

  @ApiProperty({ type: ReadinessChecksDto })
  checks: ReadinessChecksDto;

  @ApiPropertyOptional({
    enum: ['starting', 'running', 'degraded', 'stopped'],
    description: 'Background job workers (only present when they are enabled). Informational: does not change `status`.',
  })
  jobs?: string;

  @ApiProperty({ example: '2026-10-22T09:30:00.000Z' })
  timestamp: string;
}

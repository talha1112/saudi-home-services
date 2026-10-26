import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { HealthService } from './health.service.js';
import { HealthResponseDto } from './dto/health-response.dto.js';
import { ReadinessResponseDto } from './dto/readiness-response.dto.js';

@ApiTags('Health')
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check', description: 'Returns 200 while the process is able to serve requests.' })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return this.health.check();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check',
    description: 'Verifies PostgreSQL and Redis. Returns 503 when any dependency is unreachable.',
  })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiResponse({ status: 503, type: ReadinessResponseDto, description: 'A dependency is down' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponseDto> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}

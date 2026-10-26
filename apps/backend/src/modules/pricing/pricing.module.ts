import { Body, Controller, Get, HttpCode, HttpStatus, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { Role } from '../../generated/prisma/client.js';
import { AuthModule } from '../auth/auth.module.js';
import { CreatePricingSettingDto, PagedPricingSettingsDto, PricingSettingDto } from './dto/pricing.dto.js';
import { PricingService } from './pricing.service.js';

@ApiTags('Admin pricing')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/pricing-settings', version: '1' })
export class AdminPricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  @ApiOperation({ summary: 'History of pricing settings (newest first)' })
  @ApiOkResponse({ type: PagedPricingSettingsDto })
  list(@Query() query: PageQueryDto) {
    return this.pricing.list(query);
  }

  @Get('current')
  @ApiOperation({ summary: 'The setting that applies to new quotes right now' })
  @ApiOkResponse({ type: PricingSettingDto })
  current() {
    return this.pricing.currentDto();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Publish a new pricing version (VAT, commission, minimum service charge)',
    description: 'Applies to quotes created from `effectiveFrom`; existing quotes and bookings keep their rates. Amounts are integers: halalas and basis points.',
  })
  @ApiCreatedResponse({ type: PricingSettingDto })
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreatePricingSettingDto) {
    return this.pricing.create(dto, admin.id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AdminPricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}

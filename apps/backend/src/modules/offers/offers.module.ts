import { Body, Controller, Get, HttpCode, HttpStatus, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminListOffersQueryDto, CreateOfferDto, ListOffersQueryDto, UpdateOfferDto } from './offers.dto.js';
import { OffersService } from './offers.service.js';

const uuid = () => new ParseUUIDPipe();

@ApiTags('Admin offers')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/offers', version: '1' })
export class AdminOffersController {
  constructor(private readonly offers: OffersService) {}

  @Post()
  @ApiOperation({ summary: 'Create an offer (draft). Announcement only: no discount or redemption data exists.' })
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateOfferDto) {
    return this.offers.create(admin, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List offers (every status), newest first' })
  list(@Query() q: AdminListOffersQueryDto) {
    return this.offers.adminList(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One offer with its audit history' })
  get(@Param('id', uuid()) id: string) {
    return this.offers.adminGet(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a DRAFT or PAUSED offer' })
  update(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: UpdateOfferDto) {
    return this.offers.update(admin, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish (or resume) an offer. It is visible only inside its start/end window.' })
  publish(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.offers.transition(admin, id, 'publish');
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide a published offer immediately' })
  pause(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.offers.transition(admin, id, 'pause');
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire an offer for good' })
  archive(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.offers.transition(admin, id, 'archive');
  }
}

@ApiTags('Offers')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'offers', version: '1' })
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @ApiOperation({
    summary: 'Offers I can see right now',
    description: 'Customers see customer offers; workers see worker offers that match the cities and services they serve. Text is returned in my language with a deterministic fallback. Read-only: offers cannot be redeemed.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListOffersQueryDto) {
    return this.offers.listEligible(user, q);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AdminOffersController, OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { ReviewStatus, Role } from '../../generated/prisma/client.js';
import { clientMeta } from '../auth/auth.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ReviewsService } from './reviews.service.js';

const uuid = () => new ParseUUIDPipe();
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SubmitReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @Type(() => Number) @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
}

export class ModerateReviewDto {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AdminReviewsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ReviewStatus }) @IsOptional() @IsEnum(ReviewStatus) status?: ReviewStatus;
  @ApiPropertyOptional({ description: 'Worker profile id' }) @IsOptional() @IsUUID() workerProfileId?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 5 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'At most this many stars' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) maxRating?: number;
  @ApiPropertyOptional({ description: 'Only reviews of bookings in this city' }) @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional({ description: 'Search: comment text, customer, worker or booking reference' }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(60) q?: string;
}

@ApiTags('Reviews')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Roles(Role.CUSTOMER)
  @Post('bookings/:bookingId/review')
  @RateLimit({ name: 'review-submit', limit: 30, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Review the worker of one of my COMPLETED bookings (once, not editable)' })
  submit(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string, @Body() dto: SubmitReviewDto) {
    return this.reviews.submit(user, bookingId, dto);
  }

  @Roles(Role.CUSTOMER)
  @Get('bookings/:bookingId/review')
  @ApiOperation({ summary: 'My review of this booking' })
  mine(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string) {
    return this.reviews.mine(user, bookingId);
  }

  @Roles(Role.CUSTOMER)
  @Delete('bookings/:bookingId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my review (final: it stops counting and cannot be resubmitted)' })
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string) {
    return this.reviews.withdraw(user, bookingId);
  }

  @Roles(Role.CUSTOMER)
  @Get('reviews/workers/:workerId')
  @ApiOperation({ summary: 'Published reviews and the rating summary of an approved worker (no customer identities)' })
  forWorker(@Param('workerId', uuid()) workerId: string, @Query() q: PageQueryDto) {
    return this.reviews.forWorker(workerId, q);
  }

  @Roles(Role.WORKER)
  @Get('reviews/received')
  @ApiOperation({ summary: 'My own published reviews and rating summary (no customer identities)' })
  received(@CurrentUser() user: AuthenticatedUser, @Query() q: PageQueryDto) {
    return this.reviews.receivedByMe(user, q);
  }
}

@ApiTags('Admin reviews')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/reviews', version: '1' })
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'All reviews (filters: status, workerProfileId, rating, created range)' })
  list(@Query() q: AdminReviewsQueryDto) {
    return this.reviews.adminList(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One review with its full moderation history' })
  get(@Param('id', uuid()) id: string) {
    return this.reviews.adminGet(id);
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'admin-review-moderation', limit: 120, windowSeconds: 600 })
  @ApiOperation({ summary: 'Hide a published review (reversible; excluded from ratings). A reason is required. Reviews can never be edited or created by an administrator.' })
  hide(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: ModerateReviewDto, @Req() req: Request) {
    return this.reviews.moderate(admin, id, 'hide', dto.reason, clientMeta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'admin-review-moderation', limit: 120, windowSeconds: 600 })
  @ApiOperation({ summary: 'Publish a hidden review again (a withdrawn review stays withdrawn)' })
  restore(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: ModerateReviewDto, @Req() req: Request) {
    return this.reviews.moderate(admin, id, 'restore', dto.reason, clientMeta(req));
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ReviewsController, AdminReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}

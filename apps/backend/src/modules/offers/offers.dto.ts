import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsISO8601, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { OfferAudience, OfferStatus } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Fields an administrator can set. Text may be given in Arabic, English or both; at least one title is required. */
export class CreateOfferDto {
  @ApiProperty({ enum: OfferAudience, description: 'Who may see it. CUSTOMERS, WORKERS or ALL signed-in people.' })
  @IsEnum(OfferAudience)
  audience!: OfferAudience;

  @ApiPropertyOptional({ maxLength: 150 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(150) titleAr?: string;
  @ApiPropertyOptional({ maxLength: 150 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(150) titleEn?: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) descriptionAr?: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) descriptionEn?: string;
  @ApiPropertyOptional({ maxLength: 2000, description: 'Terms shown with the offer (text only; no pricing logic is derived from it).' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) termsAr?: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) termsEn?: string;

  @ApiProperty({ example: '2026-11-01T00:00:00.000Z' }) @IsISO8601({ strict: true }) startsAt!: string;
  @ApiProperty({ example: '2026-11-30T23:59:59.000Z' }) @IsISO8601({ strict: true }) endsAt!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only for this city' }) @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Only for this service' }) @IsOptional() @IsUUID() serviceId?: string;
}

/** Same fields, all optional. Send `null` for cityId/serviceId (or an empty string for text) to clear it. */
export class UpdateOfferDto {
  @ApiPropertyOptional({ enum: OfferAudience }) @IsOptional() @IsEnum(OfferAudience) audience?: OfferAudience;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(150) titleAr?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(150) titleEn?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) descriptionAr?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) descriptionEn?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) termsAr?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) termsEn?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) endsAt?: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @IsUUID() cityId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @IsUUID() serviceId?: string | null;
}

export class AdminListOffersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SCHEDULED', 'EXPIRED'], description: 'Published offers that are showing now, start later, or have ended' }) @IsOptional() @IsIn(['ACTIVE', 'SCHEDULED', 'EXPIRED']) phase?: 'ACTIVE' | 'SCHEDULED' | 'EXPIRED';
  @ApiPropertyOptional({ description: 'Search: title in either language' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: OfferStatus }) @IsOptional() @IsEnum(OfferStatus) status?: OfferStatus;
  @ApiPropertyOptional({ enum: OfferAudience }) @IsOptional() @IsEnum(OfferAudience) audience?: OfferAudience;
}

export class ListOffersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Narrow to offers for this city (offers with no city restriction still match)' })
  @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Narrow to offers for this service (offers with no service restriction still match)' })
  @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional({ enum: ['ar', 'en'], description: 'Render in this language instead of the account preference' })
  @IsOptional() @IsIn(['ar', 'en', 'AR', 'EN']) locale?: string;
}

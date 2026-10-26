import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PageMetaDto } from '../../../common/pagination/pagination.js';

export class PricingSettingDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Basis points of the service price: 1500 = 15%' }) vatRateBps: number;
  @ApiProperty({ description: 'Basis points of the service price, deducted from the worker' }) commissionRateBps: number;
  @ApiProperty({ description: 'Halalas (100 = SAR 1)' }) minServiceChargeHalalas: number;
  @ApiProperty({ description: 'True for placeholder values the business has not confirmed' }) isProvisional: boolean;
  @ApiProperty({ nullable: true }) note: string | null;
  @ApiProperty() effectiveFrom: string;
  @ApiProperty() createdAt: string;
}

export class PagedPricingSettingsDto {
  @ApiProperty({ type: [PricingSettingDto] }) items: PricingSettingDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class CreatePricingSettingDto {
  @ApiProperty({ example: 1500, description: 'VAT in basis points (0-5000)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  vatRateBps: number;

  @ApiProperty({ example: 1500, description: 'Platform commission in basis points (0-5000)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  commissionRateBps: number;

  @ApiProperty({ example: 5000, description: 'Minimum service price before VAT, in halalas' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minServiceChargeHalalas: number;

  @ApiPropertyOptional({ description: 'When it starts to apply to NEW quotes. Defaults to now; may not be in the past.' })
  @IsOptional()
  @IsDateString({ strict: true })
  effectiveFrom?: string;

  @ApiPropertyOptional({ description: 'Why the change was made (e.g. the decision it implements)' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  note?: string;
}

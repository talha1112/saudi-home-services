import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { ActiveFilterDto, PageMetaDto } from '../../../common/pagination/pagination.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : trim({ value }));

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugRule = { message: 'slug must be lowercase letters, digits and single hyphens' };

// ------------------------------------------------------------------ responses

export class CityDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty() sortOrder: number;
}

export class ServiceDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryId: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
  @ApiProperty({ nullable: true }) descriptionEn: string | null;
  @ApiProperty({ nullable: true }) descriptionAr: string | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty() sortOrder: number;
}

export class ServiceCategoryDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
  @ApiProperty({ nullable: true }) descriptionEn: string | null;
  @ApiProperty({ nullable: true }) descriptionAr: string | null;
  @ApiProperty({ nullable: true }) iconKey: string | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty() sortOrder: number;
}

export class CategoryWithServicesDto extends ServiceCategoryDto {
  @ApiProperty({ type: [ServiceDto] }) services: ServiceDto[];
}

export class CatalogDto {
  @ApiProperty({ type: [CategoryWithServicesDto] }) categories: CategoryWithServicesDto[];
}

export class CityListDto {
  @ApiProperty({ type: [CityDto] }) items: CityDto[];
}

export class PagedCitiesDto {
  @ApiProperty({ type: [CityDto] }) items: CityDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class PagedCategoriesDto {
  @ApiProperty({ type: [ServiceCategoryDto] }) items: ServiceCategoryDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class PagedServicesDto {
  @ApiProperty({ type: [ServiceDto] }) items: ServiceDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

// -------------------------------------------------------------------- queries

export class ListCitiesQueryDto extends ActiveFilterDto {
  @ApiPropertyOptional({ description: 'Matches slug or either name' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ListCategoriesQueryDto extends ListCitiesQueryDto {}

export class ListServicesQueryDto extends ListCitiesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

// ---------------------------------------------------------------------- writes

export class CreateCityDto {
  @ApiProperty({ example: 'riyadh' })
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  @Matches(SLUG_PATTERN, slugRule)
  slug: string;

  @ApiProperty({ example: 'Riyadh' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nameEn: string;

  @ApiProperty({ example: 'الرياض' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nameAr: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}

/** All fields optional; the slug is immutable so links and integrations stay stable. */
export class UpdateCityDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}

export class CreateCategoryDto extends CreateCityDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Key of a bundled app icon, e.g. "bolt"' })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9_-]+$/, { message: 'iconKey may only contain lowercase letters, digits, - and _' })
  iconKey?: string | null;
}

export class UpdateCategoryDto extends UpdateCityDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9_-]+$/, { message: 'iconKey may only contain lowercase letters, digits, - and _' })
  iconKey?: string | null;
}

export class CreateServiceDto {
  @ApiProperty()
  @IsUUID()
  categoryId: string;

  @ApiProperty({ example: 'ac-repair' })
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  @Matches(SLUG_PATTERN, slugRule)
  slug: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nameEn: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nameAr: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}

export class UpdateServiceDto {
  @ApiPropertyOptional({ description: 'Move the service to another category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}

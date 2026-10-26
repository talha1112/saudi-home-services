import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PageMetaDto, PageQueryDto, toOptionalBoolean } from '../../../common/pagination/pagination.js';

export class DiscoverWorkersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only workers serving this city' })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Only workers offering this service' })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Only workers offering a service in this category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Only workers who are online now' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  onlineOnly?: boolean;
}

class PublicServiceDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryId: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
}

class PublicCityDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
}

/**
 * What customers may see about a worker. Deliberately has no phone, email, user id,
 * documents, verification notes or history.
 */
export class PublicWorkerDto {
  @ApiProperty({ description: 'Worker profile id (not the account id)' }) id: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiProperty({ nullable: true }) bio: string | null;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
  @ApiProperty() isOnline: boolean;
  @ApiProperty({ type: [PublicServiceDto] }) services: PublicServiceDto[];
  @ApiProperty({ type: [PublicCityDto] }) cities: PublicCityDto[];
}

export class PagedPublicWorkersDto {
  @ApiProperty({ type: [PublicWorkerDto] }) items: PublicWorkerDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

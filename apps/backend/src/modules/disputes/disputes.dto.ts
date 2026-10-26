import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { DisputeCategory, DisputeFinancialFollowup, DisputeStatus } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const MAX_EVIDENCE = 10;

export class EvidenceRefsDto {
  @ApiPropertyOptional({ type: [String], description: 'Ids of photos already uploaded to THIS booking. Files are referenced, never copied.' })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_EVIDENCE) @IsUUID('all', { each: true })
  bookingPhotoIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Ids of chat messages of THIS booking' })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_EVIDENCE) @IsUUID('all', { each: true })
  chatMessageIds?: string[];
}

export class OpenDisputeDto extends EvidenceRefsDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookingId!: string;
  @ApiProperty({ enum: DisputeCategory }) @IsEnum(DisputeCategory) category!: DisputeCategory;
  @ApiProperty({ minLength: 10, maxLength: 2000 }) @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000) description!: string;
}

export class DisputeTextDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000) text!: string;
}

export class ListMyDisputesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus }) @IsOptional() @IsEnum(DisputeStatus) status?: DisputeStatus;
}

export class AdminListDisputesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Search: booking reference, customer, worker or opener name, service name' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: DisputeStatus, isArray: true, description: 'One status or several, comma-separated' }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : value)) @IsEnum(DisputeStatus, { each: true }) status?: DisputeStatus[];
  @ApiPropertyOptional({ enum: DisputeCategory }) @IsOptional() @IsEnum(DisputeCategory) category?: DisputeCategory;
  @ApiPropertyOptional({ description: 'Only disputes about bookings in this city' }) @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() bookingId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() openedById?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignedAdminId?: string;
  @ApiPropertyOptional({ enum: DisputeFinancialFollowup }) @IsOptional() @IsEnum(DisputeFinancialFollowup) financialFollowup?: DisputeFinancialFollowup;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class AssignDisputeDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'An active administrator. Omit to assign yourself.' }) @IsOptional() @IsUUID() adminId?: string;
}

export class AdminNoteDto {
  @ApiProperty({ minLength: 3, maxLength: 2000 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) note!: string;
}

export class ResolveDisputeDto {
  @ApiProperty({ description: 'What the participants are told. Required.', minLength: 10, maxLength: 2000 })
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000) summary!: string;

  @ApiPropertyOptional({ description: 'Visible to administrators only.', maxLength: 2000 })
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) internalNote?: string;

  @ApiPropertyOptional({ enum: DisputeFinancialFollowup, description: 'REQUESTED only FLAGS a money follow-up for a separate approved workflow. Nothing is refunded, reversed or compensated.' })
  @IsOptional() @IsEnum(DisputeFinancialFollowup) financialFollowup?: DisputeFinancialFollowup;
}

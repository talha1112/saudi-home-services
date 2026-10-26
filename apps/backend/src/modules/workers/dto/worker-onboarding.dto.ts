import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  DocumentStatus,
  DocumentType,
  VerificationAction,
  WorkerVerificationStatus,
  ScanStatus,
} from '../../../generated/prisma/client.js';
import type { MissingItem } from '../verification-workflow.js';
import { CityDto, ServiceDto } from '../../catalog/dto/catalog.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : trim({ value }));

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

// -------------------------------------------------------------------- requests

export class UpdateWorkerProfileDto {
  @ApiPropertyOptional({ example: 'Ahmed Al-Qahtani' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ example: 'أحمد القحطاني' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullNameAr?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Short introduction shown to customers; empty clears it' })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  bio?: string | null;

  @ApiPropertyOptional({ description: 'Total years of working experience', minimum: 0, maximum: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  yearsOfExperience?: number;
}

export class WorkerServiceInputDto {
  @ApiProperty()
  @IsUUID()
  serviceId: string;

  @ApiPropertyOptional({ description: 'Years of experience in this particular service', minimum: 0, maximum: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  yearsOfExperience?: number;
}

export class SetWorkerServicesDto {
  @ApiProperty({ type: [WorkerServiceInputDto], description: 'Replaces the whole list; 1 to 20 services' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WorkerServiceInputDto)
  services: WorkerServiceInputDto[];
}

export class SetWorkerAreasDto {
  @ApiProperty({ type: [String], description: 'City ids from GET /catalog/cities; replaces the whole list; 1 to 10' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  cityIds: string[];
}

export class AvailabilityWindowDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = Sunday ... 6 = Saturday' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '08:00', description: 'Saudi local time, 24-hour' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must look like 08:00' })
  startTime: string;

  @ApiProperty({ example: '17:00', description: '24:00 means end of day' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must look like 17:00' })
  endTime: string;
}

export class SetWorkerAvailabilityDto {
  @ApiProperty({ type: [AvailabilityWindowDto], description: 'Replaces the weekly schedule; 1 to 28 windows' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows: AvailabilityWindowDto[];
}

export class RegisterDocumentDto {
  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  type: DocumentType;

  @ApiProperty({ example: 'iqama-front.jpg' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/^[^/\\\0]+$/, { message: 'fileName must not contain path separators' })
  fileName: string;

  @ApiProperty({ enum: ALLOWED_DOCUMENT_MIME_TYPES })
  @IsIn(ALLOWED_DOCUMENT_MIME_TYPES)
  mimeType: string;

  @ApiProperty({ maximum: MAX_DOCUMENT_BYTES })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENT_BYTES)
  sizeBytes: number;

  @ApiPropertyOptional({ example: '2028-04-30', description: 'Expiry date printed on the document' })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresOn?: string;
}

export class ConfirmDocumentDto {
  @ApiPropertyOptional({ description: 'SHA-256 of the uploaded file (hex), for later integrity checks' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @Matches(/^[0-9a-f]{64}$/, { message: 'checksumSha256 must be 64 hex characters' })
  checksumSha256?: string;
}

// ------------------------------------------------------------------- responses

export class WorkerDocumentDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: DocumentType }) type: DocumentType;
  @ApiProperty({ enum: DocumentStatus }) status: DocumentStatus;
  @ApiProperty() fileName: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ nullable: true }) expiresOn: string | null;
  @ApiProperty({ nullable: true, description: 'Reviewer feedback, e.g. why a document was rejected' }) reviewNote: string | null;
  @ApiProperty({ enum: ScanStatus, description: 'Malware scan result. NOT_SCANNED means no scanner has looked at the file; it does not mean the file is safe.' }) scanStatus: ScanStatus;
  @ApiProperty() createdAt: string;
}

export class DocumentUploadDto {
  @ApiProperty({ type: WorkerDocumentDto }) document: WorkerDocumentDto;
  @ApiProperty() uploadUrl: string;
  @ApiProperty({ example: 'PUT' }) method: 'PUT';
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers: Record<string, string>;
  @ApiProperty() expiresAt: string;
}

export class VerificationHistoryItemDto {
  @ApiProperty({ enum: VerificationAction }) action: VerificationAction;
  @ApiProperty({ enum: WorkerVerificationStatus }) fromStatus: WorkerVerificationStatus;
  @ApiProperty({ enum: WorkerVerificationStatus }) toStatus: WorkerVerificationStatus;
  @ApiProperty({ nullable: true }) reason: string | null;
  @ApiProperty() createdAt: string;
}

export class VerificationStatusDto {
  @ApiProperty({ enum: WorkerVerificationStatus }) status: WorkerVerificationStatus;
  @ApiProperty({ nullable: true, description: 'Latest message from the reviewer' }) note: string | null;
  @ApiProperty({ nullable: true }) submittedAt: string | null;
  @ApiProperty({ nullable: true }) verifiedAt: string | null;
  @ApiProperty({ description: 'True when the worker may submit (or resubmit) for review right now' }) canSubmit: boolean;
  @ApiProperty({ type: [String], description: 'Items still missing before submission is possible' }) missing: MissingItem[];
  @ApiProperty({ type: [VerificationHistoryItemDto] }) history: VerificationHistoryItemDto[];
}

export class WorkerProfileDetailsDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiProperty({ nullable: true }) bio: string | null;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
  @ApiProperty() isOnline: boolean;
}

export class WorkerServiceSelectionDto extends ServiceDto {
  @ApiProperty({ nullable: true }) workerYearsOfExperience: number | null;
}

export class AvailabilityWindowViewDto {
  @ApiProperty() dayOfWeek: number;
  @ApiProperty() startTime: string;
  @ApiProperty() endTime: string;
}

export class WorkerOnboardingDto {
  @ApiProperty({ type: WorkerProfileDetailsDto }) profile: WorkerProfileDetailsDto;
  @ApiProperty({ type: [WorkerServiceSelectionDto] }) services: WorkerServiceSelectionDto[];
  @ApiProperty({ type: [CityDto] }) cities: CityDto[];
  @ApiProperty({ type: [AvailabilityWindowViewDto] }) availability: AvailabilityWindowViewDto[];
  @ApiProperty({ type: [WorkerDocumentDto] }) documents: WorkerDocumentDto[];
  @ApiProperty({ type: VerificationStatusDto }) verification: VerificationStatusDto;
}

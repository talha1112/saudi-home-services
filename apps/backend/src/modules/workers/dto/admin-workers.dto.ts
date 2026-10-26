import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination/pagination.js';
import { CityDto } from '../../catalog/dto/catalog.dto.js';
import {
  DocumentStatus,
  DocumentType,
  UserStatus,
  VerificationAction,
  WorkerVerificationStatus,
} from '../../../generated/prisma/client.js';
import { AvailabilityWindowViewDto, WorkerServiceSelectionDto } from './worker-onboarding.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean) : value;

export const STATUS_FILTER_VALUES = [...Object.values(WorkerVerificationStatus), 'ALL'] as const;

// -------------------------------------------------------------------- requests

export class ListWorkersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated verification statuses, or ALL. Default: SUBMITTED,UNDER_REVIEW (the review queue).',
    example: 'SUBMITTED,UNDER_REVIEW',
  })
  @IsOptional()
  @Transform(csv)
  @IsIn(STATUS_FILTER_VALUES, { each: true })
  status?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Matches name or phone number' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['oldest', 'newest'], default: 'oldest', description: 'By submission time' })
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort: 'oldest' | 'newest' = 'oldest';
}

export class ReviewDecisionDto {
  @ApiPropertyOptional({ description: 'Required for reject, request-info and suspend. Shown to the worker.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ReviewDocumentDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn([DocumentStatus.ACCEPTED, DocumentStatus.REJECTED])
  status: 'ACCEPTED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Required when rejecting' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ------------------------------------------------------------------- responses

export class AdminWorkerListItemDto {
  @ApiProperty({ description: 'Worker profile id' }) id: string;
  @ApiProperty() userId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty({ enum: WorkerVerificationStatus }) verificationStatus: WorkerVerificationStatus;
  @ApiProperty({ nullable: true }) submittedAt: string | null;
  @ApiProperty() serviceCount: number;
  @ApiProperty() cityCount: number;
  @ApiProperty() documentCount: number;
}

export class PagedAdminWorkersDto {
  @ApiProperty({ type: [AdminWorkerListItemDto] }) items: AdminWorkerListItemDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class AdminDocumentDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: DocumentType }) type: DocumentType;
  @ApiProperty({ enum: DocumentStatus }) status: DocumentStatus;
  @ApiProperty() fileName: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ nullable: true }) expiresOn: string | null;
  @ApiProperty({ nullable: true }) reviewNote: string | null;
  @ApiProperty({ nullable: true }) reviewedAt: string | null;
  @ApiProperty() createdAt: string;
}

export class AdminHistoryItemDto {
  @ApiProperty({ enum: VerificationAction }) action: VerificationAction;
  @ApiProperty({ enum: WorkerVerificationStatus }) fromStatus: WorkerVerificationStatus;
  @ApiProperty({ enum: WorkerVerificationStatus }) toStatus: WorkerVerificationStatus;
  @ApiProperty({ nullable: true }) reason: string | null;
  @ApiProperty({ nullable: true, description: 'Who made the change (the worker for submissions)' }) actorUserId: string | null;
  @ApiProperty({ nullable: true }) actorName: string | null;
  @ApiProperty() createdAt: string;
}

export class AdminWorkerDetailDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ enum: UserStatus }) accountStatus: UserStatus;
  @ApiProperty({ nullable: true }) bio: string | null;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
  @ApiProperty({ enum: WorkerVerificationStatus }) verificationStatus: WorkerVerificationStatus;
  @ApiProperty({ nullable: true }) verificationNote: string | null;
  @ApiProperty({ nullable: true }) submittedAt: string | null;
  @ApiProperty({ nullable: true }) verifiedAt: string | null;
  @ApiProperty({ type: [WorkerServiceSelectionDto] }) services: WorkerServiceSelectionDto[];
  @ApiProperty({ type: [CityDto] }) cities: CityDto[];
  @ApiProperty({ type: [AvailabilityWindowViewDto] }) availability: AvailabilityWindowViewDto[];
  @ApiProperty({ type: [AdminDocumentDto], description: 'Metadata only; use the download-url endpoint to view a file' })
  documents: AdminDocumentDto[];
  @ApiProperty({ type: [AdminHistoryItemDto] }) history: AdminHistoryItemDto[];
}

export class DocumentDownloadDto {
  @ApiProperty({ description: 'Short-lived signed URL. Do not store or share it.' }) url: string;
  @ApiProperty() expiresAt: string;
}

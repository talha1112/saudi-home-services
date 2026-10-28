import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { clientMeta } from '../auth/auth.controller.js';
import {
  AdminDocumentDto,
  AdminWorkerDetailDto,
  DocumentDownloadDto,
  ListWorkersQueryDto,
  PagedAdminWorkersDto,
  ReviewDecisionDto,
  ReviewDocumentDto,
} from './dto/admin-workers.dto.js';
import { DiscoverWorkersQueryDto, PagedPublicWorkersDto, PublicWorkerDto } from './dto/discovery.dto.js';
import {
  ConfirmDocumentDto,
  DocumentUploadDto,
  RegisterDocumentDto,
  SetWorkerAreasDto,
  SetWorkerAvailabilityDto,
  SetWorkerServicesDto,
  UpdateWorkerProfileDto,
  VerificationStatusDto,
  WorkerDocumentDto,
  WorkerOnboardingDto,
} from './dto/worker-onboarding.dto.js';
import type { ReviewAction } from './verification-workflow.js';
import { WorkerDiscoveryService } from './worker-discovery.service.js';
import { WorkerOnboardingService } from './worker-onboarding.service.js';
import { WorkerVerificationService } from './worker-verification.service.js';

// ---------------------------------------------------------------------------
// Worker app: onboarding and verification (the worker's own data only)
// ---------------------------------------------------------------------------

@ApiTags('Worker onboarding')
@ApiBearerAuth()
@Roles(Role.WORKER)
@Controller({ path: 'workers/me', version: '1' })
export class WorkerOnboardingController {
  constructor(private readonly onboarding: WorkerOnboardingService) {}

  @Get('onboarding')
  @ApiOperation({ summary: 'Everything about my application: profile, services, cities, schedule, documents, status' })
  @ApiOkResponse({ type: WorkerOnboardingDto })
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.overview(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update my name, introduction and years of experience' })
  @ApiOkResponse({ type: WorkerOnboardingDto })
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateWorkerProfileDto) {
    return this.onboarding.updateProfile(user.id, dto);
  }

  @Put('services')
  @ApiOperation({ summary: 'Choose the services I offer (replaces the list)' })
  @ApiOkResponse({ type: WorkerOnboardingDto })
  setServices(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetWorkerServicesDto) {
    return this.onboarding.setServices(user.id, dto);
  }

  @Put('areas')
  @ApiOperation({ summary: 'Choose the cities I work in (replaces the list)' })
  @ApiOkResponse({ type: WorkerOnboardingDto })
  setAreas(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetWorkerAreasDto) {
    return this.onboarding.setAreas(user.id, dto);
  }

  @Put('availability')
  @ApiOperation({ summary: 'Set my weekly working hours (replaces the schedule)' })
  @ApiOkResponse({ type: WorkerOnboardingDto })
  setAvailability(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetWorkerAvailabilityDto) {
    return this.onboarding.setAvailability(user.id, dto);
  }

  @Get('documents')
  @ApiOperation({ summary: 'My verification documents (metadata only)' })
  listDocuments(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.listDocuments(user.id);
  }

  @Get('photo')
  @ApiOperation({ summary: 'A short-lived link to my profile photo (url is null while I have none)' })
  photo(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.profilePhoto(user.id);
  }

  @Post('documents')
  @RateLimit({ name: 'file-register', limit: 120, windowSeconds: 600 })
  @ApiOperation({
    summary: 'Register a document and get a signed upload URL',
    description: 'Upload the file bytes straight to the returned URL, then call confirm. Returns 503 while no storage is configured.',
  })
  @ApiCreatedResponse({ type: DocumentUploadDto })
  registerDocument(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDocumentDto) {
    return this.onboarding.registerDocument(user.id, dto);
  }

  @Post('documents/:documentId/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'file-confirm', limit: 240, windowSeconds: 600 })
  @ApiOperation({ summary: 'Confirm that the file was uploaded' })
  @ApiOkResponse({ type: WorkerDocumentDto })
  confirmDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() dto: ConfirmDocumentDto,
  ) {
    return this.onboarding.confirmDocument(user.id, documentId, dto);
  }

  @Delete('documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a document (not allowed during review or after approval)' })
  @ApiNoContentResponse()
  async deleteDocument(@CurrentUser() user: AuthenticatedUser, @Param('documentId', new ParseUUIDPipe()) documentId: string) {
    await this.onboarding.deleteDocument(user.id, documentId);
  }

  @Get('verification')
  @ApiOperation({ summary: 'My verification status, reviewer message, history and what is still missing' })
  @ApiOkResponse({ type: VerificationStatusDto })
  verification(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.verificationStatus(user.id);
  }

  @Post('verification/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit my application for review',
    description: '409 VERIFICATION_INCOMPLETE (with the missing items) until everything required is filled in.',
  })
  @ApiOkResponse({ type: VerificationStatusDto })
  submit(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.onboarding.submit(user.id, clientMeta(req));
  }
}

// ---------------------------------------------------------------------------
// Customer app: discovery of approved workers (no private data)
// ---------------------------------------------------------------------------

@ApiTags('Worker discovery')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.ADMIN)
@Controller({ path: 'discovery/workers', version: '1' })
export class WorkerDiscoveryController {
  constructor(private readonly discovery: WorkerDiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Approved workers, filterable by city, service, category and online status' })
  @ApiOkResponse({ type: PagedPublicWorkersDto })
  list(@Query() query: DiscoverWorkersQueryDto) {
    return this.discovery.list(query);
  }

  @Get(':workerId')
  @ApiOperation({ summary: 'One approved worker. Unapproved or suspended workers return 404.' })
  @ApiOkResponse({ type: PublicWorkerDto })
  get(@Param('workerId', new ParseUUIDPipe()) workerId: string) {
    return this.discovery.get(workerId);
  }
}

// ---------------------------------------------------------------------------
// Admin: verification queue and decisions
// ---------------------------------------------------------------------------

@ApiTags('Admin workers')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/workers', version: '1' })
export class AdminWorkersController {
  constructor(private readonly verification: WorkerVerificationService) {}

  @Get()
  @ApiOperation({
    summary: 'Workers by verification status (default: the review queue, oldest first)',
    description: 'Filters: status (CSV or ALL), cityId, serviceId, q (name/phone), sort, page, limit.',
  })
  @ApiOkResponse({ type: PagedAdminWorkersDto })
  list(@Query() query: ListWorkersQueryDto) {
    return this.verification.list(query);
  }

  @Get(':workerId')
  @ApiOperation({ summary: 'Full application for review: contact, services, cities, schedule, documents (metadata), history' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  detail(@Param('workerId', new ParseUUIDPipe()) workerId: string) {
    return this.verification.detail(workerId);
  }

  @Post(':workerId/start-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SUBMITTED -> UNDER_REVIEW' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  startReview(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'start_review', admin, dto, req);
  }

  @Post(':workerId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a worker (SUBMITTED or UNDER_REVIEW -> APPROVED)',
    description: 'Requires an ACCEPTED identity document when WORKER_REQUIRE_IDENTITY_DOCUMENT is on.',
  })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  approve(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'approve', admin, dto, req);
  }

  @Post(':workerId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an application; a reason is required and shown to the worker, who may fix and resubmit' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  reject(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'reject', admin, dto, req);
  }

  @Post(':workerId/request-info')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the worker for more information (-> INFO_REQUIRED); a reason is required' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  requestInfo(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'request_info', admin, dto, req);
  }

  @Post(':workerId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend an approved worker (APPROVED -> SUSPENDED); a reason is required' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  suspend(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'suspend', admin, dto, req);
  }

  @Post(':workerId/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a suspension (SUSPENDED -> APPROVED)' })
  @ApiOkResponse({ type: AdminWorkerDetailDto })
  reinstate(@CurrentUser() admin: AuthenticatedUser, @Param('workerId', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDecisionDto, @Req() req: Request) {
    return this.decide(id, 'reinstate', admin, dto, req);
  }

  @Patch(':workerId/documents/:documentId')
  @ApiOperation({ summary: 'Accept or reject a submitted document' })
  @ApiOkResponse({ type: AdminDocumentDto })
  reviewDocument(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('workerId', new ParseUUIDPipe()) workerId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() dto: ReviewDocumentDto,
    @Req() req: Request,
  ) {
    return this.verification.reviewDocument(workerId, documentId, admin.id, dto, clientMeta(req));
  }

  @Get(':workerId/documents/:documentId/download-url')
  @ApiOperation({
    summary: 'Short-lived signed URL to view a private document',
    description: 'Every call is written to the audit log. Returns 503 while no storage is configured.',
  })
  @ApiOkResponse({ type: DocumentDownloadDto })
  downloadUrl(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('workerId', new ParseUUIDPipe()) workerId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Req() req: Request,
  ) {
    return this.verification.documentDownload(workerId, documentId, admin.id, clientMeta(req));
  }

  private decide(id: string, action: ReviewAction, admin: AuthenticatedUser, dto: ReviewDecisionDto, req: Request) {
    return this.verification.decide(id, action, admin.id, dto.reason, clientMeta(req));
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { CatalogService } from './catalog.service.js';
import {
  CatalogDto,
  CityDto,
  CityListDto,
  CreateCategoryDto,
  CreateCityDto,
  CreateServiceDto,
  ListCategoriesQueryDto,
  ListCitiesQueryDto,
  ListServicesQueryDto,
  PagedCategoriesDto,
  PagedCitiesDto,
  PagedServicesDto,
  ServiceCategoryDto,
  ServiceDto,
  UpdateCategoryDto,
  UpdateCityDto,
  UpdateServiceDto,
} from './dto/catalog.dto.js';

/** Read-only catalog for the apps. Public so the apps can show services before sign-in. */
@ApiTags('Catalog')
@Public()
@RateLimit({ name: 'catalog', limit: 120, windowSeconds: 60 })
@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Active service categories with their active services (English and Arabic)' })
  @ApiOkResponse({ type: CatalogDto })
  list(): Promise<CatalogDto> {
    return this.catalog.publicCatalog();
  }

  @Get('cities')
  @ApiOperation({ summary: 'Active launch cities' })
  @ApiOkResponse({ type: CityListDto })
  cities(): Promise<CityListDto> {
    return this.catalog.publicCities();
  }
}

@ApiTags('Admin catalog')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin', version: '1' })
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ------------------------------------------------------------------ cities

  @Get('cities')
  @ApiOperation({ summary: 'List cities (active and inactive)' })
  @ApiOkResponse({ type: PagedCitiesDto })
  listCities(@Query() query: ListCitiesQueryDto) {
    return this.catalog.listCities(query);
  }

  @Post('cities')
  @ApiOperation({ summary: 'Add a launch city' })
  @ApiCreatedResponse({ type: CityDto })
  createCity(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCityDto) {
    return this.catalog.createCity(dto, admin.id);
  }

  @Get('cities/:id')
  @ApiOkResponse({ type: CityDto })
  getCity(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getCity(id);
  }

  @Patch('cities/:id')
  @ApiOperation({ summary: 'Rename, reorder, activate or deactivate a city' })
  @ApiOkResponse({ type: CityDto })
  updateCity(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateCityDto) {
    return this.catalog.updateCity(id, dto, admin.id);
  }

  // -------------------------------------------------------------- categories

  @Get('service-categories')
  @ApiOperation({ summary: 'List service categories (active and inactive)' })
  @ApiOkResponse({ type: PagedCategoriesDto })
  listCategories(@Query() query: ListCategoriesQueryDto) {
    return this.catalog.listCategories(query);
  }

  @Post('service-categories')
  @ApiOperation({ summary: 'Create a service category' })
  @ApiCreatedResponse({ type: ServiceCategoryDto })
  createCategory(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCategoryDto) {
    return this.catalog.createCategory(dto, admin.id);
  }

  @Get('service-categories/:id')
  @ApiOkResponse({ type: ServiceCategoryDto })
  getCategory(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getCategory(id);
  }

  @Patch('service-categories/:id')
  @ApiOperation({ summary: 'Update or deactivate a service category' })
  @ApiOkResponse({ type: ServiceCategoryDto })
  updateCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(id, dto, admin.id);
  }

  // ---------------------------------------------------------------- services

  @Get('services')
  @ApiOperation({ summary: 'List services (active and inactive), optionally by category' })
  @ApiOkResponse({ type: PagedServicesDto })
  listServices(@Query() query: ListServicesQueryDto) {
    return this.catalog.listServices(query);
  }

  @Post('services')
  @ApiOperation({ summary: 'Create a service inside a category' })
  @ApiCreatedResponse({ type: ServiceDto })
  createService(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateServiceDto) {
    return this.catalog.createService(dto, admin.id);
  }

  @Get('services/:id')
  @ApiOkResponse({ type: ServiceDto })
  getService(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getService(id);
  }

  @Patch('services/:id')
  @ApiOperation({ summary: 'Update, move or deactivate a service' })
  @ApiOkResponse({ type: ServiceDto })
  updateService(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateServiceDto) {
    return this.catalog.updateService(id, dto, admin.id);
  }
}

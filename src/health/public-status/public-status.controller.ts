import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../decorators/public.decorator';
import {
  PUBLIC_STATUS_SCHEMA_VERSION,
  PublicStatusResponseDto,
} from './public-status.dto';
import { PublicStatusRateLimitGuard } from './public-status-rate-limit.guard';
import { PublicStatusService } from './public-status.service';

/**
 * Sanitized public service-status projection (UX-BE-001). Unlike the
 * protected `/health/*` reports, this endpoint returns only the allow-listed
 * `PublicStatusResponseDto`.
 */
@ApiTags('Public Status')
@Public()
@Controller('status')
export class PublicStatusController {
  constructor(private readonly publicStatusService: PublicStatusService) {}

  @Get('public')
  @UseGuards(PublicStatusRateLimitGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Public service status',
    description:
      'Freshness-labelled, allow-listed status for the public status page. ' +
      'Missing data is reported as `unknown` and old data as `stale`; ' +
      'neither is ever reported as `operational`.',
  })
  @ApiOkResponse({ type: PublicStatusResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'Per-client rate limit exceeded.',
  })
  async getPublicStatus(
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicStatusResponseDto> {
    const { body, maxAgeSeconds } =
      await this.publicStatusService.getSnapshot();
    res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    res.setHeader('X-Public-Status-Schema', PUBLIC_STATUS_SCHEMA_VERSION);
    return body;
  }
}

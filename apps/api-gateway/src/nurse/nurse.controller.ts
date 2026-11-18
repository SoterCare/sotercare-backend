import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NurseService } from './nurse.service';

@Controller('nurse')
@UseGuards(JwtAuthGuard)
export class NurseController {
  private readonly logger = new Logger(NurseController.name);

  constructor(private readonly nurseService: NurseService) {}

  @Post('chat')
  async chat(
    @Body() body: { message: string; sessionId?: string },
    @Req() req: any,
  ) {
    if (!body.message?.trim()) {
      throw new BadRequestException('message is required');
    }
    const userId: number = req.user.userId;
    const result = await this.nurseService.chat(
      userId,
      body.message.trim(),
      body.sessionId ?? '',
    );
    return {
      reply: result.reply,
      sessionId: result.session_id,
    };
  }

  @Post('upload-prescription')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPrescription(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const userId: number = req.user.userId;
    const result = await this.nurseService.uploadPrescription(
      userId,
      file.buffer,
      file.originalname,
    );
    return {
      success: result.success,
      message: result.message,
      docId: result.doc_id,
    };
  }
}

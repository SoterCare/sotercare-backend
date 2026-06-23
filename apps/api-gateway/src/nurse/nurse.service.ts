import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, Observable, timeout } from 'rxjs';

interface NurseGrpcService {
  chat(data: {
    user_id: number;
    message: string;
    session_id: string;
  }): Observable<{ reply: string; session_id: string }>;
  uploadPrescription(data: {
    user_id: number;
    file_data: Buffer;
    file_name: string;
  }): Observable<{ success: boolean; message: string; doc_id: string }>;
}

const AI_GRPC_TIMEOUT_MS = 120_000;

@Injectable()
export class NurseService implements OnModuleInit {
  private readonly logger = new Logger(NurseService.name);
  private nurseGrpc: NurseGrpcService;

  constructor(@Inject('SUMMARY_SERVICE') private client: ClientGrpc) {}

  onModuleInit() {
    this.nurseGrpc = this.client.getService<NurseGrpcService>('SummaryService');
  }

  async chat(userId: number, message: string, sessionId: string): Promise<{ reply: string; session_id: string }> {
    this.logger.log(`[chat] userId=${userId} sessionId=${sessionId || 'new'}`);
    return lastValueFrom(
      this.nurseGrpc
        .chat({ user_id: userId, message, session_id: sessionId })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }

  async uploadPrescription(
    userId: number,
    fileData: Buffer,
    fileName: string,
  ): Promise<{ success: boolean; message: string; doc_id: string }> {
    return lastValueFrom(
      this.nurseGrpc
        .uploadPrescription({ user_id: userId, file_data: fileData, file_name: fileName })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }
}

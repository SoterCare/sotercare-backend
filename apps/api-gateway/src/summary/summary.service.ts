import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, Observable, timeout } from 'rxjs';

interface SummaryGrpcService {
  analyzeData(data: {
    data_json: string;
    format: string;
    user_id: number;
  }): Observable<any>;
  uploadPrescription(data: {
    user_id: number;
    file_data: Buffer;
    file_name: string;
  }): Observable<any>;
  queryPrescription(data: {
    user_id: number;
    question: string;
  }): Observable<any>;
}

// LLM-backed calls are slow but must still be bounded — without a deadline a
// hung AI service pins the HTTP request (and its DB/pool resources) forever.
const AI_GRPC_TIMEOUT_MS = 60000;

@Injectable()
export class SummaryService implements OnModuleInit {
  private readonly logger = new Logger(SummaryService.name);
  private summaryGrpc: SummaryGrpcService;

  constructor(@Inject('SUMMARY_SERVICE') private client: ClientGrpc) {}

  onModuleInit() {
    this.summaryGrpc =
      this.client.getService<SummaryGrpcService>('SummaryService');
  }

  async analyzeData(dataJson: string, userId: number): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc
        .analyzeData({ data_json: dataJson, format: 'json', user_id: userId })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }

  async uploadPrescription(
    userId: number,
    fileData: Buffer,
    fileName: string,
  ): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc
        .uploadPrescription({
          user_id: userId,
          file_data: fileData,
          file_name: fileName,
        })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }

  async queryPrescription(userId: number, question: string): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc
        .queryPrescription({ user_id: userId, question })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }
}

import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, Observable } from 'rxjs';

interface SummaryGrpcService {
  analyzeData(data: { data_json: string; format: string }): Observable<any>;
  uploadPrescription(data: { user_id: number; file_data: Buffer; file_name: string }): Observable<any>;
  queryPrescription(data: { user_id: number; question: string }): Observable<any>;
}

@Injectable()
export class SummaryService implements OnModuleInit {
  private readonly logger = new Logger(SummaryService.name);
  private summaryGrpc: SummaryGrpcService;

  constructor(@Inject('SUMMARY_SERVICE') private client: ClientGrpc) {}

  onModuleInit() {
    this.summaryGrpc = this.client.getService<SummaryGrpcService>('SummaryService');
  }

  async analyzeData(dataJson: string): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc.analyzeData({ data_json: dataJson, format: 'json' }),
    );
  }

  async uploadPrescription(userId: number, fileData: Buffer, fileName: string): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc.uploadPrescription({ user_id: userId, file_data: fileData, file_name: fileName }),
    );
  }

  async queryPrescription(userId: number, question: string): Promise<any> {
    return lastValueFrom(
      this.summaryGrpc.queryPrescription({ user_id: userId, question }),
    );
  }
}

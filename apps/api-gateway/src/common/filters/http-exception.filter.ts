import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (
        exceptionResponse &&
        typeof exceptionResponse === 'object' &&
        'success' in exceptionResponse
      ) {
        response.status(status).json(exceptionResponse);
        return;
      }

      const message: unknown =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : ((exceptionResponse as { message?: unknown } | null)?.message ??
            exception.message);

      response.status(status).json({
        success: false,
        message,
      });
      return;
    }

    response.status(status).json({
      success: false,
      message: 'Internal server error',
    });
  }
}

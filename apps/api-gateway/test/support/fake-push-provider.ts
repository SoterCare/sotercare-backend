import type {
  PushMessage,
  PushProvider,
  PushReceipt,
  PushTicket,
} from '../../src/notifications/push-provider';

/**
 * In-memory push provider for tests: records messages, never contacts Expo.
 * `ticketFor` and `receipts` script the provider's answers; `failWith` makes
 * the next sends throw like a network/HTTP failure.
 */
export class FakePushProvider implements PushProvider {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  failWith: Error | null = null;
  receipts: Record<string, PushReceipt> = {};
  ticketFor: (message: PushMessage, index: number) => PushTicket = () => ({
    status: 'ok',
    id: `ticket-${++this.counter}`,
  });
  private counter = 0;

  send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(...messages);
    return Promise.resolve(messages.map((m, i) => this.ticketFor(m, i)));
  }

  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Promise.resolve(
      Object.fromEntries(
        ids
          .filter((id) => id in this.receipts)
          .map((id) => [id, this.receipts[id]]),
      ),
    );
  }
}

export type AuditEventInput = {
  type: string;
  actor: string;
  mandateId?: string;
  data?: unknown;
};

export type AuditEvent = AuditEventInput & {
  id: string;
  timestamp: number;
};

export class InMemoryAuditLog {
  readonly #events: AuditEvent[] = [];

  append(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    this.#events.push(event);
    return event;
  }

  list(): AuditEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }
}
